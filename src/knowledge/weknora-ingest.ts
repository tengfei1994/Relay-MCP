import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import { htmlToStructuredMarkdown } from "./weknora-markdown.js";
import { WeKnoraError, type WeKnoraClient } from "./weknora.js";

export interface WeKnoraDocumentInput { idempotencyKey: string; title: string; content: string; productVersion?: string; solution?: string; module?: string; topicId?: string; sourcePath?: string; language?: string; projectId?: string; parserVersion: string; rawSha256?: string; }
export interface ExternalDocumentResult { externalDocumentId: string; externalChunkIds?: string[]; knowledgeBaseId?: string; }
export type WeKnoraDocumentStatus = "staged" | "published" | "deprecated" | "failed";
export interface StagedWeKnoraDocument { id: string; externalDocumentId: string; title: string; normalizedContentSha256: string; identityHash?: string; rawSha256?: string; parserVersion: string; productVersion?: string; solution?: string; module?: string; topicId?: string; sourcePath?: string; language?: string; projectId?: string; status: WeKnoraDocumentStatus; failureCode?: string; failureMessage?: string; attemptCount: number; createdAt: string; updatedAt: string; publishedAt?: string; }
export interface WeKnoraDocumentWriter { upsertDocument(input: WeKnoraDocumentInput & { normalizedContent: string; normalizedContentSha256: string }): Promise<ExternalDocumentResult>; }

export interface WeKnoraRetrievalFilter { productVersion?: string; solution?: string; module?: string; topicId?: string; projectId?: string; language?: string; }
export interface WeKnoraIngestBatchItem { idempotencyKey: string; documentId?: string; status: "staged" | "skipped" | "failed"; failureCode?: string; error?: string; }
export interface WeKnoraIngestBatchReport { total: number; staged: number; skipped: number; failed: number; items: WeKnoraIngestBatchItem[]; }

/** Only published documents are visible to Product Knowledge retrieval. */
export const WEKNORA_RETRIEVAL_VISIBLE_STATUS: WeKnoraDocumentStatus = "published";

export class WeKnoraIngestError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WeKnoraIngestError"; }
}

/** Structured normalization: headings, lists, tables, code, images, links and anchors survive. */
export function normalizeProductContent(content: string): string {
  return htmlToStructuredMarkdown(content).markdown;
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function canonicalIdentity(input: WeKnoraDocumentInput, normalizedContentSha256: string): string {
  const scope = {
    normalizedContentSha256,
    productVersion: input.productVersion ?? null,
    solution: input.solution ?? null,
    module: input.module ?? null,
    topicId: input.topicId ?? null,
    sourcePath: input.sourcePath ?? null,
    language: input.language ?? null,
    projectId: input.projectId ?? null,
  };
  return hash(JSON.stringify(scope));
}

function sanitizeFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/Bearer\s+\S+/gi, "[redacted]").slice(0, 300);
}

function failureCode(error: unknown): string {
  if (error instanceof WeKnoraError) return error.code;
  return "writer_error";
}

function rowToDocument(row: Record<string, unknown>): StagedWeKnoraDocument {
  return {
    id: String(row.id),
    externalDocumentId: String(row.external_document_id),
    title: String(row.title),
    normalizedContentSha256: String(row.normalized_content_sha256),
    identityHash: row.identity_hash ? String(row.identity_hash) : undefined,
    rawSha256: row.raw_sha256 ? String(row.raw_sha256) : undefined,
    parserVersion: String(row.parser_version),
    productVersion: row.product_version ? String(row.product_version) : undefined,
    solution: row.solution ? String(row.solution) : undefined,
    module: row.module ? String(row.module) : undefined,
    topicId: row.topic_id ? String(row.topic_id) : undefined,
    sourcePath: row.source_path ? String(row.source_path) : undefined,
    language: row.language ? String(row.language) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    status: String(row.status) as WeKnoraDocumentStatus,
    failureCode: row.failure_code ? String(row.failure_code) : undefined,
    failureMessage: row.failure_message ? String(row.failure_message) : undefined,
    attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : Number(row.attempt_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    publishedAt: row.published_at ? String(row.published_at) : undefined,
  };
}

/**
 * Real writer boundary: pushes normalized Markdown to WeKnora through the
 * client and records the control-plane ids. The knowledge base id stays in
 * the ingest control plane and never leaks into retrieval DTOs.
 */
export class WeKnoraClientDocumentWriter implements WeKnoraDocumentWriter {
  constructor(private readonly client: WeKnoraClient, private readonly knowledgeBaseId: string) {}
  async upsertDocument(input: WeKnoraDocumentInput & { normalizedContent: string; normalizedContentSha256: string }): Promise<ExternalDocumentResult> {
    const ref = await this.client.upsertDocument({
      knowledgeBaseId: this.knowledgeBaseId,
      title: input.title,
      content: input.normalizedContent,
      sourcePath: input.sourcePath,
      metadata: {
        relay_document_key: input.idempotencyKey,
        parser_version: input.parserVersion,
        normalized_content_sha256: input.normalizedContentSha256,
        ...(input.rawSha256 ? { raw_sha256: input.rawSha256 } : {}),
        ...(input.productVersion ? { productVersion: input.productVersion } : {}),
        ...(input.solution ? { solution: input.solution } : {}),
        ...(input.module ? { module: input.module } : {}),
        ...(input.topicId ? { topicId: input.topicId } : {}),
        ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
        ...(input.language ? { language: input.language } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
      },
    });
    return { externalDocumentId: ref.documentId, knowledgeBaseId: this.knowledgeBaseId, externalChunkIds: [] };
  }
}

export class WeKnoraIngestor {
  constructor(private readonly store: KnowledgeStore, private readonly writer: WeKnoraDocumentWriter, private readonly clock: () => Date = () => new Date()) {}

  async stage(input: WeKnoraDocumentInput, options?: { retry?: boolean }): Promise<StagedWeKnoraDocument> {
    return (await this.stageInternal(input, options)).document;
  }

  /** Per-file batch import: one failure never aborts the rest of the batch. */
  async stageBatch(inputs: WeKnoraDocumentInput[], options?: { retry?: boolean }): Promise<WeKnoraIngestBatchReport> {
    const items: WeKnoraIngestBatchItem[] = [];
    for (const input of inputs) {
      try {
        const outcome = await this.stageInternal(input, options);
        items.push({ idempotencyKey: input.idempotencyKey, documentId: outcome.document.id, status: outcome.deduplicated ? "skipped" : "staged" });
      } catch (error) {
        const code = failureCode(error);
        items.push({ idempotencyKey: input.idempotencyKey, status: "failed", failureCode: code, error: sanitizeFailureMessage(error) });
      }
    }
    return {
      total: items.length,
      staged: items.filter((item) => item.status === "staged").length,
      skipped: items.filter((item) => item.status === "skipped").length,
      failed: items.filter((item) => item.status === "failed").length,
      items,
    };
  }

  get(id: string): StagedWeKnoraDocument | undefined {
    const row = this.store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE id=? OR external_document_id=?").get(id, id) as Record<string, unknown> | undefined;
    return row ? rowToDocument(row) : undefined;
  }

  isRetrievalVisible(document: StagedWeKnoraDocument): boolean {
    return document.status === WEKNORA_RETRIEVAL_VISIBLE_STATUS;
  }

  /** Published documents only; staged, failed and deprecated stay invisible. */
  listRetrievalVisible(filter: WeKnoraRetrievalFilter = {}): StagedWeKnoraDocument[] {
    const conditions = ["status = 'published'"];
    const params: unknown[] = [];
    const add = (column: string, value: string | undefined) => {
      if (value === undefined) return;
      conditions.push(`(${column} IS NULL OR ${column} = ?)`);
      params.push(value);
    };
    add("product_version", filter.productVersion);
    add("solution", filter.solution);
    add("module", filter.module);
    add("topic_id", filter.topicId);
    add("project_id", filter.projectId);
    add("language", filter.language);
    const rows = this.store.db.prepare(`SELECT * FROM knowledge_weknora_documents WHERE ${conditions.join(" AND ")} ORDER BY created_at`).all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToDocument);
  }

  /** External document ids for WeKnora knowledge_ids scoping; KB ids stay server-side. */
  retrievalKnowledgeIds(filter: WeKnoraRetrievalFilter = {}): string[] {
    return this.listRetrievalVisible(filter)
      .map((document) => document.externalDocumentId)
      .filter((id) => id && !id.startsWith("pending:"));
  }

  publish(id: string, actorId: number): StagedWeKnoraDocument {
    const now = this.clock().toISOString();
    const result = this.store.db.prepare("UPDATE knowledge_weknora_documents SET status='published',published_at=?,updated_at=?,deprecated_at=NULL WHERE id=? AND status IN ('staged','published')").run(now, now, id);
    if (!result.changes) throw new Error("WeKnora document is not staged");
    this.store.audit({ actorId, action: "knowledge.weknora.publish", entityType: "weknora_document", entityId: id, details: { status: "published" } });
    return this.get(id)!;
  }

  deprecate(id: string, actorId: number): StagedWeKnoraDocument {
    const now = this.clock().toISOString();
    const result = this.store.db.prepare("UPDATE knowledge_weknora_documents SET status='deprecated',deprecated_at=?,updated_at=? WHERE id=?").run(now, now, id);
    if (!result.changes) throw new Error("WeKnora document not found");
    this.store.audit({ actorId, action: "knowledge.weknora.deprecate", entityType: "weknora_document", entityId: id });
    return this.get(id)!;
  }

  private async stageInternal(input: WeKnoraDocumentInput, options?: { retry?: boolean }): Promise<{ document: StagedWeKnoraDocument; deduplicated: boolean }> {
    const key = input.idempotencyKey.trim();
    if (!key) throw new Error("idempotencyKey is required");
    const normalizedContent = normalizeProductContent(input.content);
    const normalizedContentSha256 = hash(normalizedContent);
    const identityHash = canonicalIdentity(input, normalizedContentSha256);
    const now = () => this.clock().toISOString();

    const existing = this.store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE idempotency_key=?").get(key) as Record<string, unknown> | undefined;
    if (existing) {
      if (String(existing.status) !== "failed" || !options?.retry) return { document: rowToDocument(existing), deduplicated: true };
      return { document: await this.retryFailed(existing, input, normalizedContent, normalizedContentSha256, identityHash), deduplicated: false };
    }

    // Identity dedupe spans the full logical scope (content hash + version +
    // solution + module + topic + source path + language + project), so the
    // same content under a different topic or source is never merged.
    const sameContent = this.store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE identity_hash=? AND status NOT IN ('deprecated','failed') LIMIT 1").get(identityHash) as Record<string, unknown> | undefined;
    if (sameContent) return { document: rowToDocument(sameContent), deduplicated: true };

    let external: ExternalDocumentResult;
    try {
      external = await this.writer.upsertDocument({ ...input, normalizedContent, normalizedContentSha256 });
    } catch (error) {
      const code = failureCode(error);
      const message = sanitizeFailureMessage(error);
      const id = `weknora-${randomUUID()}`;
      this.store.db.prepare(`INSERT INTO knowledge_weknora_documents(id,external_document_id,title,normalized_content_sha256,identity_hash,raw_sha256,parser_version,product_version,solution,module,topic_id,source_path,language,project_id,status,failure_code,failure_message,attempt_count,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, `pending:${id}`, input.title.slice(0, 500), normalizedContentSha256, identityHash, input.rawSha256 ?? null, input.parserVersion, input.productVersion ?? null, input.solution ?? null, input.module ?? null, input.topicId ?? null, input.sourcePath ?? null, input.language ?? null, input.projectId ?? null, "failed", code, message, 1, key, now(), now());
      this.store.audit({ projectId: input.projectId, action: "knowledge.weknora.stage", entityType: "weknora_document", entityId: id, details: { status: "failed", failureCode: code, normalizedContentSha256 } });
      throw new WeKnoraIngestError(code, `WeKnora ingest failed (${code}): ${message}`);
    }

    // Upstream upsert dedupe (HTTP 409) may return an external document id we
    // already recorded; reuse that control-plane row instead of inserting a
    // duplicate.
    const existingExternal = this.store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE external_document_id=? AND status != 'deprecated' LIMIT 1").get(external.externalDocumentId) as Record<string, unknown> | undefined;
    if (existingExternal) return { document: rowToDocument(existingExternal), deduplicated: true };

    const id = `weknora-${randomUUID()}`;
    this.store.db.prepare(`INSERT INTO knowledge_weknora_documents(id,external_document_id,external_knowledge_base_id,external_chunk_ids_json,title,normalized_content_sha256,identity_hash,raw_sha256,parser_version,product_version,solution,module,topic_id,source_path,language,project_id,status,attempt_count,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, external.externalDocumentId, external.knowledgeBaseId ?? null, JSON.stringify(external.externalChunkIds ?? []), input.title.slice(0, 500), normalizedContentSha256, identityHash, input.rawSha256 ?? null, input.parserVersion, input.productVersion ?? null, input.solution ?? null, input.module ?? null, input.topicId ?? null, input.sourcePath ?? null, input.language ?? null, input.projectId ?? null, "staged", 1, key, now(), now());
    this.store.audit({ projectId: input.projectId, action: "knowledge.weknora.stage", entityType: "weknora_document", entityId: id, details: { externalDocumentId: external.externalDocumentId, normalizedContentSha256, identityHash, parserVersion: input.parserVersion, status: "staged" } });
    return { document: this.get(id)!, deduplicated: false };
  }

  /** Retry a failed staging without creating a second control-plane document. */
  private async retryFailed(row: Record<string, unknown>, input: WeKnoraDocumentInput, normalizedContent: string, normalizedContentSha256: string, identityHash: string): Promise<StagedWeKnoraDocument> {
    const id = String(row.id);
    const attempts = Number(row.attempt_count ?? 0) + 1;
    try {
      const external = await this.writer.upsertDocument({ ...input, normalizedContent, normalizedContentSha256 });
      this.store.db.prepare("UPDATE knowledge_weknora_documents SET external_document_id=?,external_knowledge_base_id=?,external_chunk_ids_json=?,status='staged',failure_code=NULL,failure_message=NULL,attempt_count=?,updated_at=? WHERE id=?")
        .run(external.externalDocumentId, external.knowledgeBaseId ?? null, JSON.stringify(external.externalChunkIds ?? []), attempts, this.clock().toISOString(), id);
      this.store.audit({ projectId: input.projectId, action: "knowledge.weknora.stage", entityType: "weknora_document", entityId: id, details: { externalDocumentId: external.externalDocumentId, normalizedContentSha256, identityHash, status: "staged", retry: true, attemptCount: attempts } });
      return this.get(id)!;
    } catch (error) {
      const code = failureCode(error);
      const message = sanitizeFailureMessage(error);
      this.store.db.prepare("UPDATE knowledge_weknora_documents SET status='failed',failure_code=?,failure_message=?,attempt_count=?,updated_at=? WHERE id=?")
        .run(code, message, attempts, this.clock().toISOString(), id);
      throw new WeKnoraIngestError(code, `WeKnora ingest failed (${code}): ${message}`);
    }
  }
}
