import { randomUUID } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { assertReviewer } from "./domain.js";
import { scanCandidateContent } from "./candidate-insight.js";
import type { KnowledgeStore } from "./store.js";

export const WIKI_PAGE_STATUSES = ["draft", "published", "deprecated"] as const;
export type WikiPageStatus = (typeof WIKI_PAGE_STATUSES)[number];

/**
 * Stable DTO returned to HTTP/MCP adapters. It intentionally carries no
 * provider internals: no WeKnora token, knowledge-base id or raw provider
 * payload ever leaves this service.
 */
export interface WikiPage {
  id: string;
  pageKey: string;
  title: string;
  body: string;
  status: WikiPageStatus;
  projectId?: string;
  productVersion?: string;
  topicId?: string;
  solution?: string;
  module?: string;
  sourceRefs: string[];
  currentRevision: number;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  deprecatedAt?: string;
}

export type WikiPageSummary = Omit<WikiPage, "body">;

export interface WikiPageRevision {
  id: string;
  pageId: string;
  revision: number;
  title: string;
  body: string;
  changeReason: string;
  authorId: number;
  createdAt: string;
}

export interface WikiPageListQuery {
  actorId: number;
  projectId?: string;
  status?: WikiPageStatus;
  productVersion?: string;
  topicId?: string;
  solution?: string;
  module?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface WikiPageListResult {
  items: WikiPageSummary[];
  total: number;
  limit: number;
  offset: number;
}

function pageFromRow(row: Record<string, unknown>): WikiPage {
  return {
    id: String(row.id),
    pageKey: String(row.page_key),
    title: String(row.title),
    body: String(row.body),
    status: String(row.status) as WikiPageStatus,
    projectId: row.project_id ? String(row.project_id) : undefined,
    productVersion: row.product_version ? String(row.product_version) : undefined,
    topicId: row.topic_id ? String(row.topic_id) : undefined,
    solution: row.solution ? String(row.solution) : undefined,
    module: row.module ? String(row.module) : undefined,
    sourceRefs: JSON.parse(String(row.source_refs_json)) as string[],
    currentRevision: Number(row.current_revision),
    createdBy: Number(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    publishedAt: row.published_at ? String(row.published_at) : undefined,
    deprecatedAt: row.deprecated_at ? String(row.deprecated_at) : undefined,
  };
}

function revisionFromRow(row: Record<string, unknown>): WikiPageRevision {
  return {
    id: String(row.id),
    pageId: String(row.page_id),
    revision: Number(row.revision),
    title: String(row.title),
    body: String(row.body),
    changeReason: String(row.change_reason),
    authorId: Number(row.author_id),
    createdAt: String(row.created_at),
  };
}

function summaryFromRow(row: Record<string, unknown>): WikiPageSummary {
  const { body: _body, ...summary } = pageFromRow(row);
  return summary;
}

function requireReason(reason: string): string {
  const trimmed = String(reason ?? "").trim();
  if (!trimmed) throw new Error("A change reason is required");
  return trimmed.slice(0, 2_000);
}

function optionalText(value: string | undefined, max: number): string | undefined {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Relay-native Wiki core service (#54). Pages have a stable page_key identity
 * and an append-only revision history: edits, publishes, deprecations and
 * rollbacks are ACL-checked, transactional and audited. Rollback always
 * appends a new revision; history is never deleted.
 */
export class WikiService {
  constructor(private readonly store: KnowledgeStore, private readonly clock: () => Date = () => new Date()) {}

  private loadRow(id: string): Record<string, unknown> {
    const row = this.store.db.prepare("SELECT * FROM knowledge_wiki_pages WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Wiki page not found");
    return row;
  }

  /** Mirrors KnowledgeStore.canRead; global pages require any readable project. */
  private canReadPage(actorId: number, projectId: string | undefined): boolean {
    if (projectId) return this.store.canRead(actorId, projectId);
    return !!this.store.db.prepare("SELECT 1 FROM knowledge_acl WHERE user_id = ? AND can_read = 1 LIMIT 1").get(actorId);
  }

  private assertReader(actorId: number, projectId: string | undefined): void {
    if (!this.canReadPage(actorId, projectId)) throw new Error("Knowledge access denied");
  }

  private assertPageReviewer(actorId: number, projectId: string | undefined): void {
    this.assertReader(actorId, projectId);
    const acl = projectId
      ? this.store.db.prepare("SELECT can_review FROM knowledge_acl WHERE project_id = ? AND user_id = ?").get(projectId, actorId) as { can_review?: number } | undefined
      : this.store.db.prepare("SELECT can_review FROM knowledge_acl WHERE user_id = ? AND can_review = 1 LIMIT 1").get(actorId) as { can_review?: number } | undefined;
    assertReviewer(acl?.can_review === 1);
  }

  private assertNoSecrets(content: Record<string, unknown>): void {
    const disallowed = scanCandidateContent(content);
    if (disallowed) throw new Error(`Wiki content contains ${disallowed}`);
  }

  /** Server-side pagination, filtering and title/body LIKE search with ACL. */
  list(input: WikiPageListQuery): WikiPageListResult {
    if (input.projectId) this.assertReader(input.actorId, input.projectId);
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const where: string[] = [
      "((p.project_id IS NULL AND EXISTS(SELECT 1 FROM knowledge_acl a WHERE a.user_id = @actorId AND a.can_read = 1))",
      " OR EXISTS(SELECT 1 FROM knowledge_acl a WHERE a.project_id = p.project_id AND a.user_id = @actorId AND a.can_read = 1))",
    ];
    const params: Record<string, unknown> = { actorId: input.actorId, limit, offset };
    if (input.projectId) { where.push("AND (p.project_id = @projectId OR p.project_id IS NULL)"); params.projectId = input.projectId; }
    if (input.status) { where.push("AND p.status = @status"); params.status = input.status; }
    if (input.productVersion) { where.push("AND p.product_version = @productVersion"); params.productVersion = input.productVersion; }
    if (input.topicId) { where.push("AND p.topic_id = @topicId"); params.topicId = input.topicId; }
    if (input.solution) { where.push("AND p.solution = @solution"); params.solution = input.solution; }
    if (input.module) { where.push("AND p.module = @module"); params.module = input.module; }
    if (input.search?.trim()) { where.push("AND (p.title LIKE @search ESCAPE '\\' OR p.body LIKE @search ESCAPE '\\')"); params.search = likePattern(input.search.trim()); }
    const predicate = where.join("\n");
    const total = (this.store.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_wiki_pages p WHERE ${predicate}`).get(params) as { count: number }).count;
    const rows = this.store.db.prepare(`SELECT p.* FROM knowledge_wiki_pages p WHERE ${predicate} ORDER BY p.updated_at DESC, p.id LIMIT @limit OFFSET @offset`).all(params) as Array<Record<string, unknown>>;
    return { items: rows.map(summaryFromRow), total, limit, offset };
  }

  get(input: { actorId: number; id: string }): WikiPage {
    const row = this.loadRow(input.id);
    this.assertReader(input.actorId, row.project_id ? String(row.project_id) : undefined);
    return pageFromRow(row);
  }

  getByKey(input: { actorId: number; pageKey: string }): WikiPage {
    const row = this.store.db.prepare("SELECT * FROM knowledge_wiki_pages WHERE page_key = ?").get(input.pageKey) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Wiki page not found");
    this.assertReader(input.actorId, row.project_id ? String(row.project_id) : undefined);
    return pageFromRow(row);
  }

  /** Idempotent on page_key: a replay returns the existing page unchanged. */
  create(input: {
    actorId: number;
    pageKey: string;
    title: string;
    body: string;
    projectId?: string;
    productVersion?: string;
    topicId?: string;
    solution?: string;
    module?: string;
    sourceRefs?: string[];
    reason: string;
  }): WikiPage {
    const reason = requireReason(input.reason);
    const pageKey = String(input.pageKey ?? "").trim();
    if (!pageKey || pageKey.length > 300) throw new Error("A page_key of 1-300 characters is required");
    const title = String(input.title ?? "").trim();
    if (!title) throw new Error("A title is required");
    const body = String(input.body ?? "");
    if (!body.trim()) throw new Error("A body is required");
    this.assertNoSecrets({ title, body, sourceRefs: input.sourceRefs ?? [] });

    const existing = this.store.db.prepare("SELECT * FROM knowledge_wiki_pages WHERE page_key = ?").get(pageKey) as Record<string, unknown> | undefined;
    if (existing) {
      this.assertReader(input.actorId, existing.project_id ? String(existing.project_id) : undefined);
      return pageFromRow(existing);
    }

    const projectId = optionalText(input.projectId, 200);
    if (projectId) this.assertReader(input.actorId, projectId);
    const now = this.clock().toISOString();
    const id = randomUUID();
    const sourceRefs = [...new Set((input.sourceRefs ?? []).map((ref) => String(ref).trim()).filter(Boolean))].slice(0, 100);
    this.store.db.transaction(() => {
      this.store.db.prepare(`INSERT INTO knowledge_wiki_pages
        (id,page_key,title,body,status,project_id,product_version,topic_id,solution,module,source_refs_json,current_revision,created_by,created_at,updated_at)
        VALUES (?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?)`).run(
        id, pageKey, title.slice(0, 500), body, projectId ?? null,
        optionalText(input.productVersion, 120) ?? null, optionalText(input.topicId, 200) ?? null,
        optionalText(input.solution, 200) ?? null, optionalText(input.module, 200) ?? null,
        JSON.stringify(sourceRefs), 1, input.actorId, now, now,
      );
      this.store.db.prepare("INSERT INTO knowledge_wiki_page_revisions(id,page_id,revision,title,body,change_reason,author_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(randomUUID(), id, 1, title.slice(0, 500), body, reason, input.actorId, now);
      this.store.audit({ actorId: input.actorId, projectId, action: "wiki.create", entityType: "wiki_page", entityId: id, details: { pageKey, title: title.slice(0, 500), reason, revision: 1, sourceRefCount: sourceRefs.length } });
    })();
    return pageFromRow(this.loadRow(id));
  }

  /** Edit appends a new revision and bumps current_revision. */
  edit(input: { actorId: number; id: string; title?: string; body?: string; reason: string }): WikiPage {
    const reason = requireReason(input.reason);
    const row = this.loadRow(input.id);
    const page = pageFromRow(row);
    this.assertPageReviewer(input.actorId, page.projectId);
    if (page.status === "deprecated") throw new Error("A deprecated Wiki page cannot be edited");
    const title = input.title === undefined ? page.title : String(input.title).trim();
    if (!title) throw new Error("A title is required");
    const body = input.body === undefined ? page.body : String(input.body);
    if (!body.trim()) throw new Error("A body is required");
    if (title === page.title && body === page.body) return page;
    this.assertNoSecrets({ title, body });
    this.appendRevision({ page, actorId: input.actorId, title: title.slice(0, 500), body, reason, action: "edit", auditDetails: { pageKey: page.pageKey } });
    return pageFromRow(this.loadRow(input.id));
  }

  /** Publish a draft. Reviewer-only and idempotent on replay. */
  publish(input: { actorId: number; id: string; reason: string }): WikiPage {
    const reason = requireReason(input.reason);
    const row = this.loadRow(input.id);
    const page = pageFromRow(row);
    this.assertPageReviewer(input.actorId, page.projectId);
    if (page.status === "published") return page;
    if (page.status === "deprecated") throw new Error("A deprecated Wiki page cannot be published");
    const now = this.clock().toISOString();
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE knowledge_wiki_pages SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?").run(now, now, page.id);
      this.store.audit({ actorId: input.actorId, projectId: page.projectId, action: "wiki.publish", entityType: "wiki_page", entityId: page.id, details: { pageKey: page.pageKey, reason, revision: page.currentRevision } });
    })();
    return pageFromRow(this.loadRow(input.id));
  }

  /** Deprecate a page. Reviewer-only and idempotent on replay. */
  deprecate(input: { actorId: number; id: string; reason: string }): WikiPage {
    const reason = requireReason(input.reason);
    const row = this.loadRow(input.id);
    const page = pageFromRow(row);
    this.assertPageReviewer(input.actorId, page.projectId);
    if (page.status === "deprecated") return page;
    const now = this.clock().toISOString();
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE knowledge_wiki_pages SET status = 'deprecated', deprecated_at = ?, updated_at = ? WHERE id = ?").run(now, now, page.id);
      this.store.audit({ actorId: input.actorId, projectId: page.projectId, action: "wiki.deprecate", entityType: "wiki_page", entityId: page.id, details: { pageKey: page.pageKey, reason, previousStatus: page.status } });
    })();
    return pageFromRow(this.loadRow(input.id));
  }

  listRevisions(input: { actorId: number; id: string; limit?: number; offset?: number }): WikiPageRevision[] {
    const row = this.loadRow(input.id);
    this.assertReader(input.actorId, row.project_id ? String(row.project_id) : undefined);
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const rows = this.store.db.prepare("SELECT * FROM knowledge_wiki_page_revisions WHERE page_id = ? ORDER BY revision DESC LIMIT ? OFFSET ?").all(input.id, limit, offset) as Array<Record<string, unknown>>;
    return rows.map(revisionFromRow);
  }

  /** Unified diff between two revisions of the same page. */
  diffRevisions(input: { actorId: number; id: string; fromRevision: number; toRevision: number }): string {
    const row = this.loadRow(input.id);
    const page = pageFromRow(row);
    this.assertReader(input.actorId, page.projectId);
    const load = (revision: number): WikiPageRevision => {
      const revRow = this.store.db.prepare("SELECT * FROM knowledge_wiki_page_revisions WHERE page_id = ? AND revision = ?").get(page.id, revision) as Record<string, unknown> | undefined;
      if (!revRow) throw new Error(`Wiki revision ${revision} not found`);
      return revisionFromRow(revRow);
    };
    const from = load(Math.trunc(input.fromRevision));
    const to = load(Math.trunc(input.toRevision));
    return createTwoFilesPatch(
      `${page.pageKey}@r${from.revision}`, `${page.pageKey}@r${to.revision}`,
      from.body, to.body,
      `revision ${from.revision}`, `revision ${to.revision}`,
    );
  }

  /**
   * Roll back to an earlier revision by appending a new revision with that
   * content. History is never rewritten or deleted.
   */
  rollback(input: { actorId: number; id: string; revision: number; reason: string }): WikiPage {
    const reason = requireReason(input.reason);
    const row = this.loadRow(input.id);
    const page = pageFromRow(row);
    this.assertPageReviewer(input.actorId, page.projectId);
    if (page.status === "deprecated") throw new Error("A deprecated Wiki page cannot be rolled back");
    const target = this.store.db.prepare("SELECT * FROM knowledge_wiki_page_revisions WHERE page_id = ? AND revision = ?").get(page.id, Math.trunc(input.revision)) as Record<string, unknown> | undefined;
    if (!target) throw new Error(`Wiki revision ${input.revision} not found`);
    const targetRevision = revisionFromRow(target);
    if (targetRevision.revision === page.currentRevision) return page;
    this.appendRevision({
      page, actorId: input.actorId, title: targetRevision.title, body: targetRevision.body, reason,
      action: "rollback", auditDetails: { pageKey: page.pageKey, rolledBackTo: targetRevision.revision },
    });
    return pageFromRow(this.loadRow(input.id));
  }

  private appendRevision(input: { page: WikiPage; actorId: number; title: string; body: string; reason: string; action: "edit" | "rollback"; auditDetails: Record<string, unknown> }): void {
    const now = this.clock().toISOString();
    const nextRevision = input.page.currentRevision + 1;
    this.store.db.transaction(() => {
      this.store.db.prepare("INSERT INTO knowledge_wiki_page_revisions(id,page_id,revision,title,body,change_reason,author_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(randomUUID(), input.page.id, nextRevision, input.title, input.body, input.reason, input.actorId, now);
      this.store.db.prepare("UPDATE knowledge_wiki_pages SET title = ?, body = ?, current_revision = ?, updated_at = ? WHERE id = ?")
        .run(input.title, input.body, nextRevision, now, input.page.id);
      // Audit details carry metadata only; page bodies never enter the audit log.
      this.store.audit({ actorId: input.actorId, projectId: input.page.projectId, action: `wiki.${input.action}`, entityType: "wiki_page", entityId: input.page.id, details: { ...input.auditDetails, reason: input.reason, revision: nextRevision } });
    })();
  }
}
