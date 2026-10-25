/**
 * Minimal OpenAI-compatible HTTP calls for managed providers (embedding,
 * rerank, chat). Errors are classified into safe categories; messages and
 * audit never carry prompts, request bodies, or response bodies.
 */
import { providerFailureReasons, readProviderErrorSummary, safeProviderRequestId, type UpstreamErrorSummary } from "./provider-error-summary.js";

export type ManagedProviderErrorCode =
  | "timeout"
  | "rate_limited"
  | "unauthorized"
  | "invalid_response"
  | "invalid_vector"
  | "dimension_mismatch"
  | "unavailable";

const stages = { "/models": "models", "/embeddings": "embedding", "/rerank": "rerank", "/chat/completions": "inference" } as const;
export interface ManagedProviderDiagnostics extends UpstreamErrorSummary {
  stage: (typeof stages)[keyof typeof stages];
  method: "GET" | "POST";
  /** Fixed adapter path only: never a user-supplied URL or query string. */
  endpoint: keyof typeof stages;
  upstreamStatus?: number;
  responseFormat?: "json" | "html" | "other";
}

export class ManagedProviderError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: ManagedProviderErrorCode, message: string, readonly status?: number, readonly diagnostics?: ManagedProviderDiagnostics) {
    const labels = { models: "Model discovery", embedding: "Embedding", rerank: "Rerank", inference: "Inference" };
    const summary = diagnostics
      ? `${diagnostics.upstreamErrorCode ? `; upstream code: ${diagnostics.upstreamErrorCode}` : ""}${diagnostics.upstreamReportedStatus ? `; upstream reported HTTP ${diagnostics.upstreamReportedStatus}` : ""}${diagnostics.reason ? `; ${providerFailureReasons[diagnostics.reason]}` : ""}`
      : "";
    super(diagnostics
      ? `${labels[diagnostics.stage]} failed (${diagnostics.method} ${diagnostics.endpoint}): ${message}${summary}${diagnostics.upstreamRequestId ? `; upstream request ID: ${diagnostics.upstreamRequestId}` : ""}`
      : message);
    this.name = "ManagedProviderError";
    this.retryable = code === "timeout" || code === "rate_limited" || (code === "unavailable" && (status === undefined || status >= 500));
  }
}

export interface ProviderTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ManagedHttpOptions {
  baseUrl: string;
  modelId: string;
  /** Resolved plaintext token for this single call; never logged or stored. */
  token?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
}

export interface EmbeddingCallResult {
  status: number;
  latencyMs: number;
  vectors: number[][];
  tokenUsage?: ProviderTokenUsage;
}

export interface RerankCallResult {
  status: number;
  latencyMs: number;
  scores: Array<{ index: number; score: number }>;
  tokenUsage?: ProviderTokenUsage;
}

export interface ChatCallResult { finishReason?: string;
  status: number;
  latencyMs: number;
  text: string;
  tokenUsage?: ProviderTokenUsage;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function tokenUsageOf(body: unknown): ProviderTokenUsage | undefined {
  const usage = asRecord(asRecord(body)?.usage);
  if (!usage) return undefined;
  const read = (key: string): number | undefined => {
    const value = usage[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const result = { promptTokens: read("prompt_tokens"), completionTokens: read("completion_tokens"), totalTokens: read("total_tokens") };
  return result.promptTokens === undefined && result.completionTokens === undefined && result.totalTokens === undefined ? undefined : result;
}

function safeUpstreamRequestId(response: Response, token?: string, requestBody?: string): string | undefined {
  // Never forward response bodies or arbitrary headers. Reject even a syntactically
  // valid ID if the upstream echoed this call's credential (raw or encoded).
  for (const header of ["x-request-id", "request-id", "cf-ray"]) {
    const id = safeProviderRequestId(response.headers.get(header), token, requestBody);
    if (id) return id;
  }
  return undefined;
}

async function requestJson(options: ManagedHttpOptions, path: keyof typeof stages, payload?: unknown): Promise<{ status: number; latencyMs: number; body: unknown; diagnostics: ManagedProviderDiagnostics }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const diagnostics: ManagedProviderDiagnostics = { stage: stages[path], method: payload === undefined ? "GET" : "POST", endpoint: path };
  const requestBody = payload === undefined ? undefined : JSON.stringify(payload);
  const fail = (code: ManagedProviderErrorCode, message: string) => new ManagedProviderError(code, message, diagnostics.upstreamStatus, diagnostics);
  const started = now();
  let response: Response;
  try {
    response = await fetchImpl(endpoint(options.baseUrl, path), { method: diagnostics.method, headers, body: requestBody, signal: options.signal, redirect: "error" });
  } catch {
    if (options.signal?.aborted) throw fail("timeout", "Managed provider request timed out");
    throw fail("unavailable", "Managed provider request failed before an HTTP response was received");
  }
  diagnostics.upstreamStatus = response.status;
  const upstreamRequestId = safeUpstreamRequestId(response, options.token, requestBody);
  if (upstreamRequestId) diagnostics.upstreamRequestId = upstreamRequestId;
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  diagnostics.responseFormat = contentType === "application/json" || contentType.endsWith("+json") ? "json" : contentType === "text/html" ? "html" : "other";
  const latencyMs = Math.max(0, Math.round(now() - started));
  if (!response.ok) {
    if (diagnostics.responseFormat === "json") {
      const summary = await readProviderErrorSummary(response, options.token, requestBody);
      Object.assign(diagnostics, summary);
      if (upstreamRequestId) diagnostics.upstreamRequestId = upstreamRequestId;
    } else { await response.body?.cancel().catch(() => undefined); }
    if (response.status === 401 || response.status === 403) throw fail("unauthorized", "Managed provider authorization failed; check the token");
    if (response.status === 429) throw fail("rate_limited", "Managed provider rate limit exceeded");
    throw fail("unavailable", `Managed provider returned HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    const limit = path === "/models" ? 2 * 1024 * 1024 : 16 * 1024 * 1024;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error("response too large");
        chunks.push(value);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel(); }
  } catch {
    if (options.signal?.aborted) throw fail("timeout", "Managed provider request timed out");
    throw fail("invalid_response", "Managed provider returned invalid JSON");
  }
  return { status: response.status, latencyMs, body, diagnostics };
}

export async function listOpenAiModels(options: ManagedHttpOptions): Promise<Array<{ id: string }>> {
  const { body, diagnostics } = await requestJson(options, "/models");
  const data = asRecord(body)?.data;
  if (!Array.isArray(data) || data.length > 10_000) throw new ManagedProviderError("invalid_response", "Provider returned an invalid model list", diagnostics.upstreamStatus, diagnostics);
  const ids = new Set<string>();
  for (const entry of data) {
    const id = asRecord(entry)?.id;
    if (typeof id !== "string" || !id.trim() || id.length > 200 || /[\x00-\x1f\x7f]/.test(id) || (options.token && id.includes(options.token))) {
      throw new ManagedProviderError("invalid_response", "Provider returned an invalid model ID", diagnostics.upstreamStatus, diagnostics);
    }
    ids.add(id);
  }
  return [...ids].sort().map((id) => ({ id }));
}

export async function callOpenAiEmbedding(options: ManagedHttpOptions & { texts: string[]; expectedDimensions?: number }): Promise<EmbeddingCallResult> {
  const { status, latencyMs, body, diagnostics } = await requestJson(options, "/embeddings", { model: options.modelId, input: options.texts });
  const data = asRecord(body)?.data;
  if (!Array.isArray(data) || data.length !== options.texts.length) throw new ManagedProviderError("invalid_response", "Embedding response does not match the request shape", status, diagnostics);
  const vectors = data.map((entry) => {
    const embedding = asRecord(entry)?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0 || embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new ManagedProviderError("invalid_vector", "Embedding response contains an invalid vector", status, diagnostics);
    }
    return embedding as number[];
  });
  if (options.expectedDimensions !== undefined) {
    for (const vector of vectors) {
      if (vector.length !== options.expectedDimensions) {
        throw new ManagedProviderError("dimension_mismatch", `Embedding dimension ${vector.length} does not match configured ${options.expectedDimensions}`, status, diagnostics);
      }
    }
  }
  return { status, latencyMs, vectors, tokenUsage: tokenUsageOf(body) };
}

export async function callOpenAiRerank(options: ManagedHttpOptions & { query: string; documents: string[] }): Promise<RerankCallResult> {
  const { status, latencyMs, body, diagnostics } = await requestJson(options, "/rerank", { model: options.modelId, query: options.query, documents: options.documents });
  const results = asRecord(body)?.results;
  if (!Array.isArray(results)) throw new ManagedProviderError("invalid_response", "Rerank response has no results array", status, diagnostics);
  const scores = results.map((entry) => {
    const record = asRecord(entry);
    const index = record?.index;
    const score = record?.relevance_score ?? record?.score;
    if (!Number.isInteger(index) || typeof score !== "number" || !Number.isFinite(score) || (index as number) < 0 || (index as number) >= options.documents.length) {
      throw new ManagedProviderError("invalid_response", "Rerank response contains an invalid result entry", status, diagnostics);
    }
    return { index: index as number, score };
  });
  return { status, latencyMs, scores, tokenUsage: tokenUsageOf(body) };
}

export interface ManagedChatMessage { role: "system" | "user" | "assistant"; content: string; }
export async function callOpenAiChat(options: ManagedHttpOptions & { prompt?: string; messages?: ManagedChatMessage[]; maxTokens?: number; responseFormat?: {type: "text" | "json_object"} }): Promise<ChatCallResult> {
  const { status, latencyMs, body, diagnostics } = await requestJson(options, "/chat/completions", {
    model: options.modelId,
    messages: options.messages ?? [{ role: "user", content: options.prompt ?? "" }],
    ...(options.responseFormat ? {response_format: options.responseFormat} : {}),
    max_tokens: Math.max(1, Math.min(options.maxTokens ?? 16, 32768)),
  });
  const choices = asRecord(body)?.choices;
  const content = Array.isArray(choices) ? asRecord(asRecord(choices[0])?.message)?.content : undefined;
  if (typeof content !== "string") throw new ManagedProviderError("invalid_response", "Chat response has no message content", status, diagnostics);
  return { status, latencyMs, text: content, finishReason: Array.isArray(choices) && typeof asRecord(choices[0])?.finish_reason === "string" ? String(asRecord(choices[0])!.finish_reason) : undefined, tokenUsage: tokenUsageOf(body) };
}
