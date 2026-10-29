import { randomUUID } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { assertReviewer } from "./domain.js";
import { scanCandidateContent } from "./candidate-insight.js";
import type { KnowledgeStore } from "./store.js";
import { canonicalWikiRow, isCanonicalWikiRow } from "./wiki-identity.js";

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
  environment?: string;
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
  /** Present for a retained duplicate; normal lists omit duplicate rows. */
  duplicateOf?: string;
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
  isAdmin?: boolean;
  projectId?: string;
  environment?: string;
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

function pageFromRow(row: Record<string, unknown>, duplicateOf?: string): WikiPage {
  const page: WikiPage = {
    id: String(row.id),
    pageKey: String(row.page_key),
    title: String(row.title),
    body: String(row.body),
    status: String(row.status) as WikiPageStatus,
    projectId: row.project_id ? String(row.project_id) : undefined,
    environment: row.environment ? String(row.environment) : undefined,
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
  if (duplicateOf) page.duplicateOf = duplicateOf;
  return page;
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
  private localRows(): Array<Record<string, unknown>> {
    return this.store.db.prepare("SELECT rowid AS __wiki_rowid,* FROM knowledge_wiki_pages WHERE id NOT LIKE 'engine-wiki:%'").all() as Array<Record<string, unknown>>;
  }

  private duplicateOf(row: Record<string, unknown>): string | undefined {
    const canonical = canonicalWikiRow(this.localRows(), row);
    return String(canonical.id) === String(row.id) ? undefined : String(canonical.id);
  }

  private assertCanonical(row: Record<string, unknown>): void {
    const duplicateOf = this.duplicateOf(row);
    if (duplicateOf) throw new Error(`Duplicate Wiki page cannot be published; canonical page is ${duplicateOf}`);
  }


  /** Global pages are public once published; project ACL controls draft reads. */
  private canReadPage(actorId: number, projectId: string | undefined, status: WikiPageStatus = "published", isAdmin = false, environment?: string): boolean {
    if (!projectId && environment) return false;
    if (projectId) {
      const acl = this.store.db.prepare("SELECT can_read FROM knowledge_acl WHERE project_id = ? AND user_id = ?").get(projectId, actorId) as { can_read?: number } | undefined;
      return acl?.can_read === 1;
    }
    if (status === "published") return true;
    if (isAdmin) return true;
    return Boolean(this.store.db.prepare("SELECT 1 FROM knowledge_acl WHERE user_id = ? AND can_read = 1 LIMIT 1").get(actorId));
  }

  private assertReader(actorId: number, projectId: string | undefined, status?: WikiPageStatus, isAdmin = false, environment?: string): void {
    if (!this.canReadPage(actorId, projectId, status, isAdmin, environment)) throw new Error("Knowledge access denied");
  }

  private assertRequestedScope(row: Record<string, unknown>, projectId?: string, environment?: string, strict = true): void {
    const requestedProject = optionalText(projectId, 200);
    const requestedEnvironment = optionalText(environment, 200);
    if (requestedEnvironment && !requestedProject) throw new Error("Knowledge access denied");
    // Older direct callers did not carry scope. Keep those calls compatible,
    // while ActiveWiki/HTTP callers pass isAdmin and therefore use strict
    // exact-scope enforcement.
    if (!strict && !requestedProject && !requestedEnvironment) return;
    const pageProject = row.project_id ? String(row.project_id) : undefined;
    const pageEnvironment = row.environment ? String(row.environment) : undefined;
    // An omitted scope is safe only for a truly global page in strict mode.
    if (requestedProject !== pageProject || requestedEnvironment !== pageEnvironment) throw new Error("Knowledge access denied");
  }

  private assertPageReviewer(actorId: number, projectId: string | undefined, isAdmin = false): void {
    if (projectId) {
      this.assertReader(actorId, projectId);
      const acl = this.store.db.prepare("SELECT can_review FROM knowledge_acl WHERE project_id = ? AND user_id = ?").get(projectId, actorId) as { can_review?: number } | undefined;
      assertReviewer(acl?.can_review === 1);
      return;
    }
    if (isAdmin) return;
    const acl = this.store.db.prepare("SELECT can_review FROM knowledge_acl WHERE user_id = ? AND can_read = 1 AND can_review = 1 LIMIT 1").get(actorId);
    assertReviewer(Boolean(acl));
  }

  private hasEnvironmentColumn(): boolean {
    return (this.store.db.prepare("PRAGMA table_info(knowledge_wiki_pages)").all() as Array<{ name?: unknown }>).some(column => column.name === "environment");
  }

  private assertNoSecrets(content: Record<string, unknown>): void {
    const disallowed = scanCandidateContent(content);
    if (disallowed) throw new Error(`Wiki content contains ${disallowed}`);
  }

  /** Server-side pagination, filtering and title/body search with ACL. */
  list(input: WikiPageListQuery): WikiPageListResult {
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const projectId = optionalText(input.projectId, 200);
    const environment = optionalText(input.environment, 200);
    if (projectId) this.assertReader(input.actorId, projectId, "published", input.isAdmin, environment);
    const environmentSql = this.hasEnvironmentColumn() ? "p.environment" : "NULL";
    const where: string[] = ["p.id NOT LIKE 'engine-wiki:%'"];
    const params: Record<string, unknown> = { actorId: input.actorId, isAdmin: input.isAdmin ? 1 : 0, projectId: projectId ?? null, environment: environment ?? null };
    // Fetch the complete ACL-visible scope first. Canonical selection must
    // happen before status/search filters, otherwise a matching duplicate can
    // incorrectly displace its retained canonical row.
    if (projectId) {
      where.push(`(
        (p.project_id IS NULL AND ${environmentSql} IS NULL AND
          (p.status = 'published' OR @isAdmin = 1 OR EXISTS (
            SELECT 1 FROM knowledge_acl a WHERE a.user_id = @actorId AND a.can_read = 1
          )))
        OR
        (p.project_id = @projectId AND
          ((@environment IS NULL AND ${environmentSql} IS NULL) OR ${environmentSql} = @environment) AND
          EXISTS (
            SELECT 1 FROM knowledge_acl a WHERE a.project_id = @projectId AND a.user_id = @actorId AND a.can_read = 1
          ))
      )`);
    } else {
      where.push(`(
        p.project_id IS NULL AND ${environmentSql} IS NULL AND
        (p.status = 'published' OR @isAdmin = 1 OR EXISTS (
          SELECT 1 FROM knowledge_acl a WHERE a.user_id = @actorId AND a.can_read = 1
        ))
      )`);
    }
    const predicate = where.join("\n AND ");
    const rows = this.store.db.prepare(`SELECT p.rowid AS __wiki_rowid,p.* FROM knowledge_wiki_pages p WHERE ${predicate} ORDER BY p.updated_at DESC, p.id`).all(params) as Array<Record<string, unknown>>;
    let canonical = rows.filter(row => isCanonicalWikiRow(rows, row));
    if (input.status) canonical = canonical.filter(row => row.status === input.status);
    if (input.productVersion) canonical = canonical.filter(row => row.product_version === input.productVersion);
    if (input.topicId) canonical = canonical.filter(row => row.topic_id === input.topicId);
    if (input.solution) canonical = canonical.filter(row => row.solution === input.solution);
    if (input.module) canonical = canonical.filter(row => row.module === input.module);
    if (input.search?.trim()) {
      const term = input.search.trim().toLocaleLowerCase();
      canonical = canonical.filter(row => `${String(row.title)}\n${String(row.body)}`.toLocaleLowerCase().includes(term));
    }
    return { items: canonical.slice(offset, offset + limit).map(summaryFromRow), total: canonical.length, limit, offset };
  }

  get(input: { actorId: number; isAdmin?: boolean; id: string; projectId?: string; environment?: string }): WikiPage {
    const row = this.loadRow(input.id);
    this.assertRequestedScope(row, input.projectId, input.environment, input.isAdmin !== undefined);
    const projectId = row.project_id ? String(row.project_id) : undefined;
    const environment = row.environment ? String(row.environment) : undefined;
    this.assertReader(input.actorId, projectId, String(row.status) as WikiPageStatus, input.isAdmin, environment);
    return pageFromRow(row, this.duplicateOf(row));
  }

  getByKey(input: { actorId: number; isAdmin?: boolean; pageKey: string; projectId?: string; environment?: string }): WikiPage {
    const row = this.store.db.prepare("SELECT * FROM knowledge_wiki_pages WHERE page_key = ?").get(input.pageKey) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Wiki page not found");
    this.assertRequestedScope(row, input.projectId, input.environment, input.isAdmin !== undefined);
    const projectId = row.project_id ? String(row.project_id) : undefined;
    const environment = row.environment ? String(row.environment) : undefined;
    this.assertReader(input.actorId, projectId, String(row.status) as WikiPageStatus, input.isAdmin, environment);
    return pageFromRow(row, this.duplicateOf(row));
  }

  /** Idempotent on page_key: a replay returns the existing page unchanged. */
  create(input: {
    actorId: number;
    isAdmin?: boolean;
    pageKey: string;
    title: string;
    body: string;
    projectId?: string;
    environment?: string;
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
    const projectId = optionalText(input.projectId, 200);
    const environment = optionalText(input.environment, 200);
    if (environment && !projectId) throw new Error("Knowledge access denied");
    const existing = this.store.db.prepare("SELECT * FROM knowledge_wiki_pages WHERE page_key = ?").get(pageKey) as Record<string, unknown> | undefined;
    if (existing) {
      this.assertRequestedScope(existing, projectId, environment, input.isAdmin !== undefined);
      this.assertReader(input.actorId, existing.project_id ? String(existing.project_id) : undefined, String(existing.status) as WikiPageStatus, input.isAdmin, existing.environment ? String(existing.environment) : undefined);
      return pageFromRow(existing, this.duplicateOf(existing));
    }

    if (projectId) this.assertReader(input.actorId, projectId);
    else this.assertPageReviewer(input.actorId, undefined, input.isAdmin);
    if (environment && !this.hasEnvironmentColumn()) throw new Error("Wiki environment persistence is unavailable");
    const sourceRefs = [...new Set((input.sourceRefs ?? []).map((ref) => String(ref).trim()).filter(Boolean))].slice(0, 100);
    const candidate: Record<string, unknown> = {
      id: randomUUID(), page_key: pageKey, title, body, status: "draft", project_id: projectId ?? null,
      environment: environment ?? null, product_version: optionalText(input.productVersion, 120) ?? null,
      topic_id: optionalText(input.topicId, 200) ?? null, solution: optionalText(input.solution, 200) ?? null,
      module: optionalText(input.module, 200) ?? null, source_refs_json: JSON.stringify(sourceRefs),
      created_at: this.clock().toISOString(),
    };
    const existingTopics = this.localRows().filter(row => canonicalWikiRow([row, candidate], row).id === row.id);
    const canonical = existingTopics.length ? canonicalWikiRow(existingTopics, candidate) : candidate;
    if (String(canonical.id) !== String(candidate.id)) return pageFromRow(canonical, this.duplicateOf(canonical));
    const id = String(candidate.id), now = String(candidate.created_at);

    this.store.db.transaction(() => {
      const columns = this.hasEnvironmentColumn()
        ? "(id,page_key,title,body,status,project_id,environment,product_version,topic_id,solution,module,source_refs_json,current_revision,created_by,created_at,updated_at)"
        : "(id,page_key,title,body,status,project_id,product_version,topic_id,solution,module,source_refs_json,current_revision,created_by,created_at,updated_at)";
      const placeholders = this.hasEnvironmentColumn() ? "VALUES (?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?)" : "VALUES (?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?)";
      const values = this.hasEnvironmentColumn()
        ? [id, pageKey, title.slice(0, 500), body, projectId ?? null, environment ?? null, optionalText(input.productVersion, 120) ?? null, optionalText(input.topicId, 200) ?? null, optionalText(input.solution, 200) ?? null, optionalText(input.module, 200) ?? null, JSON.stringify(sourceRefs), 1, input.actorId, now, now]
        : [id, pageKey, title.slice(0, 500), body, projectId ?? null, optionalText(input.productVersion, 120) ?? null, optionalText(input.topicId, 200) ?? null, optionalText(input.solution, 200) ?? null, optionalText(input.module, 200) ?? null, JSON.stringify(sourceRefs), 1, input.actorId, now, now];
      this.store.db.prepare(`INSERT INTO knowledge_wiki_pages ${columns} ${placeholders}`).run(...values);
      this.store.db.prepare("INSERT INTO knowledge_wiki_page_revisions(id,page_id,revision,title,body,change_reason,author_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(randomUUID(), id, 1, title.slice(0, 500), body, reason, input.actorId, now);
      this.store.audit({ actorId: input.actorId, projectId, action: "wiki.create", entityType: "wiki_page", entityId: id, details: { pageKey, title: title.slice(0, 500), reason, revision: 1, sourceRefCount: sourceRefs.length } });
    })();
    const saved = this.loadRow(id);
    return pageFromRow(saved, this.duplicateOf(saved));
  }

  /** Edit appends a new revision and bumps current_revision. */
  edit(input: { actorId: number; isAdmin?: boolean; id: string; projectId?: string; environment?: string; title?: string; body?: string; reason: string }): WikiPage {
    const reason = requireReason(input.reason);
    const row = this.loadRow(input.id);
    this.assertRequestedScope(row, input.projectId, input.environment, input.isAdmin !== undefined);
    const page = pageFromRow(row);
    this.assertPageReviewer(input.actorId, page.projectId, input.isAdmin);
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
  publish(input: { actorId: number; isAdmin?: boolean; id: string; projectId?: string; environment?: string; reason: string }): WikiPage {
    const reason = requireReason(input.reason);
    const row = this.loadRow(input.id);
    this.assertRequestedScope(row, input.projectId, input.environment, input.isAdmin !== undefined);
    const page = pageFromRow(row);
    this.assertPageReviewer(input.actorId, page.projectId, input.isAdmin);
    this.assertCanonical(row);
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
  deprecate(input: { actorId: number; isAdmin?: boolean; id: string; projectId?: string; environment?: string; reason: string }): WikiPage {
    const reason = requireReason(input.reason);
    const row = this.loadRow(input.id);
    this.assertRequestedScope(row, input.projectId, input.environment, input.isAdmin !== undefined);
    const page = pageFromRow(row);
    this.assertPageReviewer(input.actorId, page.projectId, input.isAdmin);
    if (page.status === "deprecated") return page;
    const now = this.clock().toISOString();
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE knowledge_wiki_pages SET status = 'deprecated', deprecated_at = ?, updated_at = ? WHERE id = ?").run(now, now, page.id);
      this.store.audit({ actorId: input.actorId, projectId: page.projectId, action: "wiki.deprecate", entityType: "wiki_page", entityId: page.id, details: { pageKey: page.pageKey, reason, previousStatus: page.status } });
    })();
    return pageFromRow(this.loadRow(input.id));
  }

  listRevisions(input: { actorId: number; isAdmin?: boolean; id: string; projectId?: string; environment?: string; limit?: number; offset?: number }): WikiPageRevision[] {
    const row = this.loadRow(input.id);
    this.assertRequestedScope(row, input.projectId, input.environment, input.isAdmin !== undefined);
    this.assertReader(input.actorId, row.project_id ? String(row.project_id) : undefined, String(row.status) as WikiPageStatus, input.isAdmin, row.environment ? String(row.environment) : undefined);
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const rows = this.store.db.prepare("SELECT * FROM knowledge_wiki_page_revisions WHERE page_id = ? ORDER BY revision DESC LIMIT ? OFFSET ?").all(input.id, limit, offset) as Array<Record<string, unknown>>;
    return rows.map(revisionFromRow);
  }

  /** Unified diff between two revisions of the same page. */
  diffRevisions(input: { actorId: number; isAdmin?: boolean; id: string; projectId?: string; environment?: string; fromRevision: number; toRevision: number }): string {
    const row = this.loadRow(input.id);
    this.assertRequestedScope(row, input.projectId, input.environment, input.isAdmin !== undefined);
    const page = pageFromRow(row);
    this.assertReader(input.actorId, page.projectId, page.status, input.isAdmin, page.environment);
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
  rollback(input: { actorId: number; isAdmin?: boolean; id: string; projectId?: string; environment?: string; revision: number; reason: string }): WikiPage {
    const reason = requireReason(input.reason);
    const row = this.loadRow(input.id);
    this.assertRequestedScope(row, input.projectId, input.environment, input.isAdmin !== undefined);
    const page = pageFromRow(row);
    this.assertPageReviewer(input.actorId, page.projectId, input.isAdmin);
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
