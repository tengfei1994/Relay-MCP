import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import { normalizeProductMarkup, legacyProductMarkupForReplay } from "./weknora-markdown.js";
import { WeKnoraError, type WeKnoraClient, type WeKnoraReadinessOptions } from "./weknora.js";

export interface WeKnoraModelProvenance { knowledgeBaseId: string; providerId: string; modelId: string; dimensions: number; indexVersion: number; }
export interface WeKnoraDocumentInput { idempotencyKey: string; title: string; content: string; productVersion?: string; solution?: string; module?: string; topicId?: string; sourcePath?: string; language?: string; projectId?: string; environment?: string; parserVersion: string; rawSha256?: string; modelProvenance?: WeKnoraModelProvenance; }
export interface ExternalDocumentResult { externalDocumentId: string; externalChunkIds?: string[]; knowledgeBaseId?: string; parseStatus?: string; modelProvenance?: WeKnoraModelProvenance; }
export type WeKnoraDocumentStatus = "staged" | "published" | "deprecated" | "failed";
export interface StagedWeKnoraDocument { id: string; externalDocumentId: string; externalChunkIds: string[]; knowledgeBaseId?: string; title: string; normalizedContentSha256: string; identityHash?: string; rawSha256?: string; parserVersion: string; productVersion?: string; solution?: string; module?: string; topicId?: string; sourcePath?: string; language?: string; projectId?: string; environment?: string; upstreamParseStatus?: string; upstreamVerifiedAt?: string; modelProvenance?: WeKnoraModelProvenance; status: WeKnoraDocumentStatus; failureCode?: string; failureMessage?: string; attemptCount: number; createdAt: string; updatedAt: string; publishedAt?: string; }
export interface WeKnoraDocumentWriter {
  upsertDocument(input: NormalizedWeKnoraInput, options?: WeKnoraWriteOptions): Promise<ExternalDocumentResult>;
  resumeDocument?(externalDocumentId: string, input: NormalizedWeKnoraInput, options?: WeKnoraWriteOptions): Promise<ExternalDocumentResult>;
  getModelProvenance?(): Promise<WeKnoraModelProvenance | undefined>;
}
export type NormalizedWeKnoraInput = WeKnoraDocumentInput & { normalizedContent: string; normalizedContentSha256: string };
export interface WeKnoraWriteOptions { onAccepted?: (document: ExternalDocumentResult) => void | Promise<void>; }
export interface WeKnoraClientDocumentWriterOptions {
  readiness?: WeKnoraReadinessOptions;
  modelProvenance?: WeKnoraModelProvenance | (() => WeKnoraModelProvenance | undefined | Promise<WeKnoraModelProvenance | undefined>);
  deferSynthesis?: boolean;
  assertCurrentConfiguration?: () => void | Promise<void>;
}
export interface WeKnoraRetrievalFilter { productVersion?: string; solution?: string; module?: string; topicId?: string; projectId?: string; environment?: string; language?: string; }
export interface WeKnoraIngestBatchItem { idempotencyKey: string; documentId?: string; status: "staged" | "skipped" | "failed"; failureCode?: string; error?: string; }
export interface WeKnoraIngestBatchReport { total: number; staged: number; skipped: number; failed: number; items: WeKnoraIngestBatchItem[]; }
export const WEKNORA_RETRIEVAL_VISIBLE_STATUS: WeKnoraDocumentStatus = "published";

export class WeKnoraIngestError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WeKnoraIngestError"; }
}

export function normalizeProductContent(content: string): string { return normalizeProductMarkup(content); }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function legacyCanonicalIdentity(input: WeKnoraDocumentInput, normalizedContentSha256: string): string {
  return hash(JSON.stringify({ normalizedContentSha256, productVersion: input.productVersion ?? null,
    solution: input.solution ?? null, module: input.module ?? null, topicId: input.topicId ?? null,
    sourcePath: input.sourcePath ?? null, language: input.language ?? null, projectId: input.projectId ?? null,
    environment: input.environment ?? null, modelProvenance: input.modelProvenance ?? null }));
}
function canonicalIdentity(input: WeKnoraDocumentInput, normalizedContentSha256: string): string {
  return hash(JSON.stringify({ sourceIdentity: legacyCanonicalIdentity(input, normalizedContentSha256), parserVersion: input.parserVersion, rawSha256: input.rawSha256 ?? null }));
}
function matchesStoredIdentity(row: Record<string, unknown>, input: WeKnoraDocumentInput, normalizedContentSha256: string, identityHash: string): boolean {
  if (row.parser_version !== input.parserVersion || (row.raw_sha256 ?? null) !== (input.rawSha256 ?? null)) return false;
  if (row.normalized_content_sha256 === normalizedContentSha256 &&
      (row.identity_hash === identityHash || row.identity_hash === legacyCanonicalIdentity(input, normalizedContentSha256))) return true;
  const legacyContentHash = hash(legacyProductMarkupForReplay(input.content));
  return row.normalized_content_sha256 === legacyContentHash && row.identity_hash === legacyCanonicalIdentity(input, legacyContentHash);
}
function sanitizeFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/(?:Bearer|X-API-Key[:=]?)\s+\S+/gi, "[redacted]").slice(0, 300);
}
function failureCode(error: unknown): string { return error instanceof WeKnoraError || error instanceof WeKnoraIngestError ? error.code : "writer_error"; }
function parseJson(value: unknown): unknown { try { return JSON.parse(String(value)); } catch { return undefined; } }
function chunkIds(value: unknown): string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string" && id.trim()) ? [...new Set(value as string[])] : [];
}
function provenanceFrom(value: unknown): WeKnoraModelProvenance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (![row.knowledgeBaseId, row.providerId, row.modelId].every((s) => typeof s === "string" && s.trim()) ||
      !Number.isInteger(row.dimensions) || Number(row.dimensions) < 1 || !Number.isInteger(row.indexVersion) || Number(row.indexVersion) < 1) return undefined;
  return { knowledgeBaseId: String(row.knowledgeBaseId), providerId: String(row.providerId), modelId: String(row.modelId), dimensions: Number(row.dimensions), indexVersion: Number(row.indexVersion) };
}
function validateProvenance(value: WeKnoraModelProvenance | undefined): WeKnoraModelProvenance | undefined {
  if (value === undefined) return undefined;
  const result = provenanceFrom(value);
  if (!result) throw new WeKnoraIngestError("model_provenance_invalid", "Embedding model provenance is invalid");
  return result;
}
export function weKnoraDocumentFromRow(row: Record<string, unknown>): StagedWeKnoraDocument {
  const parsedProvenance = parseJson(row.model_provenance_json ?? "{}");
  if (!parsedProvenance || typeof parsedProvenance !== "object" || Array.isArray(parsedProvenance) ||
      (Object.keys(parsedProvenance).length > 0 && !provenanceFrom(parsedProvenance))) {
    throw new WeKnoraIngestError("model_provenance_invalid", "Stored embedding model provenance is invalid");
  }
  const optional = (key: string) => row[key] ? String(row[key]) : undefined;
  return {
    id: String(row.id), externalDocumentId: String(row.external_document_id), externalChunkIds: chunkIds(parseJson(row.external_chunk_ids_json)),
    knowledgeBaseId: optional("external_knowledge_base_id"), title: String(row.title), normalizedContentSha256: String(row.normalized_content_sha256),
    identityHash: optional("identity_hash"), rawSha256: optional("raw_sha256"), parserVersion: String(row.parser_version),
    productVersion: optional("product_version"), solution: optional("solution"), module: optional("module"), topicId: optional("topic_id"),
    sourcePath: optional("source_path"), language: optional("language"), projectId: optional("project_id"), environment: optional("environment"),
    upstreamParseStatus: optional("upstream_parse_status"), upstreamVerifiedAt: optional("upstream_verified_at"),
    modelProvenance: provenanceFrom(parseJson(row.model_provenance_json)), status: String(row.status) as WeKnoraDocumentStatus,
    failureCode: optional("failure_code"), failureMessage: optional("failure_message"), attemptCount: Number(row.attempt_count ?? 0),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), publishedAt: optional("published_at"),
  };
}

/** Stored readiness is established only after fetching completed parse status and indexed chunk ids. */
export function isVerifiedWeKnoraDocument(document: StagedWeKnoraDocument): boolean {
  return document.upstreamParseStatus === "completed" && Boolean(document.upstreamVerifiedAt && Number.isFinite(Date.parse(document.upstreamVerifiedAt))) &&
    Boolean(document.externalDocumentId && !document.externalDocumentId.startsWith("pending:")) && document.externalChunkIds.length > 0 &&
    (!document.modelProvenance || document.modelProvenance.knowledgeBaseId === document.knowledgeBaseId);
}
function verifiedExternal(external: ExternalDocumentResult, expected?: WeKnoraModelProvenance): ExternalDocumentResult {
  if (external.parseStatus !== "completed" || !external.externalDocumentId?.trim() || external.externalDocumentId.startsWith("pending:") || !chunkIds(external.externalChunkIds).length) {
    throw new WeKnoraIngestError("upstream_not_ready", "WeKnora readiness requires a completed parse and verified nonempty chunks");
  }
  const provenance = validateProvenance(external.modelProvenance ?? expected);
  if (provenance && (provenance.knowledgeBaseId !== external.knowledgeBaseId || (expected && JSON.stringify(provenance) !== JSON.stringify(expected)))) {
    throw new WeKnoraIngestError("model_provenance_mismatch", "Embedding model provenance does not match the indexed knowledge base");
  }
  return { ...external, externalChunkIds: chunkIds(external.externalChunkIds), modelProvenance: provenance };
}

/** Upload normalized Markdown, then verify the upstream parser and actual indexed chunks. */
export class WeKnoraClientDocumentWriter implements WeKnoraDocumentWriter {
  constructor(private readonly client: WeKnoraClient, private readonly knowledgeBaseId: string, private readonly options: WeKnoraClientDocumentWriterOptions = {}) {}
  async getModelProvenance(): Promise<WeKnoraModelProvenance | undefined> {
    return validateProvenance(typeof this.options.modelProvenance === "function" ? await this.options.modelProvenance() : this.options.modelProvenance);
  }
  private async assertConfiguration(expected?: WeKnoraModelProvenance): Promise<void> {
    try {
      await this.options.assertCurrentConfiguration?.();
      if (JSON.stringify(await this.getModelProvenance()) !== JSON.stringify(expected)) throw new Error("Model binding changed");
    } catch { throw new WeKnoraIngestError("ingestion_configuration_changed", "Knowledge engine ingestion configuration changed; restore the frozen migration configuration before resuming"); }
  }
  async upsertDocument(input: NormalizedWeKnoraInput, options?: WeKnoraWriteOptions): Promise<ExternalDocumentResult> {
    const configured = await this.getModelProvenance();
    const provenance = configured ?? validateProvenance(input.modelProvenance);
    if (provenance && (provenance.knowledgeBaseId !== this.knowledgeBaseId || (configured && input.modelProvenance && JSON.stringify(configured) !== JSON.stringify(validateProvenance(input.modelProvenance))))) {
      throw new WeKnoraIngestError("model_provenance_mismatch", "Embedding model binding changed before document upload");
    }
    await this.assertConfiguration(configured);
    // Match Relay's immutable mapping identity, not the import-run key. The
    // v0.8.3 datasource compatibility fields isolate same-byte versions/scopes
    // without injecting hashes into Markdown or claiming a GitLab data source.
    const sourceIdentity = { dataSourceId: "relay-mcp-product-v1", externalId: canonicalIdentity({ ...input, modelProvenance: provenance }, input.normalizedContentSha256) };
    const ref = await this.client.upsertDocument({ knowledgeBaseId: this.knowledgeBaseId, title: input.title, content: input.normalizedContent, sourcePath: input.sourcePath, sourceIdentity,
      ...(this.options.deferSynthesis ? { processConfig: { summary_enabled: false, question_generation_config: { enabled: false } } } : {}),
      metadata: {
        relay_ingestion_source: "relay_product_knowledge", relay_source_identity_contract: "weknora-v0.8.3-file-v2",
        relay_document_key: input.idempotencyKey, parser_version: input.parserVersion, normalized_content_sha256: input.normalizedContentSha256,
        ...(input.rawSha256 ? { raw_sha256: input.rawSha256 } : {}), ...(input.productVersion ? { productVersion: input.productVersion } : {}),
        ...(input.solution ? { solution: input.solution } : {}), ...(input.module ? { module: input.module } : {}), ...(input.topicId ? { topicId: input.topicId } : {}),
        ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}), ...(input.language ? { language: input.language } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.environment ? { environment: input.environment } : {}),
      } });
    await options?.onAccepted?.({externalDocumentId:ref.documentId,knowledgeBaseId:this.knowledgeBaseId,parseStatus:ref.parseStatus??"pending",modelProvenance:provenance});
    return this.finishDocument(ref.documentId,provenance,configured,options);
  }
  async resumeDocument(externalDocumentId: string, input: NormalizedWeKnoraInput, options?: WeKnoraWriteOptions): Promise<ExternalDocumentResult> {
    const configured=await this.getModelProvenance(),provenance=configured??validateProvenance(input.modelProvenance);
    if (provenance && (provenance.knowledgeBaseId!==this.knowledgeBaseId || (configured && input.modelProvenance && JSON.stringify(configured)!==JSON.stringify(validateProvenance(input.modelProvenance))))) throw new WeKnoraIngestError("model_provenance_mismatch","Embedding model binding changed before resuming the accepted upload");
    await this.assertConfiguration(configured);
    return this.finishDocument(externalDocumentId,provenance,configured,options);
  }
  private async finishDocument(id: string, provenance: WeKnoraModelProvenance|undefined, configured: WeKnoraModelProvenance|undefined, options?: WeKnoraWriteOptions): Promise<ExternalDocumentResult> {
    const current=await this.client.getDocument(id);
    await options?.onAccepted?.({externalDocumentId:id,knowledgeBaseId:this.knowledgeBaseId,parseStatus:current.parseStatus??"pending",modelProvenance:provenance});
    if (["failed","cancelled","deleting"].includes(current.parseStatus??"")) throw new WeKnoraError("parse_failed",`WeKnora document processing ended with status ${current.parseStatus}`);
    if (current.parseStatus!=="completed") {
      try { await this.client.waitForDocumentReady(id, this.options.readiness); }
      catch (error) {
        if (error instanceof WeKnoraError && error.code === "parse_failed") {
          const terminal = await this.client.getDocument(id);
          await options?.onAccepted?.({externalDocumentId:id,knowledgeBaseId:this.knowledgeBaseId,parseStatus:terminal.parseStatus??"pending",modelProvenance:provenance});
        }
        throw error;
      }
    }
    const chunks = await this.client.listDocumentChunks(id);
    const textChunks = chunks.filter((chunk) => (!chunk.chunkType || chunk.chunkType === "text") && chunk.isEnabled !== false && chunk.content.trim());
    if (!textChunks.length || textChunks.some((chunk) => chunk.indexStatus !== "ready")) {
      throw new WeKnoraIngestError("upstream_not_ready", "WeKnora parse completed without ready indexed text chunks");
    }
    await this.assertConfiguration(configured);
    return verifiedExternal({ externalDocumentId: id, knowledgeBaseId: this.knowledgeBaseId, parseStatus: "completed", externalChunkIds: chunks.filter((chunk) => chunk.isEnabled !== false && chunk.indexStatus === "ready").map((chunk) => chunk.chunkId), modelProvenance: provenance }, provenance);
  }
}

export class WeKnoraIngestor {
  constructor(private readonly store: KnowledgeStore, private readonly writer: WeKnoraDocumentWriter, private readonly clock: () => Date = () => new Date()) {}
  async stage(input: WeKnoraDocumentInput, options?: { retry?: boolean }): Promise<StagedWeKnoraDocument> { return (await this.stageInternal(input, options)).document; }
  async stageBatch(inputs: WeKnoraDocumentInput[], options?: { retry?: boolean }): Promise<WeKnoraIngestBatchReport> {
    const items: WeKnoraIngestBatchItem[] = [];
    for (const input of inputs) {
      try { const outcome = await this.stageInternal(input, options); items.push({ idempotencyKey: input.idempotencyKey, documentId: outcome.document.id, status: outcome.deduplicated ? "skipped" : "staged" }); }
      catch (error) { items.push({ idempotencyKey: input.idempotencyKey, status: "failed", failureCode: failureCode(error), error: sanitizeFailureMessage(error) }); }
    }
    return { total: items.length, staged: items.filter((i) => i.status === "staged").length, skipped: items.filter((i) => i.status === "skipped").length, failed: items.filter((i) => i.status === "failed").length, items };
  }
  get(id: string): StagedWeKnoraDocument | undefined {
    const row = this.store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE id=? OR external_document_id=?").get(id, id) as Record<string, unknown> | undefined;
    return row ? weKnoraDocumentFromRow(row) : undefined;
  }
  isRetrievalVisible(document: StagedWeKnoraDocument): boolean { return document.status === WEKNORA_RETRIEVAL_VISIBLE_STATUS && isVerifiedWeKnoraDocument(document); }
  listRetrievalVisible(filter: WeKnoraRetrievalFilter = {}): StagedWeKnoraDocument[] {
    const conditions = ["status = 'published'"]; const params: unknown[] = [];
    const add = (column: string, value: string | undefined, strict = false) => {
      if (value === undefined) return;
      conditions.push(strict ? `${column} = ?` : `(${column} IS NULL OR ${column} = ?)`); params.push(value);
    };
    add("product_version", filter.productVersion); add("solution", filter.solution); add("module", filter.module); add("topic_id", filter.topicId);
    add("language", filter.language);
    if (filter.projectId !== undefined || filter.environment !== undefined) {
      conditions.push("((project_id IS ? AND environment IS ?) OR (project_id IS NULL AND environment IS NULL))");
      params.push(filter.projectId ?? null, filter.environment ?? null);
    }
    const rows = this.store.db.prepare(`SELECT * FROM knowledge_weknora_documents WHERE ${conditions.join(" AND ")} ORDER BY created_at`).all(...params) as Array<Record<string, unknown>>;
    return rows.map(weKnoraDocumentFromRow).filter((document) => this.isRetrievalVisible(document));
  }
  retrievalKnowledgeIds(filter: WeKnoraRetrievalFilter = {}): string[] { return this.listRetrievalVisible(filter).map((document) => document.externalDocumentId); }
  publish(id: string, actorId: number): StagedWeKnoraDocument {
    const document = this.get(id);
    if (!document || !["staged", "published"].includes(document.status)) throw new Error("WeKnora document is not staged");
    if (!isVerifiedWeKnoraDocument(document)) throw new WeKnoraIngestError("upstream_not_ready", "Cannot publish without verified completed parsing and nonempty chunks");
    const now = this.clock().toISOString();
    this.store.db.prepare("UPDATE knowledge_weknora_documents SET status='published',published_at=?,updated_at=?,deprecated_at=NULL WHERE id=?").run(now, now, document.id);
    this.store.audit({ actorId, action: "knowledge.weknora.publish", entityType: "weknora_document", entityId: document.id, details: { status: "published" } });
    return this.get(document.id)!;
  }
  deprecate(id: string, actorId: number): StagedWeKnoraDocument {
    return this.store.db.transaction(() => {
      const document = this.get(id);
      if (!document) throw new Error("WeKnora document not found");
      if (document.status === "deprecated") return document;
      const now = this.clock().toISOString();
      // Migration 043 withdraws and audits all active mappings in this same
      // transaction, including mappings shared by several migrations.
      this.store.db.prepare("UPDATE knowledge_weknora_documents SET status='deprecated',deprecated_at=?,updated_at=? WHERE id=?").run(now, now, id);
      this.store.audit({ actorId, action: "knowledge.weknora.deprecate", entityType: "weknora_document", entityId: id, details: { previousStatus: document.status } });
      return this.get(id)!;
    }).immediate();
  }
  private assertExternalIdentity(externalId: string, identityHash: string, localId?: string): Record<string, unknown> | undefined {
    const existing = this.store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE external_document_id=?").get(externalId) as Record<string, unknown> | undefined;
    if (existing && existing.id !== localId && (existing.identity_hash !== identityHash || !["staged", "published"].includes(String(existing.status)))) {
      throw new WeKnoraIngestError("external_identity_conflict", "Upstream deduplication returned a document from another Relay scope or identity");
    }
    return existing;
  }
  private async stageInternal(rawInput: WeKnoraDocumentInput, options?: { retry?: boolean }): Promise<{ document: StagedWeKnoraDocument; deduplicated: boolean }> {
    const key = rawInput.idempotencyKey.trim(); if (!key) throw new Error("idempotencyKey is required");
    const configured = await this.writer.getModelProvenance?.();
    const supplied = validateProvenance(rawInput.modelProvenance);
    if (configured && supplied && JSON.stringify(configured) !== JSON.stringify(supplied)) throw new WeKnoraIngestError("model_provenance_mismatch", "Requested embedding model does not match the active binding");
    const input = { ...rawInput, idempotencyKey: key, modelProvenance: validateProvenance(configured ?? supplied) };
    const normalizedContent = normalizeProductContent(input.content); const normalizedContentSha256 = hash(normalizedContent);
    const identityHash = canonicalIdentity(input, normalizedContentSha256);
    const existing = this.store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE idempotency_key=?").get(key) as Record<string, unknown> | undefined;
    if (existing) {
      if (!matchesStoredIdentity(existing, input, normalizedContentSha256, identityHash)) throw new WeKnoraIngestError("idempotency_conflict", "Idempotency key belongs to a different document identity");
      if (["published", "deprecated"].includes(String(existing.status)) || (existing.status === "staged" && isVerifiedWeKnoraDocument(weKnoraDocumentFromRow(existing))) || (existing.status === "failed" && !options?.retry)) return { document: weKnoraDocumentFromRow(existing), deduplicated: true };
      if (existing.normalized_content_sha256 !== normalizedContentSha256) throw new WeKnoraIngestError("parser_upgrade_required", "Changed normalization requires a new parser version and operation key");
      return { document: await this.retryFailed(existing, input, normalizedContent, normalizedContentSha256, identityHash), deduplicated: false };
    }
    // Legacy hashes omitted parserVersion. Require the same parser and raw
    // source proof; explicit parser upgrades always create a new mapping.
    const sameContent = this.store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE identity_hash IN (?,?,?) AND parser_version=? AND raw_sha256 IS ? AND status NOT IN ('deprecated','failed') ORDER BY CASE WHEN identity_hash=? THEN 0 ELSE 1 END LIMIT 1").get(identityHash, legacyCanonicalIdentity(input, normalizedContentSha256), legacyCanonicalIdentity(input, hash(legacyProductMarkupForReplay(input.content))), input.parserVersion, input.rawSha256 ?? null, identityHash) as Record<string, unknown> | undefined;
    if (sameContent && matchesStoredIdentity(sameContent, input, normalizedContentSha256, identityHash) && isVerifiedWeKnoraDocument(weKnoraDocumentFromRow(sameContent))) return { document: weKnoraDocumentFromRow(sameContent), deduplicated: true };
    if (sameContent && matchesStoredIdentity(sameContent, input, normalizedContentSha256, identityHash)) {
      if (sameContent.normalized_content_sha256 !== normalizedContentSha256) throw new WeKnoraIngestError("parser_upgrade_required", "Changed normalization requires a new parser version and operation key");
      return { document: await this.retryFailed(sameContent, input, normalizedContent, normalizedContentSha256, identityHash), deduplicated: false };
    }
    const id = `weknora-${randomUUID()}`; const now = this.clock().toISOString();
    // Reserve the immutable identity before any remote side effect. An unknown
    // acceptance window can only reconcile using this same canonical identity.
    this.insertMapping(id, input, normalizedContentSha256, identityHash, { externalDocumentId: `pending:${id}`, parseStatus: "pending" }, "staged", now);
    const row = this.store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE id=?").get(id) as Record<string, unknown>;
    return { document: await this.retryFailed(row, input, normalizedContent, normalizedContentSha256, identityHash, true), deduplicated: false };
  }
  private insertMapping(id: string, input: WeKnoraDocumentInput, normalizedContentSha256: string, identityHash: string, external: ExternalDocumentResult, status: "staged" | "failed", now: string, code?: string, message?: string): void {
    const row = {
      id, external_document_id: external.externalDocumentId, external_knowledge_base_id: external.knowledgeBaseId ?? input.modelProvenance?.knowledgeBaseId ?? null,
      external_chunk_ids_json: JSON.stringify(external.externalChunkIds ?? []), title: input.title.slice(0, 500), normalized_content_sha256: normalizedContentSha256,
      identity_hash: identityHash, raw_sha256: input.rawSha256 ?? null, parser_version: input.parserVersion, product_version: input.productVersion ?? null,
      solution: input.solution ?? null, module: input.module ?? null, topic_id: input.topicId ?? null, source_path: input.sourcePath ?? null,
      language: input.language ?? null, project_id: input.projectId ?? null, environment: input.environment ?? null,
      upstream_parse_status: external.parseStatus ?? null, upstream_verified_at: null,
      model_provenance_json: JSON.stringify(external.modelProvenance ?? input.modelProvenance ?? {}), status,
      failure_code: code ?? null, failure_message: message ?? null, attempt_count: 1, idempotency_key: input.idempotencyKey, created_at: now, updated_at: now,
    };
    this.store.db.prepare(`INSERT INTO knowledge_weknora_documents(${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  }
  private async retryFailed(row: Record<string, unknown>, input: WeKnoraDocumentInput, normalizedContent: string, normalizedContentSha256: string, identityHash: string, initial = false): Promise<StagedWeKnoraDocument> {
    const id = String(row.id); const attempts = Number(row.attempt_count ?? 0) + (initial ? 0 : 1);
    const onAccepted = (external: ExternalDocumentResult) => this.store.db.transaction(() => {
      const current = this.get(id);
      if (!current || !["staged", "failed"].includes(current.status)) throw new WeKnoraIngestError("ingest_state_conflict", "Document state changed while processing the upload");
      if (!external.externalDocumentId?.trim() || external.externalDocumentId.startsWith("pending:")) throw new WeKnoraIngestError("upstream_not_ready", "Upstream did not return an accepted document id");
      if (!current.externalDocumentId.startsWith("pending:") && current.externalDocumentId !== external.externalDocumentId) throw new WeKnoraIngestError("external_identity_conflict", "Accepted document id changed during recovery");
      const provenance = validateProvenance(external.modelProvenance ?? input.modelProvenance);
      if (provenance && (provenance.knowledgeBaseId !== external.knowledgeBaseId || (input.modelProvenance && JSON.stringify(provenance) !== JSON.stringify(input.modelProvenance)))) throw new WeKnoraIngestError("model_provenance_mismatch", "Accepted upload does not match the frozen model binding");
      const collision = this.assertExternalIdentity(external.externalDocumentId, identityHash, id);
      if (collision && collision.id !== id) throw new WeKnoraIngestError("external_identity_conflict", "Accepted upload belongs to another mapping");
      this.store.db.prepare("UPDATE knowledge_weknora_documents SET external_document_id=?,external_knowledge_base_id=?,upstream_parse_status=?,model_provenance_json=?,upstream_verified_at=NULL,external_chunk_ids_json='[]',status='staged',failure_code=NULL,failure_message=NULL,attempt_count=?,updated_at=? WHERE id=?")
        .run(external.externalDocumentId, external.knowledgeBaseId ?? null, external.parseStatus ?? "pending", JSON.stringify(provenance ?? {}), attempts, this.clock().toISOString(), id);
    }).immediate();
    try {
      const normalized = { ...input, normalizedContent, normalizedContentSha256 };
      let result: ExternalDocumentResult;
      if (!String(row.external_document_id).startsWith("pending:")) {
        if (!this.writer.resumeDocument) throw new WeKnoraIngestError("resume_not_supported", "Accepted upload requires a writer that supports polling recovery");
        result = await this.writer.resumeDocument(String(row.external_document_id), normalized, { onAccepted });
      } else result = await this.writer.upsertDocument(normalized, { onAccepted });
      // Legacy/fake writers may not call the optional acceptance callback.
      onAccepted(result);
      const external = verifiedExternal(result, input.modelProvenance);
      const collision = this.assertExternalIdentity(external.externalDocumentId, identityHash, id);
      if (collision && collision.id !== id) throw new WeKnoraIngestError("external_identity_conflict", "Retry returned another document identity");
      const now = this.clock().toISOString();
      const updated = this.store.db.prepare("UPDATE knowledge_weknora_documents SET external_document_id=?,external_knowledge_base_id=?,external_chunk_ids_json=?,upstream_parse_status='completed',upstream_verified_at=?,model_provenance_json=?,status='staged',failure_code=NULL,failure_message=NULL,attempt_count=?,updated_at=? WHERE id=? AND status='staged' AND external_document_id=?")
        .run(external.externalDocumentId, external.knowledgeBaseId ?? null, JSON.stringify(external.externalChunkIds), now, JSON.stringify(external.modelProvenance ?? {}), attempts, now, id, external.externalDocumentId);
      if (updated.changes !== 1) throw new WeKnoraIngestError("ingest_state_conflict", "Document state changed before readiness was recorded");
      this.store.audit({ projectId: input.projectId, action: "knowledge.weknora.stage", entityType: "weknora_document", entityId: id, details: { externalDocumentId: external.externalDocumentId, normalizedContentSha256, identityHash, status: "staged", retry: true, attemptCount: attempts } });
      return this.get(id)!;
    } catch (error) {
      const code = failureCode(error); const message = sanitizeFailureMessage(error);
      const failed = this.store.db.prepare("UPDATE knowledge_weknora_documents SET status='failed',failure_code=?,failure_message=?,upstream_verified_at=NULL,attempt_count=?,updated_at=? WHERE id=? AND status IN ('staged','failed')").run(code, message, attempts, this.clock().toISOString(), id);
      if (failed.changes) this.store.audit({ projectId: input.projectId, action: "knowledge.weknora.stage", entityType: "weknora_document", entityId: id, details: { status: "failed", failureCode: code, normalizedContentSha256, attemptCount: attempts } });
      throw new WeKnoraIngestError(code, `WeKnora ingest failed (${code}): ${message}`);
    }
  }
}
