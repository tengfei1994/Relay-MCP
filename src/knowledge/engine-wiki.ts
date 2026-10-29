import { createHash, randomUUID } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { scanCandidateContent } from "./candidate-insight.js";
import type { KnowledgeStore } from "./store.js";
import type { WikiPage, WikiPageListQuery, WikiPageRevision, WikiPageStatus } from "./wiki.js";
import { canonicalWikiRow, isCanonicalWikiRow } from "./wiki-identity.js";

/** Auth is owned by the managed engine; this callback must return the raw parsed JSON. */
export type EngineWikiTransport = (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => Promise<unknown>;
export interface EngineWikiOptions { knowledgeBaseId: string; request: EngineWikiTransport; maxListPages?: number; }
export interface EngineWikiCitation {
  documentId: string; title: string; sourceLocator?: string; sourceSha256?: string;
  productVersion?: string; topicId?: string; chunkIds: string[];
}
export interface EngineWikiPage extends WikiPage { environment?: string; citations: EngineWikiCitation[]; }
export type EngineWikiPageSummary = Omit<EngineWikiPage, "body">;
type Row = Record<string, unknown>;
type Source = { row: Row; chunks: string[] };
type Scope = { projectId?: string; environment?: string; productVersion?: string; topicId?: string; solution?: string; module?: string };
type PageInput = { actorId: number; isAdmin?: boolean; id: string; projectId?: string; environment?: string };
type ChangeInput = PageInput & { reason: string };
class WikiSourceError extends Error {}
export class EngineWikiError extends Error {
  constructor(readonly code: "unavailable" | "invalid_response" | "conflict", message: string) { super(message); this.name = "EngineWikiError"; }
}
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EngineWikiError("invalid_response", "Knowledge engine returned an invalid Wiki response");
  return value as Row;
}
function optional(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function strings(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new EngineWikiError("invalid_response", "Knowledge engine returned invalid Wiki references");
  return value as string[];
}
function storedStrings(value: unknown): string[] {
  try { return strings(JSON.parse(String(value ?? "[]"))); } catch { throw new Error("Wiki reference mapping is invalid"); }
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new EngineWikiError("invalid_response", "Knowledge engine returned an invalid Wiki revision");
  return Number(value);
}
function safeContent(value: Row): void {
  const result = scanCandidateContent(value);
  if (result) throw new Error("Wiki content contains " + result);
}
function reason(value: string): string {
  const text = value?.trim();
  if (!text) throw new Error("A change reason is required");
  safeContent({ reason: text });
  return text.slice(0, 2000);
}

/**
 * Upstream owns page content and revision history. Existing Wiki rows hold only
 * Relay identity, scope, publication and audit metadata; their body stays empty.
 * Legacy local Wiki IDs require an explicit migration and are never a fallback.
 */
export class EngineWikiService {
  private readonly prefix: string;
  private readonly base: string;
  constructor(private readonly store: KnowledgeStore, private readonly options: EngineWikiOptions, private readonly clock: () => Date = () => new Date()) {
    if (!options.knowledgeBaseId.trim()) throw new Error("Managed Wiki knowledge base is required");
    this.prefix = "engine-wiki:" + createHash("sha256").update(options.knowledgeBaseId).digest("hex").slice(0, 16) + ":";
    this.base = "/api/v1/knowledgebase/" + encodeURIComponent(options.knowledgeBaseId) + "/wiki";
  }

  private async request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<Row> {
    let result: unknown;
    try { result = await this.options.request(method, this.base + path, body); }
    catch (error) {
      const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
      if (status === 409) throw new EngineWikiError("conflict", "Wiki was changed concurrently; reload and retry");
      throw new EngineWikiError("unavailable", "Knowledge engine Wiki is unavailable; retry when the engine is healthy");
    }
    return object(result);
  }
  private scope(row: Row): Scope {
    return { projectId: optional(row.project_id), environment: optional(row.environment), productVersion: optional(row.product_version), topicId: optional(row.topic_id), solution: optional(row.solution), module: optional(row.module) };
  }
  private global(scope: Scope): boolean { return !scope.projectId && !scope.environment; }
  private inContext(scope: Scope, context: Pick<Scope, "projectId" | "environment">): boolean {
    const projectId = optional(context.projectId), environment = optional(context.environment);
    if (!projectId) return this.global(scope) && !environment;
    return this.global(scope) || (scope.environment === environment && scope.projectId === projectId);
  }
  private canRead(actorId: number, projectId?: string): boolean {
    return projectId ? this.store.canRead(actorId, projectId) : true;
  }
  private reviewer(actorId: number, projectId?: string, isAdmin = false): boolean {
    if (!projectId && isAdmin) return true;
    const row = projectId
      ? this.store.db.prepare("SELECT can_review FROM knowledge_acl WHERE user_id=? AND project_id=? AND can_read=1").get(actorId, projectId)
      : this.store.db.prepare("SELECT can_review FROM knowledge_acl WHERE user_id=? AND can_read=1 AND can_review=1 LIMIT 1").get(actorId);
    return Number((row as Row | undefined)?.can_review) === 1;
  }
  private assertReviewer(actorId: number, projectId?: string, isAdmin = false): void {
    if (!this.canRead(actorId, projectId)) throw new Error("Knowledge access denied");
    if (!this.reviewer(actorId, projectId, isAdmin)) throw new Error("Wiki changes require reviewer permission");
  }
  private load(input: PageInput, write = false): Row {
    const row = this.store.db.prepare("SELECT * FROM knowledge_wiki_pages WHERE id=?").get(input.id) as Row | undefined;
    if (!row || !String(row.id).startsWith(this.prefix)) throw new Error("Engine Wiki page not found; local pages require explicit migration");
    const scope = this.scope(row);
    const strictScope = input.isAdmin !== undefined;
    const context = strictScope ? input : { projectId: input.projectId ?? scope.projectId, environment: input.environment ?? scope.environment };
    if (!this.canRead(input.actorId, scope.projectId) || !this.inContext(scope, context) ||
        (input.projectId && !this.canRead(input.actorId, input.projectId))) throw new Error("Knowledge access denied");
    if (write) this.assertReviewer(input.actorId, scope.projectId, input.isAdmin);
    else if (!this.reviewer(input.actorId, scope.projectId, input.isAdmin) && row.status !== "published") throw new Error("Wiki page is not published");
    return row;
  }
  private slug(row: Row): string { return optional(row.external_slug) ?? "relay-" + String(row.id).slice(this.prefix.length); }
  private engineRows(): Row[] {
    return this.store.db.prepare("SELECT rowid AS __wiki_rowid,* FROM knowledge_wiki_pages WHERE id LIKE ?").all(this.prefix + "%") as Row[];
  }

  private duplicateOf(row: Row): string | undefined {
    const canonical = canonicalWikiRow(this.engineRows(), row);
    return String(canonical.id) === String(row.id) ? undefined : String(canonical.id);
  }

  private sourceRows(refs: string[], external = false): Source[] {
    return [...new Set(refs)].map(ref => {
      const identity = external ? ref.split("|", 1)[0] : ref;
      const row = this.store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE " + (external ? "external_document_id" : "id") + "=?").get(identity) as Row | undefined;
      if (!row || row.status !== "published" || !optional(row.upstream_verified_at) ||
          row.external_knowledge_base_id !== this.options.knowledgeBaseId ||
          (row.project_id != null && !optional(row.project_id)) || (row.environment != null && !optional(row.environment)) ||
          (!optional(row.project_id) && Boolean(optional(row.environment)))) {
        throw new WikiSourceError("Wiki source citation is unknown, unpublished or outside the authorized scope");
      }
      return { row, chunks: storedStrings(row.external_chunk_ids_json) };
    });
  }
  private sources(refs: string[], scope: Scope, external = false): Source[] {
    return this.sourceRows(refs, external).map(source => {
      const sourceScope = this.scope(source.row);
      if ((!this.global(sourceScope) && (sourceScope.projectId !== scope.projectId || sourceScope.environment !== scope.environment)) ||
          (["productVersion", "topicId", "solution", "module"] as const).some(key => scope[key] && sourceScope[key] !== scope[key])) {
        throw new WikiSourceError("Wiki source citation is outside the authorized scope");
      }
      return source;
    });
  }
  private hydrate(row: Row, remote: Row, actorId: number, isAdmin = false): EngineWikiPage {
    const current = this.store.db.prepare("SELECT * FROM knowledge_wiki_pages WHERE id=?").get(row.id) as Row | undefined;
    if (current) {
      if (optional(current.project_id) !== optional(row.project_id) || optional(current.environment) !== optional(row.environment)) throw new Error("Knowledge access denied");
      row = current;
    }
    if (!this.canRead(actorId, optional(row.project_id))) throw new Error("Knowledge access denied");
    if (!this.reviewer(actorId, optional(row.project_id), isAdmin) && row.status !== "published") throw new Error("Wiki page is not published");
    if (remote.slug !== this.slug(row) || (remote.knowledge_base_id !== undefined && remote.knowledge_base_id !== this.options.knowledgeBaseId) ||
        typeof remote.title !== "string" || typeof remote.content !== "string") throw new EngineWikiError("invalid_response", "Knowledge engine returned a mismatched Wiki page");
    const currentRevision = version(remote.version);
    const scope = this.scope(row);
    const sources = [...this.sources(storedStrings(row.source_refs_json), scope), ...this.sources(strings(remote.source_refs), scope, true)];
    const byId = new Map(sources.map(source => [String(source.row.id), source]));
    const knownChunks = new Set([...byId.values()].flatMap(source => source.chunks));
    const citedChunks = new Set(strings(remote.chunk_refs));
    if ([...citedChunks].some(chunk => !knownChunks.has(chunk))) throw new WikiSourceError("Wiki chunk citation is unknown or outside the authorized source documents");
    if (row.status === "published" && Number(row.current_revision) !== currentRevision && !this.reviewer(actorId, scope.projectId, isAdmin)) throw new Error("Wiki revision has changed and requires review");
    const status = row.status === "published" && Number(row.current_revision) !== currentRevision ? "draft" : row.status as WikiPageStatus;
    safeContent({ title: remote.title, body: remote.content });
    return {
      id: String(row.id), pageKey: String(row.page_key), title: remote.title, body: remote.content, status,
      ...scope, sourceRefs: [...byId.keys()], currentRevision, createdBy: Number(row.created_by),
      createdAt: String(row.created_at), updatedAt: optional(remote.updated_at) ?? String(row.updated_at),
      publishedAt: status === "published" ? optional(row.published_at) : undefined,
      deprecatedAt: optional(row.deprecated_at),
      citations: [...byId.values()].map(({ row: source, chunks }) => ({
        documentId: String(source.id), title: String(source.title), sourceLocator: optional(source.source_path),
        sourceSha256: optional(source.raw_sha256) ?? optional(source.normalized_content_sha256),
        productVersion: optional(source.product_version), topicId: optional(source.topic_id), chunkIds: chunks.filter(chunk => citedChunks.has(chunk)),
      })),
      ...(this.duplicateOf(row) ? { duplicateOf: this.duplicateOf(row) } : {}),
    };
  }
  private readRemote(row: Row): Promise<Row> { return this.request("GET", "/pages/" + encodeURIComponent(this.slug(row))); }
  private audit(actorId: number, row: Row, action: string, changeReason: string, revision: number, extra: Row = {}): void {
    this.store.audit({ actorId, projectId: optional(row.project_id), action, entityType: "wiki_page", entityId: String(row.id), details: { reason: changeReason, revision, ...extra } });
  }
  async get(input: PageInput): Promise<EngineWikiPage> {
    const row = this.load(input), remote = await this.readRemote(row);
    this.load(input); // Recheck the caller's project context after awaiting the engine.
    return this.hydrate(row, remote, input.actorId, input.isAdmin);
  }
  async getByKey(input: { actorId: number; isAdmin?: boolean; pageKey: string; projectId?: string; environment?: string }): Promise<EngineWikiPage> {
    const row = this.store.db.prepare("SELECT id FROM knowledge_wiki_pages WHERE page_key=?").get(input.pageKey) as Row | undefined;
    if (!row) throw new Error("Wiki page not found");
    return this.get({ ...input, id: String(row.id) });
  }
  async create(input: Scope & { actorId: number; isAdmin?: boolean; pageKey: string; title: string; body: string; sourceRefs?: string[]; reason: string }): Promise<EngineWikiPage> {
    this.assertReviewer(input.actorId, input.projectId, input.isAdmin);
    const changeReason = reason(input.reason), pageKey = input.pageKey?.trim(), title = input.title?.trim();
    if (!pageKey || pageKey.length > 300 || !title || title.length > 500 || !input.body?.trim()) throw new Error("Wiki page key, title and body are required");
    safeContent({ title, body: input.body });
    const existing = this.store.db.prepare("SELECT id FROM knowledge_wiki_pages WHERE page_key=?").get(pageKey) as Row | undefined;
    if (existing) return this.get({ actorId: input.actorId, isAdmin: input.isAdmin, id: String(existing.id), projectId: input.projectId, environment: input.environment });
    const refs = [...new Set(input.sourceRefs ?? [])];
    if (refs.length > 100) throw new Error("Too many Wiki source citations");
    const sourceRows = this.sources(refs, input);
    const id = this.prefix + randomUUID(), now = this.clock().toISOString();
    const row: Row = { id, page_key: pageKey, title, body: "", status: "draft", project_id: input.projectId ?? null, environment: input.environment ?? null,
      product_version: input.productVersion ?? null, topic_id: input.topicId ?? null, solution: input.solution ?? null, module: input.module ?? null,
      source_refs_json: JSON.stringify(refs), current_revision: 1, created_by: input.actorId, created_at: now, updated_at: now };
    row.external_slug = this.slug(row);
    const existingTopics = this.engineRows().filter(candidate => canonicalWikiRow([candidate, row], candidate).id === candidate.id);
    const canonical = existingTopics.length ? canonicalWikiRow(existingTopics, row) : row;
    if (String(canonical.id) !== id) return this.get({ actorId: input.actorId, isAdmin: input.isAdmin, id: String(canonical.id), projectId: input.projectId, environment: input.environment });
    const remote = await this.request("POST", "/pages", { slug: this.slug(row), title, content: input.body, page_type: "concept",
      source_refs: sourceRows.map(({ row: source }) => String(source.external_document_id) + "|" + String(source.title)),
      chunk_refs: [...new Set(sourceRows.flatMap(source => source.chunks))] });
    const page = this.hydrate(row, remote, input.actorId, input.isAdmin);
    this.store.db.transaction(() => {
      this.store.db.prepare("INSERT INTO knowledge_wiki_pages(id,page_key,title,body,status,project_id,environment,product_version,topic_id,solution,module,source_refs_json,current_revision,created_by,created_at,updated_at,external_slug) VALUES (?,?,?,'','draft',?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, pageKey, page.title, input.projectId ?? null, input.environment ?? null, input.productVersion ?? null, input.topicId ?? null, input.solution ?? null, input.module ?? null, JSON.stringify(page.sourceRefs), page.currentRevision, input.actorId, now, now, row.external_slug);
      this.audit(input.actorId, row, "wiki.create", changeReason, page.currentRevision);
    })();
    return page;
  }

  /** Adopt a synthesized page only after all sources prove its Relay review scope. */
  async adopt(input: Scope & { actorId: number; isAdmin?: boolean; slug: string; reason: string }): Promise<EngineWikiPage> {
    return this.adoptFromEngine(input, false);
  }
  private async adoptFromEngine(input: Scope & { actorId: number; isAdmin?: boolean; slug: string; reason: string }, fromList: boolean): Promise<EngineWikiPage> {
    this.assertReviewer(input.actorId, input.projectId, input.isAdmin);
    const changeReason = reason(input.reason), slug = input.slug?.trim();
    if (!slug || slug.length > 255 || /[\r\n]/.test(slug)) throw new Error("A valid upstream Wiki slug is required");
    const existing = this.store.db.prepare("SELECT id FROM knowledge_wiki_pages WHERE external_slug=? AND id LIKE ?").get(slug, this.prefix + "%") as Row | undefined;
    if (existing) return this.get({ actorId: input.actorId, isAdmin: input.isAdmin, id: String(existing.id), projectId: input.projectId, environment: input.environment });
    const remote = await this.request("GET", "/pages/" + encodeURIComponent(slug));
    const refs = strings(remote.source_refs);
    if (!refs.length || refs.length > 100) throw new WikiSourceError("Generated Wiki requires bounded, verified source citations");
    this.assertReviewer(input.actorId, input.projectId, input.isAdmin);
    const sources = this.sourceRows(refs, true);
    const scoped = sources.map(source => this.scope(source.row)).filter(scope => !this.global(scope));
    const scopes = new Map(scoped.map(scope => [JSON.stringify([scope.projectId ?? null, scope.environment ?? null]), scope]));
    if (scopes.size > 1) throw new WikiSourceError("Generated Wiki source citations span multiple project or environment scopes");
    const sourceScope = [...scopes.values()][0] ?? {};
    if ((!this.global(sourceScope) && ((input.projectId && sourceScope.projectId !== input.projectId) ||
          (input.environment && sourceScope.environment !== input.environment))) ||
        (fromList && !this.inContext(sourceScope, input)) || !this.reviewer(input.actorId, sourceScope.projectId, input.isAdmin)) {
      throw new WikiSourceError("Generated Wiki source citations are outside the authorized review scope");
    }
    const common = (column: string): string | undefined => {
      const values = [...new Set(sources.map(source => optional(source.row[column])))];
      return values.length === 1 ? values[0] : undefined;
    };
    const binding: Scope = { projectId: sourceScope.projectId, environment: sourceScope.environment,
      productVersion: input.productVersion ?? common("product_version"), topicId: input.topicId ?? common("topic_id"),
      solution: input.solution ?? common("solution"), module: input.module ?? common("module") };
    this.sources(refs, binding, true);
    const id = this.prefix + createHash("sha256").update(slug).digest("hex"), now = this.clock().toISOString();
    const row: Row = { id, page_key: this.prefix + slug, external_slug: slug, body: "", status: "draft",
      project_id: binding.projectId ?? null, environment: binding.environment ?? null, product_version: binding.productVersion ?? null,
      topic_id: binding.topicId ?? null, solution: binding.solution ?? null, module: binding.module ?? null,
      source_refs_json: JSON.stringify([...new Set(sources.map(source => String(source.row.id)))]),
      current_revision: remote.version, created_by: input.actorId, created_at: now, updated_at: now };
    const existingTopics = this.engineRows().filter(candidate => canonicalWikiRow([candidate, row], candidate).id === candidate.id);
    const canonical = existingTopics.length ? canonicalWikiRow(existingTopics, row) : row;
    const duplicateOf = String(canonical.id) === id ? undefined : String(canonical.id);
    const page = this.hydrate(row, remote, input.actorId, input.isAdmin);
    this.store.db.transaction(() => {
      const present = this.store.db.prepare("SELECT id FROM knowledge_wiki_pages WHERE id=?").get(id);
      if (present) return;
      this.store.db.prepare("INSERT INTO knowledge_wiki_pages(id,page_key,title,body,status,project_id,environment,product_version,topic_id,solution,module,source_refs_json,current_revision,created_by,created_at,updated_at,external_slug) VALUES (?,?,?,'','draft',?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, row.page_key, page.title, row.project_id, row.environment, row.product_version, row.topic_id, row.solution, row.module,
          JSON.stringify(page.sourceRefs), page.currentRevision, input.actorId, now, now, slug);
      this.audit(input.actorId, row, duplicateOf ? "wiki.discover_duplicate" : "wiki.discover", changeReason, page.currentRevision,
        duplicateOf ? { canonicalId: duplicateOf } : {});
      if (duplicateOf) {
        const existing = this.store.db.prepare("SELECT source_refs_json FROM knowledge_wiki_pages WHERE id=?").get(duplicateOf) as Row | undefined;
        if (existing) {
          const refs = [...new Set([...storedStrings(existing.source_refs_json), ...page.sourceRefs])];
          this.store.db.prepare("UPDATE knowledge_wiki_pages SET source_refs_json=?,updated_at=? WHERE id=?").run(JSON.stringify(refs), now, duplicateOf);
        }
      }
    })();
    if (!duplicateOf) return page;
    const canonicalRow = this.store.db.prepare("SELECT * FROM knowledge_wiki_pages WHERE id=?").get(duplicateOf) as Row | undefined;
    if (!canonicalRow) throw new Error("Canonical Wiki page disappeared during adoption");
    return this.hydrate(canonicalRow, await this.readRemote(canonicalRow), input.actorId, input.isAdmin);
  }

  async edit(input: ChangeInput & { title?: string; body?: string }): Promise<EngineWikiPage> {
    const row = this.load(input, true), changeReason = reason(input.reason);
    const remote = await this.readRemote(row);
    const page = this.hydrate(row, remote, input.actorId, input.isAdmin);
    const title = input.title?.trim() ?? page.title, body = input.body ?? page.body;
    if (!title || title.length > 500 || !body.trim()) throw new Error("Wiki title and body are required");
    safeContent({ title, body });
    this.assertMutationSnapshot(input, row, page);
    if (title === page.title && body === page.body) return this.store.db.transaction(() => { this.assertMutationSnapshot(input, row, page); return page; }).immediate();
    const updated = await this.request("PUT", "/pages/" + encodeURIComponent(this.slug(row)), { title, content: body, version: page.currentRevision });
    const changed = this.hydrate({ ...row, status: "draft" }, updated, input.actorId, input.isAdmin);
    this.recordChange(input, row, changed, "wiki.edit", changeReason);
    return changed;
  }
  /** Recheck the local review snapshot while holding the writer lock at commit.
   * Upstream requests stay outside SQLite transactions; a conflict leaves their
   * new revision unreviewed rather than overwriting a newer local decision.
   */
  private assertMutationSnapshot(input: ChangeInput, expected: Row, page: EngineWikiPage): Row {
    const current = this.load(input, true);
    if (current.status === "deprecated" && expected.status !== "deprecated") throw new EngineWikiError("conflict", "Wiki was deprecated concurrently; reload and retry");
    for (const key of ["status", "current_revision", "source_refs_json", "project_id", "environment", "product_version", "topic_id", "solution", "module", "external_slug", "updated_at"] as const) {
      if ((current[key] ?? null) !== (expected[key] ?? null)) throw new EngineWikiError("conflict", "Wiki review state changed concurrently; reload and retry");
    }
    this.sources(page.sourceRefs, this.scope(current));
    return current;
  }
  private recordChange(input: ChangeInput, row: Row, page: EngineWikiPage, action: string, changeReason: string, extra: Row = {}): void {
    this.store.db.transaction(() => {
      const current = this.assertMutationSnapshot(input, row, page);
      if (current.status === "deprecated") throw new Error("A deprecated Wiki page cannot be changed");
      const result = this.store.db.prepare("UPDATE knowledge_wiki_pages SET title=?,body='',status='draft',current_revision=?,source_refs_json=?,updated_at=?,published_at=NULL WHERE id=? AND status=? AND current_revision=? AND source_refs_json=?")
        .run(page.title, page.currentRevision, JSON.stringify(page.sourceRefs), this.clock().toISOString(), page.id, current.status, current.current_revision, current.source_refs_json);
      if (!result.changes) throw new EngineWikiError("conflict", "Wiki review state changed concurrently; reload and retry");
      this.audit(input.actorId, row, action, changeReason, page.currentRevision, extra);
    }).immediate();
  }
  async publish(input: ChangeInput): Promise<EngineWikiPage> { return this.changeStatus(input, "published"); }
  async deprecate(input: ChangeInput): Promise<EngineWikiPage> { return this.changeStatus(input, "deprecated"); }
  private async changeStatus(input: ChangeInput, status: "published" | "deprecated"): Promise<EngineWikiPage> {
    const row = this.load(input, true), changeReason = reason(input.reason);
    if (status === "published" && this.duplicateOf(row)) throw new Error(`Duplicate Wiki page cannot be published; canonical page is ${this.duplicateOf(row)}`);
    const page = this.hydrate(row, await this.readRemote(row), input.actorId, input.isAdmin);
    if (page.status === "deprecated" && status === "published") throw new Error("A deprecated Wiki page cannot be published");
    if (status === "published" && !page.sourceRefs.length) throw new Error("Wiki publication requires at least one verified source citation");
    const now = this.clock().toISOString();
    return this.store.db.transaction(() => {
      const current = this.assertMutationSnapshot(input, row, page);
      if (current.status === "deprecated" && status !== "deprecated") throw new Error("A deprecated Wiki page cannot be published");
      if (page.status === status) return page;
      const result = this.store.db.prepare("UPDATE knowledge_wiki_pages SET status=?,title=?,current_revision=?,source_refs_json=?,updated_at=?,published_at=?,deprecated_at=? WHERE id=? AND status=? AND current_revision=? AND source_refs_json=?")
        .run(status, page.title, page.currentRevision, JSON.stringify(page.sourceRefs), now, status === "published" ? now : current.published_at ?? null, status === "deprecated" ? now : null, page.id, current.status, current.current_revision, current.source_refs_json);
      if (!result.changes) throw new EngineWikiError("conflict", "Wiki review state changed concurrently; reload and retry");
      this.audit(input.actorId, row, status === "published" ? "wiki.publish" : "wiki.deprecate", changeReason, page.currentRevision);
      return { ...page, status, publishedAt: status === "published" ? now : page.publishedAt, deprecatedAt: status === "deprecated" ? now : undefined };
    }).immediate();
  }
  private publishedVersions(row: Row): Set<number> {
    const audits = this.store.db.prepare("SELECT details_json FROM knowledge_audit WHERE entity_id=? AND action='wiki.publish'").all(row.id) as Row[];
    return new Set(audits.flatMap(audit => { try { const rev = JSON.parse(String(audit.details_json)).revision; return Number.isSafeInteger(rev) ? [rev] : []; } catch { return []; } }));
  }
  private async revision(row: Row, revision: number, actorId: number, current: Row, isAdmin = false): Promise<WikiPageRevision> {
    version(revision);
    if (!this.reviewer(actorId, optional(row.project_id), isAdmin) && !this.publishedVersions(row).has(revision)) throw new Error("Wiki revision has not been reviewed");
    // v0.8.3 stores only superseded snapshots. The current body belongs to the page.
    const remote = revision === version(current.version) ? current : await this.request("GET", "/revisions/" + encodeURIComponent(this.slug(row)) + "?version=" + revision);
    if (remote.slug !== this.slug(row) || version(remote.version) !== revision || typeof remote.content !== "string" || typeof remote.title !== "string") throw new EngineWikiError("invalid_response", "Knowledge engine returned a mismatched Wiki revision");
    safeContent({ title: remote.title, body: remote.content });
    const audits = this.store.db.prepare("SELECT actor_id,details_json FROM knowledge_audit WHERE entity_id=? AND action IN ('wiki.create','wiki.edit','wiki.rollback') ORDER BY occurred_at DESC").all(row.id) as Row[];
    const audit = audits.map(value => { try { return { actor: Number(value.actor_id), details: JSON.parse(String(value.details_json)) as Row }; } catch { return undefined; } }).find(value => value?.details.revision === revision);
    return { id: String(row.id) + ":r" + revision, pageId: String(row.id), revision, title: remote.title, body: remote.content,
      changeReason: optional(audit?.details.reason) ?? "Upstream revision", authorId: audit?.actor ?? 0, createdAt: optional(remote.edited_at) ?? optional(remote.updated_at) ?? optional(remote.created_at) ?? "" };
  }
  async listRevisions(input: PageInput & { limit?: number; offset?: number }): Promise<WikiPageRevision[]> {
    const row = this.load(input);
    const current = await this.readRemote(row);
    const page = this.hydrate(row, current, input.actorId, input.isAdmin);
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50))), offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const revisions: WikiPageRevision[] = [];
    const allowed = this.reviewer(input.actorId, optional(row.project_id), input.isAdmin) ? undefined : this.publishedVersions(row);
    const visible = !allowed || allowed.has(page.currentRevision) ? [page.currentRevision] : [];
    const seen = new Set([page.currentRevision]);
    let historyOffset = 0, previous = page.currentRevision;
    // Filter reviewed versions before slicing, so hidden drafts do not create
    // empty pages. Fetch metadata in bounded pages; only fetch selected bodies.
    while (visible.length < offset + limit) {
      if (historyOffset >= 20_000) throw new EngineWikiError("unavailable", "Wiki history exceeds the safe pagination limit");
      const result = await this.request("GET", "/revisions/" + encodeURIComponent(this.slug(row)) + "?limit=200&offset=" + historyOffset);
      if (!Array.isArray(result.revisions) || !Number.isSafeInteger(result.total) || Number(result.total) < 0) throw new EngineWikiError("invalid_response", "Knowledge engine returned invalid Wiki history");
      if (version(result.current_version) !== page.currentRevision) throw new EngineWikiError("conflict", "Wiki changed while reading history; reload and retry");
      for (const raw of result.revisions) {
        const rev = version(object(raw).version);
        if (seen.has(rev) || rev >= previous) throw new EngineWikiError("invalid_response", "Knowledge engine returned inconsistent Wiki history");
        seen.add(rev); previous = rev;
        if (!allowed || allowed.has(rev)) visible.push(rev);
      }
      historyOffset += result.revisions.length;
      if (historyOffset >= Number(result.total)) break;
      if (!result.revisions.length) throw new EngineWikiError("invalid_response", "Wiki history ended before its reported total");
    }
    for (const rev of visible.slice(offset, offset + limit)) revisions.push(await this.revision(row, rev, input.actorId, current, input.isAdmin));
    this.load(input);
    this.hydrate(row, current, input.actorId, input.isAdmin);
    return revisions;
  }
  async diffRevisions(input: PageInput & { fromRevision: number; toRevision: number }): Promise<string> {
    const row = this.load(input);
    const current = await this.readRemote(row);
    this.hydrate(row, current, input.actorId, input.isAdmin);
    const from = await this.revision(row, input.fromRevision, input.actorId, current, input.isAdmin), to = await this.revision(row, input.toRevision, input.actorId, current, input.isAdmin);
    this.load(input);
    return createTwoFilesPatch(String(row.page_key) + "@r" + from.revision, String(row.page_key) + "@r" + to.revision, from.body, to.body, "", "");
  }
  async rollback(input: ChangeInput & { revision: number }): Promise<EngineWikiPage> {
    const row = this.load(input, true), changeReason = reason(input.reason);
    if (row.status === "deprecated") throw new Error("A deprecated Wiki page cannot be rolled back");
    const current = await this.readRemote(row);
    const page = this.hydrate(row, current, input.actorId, input.isAdmin);
    version(input.revision);
    this.assertMutationSnapshot(input, row, page);
    if (input.revision === page.currentRevision) return this.store.db.transaction(() => { this.assertMutationSnapshot(input, row, page); return page; }).immediate();
    await this.revision(row, input.revision, input.actorId, current, input.isAdmin);
    const remote = await this.request("POST", "/revert", { slug: this.slug(row), version: input.revision });
    const changed = this.hydrate({ ...row, status: "draft" }, remote, input.actorId, input.isAdmin);
    this.recordChange(input, row, changed, "wiki.rollback", changeReason, { rolledBackTo: input.revision });
    return changed;
  }
  async list(input: WikiPageListQuery & { environment?: string }): Promise<{ items: EngineWikiPageSummary[]; total: number; limit: number; offset: number }> {
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50))), offset = Math.max(0, Math.min(1_000_000, Math.trunc(input.offset ?? 0)));
    const candidates = this.store.db.prepare("SELECT rowid AS __wiki_rowid,* FROM knowledge_wiki_pages WHERE id LIKE ?").all(this.prefix + "%") as Row[];
    const knownSlugs = new Set(candidates.map(row => this.slug(row)));
    const bySlug = new Map(candidates.filter(row => {
      const scope = this.scope(row);
      return isCanonicalWikiRow(candidates, row) && this.canRead(input.actorId, scope.projectId) && this.inContext(scope, input) &&
        (!input.status || row.status === input.status) && (this.reviewer(input.actorId, scope.projectId, input.isAdmin) || row.status === "published") &&
        (["productVersion", "topicId", "solution", "module"] as const).every(key => !input[key] || scope[key] === input[key]);
    }).map(row => [this.slug(row), row]));
    const items: EngineWikiPageSummary[] = [];
    let total = 0;
    const seenCanonical = new Set<string>();
    const maxPages = Math.max(1, Math.min(1000, this.options.maxListPages ?? 100));
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams({ page: String(page), page_size: "100", sort_by: "updated_at", sort_order: "desc" });
      if (input.search?.trim()) params.set("query", input.search.trim());
      const result = await this.request("GET", "/pages?" + params);
      if (!this.canRead(input.actorId, input.projectId)) throw new Error("Knowledge access denied");
      if (!Array.isArray(result.pages) || !Number.isSafeInteger(result.total_pages) || Number(result.total_pages) < 0) throw new EngineWikiError("invalid_response", "Knowledge engine returned invalid Wiki pagination");
      for (const value of result.pages) {
        const remote = object(value);
        let row = bySlug.get(String(remote.slug));
        if (!row && !knownSlugs.has(String(remote.slug)) && this.reviewer(input.actorId, input.projectId, input.isAdmin)) {
          try {
            const discovered = await this.adoptFromEngine({ actorId: input.actorId, isAdmin: input.isAdmin, slug: String(remote.slug), projectId: input.projectId, environment: input.environment,
              productVersion: input.productVersion, topicId: input.topicId, solution: input.solution, module: input.module, reason: "Discovered source-verified engine Wiki draft" }, true);
            row = this.load({ actorId: input.actorId, isAdmin: input.isAdmin, id: discovered.id, projectId: input.projectId, environment: input.environment });
            bySlug.set(String(remote.slug), row); knownSlugs.add(String(remote.slug));
          } catch (error) { if (error instanceof WikiSourceError) continue; throw error; }
        }
        if (!row) continue;
        if (!this.canRead(input.actorId, input.projectId)) throw new Error("Knowledge access denied");
        if (seenCanonical.has(String(row.id))) continue;
        const hydrated = this.hydrate(row, this.slug(row) === String(remote.slug) ? remote : await this.readRemote(row), input.actorId, input.isAdmin);
        if (input.status && hydrated.status !== input.status) continue;
        seenCanonical.add(String(row.id));
        const { body: _body, ...summary } = hydrated;
        if (total >= offset && items.length < limit) items.push(summary);
        total++;
      }
      if (page >= Number(result.total_pages)) return { items, total, limit, offset };
    }
    throw new EngineWikiError("unavailable", "Wiki result set exceeds the safe pagination limit; narrow the search");
  }
}
