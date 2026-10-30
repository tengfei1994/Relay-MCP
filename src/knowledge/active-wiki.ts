import type { KnowledgeStore } from "./store.js";
import { EngineWikiError, EngineWikiService, type EngineWikiPage } from "./engine-wiki.js";
import { WikiService } from "./wiki.js";
import type { WikiPage, WikiPageListQuery, WikiPageListResult, WikiPageRevision } from "./wiki.js";
import { canonicalWikiRow, wikiCanonicalKey } from "./wiki-identity.js";

type ScopedListInput = WikiPageListQuery & { environment?: string };
type PageInput = Parameters<EngineWikiService["get"]>[0];
type KeyInput = Parameters<EngineWikiService["getByKey"]>[0];
type CreateInput = Parameters<EngineWikiService["create"]>[0];
type ChangeInput = Parameters<EngineWikiService["edit"]>[0];
type RevisionInput = Parameters<EngineWikiService["listRevisions"]>[0];
type DiffInput = Parameters<EngineWikiService["diffRevisions"]>[0];
type RollbackInput = Parameters<EngineWikiService["rollback"]>[0];

/**
 * Keeps legacy Relay Wiki pages readable while engine-backed pages use the
 * upstream body, revisions and verified citations. Product routing can remain
 * relay_local until a complete Product migration is ready.
 */
export class ActiveWikiService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly local: WikiService,
    private readonly engine?: EngineWikiService,
    private readonly engineAuthoritative = false,
  ) {}


  private enginePageShadowed(item: WikiPageListResult["items"][number], local: WikiPageListResult["items"]): boolean {
    const generatedGroups = [...new Set(local
      .filter(page => page.generationStatus === "succeeded")
      .map(page => page.topicGroupId)
      .filter((value): value is string => Boolean(value)))];
    if (!generatedGroups.length || !item.sourceRefs.length) return false;
    try {
      const refs = [...new Set(item.sourceRefs.filter(Boolean))];
      const placeholders = refs.map(() => "?").join(","), groupPlaceholders = generatedGroups.map(() => "?").join(",");
      return Boolean(this.store.db.prepare(`SELECT 1
        FROM knowledge_product_documents p
        LEFT JOIN knowledge_weknora_documents w ON w.external_document_id=p.engine_external_document_id
        WHERE (p.id IN (${placeholders})
          OR p.engine_external_document_id IN (${placeholders})
          OR w.id IN (${placeholders})
          OR w.external_document_id IN (${placeholders}))
          AND p.topic_group_id IN (${groupPlaceholders}) LIMIT 1`).get(...refs, ...refs, ...refs, ...refs, ...generatedGroups));
    } catch {
      return false;
    }
  }
  private isEngineId(id: string): boolean { return id.startsWith("engine-wiki:"); }

  private isEngineKey(pageKey: string): boolean {
    const row = this.store.db.prepare("SELECT id FROM knowledge_wiki_pages WHERE page_key=?").get(pageKey) as { id?: unknown } | undefined;
    return !!row && this.isEngineId(String(row.id));
  }

  private localListInput(input: ScopedListInput): WikiPageListQuery {
    return input;
  }

  private unavailable(): never {
    throw new EngineWikiError("unavailable", "Knowledge engine Wiki is unavailable; retry when the engine is healthy");
  }

  async list(input: ScopedListInput): Promise<WikiPageListResult> {
    const localInput = this.localListInput(input);
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    if (!this.engine) return this.local.list({ ...localInput, limit, offset });

    // Each provider owns its own filtering and canonicalization. Fetching only
    // the requested window from each provider is not sufficient: duplicates
    // can occur at different offsets, and the merged total would then be
    // based on truncated provider arrays. Both providers have bounded windows
    // (the engine also enforces its safe remote page cap), so enumerate those
    // windows before applying the merged page. This can make several bounded
    // upstream requests, but keeps the merged total exact.
    const window = 200;
    const collect = async <T extends WikiPageListResult["items"][number]>(
      load: (offset: number) => Promise<WikiPageListResult & { items: T[] }>,
    ): Promise<T[]> => {
      const first = await load(0);
      const items: T[] = [...first.items];
      let cursor = items.length;
      while (cursor < first.total) {
        const page = await load(cursor);
        items.push(...page.items);
        if (!page.items.length) break;
        const nextCursor = cursor + page.items.length;
        if (nextCursor <= cursor) break;
        cursor = nextCursor;
      }
      return items;
    };

    const local = await collect(offsetValue => Promise.resolve(this.local.list({ ...localInput, limit: window, offset: offsetValue })));
    let engine: WikiPageListResult["items"];
    try {
      engine = await collect(offsetValue => this.engine!.list({ ...input, limit: window, offset: offsetValue }));
    } catch (error) {
      if (!(error instanceof EngineWikiError) || error.code !== "unavailable") throw error;
      // An unavailable engine must never expose a partially merged result.
      return this.local.list({ ...localInput, limit, offset });
    }

    const merged = [...local, ...engine.filter(item => !this.enginePageShadowed(item, local))];
    const identity = (item: WikiPageListResult["items"][number]) => {
      const raw = item as unknown as Record<string, unknown>;
      return {
        ...raw,
        page_key: item.pageKey,
        project_id: item.projectId,
        environment: typeof raw.environment === "string" ? raw.environment : undefined,
        topic_id: item.topicId,
        topic_group_id: item.topicGroupId,
        source_refs_json: JSON.stringify(item.sourceRefs),
        created_at: item.createdAt,
      };
    };
    const byIdentity = new Map<string, WikiPageListResult["items"][number]>();
    for (const item of merged) {
      const itemRow = identity(item);
      const key = wikiCanonicalKey(itemRow);
      const existing = byIdentity.get(key);
      if (!existing) {
        byIdentity.set(key, item);
        continue;
      }
      const existingIsEngine = this.isEngineId(existing.id);
      const itemIsEngine = this.isEngineId(item.id);
      if (this.engineAuthoritative && itemIsEngine !== existingIsEngine) {
        if (itemIsEngine) byIdentity.set(key, item);
        continue;
      }
      const existingRow = identity(existing);
      if (String(canonicalWikiRow([existingRow, itemRow], itemRow).id) === item.id) byIdentity.set(key, item);
    }
    const canonical = [...byIdentity.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    return { items: canonical.slice(offset, offset + limit), total: canonical.length, limit, offset };
  }
  async get(input: PageInput): Promise<WikiPage | EngineWikiPage> {
    if (this.isEngineId(input.id)) return this.engine ? this.engine.get(input) : this.unavailable();
    return this.local.get({ actorId: input.actorId, isAdmin: input.isAdmin, id: input.id, projectId: input.projectId, environment: input.environment });
  }

  async getByKey(input: KeyInput): Promise<WikiPage | EngineWikiPage> {
    if (this.isEngineKey(input.pageKey)) return this.engine ? this.engine.getByKey(input) : this.unavailable();
    return this.local.getByKey({ actorId: input.actorId, isAdmin: input.isAdmin, pageKey: input.pageKey, projectId: input.projectId, environment: input.environment });
  }

  async create(input: CreateInput): Promise<WikiPage | EngineWikiPage> {
    if (this.engineAuthoritative && this.engine) return this.engine.create(input);
    return this.local.create(input);
  }

  async edit(input: ChangeInput): Promise<WikiPage | EngineWikiPage> {
    if (this.isEngineId(input.id)) return this.engine ? this.engine.edit(input) : this.unavailable();
    return this.local.edit(input);
  }

  async publish(input: ChangeInput): Promise<WikiPage | EngineWikiPage> {
    if (this.isEngineId(input.id)) return this.engine ? this.engine.publish(input) : this.unavailable();
    return this.local.publish(input);
  }

  async deprecate(input: ChangeInput): Promise<WikiPage | EngineWikiPage> {
    if (this.isEngineId(input.id)) return this.engine ? this.engine.deprecate(input) : this.unavailable();
    return this.local.deprecate(input);
  }

  async listRevisions(input: RevisionInput): Promise<WikiPageRevision[]> {
    if (this.isEngineId(input.id)) return this.engine ? this.engine.listRevisions(input) : this.unavailable();
    return this.local.listRevisions(input);
  }

  async diffRevisions(input: DiffInput): Promise<string> {
    if (this.isEngineId(input.id)) return this.engine ? this.engine.diffRevisions(input) : this.unavailable();
    return this.local.diffRevisions(input);
  }

  async rollback(input: RollbackInput): Promise<WikiPage | EngineWikiPage> {
    if (this.isEngineId(input.id)) return this.engine ? this.engine.rollback(input) : this.unavailable();
    return this.local.rollback(input);
  }
}
