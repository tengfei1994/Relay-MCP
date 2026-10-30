import { createHash } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import type { StagedWeKnoraDocument } from "./weknora-ingest.js";

export const PRODUCT_ENGINE_STATUSES = ["not_indexed", "staged", "published", "failed", "deprecated"] as const;
export type ProductEngineStatus = (typeof PRODUCT_ENGINE_STATUSES)[number];

export interface ProductDocumentEngineState {
  status: ProductEngineStatus;
  externalDocumentId?: string;
  knowledgeBaseId?: string;
  chunkIds: string[];
  parseStatus?: string;
  verifiedAt?: string;
  modelProvenance?: Record<string, unknown>;
  failureCode?: string;
  failureMessage?: string;
  attemptCount: number;
  publishedAt?: string;
  deprecatedAt?: string;
  updatedAt?: string;
}

export type ProductDocumentEngineView = Omit<ProductDocumentEngineState, "knowledgeBaseId">;
export type ProductDocumentPublicView = Omit<ProductDocumentDomainObject, "engine"> & { engine: ProductDocumentEngineView };

/** Public Product responses must not expose the engine's private knowledge-base identifier. */
export function productDocumentEngineView(engine: ProductDocumentEngineState): ProductDocumentEngineView {
  const provenance = engine.modelProvenance;
  const modelProvenance = provenance ? {
    providerId: provenance.providerId,
    modelId: provenance.modelId,
    dimensions: provenance.dimensions,
    indexVersion: provenance.indexVersion,
  } : undefined;
  return {
    status: engine.status,
    externalDocumentId: engine.externalDocumentId,
    chunkIds: engine.chunkIds,
    parseStatus: engine.parseStatus,
    verifiedAt: engine.verifiedAt,
    modelProvenance,
    failureCode: engine.failureCode,
    failureMessage: engine.failureMessage,
    attemptCount: engine.attemptCount,
    publishedAt: engine.publishedAt,
    deprecatedAt: engine.deprecatedAt,
    updatedAt: engine.updatedAt,
  };
}

export function productDocumentPublicView(document: ProductDocumentDomainObject): ProductDocumentPublicView {
  return { ...document, engine: productDocumentEngineView(document.engine) };
}

export interface ProductDocumentDomainObject {
  id: string;
  title: string;
  body: string;
  lifecycle: string;
  documentFamilyId: string;
  topicGroupId: string;
  documentType: string;
  language: string;
  authority: string;
  sourcePath: string;
  sourceSha256?: string;
  normalizedContentSha256?: string;
  parserVersion?: string;
  version: string;
  projectId?: string;
  environment?: string;
  solution?: string;
  module?: string;
  createdAt: string;
  updatedAt: string;
  engine: ProductDocumentEngineState;
}

type Row = Record<string, unknown>;

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const valueText = String(value).trim();
  return valueText || undefined;
}
function parse(value: unknown, fallback: unknown): unknown {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(item => item.trim()))] : [];
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function productDocumentTopicGroupId(store: KnowledgeStore, documentId: string, row?: Row): string {
  const current = row ?? store.db.prepare("SELECT p.topic_group_id,p.document_family_id FROM knowledge_product_documents p WHERE p.id=?").get(documentId) as Row | undefined;
  const explicit = text(current?.topic_group_id);
  if (explicit) return explicit;
  const binding = store.db.prepare("SELECT topic_id FROM knowledge_product_document_bindings WHERE document_id=? ORDER BY updated_at DESC LIMIT 1").get(documentId) as { topic_id?: unknown } | undefined;
  const group = text(binding?.topic_id) ?? (text(current?.document_family_id) ? `family:${text(current?.document_family_id)}` : `document:${documentId}`);
  if (current && store.db.prepare("PRAGMA table_info(knowledge_product_documents)").all().some((column: unknown) => object(column).name === "topic_group_id")) {
    store.db.prepare("UPDATE knowledge_product_documents SET topic_group_id=?,updated_at=? WHERE id=? AND (topic_group_id IS NULL OR trim(topic_group_id)='')").run(group, new Date().toISOString(), documentId);
  }
  return group;
}

export function productDocumentEngineState(row: Row): ProductDocumentEngineState {
  const status = PRODUCT_ENGINE_STATUSES.includes(String(row.engine_status) as ProductEngineStatus) ? String(row.engine_status) as ProductEngineStatus : "not_indexed";
  return {
    status,
    externalDocumentId: text(row.engine_external_document_id),
    knowledgeBaseId: text(row.engine_knowledge_base_id),
    chunkIds: strings(parse(row.engine_chunk_ids_json, [])),
    parseStatus: text(row.engine_parse_status),
    verifiedAt: text(row.engine_verified_at),
    modelProvenance: object(parse(row.engine_model_provenance_json, {})),
    failureCode: text(row.engine_failure_code),
    failureMessage: text(row.engine_failure_message),
    attemptCount: Number(row.engine_attempt_count ?? 0),
    publishedAt: text(row.engine_published_at),
    deprecatedAt: text(row.engine_deprecated_at),
    updatedAt: text(row.engine_updated_at),
  };
}

export function productDocumentFromRow(store: KnowledgeStore, row: Row): ProductDocumentDomainObject {
  const topicGroupId = productDocumentTopicGroupId(store, String(row.id), row);
  return {
    id: String(row.id), title: String(row.title ?? ""), body: String(row.body ?? ""), lifecycle: String(row.lifecycle ?? "draft"),
    documentFamilyId: String(row.document_family_id ?? ""), topicGroupId, documentType: String(row.document_type ?? ""),
    language: String(row.language ?? "en"), authority: String(row.authority ?? "official"), sourcePath: String(row.source_path ?? row.source_locator ?? ""),
    sourceSha256: text(row.source_sha256 ?? row.product_source_sha256 ?? row.document_source_sha256), normalizedContentSha256: text(row.normalized_content_sha256),
    parserVersion: text(row.parser_version), version: String(row.version ?? row.samplemanager_version ?? ""), projectId: text(row.project_id), environment: text(row.environment),
    solution: text(row.solution), module: text(row.module), createdAt: String(row.created_at ?? ""), updatedAt: String(row.updated_at ?? ""), engine: productDocumentEngineState(row),
  };
}

export function loadProductDocumentDomainObject(store: KnowledgeStore, id: string): ProductDocumentDomainObject | undefined {
  const row = store.db.prepare(`SELECT d.*,p.document_family_id,p.document_type,p.language,p.authority,p.source_path,p.source_sha256 AS product_source_sha256,
    p.version,p.normalized_content_sha256,p.parser_version,p.topic_group_id,p.engine_external_document_id,p.engine_knowledge_base_id,
    p.engine_chunk_ids_json,p.engine_identity_hash,p.engine_idempotency_key,p.engine_status,p.engine_parse_status,p.engine_verified_at,
    p.engine_model_provenance_json,p.engine_failure_code,p.engine_failure_message,p.engine_attempt_count,p.engine_published_at,
    p.engine_deprecated_at,p.engine_updated_at
    FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id
    WHERE d.id=? AND d.kind='product_document'`).get(id) as Row | undefined;
  return row ? productDocumentFromRow(store, row) : undefined;
}

export function syncProductDocumentEngineProjection(store: KnowledgeStore, localDocumentId: string, document: StagedWeKnoraDocument): void {
  const now = new Date().toISOString();
  const columns = store.db.prepare("PRAGMA table_info(knowledge_product_documents)").all().map((column: unknown) => String(object(column).name ?? ""));
  if (!columns.includes("engine_external_document_id")) return;
  store.db.prepare(`UPDATE knowledge_product_documents SET
    engine_external_document_id=?,engine_knowledge_base_id=?,engine_chunk_ids_json=?,engine_status=?,engine_parse_status=?,engine_verified_at=?,
    engine_model_provenance_json=?,engine_failure_code=?,engine_failure_message=?,engine_attempt_count=?,engine_published_at=?,engine_deprecated_at=?,engine_updated_at=?,
    normalized_content_sha256=COALESCE(normalized_content_sha256,?),parser_version=COALESCE(parser_version,?),topic_group_id=COALESCE(topic_group_id,?),updated_at=?
    WHERE id=?`).run(
    document.externalDocumentId, document.knowledgeBaseId ?? null, JSON.stringify(document.externalChunkIds), document.status,
    document.upstreamParseStatus ?? null, document.upstreamVerifiedAt ?? null, JSON.stringify(document.modelProvenance ?? {}),
    document.failureCode ?? null, document.failureMessage ?? null, document.attemptCount, document.publishedAt ?? null, document.deprecatedAt ?? null,
    now, document.normalizedContentSha256, document.parserVersion, productDocumentTopicGroupId(store, localDocumentId), now, localDocumentId,
  );
}

export function markProductDocumentEngineFailure(store: KnowledgeStore, localDocumentId: string, error: { code?: string; message: string }, attemptCount: number): void {
  store.db.prepare(`UPDATE knowledge_product_documents SET engine_status='failed',engine_failure_code=?,engine_failure_message=?,engine_attempt_count=?,engine_verified_at=NULL,engine_updated_at=?,updated_at=? WHERE id=?`)
    .run(String(error.code ?? "writer_error").slice(0, 100), error.message.slice(0, 300), attemptCount, new Date().toISOString(), new Date().toISOString(), localDocumentId);
}

export function productDocumentFingerprint(row: Row): string {
  return createHash("sha256").update(JSON.stringify([
    row.id, row.source_sha256, row.source_locator, row.updated_at, row.version, row.solution, row.module, row.topic_group_id,
  ])).digest("hex");
}
