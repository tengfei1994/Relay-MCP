import { createHash } from "crypto";

export interface ProviderCapabilities {
  modelId: string;
  dimensions?: number;
  supportsStreaming?: boolean;
  dataPolicy: "local" | "enterprise" | "cloud";
}

export interface EmbeddingProvider {
  readonly capabilities: ProviderCapabilities;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface RerankProvider {
  readonly capabilities: ProviderCapabilities;
  rerank(query: string, documents: Array<{ id: string; text: string; score: number }>, signal?: AbortSignal): Promise<Array<{ id: string; score: number; reason?: string }>>;
}

export interface InferenceProvider {
  readonly capabilities: ProviderCapabilities;
  complete(prompt: string, signal?: AbortSignal): Promise<string>;
}

export interface RedactionProvider {
  readonly capabilities: ProviderCapabilities;
  redact(text: string, signal?: AbortSignal): Promise<{ text: string; redacted: boolean; findings: string[] }>;
}

export interface KnowledgeProviders {
  embedding?: EmbeddingProvider;
  rerank?: RerankProvider;
  inference?: InferenceProvider;
  redaction?: RedactionProvider;
}

export class ProviderUnavailableError extends Error {
  readonly code: string = "provider_unavailable";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderUnavailableError";
  }
}

/** A deterministic local embedding used for tests and FTS-only deployments. */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly capabilities: ProviderCapabilities;
  constructor(dimensions = 32) {
    this.capabilities = { modelId: "local-deterministic-v1", dimensions, dataPolicy: "local" };
  }
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    return texts.map((text) => {
      if (signal?.aborted) throw new ProviderUnavailableError("embedding aborted");
      const vector = new Array<number>(this.capabilities.dimensions ?? 32).fill(0);
      const hash = createHash("sha256").update(text, "utf8").digest();
      for (let index = 0; index < vector.length; index++) vector[index] = (hash[index % hash.length] - 128) / 128;
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      return vector.map((value) => value / norm);
    });
  }
}

export class LexicalRerankProvider implements RerankProvider {
  readonly capabilities: ProviderCapabilities = { modelId: "local-lexical-v1", dataPolicy: "local" };
  async rerank(query: string, documents: Array<{ id: string; text: string; score: number }>, signal?: AbortSignal) {
    const tokens = new Set(tokenize(query));
    if (signal?.aborted) throw new ProviderUnavailableError("rerank aborted");
    return documents.map((document) => {
      const overlap = tokenize(document.text).filter((token) => tokens.has(token)).length;
      return { id: document.id, score: document.score + overlap / Math.max(1, tokens.size), reason: overlap ? `lexical overlap ${overlap}` : "semantic/FTS score only" };
    }).sort((a, b) => b.score - a.score);
  }
}

export class RegexRedactionProvider implements RedactionProvider {
  readonly capabilities: ProviderCapabilities = { modelId: "local-regex-v1", dataPolicy: "local" };
  async redact(text: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new ProviderUnavailableError("redaction aborted");
    const findings: string[] = [];
    const patterns: Array<[string, RegExp]> = [
      ["credential", /(password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s;,]+/gi],
      ["bearer", /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi],
      ["connection-string", /(Server|Data Source)=[^;]+;[^\n]*/gi],
    ];
    let output = text;
    for (const [name, pattern] of patterns) {
      if (pattern.test(output)) findings.push(name);
      output = output.replace(pattern, (match) => match.replace(/([:=]\s*).*/, "$1[REDACTED]"));
    }
    return { text: output, redacted: findings.length > 0, findings };
  }
}

export function tokenize(text: string): string[] {
  return text.toLocaleLowerCase().split(/[^\p{L}\p{N}_./-]+/u).filter((token) => token.length > 0);
}

export function defaultKnowledgeProviders(): Required<Pick<KnowledgeProviders, "embedding" | "rerank" | "redaction">> {
  return { embedding: new DeterministicEmbeddingProvider(), rerank: new LexicalRerankProvider(), redaction: new RegexRedactionProvider() };
}
