/**
 * Minimal OpenAI-compatible HTTP calls for managed providers (embedding,
 * rerank, chat). Errors are classified into safe categories; messages and
 * audit never carry prompts, request bodies, or response bodies.
 */
export type ManagedProviderErrorCode =
  | "timeout"
  | "rate_limited"
  | "unauthorized"
  | "invalid_response"
  | "invalid_vector"
  | "dimension_mismatch"
  | "unavailable";

export class ManagedProviderError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: ManagedProviderErrorCode, message: string, readonly status?: number) {
    super(message);
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

export interface ChatCallResult {
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

async function requestJson(options: ManagedHttpOptions, path: string, payload: unknown): Promise<{ status: number; latencyMs: number; body: unknown }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const started = now();
  let response: Response;
  try {
    response = await fetchImpl(endpoint(options.baseUrl, path), { method: "POST", headers, body: JSON.stringify(payload), signal: options.signal });
  } catch {
    if (options.signal?.aborted) throw new ManagedProviderError("timeout", "Managed provider request timed out");
    throw new ManagedProviderError("unavailable", "Managed provider request failed");
  }
  const latencyMs = Math.max(0, Math.round(now() - started));
  if (response.status === 401 || response.status === 403) throw new ManagedProviderError("unauthorized", "Managed provider authorization failed", response.status);
  if (response.status === 429) throw new ManagedProviderError("rate_limited", "Managed provider rate limit exceeded", response.status);
  if (!response.ok) throw new ManagedProviderError("unavailable", `Managed provider returned HTTP ${response.status}`, response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ManagedProviderError("invalid_response", "Managed provider returned invalid JSON");
  }
  return { status: response.status, latencyMs, body };
}

export async function callOpenAiEmbedding(options: ManagedHttpOptions & { texts: string[]; expectedDimensions?: number }): Promise<EmbeddingCallResult> {
  const { status, latencyMs, body } = await requestJson(options, "/embeddings", { model: options.modelId, input: options.texts });
  const data = asRecord(body)?.data;
  if (!Array.isArray(data) || data.length !== options.texts.length) throw new ManagedProviderError("invalid_response", "Embedding response does not match the request shape");
  const vectors = data.map((entry) => {
    const embedding = asRecord(entry)?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0 || embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new ManagedProviderError("invalid_vector", "Embedding response contains an invalid vector");
    }
    return embedding as number[];
  });
  if (options.expectedDimensions !== undefined) {
    for (const vector of vectors) {
      if (vector.length !== options.expectedDimensions) {
        throw new ManagedProviderError("dimension_mismatch", `Embedding dimension ${vector.length} does not match configured ${options.expectedDimensions}`);
      }
    }
  }
  return { status, latencyMs, vectors, tokenUsage: tokenUsageOf(body) };
}

export async function callOpenAiRerank(options: ManagedHttpOptions & { query: string; documents: string[] }): Promise<RerankCallResult> {
  const { status, latencyMs, body } = await requestJson(options, "/rerank", { model: options.modelId, query: options.query, documents: options.documents });
  const results = asRecord(body)?.results;
  if (!Array.isArray(results)) throw new ManagedProviderError("invalid_response", "Rerank response has no results array");
  const scores = results.map((entry) => {
    const record = asRecord(entry);
    const index = record?.index;
    const score = record?.relevance_score ?? record?.score;
    if (!Number.isInteger(index) || typeof score !== "number" || !Number.isFinite(score) || (index as number) < 0 || (index as number) >= options.documents.length) {
      throw new ManagedProviderError("invalid_response", "Rerank response contains an invalid result entry");
    }
    return { index: index as number, score };
  });
  return { status, latencyMs, scores, tokenUsage: tokenUsageOf(body) };
}

export async function callOpenAiChat(options: ManagedHttpOptions & { prompt: string; maxTokens?: number }): Promise<ChatCallResult> {
  const { status, latencyMs, body } = await requestJson(options, "/chat/completions", {
    model: options.modelId,
    messages: [{ role: "user", content: options.prompt }],
    max_tokens: Math.max(1, Math.min(options.maxTokens ?? 16, 256)),
  });
  const choices = asRecord(body)?.choices;
  const content = Array.isArray(choices) ? asRecord(asRecord(choices[0])?.message)?.content : undefined;
  if (typeof content !== "string") throw new ManagedProviderError("invalid_response", "Chat response has no message content");
  return { status, latencyMs, text: content, tokenUsage: tokenUsageOf(body) };
}
