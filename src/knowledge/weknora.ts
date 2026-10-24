import { randomUUID } from "node:crypto";

export type WeKnoraErrorCode = "timeout" | "rate_limited" | "unauthorized" | "invalid_response" | "unavailable" | "not_found" | "conflict";

export class WeKnoraError extends Error {
  constructor(readonly code: WeKnoraErrorCode, message: string, readonly status?: number, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "WeKnoraError";
  }
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
  title?: string;
  snippet?: string;
  sourceLocator?: string;
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

/** Safe request trace metadata: never carries the query text or API token. */
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
  /** The only source of credentials; resolved per request and never logged. */
  secretResolver?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onTrace?: (trace: WeKnoraRequestTrace) => void;
}

export interface WeKnoraSearchInput {
  query: string;
  knowledgeBaseIds?: string[];
  knowledgeIds?: string[];
  limit?: number;
  vectorThreshold?: number;
  keywordThreshold?: number;
  rerank?: boolean;
  /**
   * Legacy Relay filter contract kept for MCP/tool callers. Scope keys
   * (knowledge_base_id(s)/knowledge_ids) map onto the upstream request;
   * metadata keys (topicId, version/productVersion, solution, module,
   * sourcePath, language) are enforced client-side on returned references.
   */
  filters?: Record<string, string | boolean | undefined>;
}

/** Public document DTO: deliberately omits the raw knowledge base id. */
export interface WeKnoraDocumentRef {
  documentId: string;
  title?: string;
  parseStatus?: string;
  /** True when the upstream returned the pre-existing document (HTTP 409 dedupe). */
  duplicate?: boolean;
}

export interface WeKnoraDocumentUpsertInput {
  knowledgeBaseId: string;
  title: string;
  content: string;
  /** Optional KB-relative folder/file path (e.g. the Relay source path). */
  sourcePath?: string;
  metadata?: Record<string, string | number | boolean>;
}

const MAX_SNIPPET = 500;

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("WeKnora baseUrl is required");
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new Error("WeKnora baseUrl must be a valid URL"); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("WeKnora baseUrl must use HTTP or HTTPS");
  if (parsed.username || parsed.password) throw new Error("WeKnora baseUrl must not contain credentials");
  return trimmed.replace(/\/api\/v1$/i, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function metadataOf(row: Record<string, unknown>): Record<string, unknown> {
  return isRecord(row.metadata) ? row.metadata : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function sourceLocator(metadata: Record<string, unknown>, fallbackFile?: string): string | undefined {
  const path = firstString(metadata.sourcePath, metadata.source_path, metadata.path) ?? fallbackFile;
  if (!path) return undefined;
  const anchor = firstString(metadata.anchor, metadata.sectionAnchor);
  const line = firstString(metadata.lineStart, metadata.line_start, metadata.page);
  return `${path}${anchor ? `#${anchor}` : line ? `:${line}` : ""}`;
}

export function mapWeKnoraReferences(rows: unknown[], retrievalRunId: string): KnowledgeReference[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const metadata = metadataOf(raw);
    const documentId = firstString(raw.knowledge_id, raw.knowledgeId, raw.document_id, raw.documentId, metadata.relay_document_id);
    if (!documentId) return [];
    const chunkId = firstString(raw.id, raw.chunk_id, raw.chunkId);
    const title = firstString(raw.knowledge_title, raw.knowledgeTitle, raw.title);
    const filename = firstString(raw.knowledge_filename, raw.knowledgeFilename);
    const content = firstString(raw.content, raw.text);
    const locator = sourceLocator(metadata, filename);
    const score = typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : undefined;
    return [{
      provider: "weknora" as const,
      documentId,
      chunkId,
      topicId: firstString(metadata.topicId, metadata.topic_id, metadata.topic),
      version: firstString(metadata.productVersion, metadata.product_version, metadata.version),
      solution: firstString(metadata.solution),
      module: firstString(metadata.module),
      language: firstString(metadata.language),
      title,
      snippet: content ? content.slice(0, MAX_SNIPPET) : undefined,
      sourceLocator: locator,
      citation: locator ?? title,
      score,
      matchReason: firstString(raw.match_reason, raw.matchReason) ?? "hybrid",
      retrievalRunId,
    }];
  });
}

interface ResolvedScope {
  knowledgeBaseIds: string[];
  knowledgeIds: string[];
  metadataFilters: Array<{ key: string; value: string }>;
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function resolveScope(input: WeKnoraSearchInput): ResolvedScope {
  const scope: ResolvedScope = {
    knowledgeBaseIds: [...(input.knowledgeBaseIds ?? [])],
    knowledgeIds: [...(input.knowledgeIds ?? [])],
    metadataFilters: [],
  };
  const filters = input.filters ?? {};
  for (const [rawKey, rawValue] of Object.entries(filters)) {
    if (rawValue === undefined || rawValue === false) continue;
    const key = rawKey.trim();
    const value = rawValue === true ? "" : String(rawValue).trim();
    if (key === "knowledge_base_id" || key === "knowledgeBaseId" || key === "knowledge_base_ids" || key === "knowledgeBaseIds") {
      if (value) scope.knowledgeBaseIds.push(...splitList(value));
    } else if (key === "knowledge_ids" || key === "knowledgeIds") {
      if (value) scope.knowledgeIds.push(...splitList(value));
    } else if (["topicId", "topic", "version", "productVersion", "solution", "module", "sourcePath", "language"].includes(key) && value) {
      scope.metadataFilters.push({ key: key === "topic" ? "topicId" : key === "productVersion" ? "version" : key, value });
    }
  }
  scope.knowledgeBaseIds = [...new Set(scope.knowledgeBaseIds)];
  scope.knowledgeIds = [...new Set(scope.knowledgeIds)];
  return scope;
}

function matchesMetadataFilters(reference: KnowledgeReference, filters: ResolvedScope["metadataFilters"]): boolean {
  return filters.every(({ key, value }) => {
    const actual = key === "topicId" ? reference.topicId
      : key === "version" ? reference.version
      : key === "solution" ? reference.solution
      : key === "module" ? reference.module
      : key === "language" ? reference.language
      : key === "sourcePath" ? (reference.sourceLocator?.split("#")[0]?.split(":")[0] ?? undefined)
      : undefined;
    return actual === value;
  });
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
    const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
    const scope = resolveScope(input);
    // Over-fetch when client-side metadata filters apply so the final page is
    // not starved by filtered-out rows; the upstream cap is 100.
    const matchCount = scope.metadataFilters.length ? Math.min(100, limit * 3) : limit;
    const body: Record<string, unknown> = { query, match_count: matchCount };
    if (scope.knowledgeBaseIds.length === 1) body.knowledge_base_id = scope.knowledgeBaseIds[0];
    else if (scope.knowledgeBaseIds.length > 1) body.knowledge_base_ids = scope.knowledgeBaseIds;
    if (scope.knowledgeIds.length) body.knowledge_ids = scope.knowledgeIds;
    if (typeof input.vectorThreshold === "number") body.vector_threshold = input.vectorThreshold;
    if (typeof input.keywordThreshold === "number") body.keyword_threshold = input.keywordThreshold;
    if (input.rerank === false) body.rerank = { enabled: false };

    const started = Date.now();
    const response = await this.request("knowledge-search", "POST", "/api/v1/knowledge-search", body);
    const payload = await this.parseBody(response, "knowledge-search", started, "POST", "/api/v1/knowledge-search");
    const value = payload as Record<string, unknown>;
    if (value.success === false) throw new WeKnoraError("invalid_response", "WeKnora returned an unsuccessful response", response.status);
    const rows = Array.isArray(value.data) ? value.data : [];
    const runId = response.headers.get("x-request-id")?.trim() || randomUUID();
    const references = mapWeKnoraReferences(rows, runId)
      .filter((reference) => matchesMetadataFilters(reference, scope.metadataFilters))
      .slice(0, limit);
    this.trace({ requestId: runId, operation: "knowledge-search", method: "POST", path: "/api/v1/knowledge-search", status: response.status, latencyMs: Date.now() - started, resultCount: references.length });
    return { retrievalRunId: runId, references };
  }

  /** Upsert a Markdown document through the stable file-ingest endpoint. */
  async upsertDocument(input: WeKnoraDocumentUpsertInput): Promise<WeKnoraDocumentRef> {
    const knowledgeBaseId = input.knowledgeBaseId.trim();
    if (!knowledgeBaseId) throw new WeKnoraError("invalid_response", "WeKnora upsert requires a knowledge base");
    const started = Date.now();
    const path = `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/knowledge/file`;
    const fileName = (input.sourcePath?.trim() || `${input.title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120) || "document"}.md`);
    const form = new FormData();
    form.append("file", new Blob([input.content], { type: "text/markdown" }), fileName.split("/").pop() ?? "document.md");
    form.append("fileName", fileName);
    if (input.metadata) form.append("metadata", JSON.stringify(input.metadata));
    const response = await this.request("knowledge-upsert", "POST", path, form);
    if (response.status === 409) {
      // WeKnora dedupes identical files with HTTP 409 and returns the existing
      // Knowledge in data; that is the upsert path for repeated imports.
      const payload = await this.parseBody(response, "knowledge-upsert", started, "POST", path);
      const documentId = this.documentIdFrom(payload);
      this.trace({ requestId: randomUUID(), operation: "knowledge-upsert", method: "POST", path, status: 409, latencyMs: Date.now() - started });
      return { documentId, title: this.documentTitle(payload), parseStatus: this.parseStatus(payload), duplicate: true };
    }
    const payload = await this.parseBody(response, "knowledge-upsert", started, "POST", path);
    const documentId = this.documentIdFrom(payload);
    this.trace({ requestId: randomUUID(), operation: "knowledge-upsert", method: "POST", path, status: response.status, latencyMs: Date.now() - started });
    return { documentId, title: this.documentTitle(payload), parseStatus: this.parseStatus(payload) };
  }

  async getDocument(documentId: string): Promise<WeKnoraDocumentRef> {
    const id = documentId.trim();
    if (!id) throw new WeKnoraError("invalid_response", "WeKnora get requires a document id");
    const started = Date.now();
    const path = `/api/v1/knowledge/${encodeURIComponent(id)}`;
    const response = await this.request("knowledge-get", "GET", path);
    const payload = await this.parseBody(response, "knowledge-get", started, "GET", "/api/v1/knowledge/:id");
    const result = { documentId: this.documentIdFrom(payload), title: this.documentTitle(payload), parseStatus: this.parseStatus(payload) };
    this.trace({ requestId: randomUUID(), operation: "knowledge-get", method: "GET", path: "/api/v1/knowledge/:id", status: response.status, latencyMs: Date.now() - started });
    return result;
  }

  async deleteDocument(documentId: string): Promise<{ documentId: string; accepted: boolean }> {
    const id = documentId.trim();
    if (!id) throw new WeKnoraError("invalid_response", "WeKnora delete requires a document id");
    const started = Date.now();
    const path = `/api/v1/knowledge/${encodeURIComponent(id)}`;
    const response = await this.request("knowledge-delete", "DELETE", path);
    await this.parseBody(response, "knowledge-delete", started, "DELETE", "/api/v1/knowledge/:id");
    this.trace({ requestId: randomUUID(), operation: "knowledge-delete", method: "DELETE", path: "/api/v1/knowledge/:id", status: response.status, latencyMs: Date.now() - started });
    return { documentId: id, accepted: true };
  }

  private documentIdFrom(payload: unknown): string {
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
    const id = firstString(data?.id, data?.knowledge_id, isRecord(payload) ? payload.id : undefined);
    if (!id) throw new WeKnoraError("invalid_response", "WeKnora response did not include a document id");
    return id;
  }

  private documentTitle(payload: unknown): string | undefined {
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
    return firstString(data?.title, data?.file_name);
  }

  private parseStatus(payload: unknown): string | undefined {
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
    return firstString(data?.parse_status, data?.parseStatus);
  }

  private async request(operation: string, method: string, path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timeout = Math.max(100, Math.min(this.options.timeoutMs ?? 30_000, 120_000));
    const timer = setTimeout(() => controller.abort(), timeout);
    const started = Date.now();
    try {
      const token = await this.options.secretResolver?.();
      const headers: Record<string, string> = { accept: "application/json" };
      if (token) headers["X-API-Key"] = token;
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body instanceof FormData) init.body = body;
      else if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      } catch {
        const code: WeKnoraErrorCode = controller.signal.aborted ? "timeout" : "unavailable";
        this.trace({ requestId: randomUUID(), operation, method, path, latencyMs: Date.now() - started, errorCode: code });
        throw new WeKnoraError(code, code === "timeout" ? "WeKnora request timed out" : "WeKnora request failed");
      }
      const classified = this.classifyStatus(response);
      if (classified) {
        this.trace({ requestId: response.headers.get("x-request-id")?.trim() || randomUUID(), operation, method, path, status: response.status, latencyMs: Date.now() - started, errorCode: classified.code, retryAfterSeconds: classified.retryAfterSeconds });
        throw classified;
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  private classifyStatus(response: Response): WeKnoraError | undefined {
    const status = response.status;
    if (status >= 200 && status < 300) return undefined;
    if (status === 409) return undefined; // handled by the caller as dedupe
    if (status === 401 || status === 403) return new WeKnoraError("unauthorized", "WeKnora authorization failed", status);
    if (status === 404) return new WeKnoraError("not_found", "WeKnora resource not found", status);
    if (status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3600) : undefined;
      return new WeKnoraError("rate_limited", "WeKnora rate limit exceeded", status, retryAfterSeconds);
    }
    if (status >= 500) return new WeKnoraError("unavailable", `WeKnora returned HTTP ${status}`, status);
    return new WeKnoraError("invalid_response", `WeKnora rejected the request with HTTP ${status}`, status);
  }

  private async parseBody(response: Response, operation: string, started: number, method = "", path = ""): Promise<unknown> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      this.trace({ requestId: randomUUID(), operation, method, path, status: response.status, latencyMs: Date.now() - started, errorCode: "invalid_response" });
      throw new WeKnoraError("invalid_response", "WeKnora returned invalid JSON", response.status);
    }
    if (!isRecord(body)) throw new WeKnoraError("invalid_response", "WeKnora returned an invalid response", response.status);
    return body;
  }

  private trace(trace: WeKnoraRequestTrace): void {
    try {
      this.options.onTrace?.(trace);
    } catch {
      // Tracing is observability only; a broken sink must never break retrieval.
    }
  }
}
