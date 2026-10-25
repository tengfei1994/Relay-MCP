import { randomUUID } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import { ProviderUnavailableError } from "./providers.js";
import { ProviderPolicy, type ProviderConfig, type ProviderHealth, type ProviderPolicyOptions, type ProviderCallOptions } from "./provider-runtime.js";
import type { SecretResolver } from "./provider-secret.js";
import { ManagedProviderError, callOpenAiChat, callOpenAiEmbedding, callOpenAiRerank, type ManagedHttpOptions, type ManagedChatMessage, type ProviderTokenUsage } from "./provider-probe.js";

export type ManagedProviderKind = "embedding" | "rerank" | "wiki_llm" | "candidate_llm";
export type ManagedProviderStatus = "ready" | "pending_reindex" | "degraded" | "disabled";
export interface ProviderQuotaConfig { maxCalls: number; windowMs: number; }
export interface ProviderConfigInput { id: string; kind: ManagedProviderKind; provider: string; baseUrl?: string; modelId: string; dimensions?: number; batchSize?: number; timeoutMs?: number; concurrency?: number; maxRetries?: number; dataResidency?: string; secretRef?: string; quota?: ProviderQuotaConfig; actorId: number; }
export interface ProviderConfigMetadata { id: string; kind: ManagedProviderKind; provider: string; baseUrl?: string; modelId: string; dimensions?: number; batchSize?: number; timeoutMs: number; concurrency: number; maxRetries: number; dataResidency?: string; status: ManagedProviderStatus; tokenConfigured: boolean; reindexRequired: boolean; indexVersion: number; quota?: ProviderQuotaConfig; lastTestAt?: string; lastErrorCode?: string; createdAt: string; updatedAt: string; disabledAt?: string; }
export type ProviderReindexJobStatus = "pending" | "running" | "completed" | "failed";
export interface ProviderReindexJob { id: string; providerId: string; indexVersion: number; fromModelId?: string; fromDimensions?: number; toModelId: string; toDimensions?: number; status: ProviderReindexJobStatus; errorCode?: string; createdAt: string; updatedAt: string; completedAt?: string; }
export interface PendingReindexEntry { job: ProviderReindexJob; provider: ProviderConfigMetadata; }
/** Numeric, credential-free probe outcome; safe for DTOs and audit. */
export interface ProviderProbeReport { ok: boolean; errorCode?: string; latencyMs?: number; httpStatus?: number; observedDimensions?: number; tokenUsage?: ProviderTokenUsage; }
export interface ProviderRegistryRuntimeOptions { secrets?: SecretResolver; fetchImpl?: typeof fetch; policy?: ProviderPolicyOptions; }

const EMBEDDING_PROBE_TEXT = "relay managed provider connectivity probe";
const RERANK_PROBE_DOCUMENT = "relay managed provider connectivity probe";
const CHAT_PROBE_PROMPT = "Reply with the word ok.";

/** Provider endpoints are configuration, never a credential transport. */
export function validateProviderBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new Error("Provider base URL must be a valid URL"); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Provider base URL must use HTTP or HTTPS");
  if (parsed.username || parsed.password) throw new Error("Provider base URL must not contain credentials");
  return trimmed;
}

function safeProviderBaseUrl(value: unknown): string | undefined {
  try { return validateProviderBaseUrl(value == null ? undefined : String(value)); } catch { return undefined; }
}

function rowToConfig(row: Record<string, unknown>): ProviderConfigMetadata {
  return { id: String(row.id), kind: String(row.kind) as ManagedProviderKind, provider: String(row.provider), baseUrl: safeProviderBaseUrl(row.base_url), modelId: String(row.model_id), dimensions: row.dimensions == null ? undefined : Number(row.dimensions), batchSize: row.batch_size == null ? undefined : Number(row.batch_size), timeoutMs: Number(row.timeout_ms), concurrency: Number(row.concurrency), maxRetries: Number(row.max_retries), dataResidency: row.data_residency ? String(row.data_residency) : undefined, status: String(row.status) as ManagedProviderStatus, tokenConfigured: Number(row.token_configured) === 1, reindexRequired: Number(row.reindex_required) === 1, indexVersion: Number(row.index_version ?? 1), quota: row.quota_max_calls != null && row.quota_window_ms != null ? { maxCalls: Number(row.quota_max_calls), windowMs: Number(row.quota_window_ms) } : undefined, lastTestAt: row.last_test_at ? String(row.last_test_at) : undefined, lastErrorCode: row.last_error_code ? String(row.last_error_code) : undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at), disabledAt: row.disabled_at ? String(row.disabled_at) : undefined };
}

function rowToReindexJob(row: Record<string, unknown>): ProviderReindexJob {
  return { id: String(row.id), providerId: String(row.provider_id), indexVersion: Number(row.index_version), fromModelId: row.from_model_id ? String(row.from_model_id) : undefined, fromDimensions: row.from_dimensions == null ? undefined : Number(row.from_dimensions), toModelId: String(row.to_model_id), toDimensions: row.to_dimensions == null ? undefined : Number(row.to_dimensions), status: String(row.status) as ProviderReindexJobStatus, errorCode: row.error_code ? String(row.error_code) : undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at), completedAt: row.completed_at ? String(row.completed_at) : undefined };
}

function assertSecretRef(value: string | undefined): void {
  if (!value) return;
  if (value.length > 500 || /(^|\b)(api[_-]?key|token|password|secret)\s*[:=]/i.test(value) || /^sk-[A-Za-z0-9]/.test(value)) throw new Error("Provider secret must be a reference, not a raw secret");
}

function assertQuota(quota: ProviderQuotaConfig | undefined): void {
  if (!quota) return;
  if (!Number.isInteger(quota.maxCalls) || quota.maxCalls < 1 || quota.maxCalls > 1_000_000) throw new Error("Invalid provider quota maxCalls");
  if (!Number.isInteger(quota.windowMs) || quota.windowMs < 1_000 || quota.windowMs > 24 * 60 * 60_000) throw new Error("Invalid provider quota windowMs");
}

/** Map an unknown runtime failure to a safe category code. */
export function classifyProviderError(error: unknown): string {
  if (error instanceof ManagedProviderError) return error.code;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && /^[a-z0-9_]+$/i.test(code)) return code;
  return "provider_error";
}

function runtimeKindOf(kind: ManagedProviderKind): ProviderConfig["kind"] {
  if (kind === "embedding") return "embedding";
  if (kind === "rerank") return "rerank";
  return "inference";
}

function dataPolicyOf(row: Record<string, unknown>): ProviderConfig["dataPolicy"] {
  const residency = String(row.data_residency ?? "");
  if (residency === "local" || residency === "enterprise" || residency === "cloud") return residency;
  return row.base_url ? "cloud" : "enterprise";
}

/** Audit-safe token usage: numeric counts only, key names that survive sanitizing. */
function auditUsage(usage: ProviderTokenUsage | undefined): Record<string, number> | undefined {
  if (!usage) return undefined;
  const out: Record<string, number> = {};
  if (usage.promptTokens !== undefined) out.prompt = usage.promptTokens;
  if (usage.completionTokens !== undefined) out.completion = usage.completionTokens;
  if (usage.totalTokens !== undefined) out.total = usage.totalTokens;
  return Object.keys(out).length ? out : undefined;
}

export interface ManagedEmbeddingResult { vectors: number[][]; tokenUsage?: ProviderTokenUsage; }
export interface ManagedRerankResult { results: Array<{ id: string; score: number }>; tokenUsage?: ProviderTokenUsage; }
export interface ManagedChatResult { text: string; finishReason?: string; tokenUsage?: ProviderTokenUsage; }

/**
 * Live handle for one managed provider. Each call re-reads the config row and
 * re-resolves the secret reference, so rotation, disable and model changes
 * take effect immediately; plaintext tokens never leave the call scope.
 */
export interface ManagedProviderHandle {
  readonly providerId: string;
  readonly kind: ManagedProviderKind;
  indexVersion(): number;
  health(): ProviderHealth;
  probe(): Promise<{ latencyMs: number; httpStatus: number; observedDimensions?: number; tokenUsage?: ProviderTokenUsage }>;
  embed(texts: string[]): Promise<ManagedEmbeddingResult>;
  rerank(query: string, documents: Array<{ id: string; text: string; score: number }>): Promise<ManagedRerankResult>;
  complete(prompt: string, maxTokens?: number): Promise<ManagedChatResult>;
  chat(messages: ManagedChatMessage[], maxTokens?: number, responseFormat?: {type: "text" | "json_object"}, options?:ProviderCallOptions): Promise<ManagedChatResult>;
}

// Process-wide, per-database provider budgets survive repeated registry/handle
// resolution. Cross-process quotas require a separate durable budget service.
const sharedPolicies=new Map<string,ProviderPolicy>();

export class ProviderRegistry {
  private readonly secrets?: SecretResolver;
  private readonly fetchImpl?: typeof fetch;
  private readonly policyOptions: ProviderPolicyOptions;

  constructor(private readonly store: KnowledgeStore, private readonly clock: () => Date = () => new Date(), options: ProviderRegistryRuntimeOptions = {}) {
    this.secrets = options.secrets;
    this.fetchImpl = options.fetchImpl;
    this.policyOptions = options.policy ?? {};
  }

  upsert(input: ProviderConfigInput): ProviderConfigMetadata {
    if (!input.id.trim() || !input.provider.trim() || !input.modelId.trim()) throw new Error("Provider id, provider and modelId are required");
    const baseUrl = validateProviderBaseUrl(input.baseUrl);
    assertSecretRef(input.secretRef);
    assertQuota(input.quota);
    if (input.dimensions !== undefined && (!Number.isInteger(input.dimensions) || input.dimensions <= 0 || input.dimensions > 100_000)) throw new Error("Invalid embedding dimensions");
    const existing = this.store.db.prepare("SELECT * FROM knowledge_provider_configs WHERE id=?").get(input.id) as Record<string, unknown> | undefined;
    const now = this.clock().toISOString();
    const changedEmbedding = Boolean(existing && String(existing.kind) === "embedding" && (String(existing.model_id) !== input.modelId || Number(existing.dimensions ?? 0) !== Number(input.dimensions ?? 0) || String(existing.provider) !== input.provider || String(existing.base_url ?? "").replace(/\/+$/, "") !== String(baseUrl ?? "").replace(/\/+$/, "")));
    const indexVersion = changedEmbedding ? Number(existing?.index_version ?? 1) + 1 : Number(existing?.index_version ?? 1);
    const status: ManagedProviderStatus = changedEmbedding ? "pending_reindex" : "ready";
    this.store.db.prepare(`INSERT INTO knowledge_provider_configs(id,kind,provider,base_url,model_id,dimensions,batch_size,timeout_ms,concurrency,max_retries,data_residency,status,secret_ref,token_configured,reindex_required,index_version,quota_max_calls,quota_window_ms,last_test_at,last_error_code,created_by,created_at,updated_at,disabled_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,provider=excluded.provider,base_url=excluded.base_url,model_id=excluded.model_id,dimensions=excluded.dimensions,batch_size=excluded.batch_size,timeout_ms=excluded.timeout_ms,concurrency=excluded.concurrency,max_retries=excluded.max_retries,data_residency=excluded.data_residency,status=excluded.status,secret_ref=COALESCE(excluded.secret_ref,knowledge_provider_configs.secret_ref),token_configured=CASE WHEN excluded.secret_ref IS NOT NULL THEN 1 ELSE knowledge_provider_configs.token_configured END,reindex_required=CASE WHEN excluded.reindex_required=1 THEN 1 ELSE knowledge_provider_configs.reindex_required END,index_version=excluded.index_version,quota_max_calls=excluded.quota_max_calls,quota_window_ms=excluded.quota_window_ms,updated_at=excluded.updated_at,disabled_at=NULL`).run(input.id, input.kind, input.provider, baseUrl ?? null, input.modelId, input.dimensions ?? null, input.batchSize ?? null, input.timeoutMs ?? 30_000, input.concurrency ?? 4, input.maxRetries ?? 2, input.dataResidency ?? null, status, input.secretRef ?? null, input.secretRef ? 1 : Number(existing?.token_configured ?? 0), changedEmbedding ? 1 : Number(existing?.reindex_required ?? 0), indexVersion, input.quota?.maxCalls ?? null, input.quota?.windowMs ?? null, existing?.last_test_at ?? null, existing?.last_error_code ?? null, input.actorId, String(existing?.created_at ?? now), now, null);
    if (changedEmbedding && existing) {
      this.store.db.prepare("INSERT INTO knowledge_provider_reindex_jobs(id,provider_id,index_version,from_model_id,from_dimensions,to_model_id,to_dimensions,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)")
        .run(randomUUID(), input.id, indexVersion, String(existing.model_id), existing.dimensions == null ? null : Number(existing.dimensions), input.modelId, input.dimensions ?? null, now, now);
      this.store.audit({ actorId: input.actorId, action: "knowledge.provider.reindex_pending", entityType: "provider", entityId: input.id, details: { indexVersion, fromModelId: String(existing.model_id), toModelId: input.modelId, fromDimensions: existing.dimensions == null ? undefined : Number(existing.dimensions), toDimensions: input.dimensions } });
    }
    const config = this.get(input.id)!;
    this.store.audit({ actorId: input.actorId, action: "knowledge.provider.upsert", entityType: "provider", entityId: input.id, details: { kind: input.kind, provider: input.provider, modelId: input.modelId, dimensions: input.dimensions, tokenConfigured: config.tokenConfigured, reindexRequired: config.reindexRequired, indexVersion: config.indexVersion } });
    return config;
  }

  get(id: string): ProviderConfigMetadata | undefined { const row = this.row(id); return row ? rowToConfig(row) : undefined; }
  list(): ProviderConfigMetadata[] { return (this.store.db.prepare("SELECT * FROM knowledge_provider_configs ORDER BY kind,provider,id").all() as Array<Record<string, unknown>>).map(rowToConfig); }
  rotateSecret(id: string, secretRef: string, actorId: number): ProviderConfigMetadata { assertSecretRef(secretRef); const now = this.clock().toISOString(); const result = this.store.db.prepare("UPDATE knowledge_provider_configs SET secret_ref=?,token_configured=1,updated_at=?,disabled_at=NULL,status=CASE WHEN status='disabled' THEN 'ready' ELSE status END WHERE id=?").run(secretRef, now, id); if (!result.changes) throw new Error("Provider not found"); this.store.audit({ actorId, action: "knowledge.provider.rotate_secret", entityType: "provider", entityId: id, details: { tokenConfigured: true } }); return this.get(id)!; }
  disable(id: string, actorId: number): ProviderConfigMetadata { const now = this.clock().toISOString(); const result = this.store.db.prepare("UPDATE knowledge_provider_configs SET status='disabled',disabled_at=?,updated_at=? WHERE id=?").run(now, now, id); if (!result.changes) throw new Error("Provider not found"); this.store.audit({ actorId, action: "knowledge.provider.disable", entityType: "provider", entityId: id }); return this.get(id)!; }
  markTest(id: string, result: { ok: boolean; errorCode?: string }, actorId?: number): ProviderConfigMetadata { const now = this.clock().toISOString(); this.store.db.prepare("UPDATE knowledge_provider_configs SET last_test_at=?,last_error_code=?,status=CASE WHEN ?=1 THEN CASE WHEN status='pending_reindex' THEN status ELSE 'ready' END ELSE 'degraded' END,updated_at=? WHERE id=?").run(now, result.ok ? null : result.errorCode ?? "provider_error", result.ok ? 1 : 0, now, id); if (actorId) this.store.audit({ actorId, action: "knowledge.provider.test", entityType: "provider", entityId: id, details: { ok: result.ok, errorCode: result.errorCode } }); return this.get(id)!; }

  /** Pending reindex jobs (with provider metadata) created by embedding model/dimension changes. */
  pendingReindex(): PendingReindexEntry[] {
    const rows = this.store.db.prepare("SELECT * FROM knowledge_provider_reindex_jobs WHERE status IN ('pending','running','failed') ORDER BY created_at,id").all() as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      const provider = this.get(String(row.provider_id));
      return provider ? [{ job: rowToReindexJob(row), provider }] : [];
    });
  }

  beginReindex(jobId: string): ProviderReindexJob {
    const now = this.clock().toISOString();
    const result = this.store.db.prepare("UPDATE knowledge_provider_reindex_jobs SET status='running',updated_at=? WHERE id=? AND status IN ('pending','failed')").run(now, jobId);
    if (!result.changes) throw new Error("Reindex job not found or already finished");
    return this.reindexJob(jobId);
  }

  completeReindex(jobId: string, actorId?: number): ProviderReindexJob {
    const job = this.reindexJob(jobId);
    const now = this.clock().toISOString();
    this.store.db.prepare("UPDATE knowledge_provider_reindex_jobs SET status='completed',completed_at=?,updated_at=? WHERE id=?").run(now, now, jobId);
    // Only the latest index version may clear the pending state, so a stale
    // job finishing late cannot mix vector spaces across versions.
    this.store.db.prepare("UPDATE knowledge_provider_configs SET reindex_required=CASE WHEN index_version=? THEN 0 ELSE reindex_required END,status=CASE WHEN status='pending_reindex' AND index_version=? THEN 'ready' ELSE status END,updated_at=? WHERE id=?").run(job.indexVersion, job.indexVersion, now, job.providerId);
    this.store.audit({ actorId, action: "knowledge.provider.reindex_completed", entityType: "provider", entityId: job.providerId, details: { jobId, indexVersion: job.indexVersion } });
    return this.reindexJob(jobId);
  }

  failReindex(jobId: string, errorCode: string, actorId?: number): ProviderReindexJob {
    const job = this.reindexJob(jobId);
    const now = this.clock().toISOString();
    this.store.db.prepare("UPDATE knowledge_provider_reindex_jobs SET status='failed',error_code=?,updated_at=? WHERE id=?").run(errorCode.slice(0, 100), now, jobId);
    this.store.audit({ actorId, action: "knowledge.provider.reindex_failed", entityType: "provider", entityId: job.providerId, details: { jobId, indexVersion: job.indexVersion, errorCode: errorCode.slice(0, 100) } });
    return this.reindexJob(jobId);
  }

  /**
   * Run a minimal connectivity probe for the provider kind through the managed
   * policy (timeout/retry/circuit/quota). Updates status/lastTest and audits
   * only numeric, credential-free fields.
   */
  async probe(id: string, actorId?: number): Promise<ProviderProbeReport> {
    const row = this.row(id);
    if (!row) throw new Error("Provider not found");
    if (String(row.status) === "disabled") return { ok: false, errorCode: "provider_disabled" };
    const handle = this.handleFromRow(row);
    try {
      const result = await handle.probe();
      this.markTest(id, { ok: true });
      this.store.audit({ actorId, action: "knowledge.provider.probe", entityType: "provider", entityId: id, details: { ok: true, latencyMs: result.latencyMs, httpStatus: result.httpStatus, observedDimensions: result.observedDimensions, usage: auditUsage(result.tokenUsage) } });
      return { ok: true, latencyMs: result.latencyMs, httpStatus: result.httpStatus, observedDimensions: result.observedDimensions, tokenUsage: result.tokenUsage };
    } catch (error) {
      const errorCode = classifyProviderError(error);
      this.markTest(id, { ok: false, errorCode });
      this.store.audit({ actorId, action: "knowledge.provider.probe", entityType: "provider", entityId: id, details: { ok: false, errorCode } });
      return { ok: false, errorCode };
    }
  }

  /**
   * Resolve a live managed provider handle for backend callers (candidate
   * pipeline, retriever). Throws when the provider is missing or disabled.
   */
  resolveCandidateProvider(id: string): ManagedProviderHandle {
    const row = this.row(id);
    if (!row) throw new ProviderUnavailableError(`Provider '${id}' is not configured`);
    if (String(row.status) === "disabled") throw new ProviderUnavailableError(`Provider '${id}' is disabled`);
    return this.handleFromRow(row);
  }

  private row(id: string): Record<string, unknown> | undefined {
    return this.store.db.prepare("SELECT * FROM knowledge_provider_configs WHERE id=?").get(id) as Record<string, unknown> | undefined;
  }

  private reindexJob(jobId: string): ProviderReindexJob {
    const row = this.store.db.prepare("SELECT * FROM knowledge_provider_reindex_jobs WHERE id=?").get(jobId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Reindex job not found");
    return rowToReindexJob(row);
  }

  private policyConfig(row: Record<string, unknown>): ProviderConfig {
    return {
      kind: runtimeKindOf(String(row.kind) as ManagedProviderKind),
      providerId: String(row.id),
      modelId: String(row.model_id),
      dimensions: row.dimensions == null ? undefined : Number(row.dimensions),
      dataPolicy: dataPolicyOf(row),
      endpoint: row.base_url ? String(row.base_url) : undefined,
      secretRef: row.secret_ref ? String(row.secret_ref) : undefined,
      timeoutMs: Number(row.timeout_ms),
      concurrency: Number(row.concurrency),
      maxRetries: Number(row.max_retries),
      quota: row.quota_max_calls != null && row.quota_window_ms != null ? { maxCalls: Number(row.quota_max_calls), windowMs: Number(row.quota_window_ms) } : undefined,
    };
  }

  private handleFromRow(initialRow: Record<string, unknown>): ManagedProviderHandle {
    const id = String(initialRow.id);
    const kind = String(initialRow.kind) as ManagedProviderKind;
    const policyKey=JSON.stringify([this.store.db.name,id]);
    let policy=sharedPolicies.get(policyKey);
    if(!policy){policy=new ProviderPolicy(this.policyConfig(initialRow),this.policyOptions);sharedPolicies.set(policyKey,policy);}
    else policy.updateConfig(this.policyConfig(initialRow));
    const currentRow = (): Record<string, unknown> => {
      const row = this.row(id);
      if (!row) throw new ProviderUnavailableError(`Provider '${id}' is not configured`);
      if (String(row.status) === "disabled") throw new ProviderUnavailableError(`Provider '${id}' is disabled`);
      if(String(row.kind)!==kind)throw new ProviderUnavailableError("Provider kind changed; resolve a new handle");
      return row;
    };
    const httpOptions = async (row: Record<string, unknown>, signal: AbortSignal): Promise<ManagedHttpOptions> => {
      const baseUrl = validateProviderBaseUrl(row.base_url ? String(row.base_url) : undefined);
      if (!baseUrl) throw new ManagedProviderError("unavailable", `Provider '${id}' has no base URL configured`);
      const token = row.secret_ref && this.secrets ? await this.secrets.resolve(String(row.secret_ref)) : undefined;
      return { baseUrl, modelId: String(row.model_id), token, fetchImpl: this.fetchImpl, signal };
    };
    const invoke = async <T extends { status: number; latencyMs: number; tokenUsage?: ProviderTokenUsage }>(request: string, call: (options: ManagedHttpOptions, row: Record<string, unknown>) => Promise<T>, callOptions?:ProviderCallOptions): Promise<T> => {
      const row = currentRow();
      policy.updateConfig(this.policyConfig(row));
      try {
        return await policy.execute(async (signal) => {const current=currentRow();return call(await httpOptions(current,signal),current);},callOptions);
      } catch (error) {
        this.store.audit({ action: "knowledge.provider.invoke_error", entityType: "provider", entityId: id, details: { request, errorCode: classifyProviderError(error) } });
        throw error;
      }
    };
    const expectedDimensions = (row: Record<string, unknown>): number | undefined => (row.dimensions == null ? undefined : Number(row.dimensions));
    return {
      providerId: id,
      kind,
      indexVersion: () => Number(currentRow().index_version ?? 1),
      health: () => policy.health(),
      probe: async () => {
        if (kind === "embedding") {
          const result = await invoke("probe", (options, row) => callOpenAiEmbedding({ ...options, texts: [EMBEDDING_PROBE_TEXT], expectedDimensions: expectedDimensions(row) }));
          return { latencyMs: result.latencyMs, httpStatus: result.status, observedDimensions: result.vectors[0]?.length, tokenUsage: result.tokenUsage };
        }
        if (kind === "rerank") {
          const result = await invoke("probe", (options) => callOpenAiRerank({ ...options, query: "relay", documents: [RERANK_PROBE_DOCUMENT] }));
          return { latencyMs: result.latencyMs, httpStatus: result.status, tokenUsage: result.tokenUsage };
        }
        const result = await invoke("probe", (options) => callOpenAiChat({ ...options, prompt: CHAT_PROBE_PROMPT, maxTokens: 8 }));
        return { latencyMs: result.latencyMs, httpStatus: result.status, tokenUsage: result.tokenUsage };
      },
      embed: async (texts: string[]) => {
        if (kind !== "embedding") throw new ProviderUnavailableError(`Provider '${id}' is not an embedding provider`);
        const result = await invoke("embed", (options, row) => callOpenAiEmbedding({ ...options, texts, expectedDimensions: expectedDimensions(row) }));
        return { vectors: result.vectors, tokenUsage: result.tokenUsage };
      },
      rerank: async (query, documents) => {
        if (kind !== "rerank") throw new ProviderUnavailableError(`Provider '${id}' is not a rerank provider`);
        const result = await invoke("rerank", (options) => callOpenAiRerank({ ...options, query, documents: documents.map((document) => document.text) }));
        return { results: result.scores.map((score) => ({ id: documents[score.index].id, score: score.score })), tokenUsage: result.tokenUsage };
      },
      chat: async (messages, maxTokens, responseFormat, callOptions) => {
        if (kind === "embedding" || kind === "rerank") throw new ProviderUnavailableError("Provider is not a chat provider");
        const result = await invoke("chat", (options) => callOpenAiChat({ ...options, messages, maxTokens, responseFormat }),callOptions);
        return { text: result.text, finishReason: result.finishReason, tokenUsage: result.tokenUsage };
      },
      complete: async (prompt, maxTokens) => {
        if (kind === "embedding" || kind === "rerank") throw new ProviderUnavailableError(`Provider '${id}' is not a chat provider`);
        const result = await invoke("chat", (options) => callOpenAiChat({ ...options, prompt, maxTokens }));
        return { text: result.text, finishReason: result.finishReason, tokenUsage: result.tokenUsage };
      },
    };
  }
}
