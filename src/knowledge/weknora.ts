import { randomUUID } from "node:crypto";

export type WeKnoraErrorCode = "timeout" | "rate_limited" | "unauthorized" | "invalid_response" | "unavailable" | "not_found" | "conflict" | "parse_failed";

export class WeKnoraError extends Error {
  constructor(readonly code: WeKnoraErrorCode, message: string, readonly status?: number, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "WeKnoraError";
  }
}

export interface WeKnoraSourceLocator {
  type: string;
  page?: number; bbox?: number[]; block?: number; slide?: number; sheet?: string;
  row_start?: number; row_end?: number; start?: number; end?: number;
  start_ms?: number; end_ms?: number; section?: number; title?: string; quote?: string;
}

/** Authoritative metadata supplied by Relay's published document mapping. */
export interface WeKnoraReferenceMetadata {
  topicId?: string; version?: string; productVersion?: string; solution?: string; module?: string;
  language?: string; projectId?: string; environment?: string; title?: string;
  sourcePath?: string; sourceSha256?: string; anchor?: string;
}

export interface KnowledgeReference {
  provider: "weknora";
  documentId: string;
  chunkId?: string;
  topicId?: string;
  version?: string;
  solution?: string;
  module?: string;
  language?: string;
  projectId?: string;
  environment?: string;
  title?: string;
  snippet?: string;
  sourcePath?: string;
  sourceSha256?: string;
  sourceLocator?: string;
  sourceLocators?: WeKnoraSourceLocator[];
  citation?: string;
  score?: number;
  matchReason?: string;
  retrievalRunId: string;
}

export interface WeKnoraSearchResult {
  retrievalRunId: string;
  references: KnowledgeReference[];
  degraded?: boolean;
}

/** Safe request trace metadata: never carries query text, request bodies or credentials. */
export interface WeKnoraRequestTrace {
  requestId: string;
  operation: string;
  method: string;
  path: string;
  status?: number;
  latencyMs: number;
  resultCount?: number;
  errorCode?: WeKnoraErrorCode;
  retryAfterSeconds?: number;
}

export interface WeKnoraClientOptions {
  baseUrl: string;
  /** Defaults to X-API-Key; Bearer is valid only for login JWTs. */
  authMode?: "api_key" | "jwt";
  /** Credentials are resolved per request and never logged. */
  secretResolver?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onTrace?: (trace: WeKnoraRequestTrace) => void;
}

export interface WeKnoraSearchInput {
  query: string;
  knowledgeBaseIds?: string[];
  /** An explicit array is an authorization scope, including [] (no documents). */
  knowledgeIds?: string[];
  limit?: number;
  vectorThreshold?: number;
  keywordThreshold?: number;
  rerank?: boolean;
  rerankModelId?: string;
  /** When supplied, only mapped documents may be returned; mapping wins over upstream metadata. */
  documentMetadata?: Record<string, WeKnoraReferenceMetadata>;
  filters?: Record<string, string | boolean | undefined>;
}

/** Public document DTO deliberately omits tenant/KB identifiers and parser error text. */
export interface WeKnoraDocumentRef {
  documentId: string;
  title?: string;
  parseStatus?: string;
  duplicate?: boolean;
}

/** Opaque Relay identity: never contains credentials or source text. */
export interface WeKnoraSourceIdentity { dataSourceId: string; externalId: string; }

// Pinned WeKnora v0.8.3 knowledge_create.go enables datasource_id/external_id
// file dedupe only for gitlab/confluence/seafile channels. This compatibility
// selector does not invoke a connector or establish GitLab source provenance;
// Relay's trusted source mapping remains authoritative for user-visible citations.
const SOURCE_IDENTITY_COMPAT_CHANNEL = "gitlab";

export interface WeKnoraDocumentUpsertInput {
  knowledgeBaseId: string;
  title: string;
  content: string;
  sourcePath?: string;
  metadata?: Record<string, string | number | boolean>;
  sourceIdentity?: WeKnoraSourceIdentity;
}

export interface WeKnoraChunk {
  chunkId: string;
  documentId: string;
  content: string;
  seq: number;
  chunkType?: string;
  isEnabled?: boolean;
  indexStatus?: string;
  sourceLocators?: WeKnoraSourceLocator[];
  contentRevision?: number;
}

export interface WeKnoraDocumentRead extends WeKnoraDocumentRef {
  content: string;
  chunks: WeKnoraChunk[];
}

export interface WeKnoraReadinessOptions { timeoutMs?: number; pollIntervalMs?: number; }
export interface WeKnoraChunkListOptions { pageSize?: number; maxPages?: number; }

const MAX_SNIPPET = 500;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("WeKnora baseUrl is required");
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new Error("WeKnora baseUrl must be a valid URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("WeKnora baseUrl must use HTTP or HTTPS");
  if (parsed.username || parsed.password) throw new Error("WeKnora baseUrl must not contain credentials");
  if (parsed.search || parsed.hash) throw new Error("WeKnora baseUrl must not contain a query or fragment");
  return trimmed.replace(/\/api\/v1$/i, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function locatorsOf(value: unknown): WeKnoraSourceLocator[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const locators = value.flatMap((item) => {
    if (!isRecord(item) || typeof item.type !== "string") return [];
    const locator: WeKnoraSourceLocator = { type: item.type };
    for (const key of ["page", "block", "slide", "row_start", "row_end", "start", "end", "start_ms", "end_ms", "section"] as const) {
      if (typeof item[key] === "number" && Number.isFinite(item[key])) locator[key] = item[key];
    }
    for (const key of ["sheet", "title", "quote"] as const) {
      if (typeof item[key] === "string") locator[key] = item[key].slice(0, key === "quote" ? 300 : 500);
    }
    if (Array.isArray(item.bbox) && item.bbox.length === 4 && item.bbox.every((v) => typeof v === "number" && Number.isFinite(v))) locator.bbox = item.bbox;
    return [locator];
  });
  return locators.length ? locators : undefined;
}

function sourceLocator(metadata: Record<string, unknown>, fallbackFile?: string, positions?: WeKnoraSourceLocator[]): string | undefined {
  const path = firstString(metadata.sourcePath, metadata.source_path, metadata.path) ?? fallbackFile;
  if (!path) return undefined;
  const anchor = firstString(metadata.anchor, metadata.sectionAnchor);
  if (anchor) return `${path}#${anchor}`;
  const position = positions?.[0];
  if (position?.type === "pdf" && position.page) return `${path}#page=${position.page}`;
  if (position?.type === "text" && position.start !== undefined) return `${path}#char=${position.start}-${position.end ?? position.start}`;
  const line = firstString(metadata.lineStart, metadata.line_start, metadata.page);
  return `${path}${line ? `:${line}` : ""}`;
}

export function mapWeKnoraReferences(rows: unknown[], retrievalRunId: string, documentMetadata?: Record<string, WeKnoraReferenceMetadata>): KnowledgeReference[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const documentId = firstString(raw.knowledge_id, raw.knowledgeId, raw.document_id, raw.documentId);
    if (!documentId) return [];
    if (documentMetadata && !Object.hasOwn(documentMetadata, documentId)) return [];
    const metadata: Record<string, unknown> = documentMetadata ? { ...documentMetadata[documentId] } : isRecord(raw.metadata) ? raw.metadata : {};
    const title = firstString(metadata.title, raw.knowledge_title, raw.knowledgeTitle, raw.title);
    const filename = firstString(raw.knowledge_filename, raw.knowledgeFilename);
    const content = firstString(raw.content, raw.text);
    const sourceLocators = locatorsOf(raw.source_locators);
    const locator = sourceLocator(metadata, filename, sourceLocators);
    return [{
      provider: "weknora" as const,
      documentId,
      chunkId: firstString(raw.id, raw.chunk_id, raw.chunkId),
      topicId: firstString(metadata.topicId, metadata.topic_id, metadata.topic),
      version: firstString(metadata.productVersion, metadata.product_version, metadata.version),
      solution: firstString(metadata.solution), module: firstString(metadata.module), language: firstString(metadata.language),
      projectId: firstString(metadata.projectId, metadata.project_id), environment: firstString(metadata.environment),
      title, snippet: content ? content.slice(0, MAX_SNIPPET) : undefined,
      sourcePath: firstString(metadata.sourcePath, metadata.source_path) ?? filename,
      sourceSha256: firstString(metadata.sourceSha256, metadata.raw_sha256, metadata.source_sha256),
      sourceLocator: locator, sourceLocators, citation: locator ?? title,
      score: typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : undefined,
      matchReason: firstString(raw.match_reason, raw.matchReason) ?? "hybrid",
      retrievalRunId,
    }];
  });
}

interface ResolvedScope {
  knowledgeBaseIds: string[];
  knowledgeIds: string[];
  documentsScoped: boolean;
  metadataFilters: Array<{ key: string; value: string }>;
}

const splitList = (value: string): string[] => value.split(",").map((item) => item.trim()).filter(Boolean);

function resolveScope(input: WeKnoraSearchInput): ResolvedScope {
  const scope: ResolvedScope = {
    knowledgeBaseIds: [...(input.knowledgeBaseIds ?? [])], knowledgeIds: [...(input.knowledgeIds ?? [])],
    documentsScoped: input.knowledgeIds !== undefined, metadataFilters: [],
  };
  for (const [key, rawValue] of Object.entries(input.filters ?? {})) {
    if (rawValue === undefined || rawValue === false) continue;
    const value = rawValue === true ? "" : String(rawValue).trim();
    if (["knowledge_base_id", "knowledgeBaseId", "knowledge_base_ids", "knowledgeBaseIds"].includes(key)) {
      scope.knowledgeBaseIds.push(...splitList(value));
    } else if (["knowledge_ids", "knowledgeIds"].includes(key)) {
      const selected = new Set(splitList(value));
      scope.knowledgeIds = scope.documentsScoped ? scope.knowledgeIds.filter((id) => selected.has(id.trim())) : [...selected];
      scope.documentsScoped = true;
    } else if (["topicId", "topic", "version", "productVersion", "solution", "module", "sourcePath", "language", "projectId", "environment"].includes(key) && value) {
      scope.metadataFilters.push({ key: key === "topic" ? "topicId" : key === "productVersion" ? "version" : key, value });
    }
  }
  scope.knowledgeBaseIds = [...new Set(scope.knowledgeBaseIds.map((id) => id.trim()).filter(Boolean))];
  scope.knowledgeIds = [...new Set(scope.knowledgeIds.map((id) => id.trim()).filter(Boolean))];
  if (input.documentMetadata) {
    const mappedIds = Object.keys(input.documentMetadata);
    scope.knowledgeIds = scope.documentsScoped ? scope.knowledgeIds.filter((id) => Object.hasOwn(input.documentMetadata!, id)) : mappedIds;
    scope.documentsScoped = true;
  }
  return scope;
}

function matchesMetadataFilters(reference: KnowledgeReference, filters: ResolvedScope["metadataFilters"]): boolean {
  return filters.every(({ key, value }) => reference[key as keyof KnowledgeReference] === value);
}

function documentFrom(payload: unknown): WeKnoraDocumentRef {
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
  const id = firstString(data?.id);
  if (!id) throw new WeKnoraError("invalid_response", "WeKnora response did not include a document id");
  return { documentId: id, title: firstString(data?.title, data?.file_name), parseStatus: firstString(data?.parse_status) };
}

function chunkFrom(raw: unknown): WeKnoraChunk {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim() || typeof raw.knowledge_id !== "string" || !raw.knowledge_id.trim() || typeof raw.content !== "string") {
    throw new WeKnoraError("invalid_response", "WeKnora returned an invalid document chunk");
  }
  return {
    chunkId: raw.id, documentId: raw.knowledge_id, content: raw.content,
    seq: typeof raw.seq === "number" && Number.isFinite(raw.seq) ? raw.seq : 0,
    chunkType: firstString(raw.chunk_type), isEnabled: typeof raw.is_enabled === "boolean" ? raw.is_enabled : undefined,
    indexStatus: firstString(raw.index_status), sourceLocators: locatorsOf(raw.source_locators),
    contentRevision: typeof raw.content_revision === "number" ? raw.content_revision : undefined,
  };
}

export class WeKnoraClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: WeKnoraClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
  }

  async search(input: WeKnoraSearchInput): Promise<WeKnoraSearchResult> {
    const query = input.query?.trim();
    if (!query) throw new WeKnoraError("invalid_response", "WeKnora search requires a non-empty query");
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 10) || 10, 200));
    const scope = resolveScope(input);
    if (scope.documentsScoped && !scope.knowledgeIds.length) return { retrievalRunId: randomUUID(), references: [] };
    if (!scope.documentsScoped && !scope.knowledgeBaseIds.length) throw new WeKnoraError("invalid_response", "WeKnora search requires an explicit knowledge scope");
    const body: Record<string, unknown> = { query, match_count: scope.metadataFilters.length ? Math.min(200, limit * 3) : limit };
    // Upstream unions KBs and documents. A document allowlist must NEVER carry KB ids.
    if (scope.documentsScoped) body.knowledge_ids = scope.knowledgeIds;
    else if (scope.knowledgeBaseIds.length === 1) body.knowledge_base_id = scope.knowledgeBaseIds[0];
    else body.knowledge_base_ids = scope.knowledgeBaseIds;
    if (typeof input.vectorThreshold === "number") body.vector_threshold = input.vectorThreshold;
    if (typeof input.keywordThreshold === "number") body.keyword_threshold = input.keywordThreshold;
    if (input.rerank === false) body.rerank = { enabled: false };
    else if (input.rerankModelId) body.rerank = { model_id: input.rerankModelId };
    const started = Date.now();
    const response = await this.request("knowledge-search", "POST", "/api/v1/knowledge-search", body);
    const payload = await this.parseBody(response);
    if (!isRecord(payload) || !Array.isArray(payload.data)) throw new WeKnoraError("invalid_response", "WeKnora returned an invalid search result", response.status);
    const runId = response.headers.get("x-request-id")?.trim() || randomUUID();
    const allowed = new Set(scope.knowledgeIds);
    // Upstream returns generated summaries alongside source text. A summary is a
    // retrieval aid, never an authoritative quotation: resolve its verified parent.
    const sourceChunks = new Map<string, WeKnoraChunk>();
    const rows: unknown[] = [];
    for (const raw of payload.data.slice(0, 200)) {
      if (!isRecord(raw)) continue;
      const documentId = firstString(raw.knowledge_id, raw.knowledgeId, raw.document_id, raw.documentId);
      if (!documentId || (scope.documentsScoped && !allowed.has(documentId))) continue;
      if (raw.chunk_type !== "summary") { rows.push(raw); continue; }
      const parentId = firstString(raw.parent_chunk_id);
      if (!parentId) throw new WeKnoraError("invalid_response", "WeKnora summary did not identify its source chunk");
      const parent = sourceChunks.get(parentId) ?? await this.getChunk(parentId);
      sourceChunks.set(parentId, parent);
      if (parent.documentId !== documentId || parent.isEnabled !== true ||
          !["text", "parent_text"].includes(parent.chunkType ?? "") ||
          (parent.indexStatus !== undefined && parent.indexStatus !== "ready")) {
        throw new WeKnoraError("invalid_response", "WeKnora summary returned an invalid source chunk");
      }
      rows.push({ ...raw, id: parent.chunkId, content: parent.content, chunk_type: parent.chunkType,
        source_locators: parent.sourceLocators, match_reason: "summary_match_source_chunk" });
    }
    const seen = new Set<string>();
    const references = mapWeKnoraReferences(rows, runId, input.documentMetadata)
      .filter((reference) => matchesMetadataFilters(reference, scope.metadataFilters))
      .filter((reference) => {
        const identity = `${reference.documentId}:${reference.chunkId}`;
        if (seen.has(identity)) return false;
        seen.add(identity); return true;
      })
      .slice(0, limit);
    this.trace({ requestId: runId, operation: "knowledge-search", method: "POST", path: "/api/v1/knowledge-search", status: response.status, latencyMs: Date.now() - started, resultCount: references.length });
    return { retrievalRunId: runId, references };
  }

  /** Upload normalized Markdown; source identity remains separately available in metadata. */
  async upsertDocument(input: WeKnoraDocumentUpsertInput): Promise<WeKnoraDocumentRef> {
    const knowledgeBaseId = input.knowledgeBaseId.trim();
    if (!knowledgeBaseId) throw new WeKnoraError("invalid_response", "WeKnora upsert requires a knowledge base");
    const path = `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/knowledge/file`;
    let fileName = input.sourcePath?.trim() || `${input.title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120) || "document"}.md`;
    fileName = fileName.replace(/\\/g, "/");
    if (!/\.(md|markdown)$/i.test(fileName)) fileName += ".md";
    const identity = input.sourceIdentity;
    if (identity && [identity.dataSourceId, identity.externalId].some(value => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(value))) {
      throw new WeKnoraError("invalid_response", "WeKnora source identity must contain bounded opaque identifiers");
    }
    const metadata = identity ? { ...input.metadata, datasource_id: identity.dataSourceId, external_id: identity.externalId } : input.metadata;
    const form = new FormData();
    if (identity) form.append("channel", SOURCE_IDENTITY_COMPAT_CHANNEL);
    form.append("file", new Blob([input.content], { type: "text/markdown" }), fileName.split("/").pop() ?? "document.md");
    form.append("fileName", fileName);
    if (metadata) form.append("metadata", JSON.stringify(Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)]))));
    const response = await this.request("knowledge-upsert", "POST", path, form, { allowDuplicate: true });
    const payload = await this.parseBody(response, response.status === 409);
    if (identity) {
      const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
      const echoed = isRecord(data?.metadata) ? data.metadata : undefined;
      if ((response.status === 409 && (!isRecord(payload) || payload.code !== "duplicate_file")) ||
          data?.knowledge_base_id !== knowledgeBaseId || data?.channel !== SOURCE_IDENTITY_COMPAT_CHANNEL ||
          echoed?.datasource_id !== identity.dataSourceId || echoed?.external_id !== identity.externalId) {
        throw new WeKnoraError("conflict", "WeKnora upload returned a conflicting source identity", response.status);
      }
    }
    const result = documentFrom(payload);
    return response.status === 409 ? { ...result, duplicate: true } : result;
  }

  async getDocument(documentId: string, options?: { timeoutMs?: number }): Promise<WeKnoraDocumentRef> {
    const id = this.requireId(documentId, "document");
    const response = await this.request("knowledge-get", "GET", `/api/v1/knowledge/${encodeURIComponent(id)}`, undefined, options);
    const result = documentFrom(await this.parseBody(response));
    if (result.documentId !== id) throw new WeKnoraError("invalid_response", "WeKnora returned a different document");
    return result;
  }

  async waitForDocumentReady(documentId: string, options: WeKnoraReadinessOptions = {}): Promise<WeKnoraDocumentRef> {
    const timeout = Math.max(1, Math.min(options.timeoutMs ?? 120_000, 7_200_000));
    const interval = Math.max(1, Math.min(options.pollIntervalMs ?? 1000, 5000));
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ref = await this.getDocument(documentId, { timeoutMs: Math.max(1, deadline - Date.now()) });
      if (ref.parseStatus === "completed") return ref;
      if (["failed", "cancelled", "deleting"].includes(ref.parseStatus ?? "")) throw new WeKnoraError("parse_failed", `WeKnora document processing ended with status ${ref.parseStatus}`);
      if (!["pending", "processing", "finalizing"].includes(ref.parseStatus ?? "")) throw new WeKnoraError("invalid_response", "WeKnora returned an unknown document parse status");
      await new Promise((resolve) => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
    }
    throw new WeKnoraError("timeout", "WeKnora document readiness timed out");
  }

  async listDocumentChunks(documentId: string, options: WeKnoraChunkListOptions = {}): Promise<WeKnoraChunk[]> {
    const id = this.requireId(documentId, "document");
    const pageSize = Math.max(1, Math.min(Math.trunc(options.pageSize ?? 100) || 100, 100));
    const maxPages = Math.max(1, Math.min(Math.trunc(options.maxPages ?? 1000) || 1000, 1000));
    const chunks: WeKnoraChunk[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= maxPages; page += 1) {
      const payload = await this.requestJson("GET", `/api/v1/chunks/${encodeURIComponent(id)}?page=${page}&page_size=${pageSize}`);
      if (!isRecord(payload) || !Array.isArray(payload.data)) throw new WeKnoraError("invalid_response", "WeKnora returned an invalid chunk list");
      for (const raw of payload.data) {
        const chunk = chunkFrom(raw);
        if (chunk.documentId !== id || seen.has(chunk.chunkId)) throw new WeKnoraError("invalid_response", "WeKnora returned an inconsistent document chunk page");
        seen.add(chunk.chunkId); chunks.push(chunk);
      }
      const total = typeof payload.total === "number" ? payload.total : undefined;
      const returnedPageSize = typeof payload.page_size === "number" && payload.page_size > 0 ? payload.page_size : pageSize;
      if (total !== undefined ? chunks.length >= total : payload.data.length < returnedPageSize) return chunks.sort((a, b) => a.seq - b.seq);
      if (!payload.data.length) throw new WeKnoraError("invalid_response", "WeKnora chunk pagination ended before the reported document total");
    }
    throw new WeKnoraError("invalid_response", "WeKnora document exceeds the chunk pagination limit");
  }

  async getChunk(chunkId: string): Promise<WeKnoraChunk> {
    const id = this.requireId(chunkId, "chunk");
    const payload = await this.requestJson("GET", `/api/v1/chunks/by-id/${encodeURIComponent(id)}`);
    const chunk = chunkFrom(isRecord(payload) ? payload.data : undefined);
    if (chunk.chunkId !== id) throw new WeKnoraError("invalid_response", "WeKnora returned a different chunk");
    return chunk;
  }

  async readDocument(documentId: string, options?: WeKnoraChunkListOptions): Promise<WeKnoraDocumentRead> {
    const document = await this.getDocument(documentId);
    const chunks = await this.listDocumentChunks(documentId, options);
    const textChunks = chunks.filter((chunk) => !chunk.chunkType || chunk.chunkType === "text");
    return { ...document, chunks, content: textChunks.map((chunk) => chunk.content).join("\n\n") };
  }

  async deleteDocument(documentId: string): Promise<{ documentId: string; accepted: boolean }> {
    const id = this.requireId(documentId, "document");
    await this.requestJson("DELETE", `/api/v1/knowledge/${encodeURIComponent(id)}`);
    return { documentId: id, accepted: true };
  }

  /** Authenticated internal transport for bootstrap and Wiki's raw JSON envelopes. */
  async requestJson(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!path.startsWith("/api/v1/") || path.includes("#")) throw new WeKnoraError("invalid_response", "Invalid WeKnora API path");
    const response = await this.request("api-request", method, path, body);
    if (response.status === 204) return undefined;
    return this.parseBody(response);
  }

  private requireId(value: string, kind: string): string {
    const id = value.trim();
    if (!id) throw new WeKnoraError("invalid_response", `WeKnora requires a ${kind} id`);
    return id;
  }

  private async request(operation: string, method: string, path: string, body?: unknown, requestOptions?: { timeoutMs?: number; allowDuplicate?: boolean }): Promise<Response> {
    const controller = new AbortController();
    const timeout = Math.max(1, Math.min(requestOptions?.timeoutMs ?? this.options.timeoutMs ?? 30_000, 120_000));
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new WeKnoraError("timeout", "WeKnora request timed out")); }, timeout);
    });
    const safePath = path.split("?")[0];
    try {
      return await Promise.race([expired, (async () => {
        const token = await this.options.secretResolver?.();
        if (controller.signal.aborted) throw new WeKnoraError("timeout", "WeKnora request timed out");
        const headers: Record<string, string> = { accept: "application/json" };
        if (token) headers[this.options.authMode === "jwt" ? "Authorization" : "X-API-Key"] = this.options.authMode === "jwt" ? `Bearer ${token}` : token;
        const init: RequestInit = { method, headers, signal: controller.signal };
        if (body instanceof FormData) init.body = body;
        else if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
        const classified = this.classifyStatus(response, requestOptions?.allowDuplicate);
        if (classified) { await response.body?.cancel(); throw classified; }
        // Consume the body before releasing the timeout, with a bounded memory budget.
        const reader = response.body?.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new WeKnoraError("invalid_response", "WeKnora response exceeds the size limit"); }
              parts.push(part.value);
            }
          } finally { reader.releaseLock(); }
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
        this.trace({ requestId: response.headers.get("x-request-id") || randomUUID(), operation, method, path: safePath, status: response.status, latencyMs: Date.now() - started });
        return new Response(response.status === 204 ? null : bytes, { status: response.status, headers: response.headers });
      })()]);
    } catch (error) {
      const classified = error instanceof WeKnoraError ? error : new WeKnoraError(controller.signal.aborted ? "timeout" : "unavailable", controller.signal.aborted ? "WeKnora request timed out" : "WeKnora request failed");
      this.trace({ requestId: randomUUID(), operation, method, path: safePath, status: classified.status, latencyMs: Date.now() - started, errorCode: classified.code, retryAfterSeconds: classified.retryAfterSeconds });
      throw classified;
    } finally { clearTimeout(timer); }
  }

  private classifyStatus(response: Response, allowDuplicate = false): WeKnoraError | undefined {
    const status = response.status;
    if (status >= 200 && status < 300) return undefined;
    if (status === 409) return allowDuplicate ? undefined : new WeKnoraError("conflict", "WeKnora resource conflict", status);
    if (status === 401 || status === 403) return new WeKnoraError("unauthorized", "WeKnora authorization failed", status);
    if (status === 404) return new WeKnoraError("not_found", "WeKnora resource not found", status);
    if (status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      return new WeKnoraError("rate_limited", "WeKnora rate limit exceeded", status, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3600) : undefined);
    }
    return new WeKnoraError(status >= 500 ? "unavailable" : "invalid_response", `WeKnora returned HTTP ${status}`, status);
  }

  private async parseBody(response: Response, allowUnsuccessful = false): Promise<unknown> {
    let body: unknown;
    try { body = await response.json(); } catch { throw new WeKnoraError("invalid_response", "WeKnora returned invalid JSON", response.status); }
    if (!isRecord(body) && !Array.isArray(body)) throw new WeKnoraError("invalid_response", "WeKnora returned an invalid response", response.status);
    if (isRecord(body) && body.success === false && !allowUnsuccessful) throw new WeKnoraError("invalid_response", "WeKnora returned an unsuccessful response", response.status);
    return body;
  }

  private trace(trace: WeKnoraRequestTrace): void {
    try { this.options.onTrace?.(trace); } catch { /* Observability must never break requests. */ }
  }
}
