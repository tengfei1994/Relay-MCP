import { ProviderAdmissionQuotaError } from "./provider-admission.js";
import type {
  EmbeddingProvider,
  InferenceProvider,
  KnowledgeProviders,
  ProviderCapabilities,
  RedactionProvider,
  RerankProvider,
} from "./providers.js";
import { ProviderUnavailableError } from "./providers.js";

export type ProviderKind = "embedding" | "rerank" | "inference" | "redaction";
export type ProviderDataPolicy = ProviderCapabilities["dataPolicy"];

export interface ProviderConfig {
  kind: ProviderKind;
  providerId: string;
  modelId: string;
  dataPolicy: ProviderDataPolicy;
  dimensions?: number;
  endpoint?: string;
  /** Reference resolved by the host; never put a credential value here. */
  secretRef?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
  concurrency?: number;
  quota?: { maxCalls: number; windowMs: number };
}

export interface ProviderPolicyOptions {
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
  concurrency?: number;
  quota?: { maxCalls: number; windowMs: number };
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}
export interface ProviderCallOptions { signal?: AbortSignal; timeoutMs?: number; }

/** A local binding guard, not an upstream failure or a retryable request. */
export class ProviderBindingStaleError extends Error {
  readonly code = "model_binding_stale";
  readonly retryable = false;
  constructor() { super("Provider model binding changed during invocation"); }
}

export class ProviderCredentialsChangedError extends Error {
  readonly code = "provider_credentials_changed";
  readonly retryable = false;
  constructor() { super("Provider credentials changed before transport"); }
}

function withAbort<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T> {
  if(!signal)return promise;
  if(signal.aborted)return Promise.reject(abortError(signal));
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(abortError(signal));signal.addEventListener("abort",abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener("abort",abort));
  });
}

export interface ProviderHealth {
  providerId: string;
  kind: ProviderKind;
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
  lastFailureAt?: number;
  nextRetryAt?: number;
  quotaUsed: number;
  quotaResetAt?: number;
}

export class ProviderTimeoutError extends ProviderUnavailableError {
  readonly code = "provider_timeout";
  constructor(providerId: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(`Provider '${providerId}' timed out after ${timeoutMs}ms`, options);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderCircuitOpenError extends ProviderUnavailableError {
  readonly code = "provider_circuit_open";
  constructor(providerId: string, retryAt: number) {
    super(`Provider '${providerId}' circuit is open until ${new Date(retryAt).toISOString()}`);
    this.name = "ProviderCircuitOpenError";
  }
}

export class ProviderQuotaExceededError extends ProviderUnavailableError {
  readonly code = "provider_quota_exceeded";
  constructor(providerId: string, resetAt: number) {
    super(`Provider '${providerId}' quota is exhausted until ${new Date(resetAt).toISOString()}`);
    this.name = "ProviderQuotaExceededError";
  }
}

const DEFAULT_POLICY: Required<Pick<ProviderPolicyOptions, "timeoutMs" | "maxRetries" | "retryBaseMs" | "circuitFailureThreshold" | "circuitCooldownMs">> = {
  timeoutMs: 30_000,
  maxRetries: 2,
  retryBaseMs: 250,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 30_000,
};

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value!))) : fallback;
}

function boundedOptional(value: number | undefined, min: number, max: number): number | undefined {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value!))) : undefined;
}

function normalizePolicy(config: ProviderConfig, options: ProviderPolicyOptions): Required<Pick<ProviderPolicyOptions, "timeoutMs" | "maxRetries" | "retryBaseMs" | "circuitFailureThreshold" | "circuitCooldownMs">> & Pick<ProviderPolicyOptions, "quota" | "concurrency"> {
  return {
    // Keep the lower bound at 1 ms so deterministic tests and local adapters
    // can exercise timeout/circuit behavior; production callers should still
    // configure a sensible value through environment or deployment policy.
    timeoutMs: bounded(config.timeoutMs ?? options.timeoutMs, DEFAULT_POLICY.timeoutMs, 1, 10 * 60_000),
    maxRetries: bounded(config.maxRetries ?? options.maxRetries, DEFAULT_POLICY.maxRetries, 0, 8),
    retryBaseMs: bounded(config.retryBaseMs ?? options.retryBaseMs, DEFAULT_POLICY.retryBaseMs, 10, 60_000),
    circuitFailureThreshold: bounded(config.circuitFailureThreshold ?? options.circuitFailureThreshold, DEFAULT_POLICY.circuitFailureThreshold, 1, 100),
    circuitCooldownMs: bounded(config.circuitCooldownMs ?? options.circuitCooldownMs, DEFAULT_POLICY.circuitCooldownMs, 100, 60 * 60_000),
    concurrency: boundedOptional(config.concurrency ?? options.concurrency, 1, 256),
    quota: config.quota ?? options.quota,
  };
}

function retryable(error: unknown): boolean {
  if (error instanceof ProviderTimeoutError) return true;
  if (error instanceof ProviderCircuitOpenError || error instanceof ProviderQuotaExceededError) return false;
  // Errors that carry an explicit retryable classification (for example the
  // managed-provider HTTP layer) win over message-based heuristics.
  const explicit = (error as { retryable?: unknown } | null | undefined)?.retryable;
  if (typeof explicit === "boolean") return explicit;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (error instanceof Error && /invalid|unauthori[sz]ed|forbidden|policy|schema/i.test(error.message)) return false;
  return true;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Provider operation aborted");
}

export class ProviderPolicy {
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private config: ProviderConfig;
  private options: ReturnType<typeof normalizePolicy>;
  private state: ProviderHealth;
  private quotaCalls: number[] = [];
  private halfOpenProbe: symbol | undefined;
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(config: ProviderConfig, private readonly baseOptions: ProviderPolicyOptions = {}) {
    const options=baseOptions;
    assertProviderConfig(config);
    this.config = { ...config };
    this.options = normalizePolicy(config, options);
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.state = {
      providerId: config.providerId,
      kind: config.kind,
      state: "closed",
      consecutiveFailures: 0,
      totalCalls: 0,
      totalFailures: 0,
      quotaUsed: 0,
    };
  }

  updateConfig(config:ProviderConfig):void {assertProviderConfig(config);this.config={...config};this.options=normalizePolicy(config,this.baseOptions);}

  health(): ProviderHealth {
    const now = this.now();
    this.quotaCalls = this.options.quota ? this.quotaCalls.filter((calledAt) => calledAt > now - this.options.quota!.windowMs) : [];
    this.state.quotaUsed = this.quotaCalls.length;
    this.state.quotaResetAt = this.quotaCalls.length && this.options.quota ? this.quotaCalls[0] + this.options.quota.windowMs : undefined;
    if (this.state.state === "open" && this.state.nextRetryAt !== undefined && now >= this.state.nextRetryAt) this.state.state = "half-open";
    return { ...this.state };
  }

  async execute<T>(operation: (signal: AbortSignal) => Promise<T>, call:ProviderCallOptions={}): Promise<T> {
    const budget=new AbortController();
    const budgetMs=call.timeoutMs===undefined?undefined:bounded(call.timeoutMs,this.options.timeoutMs,1,600_000);
    const budgetTimer=budgetMs===undefined?undefined:setTimeout(()=>budget.abort(new ProviderTimeoutError(this.config.providerId,budgetMs)),budgetMs);
    const signal=call.signal?AbortSignal.any([budget.signal,call.signal]):budget.signal;
    try{return await this.executeWithinBudget(operation,signal);}finally{if(budgetTimer)clearTimeout(budgetTimer);}
  }

  private async executeWithinBudget<T>(operation:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T> {
    if(signal.aborted)throw abortError(signal);
    const probeOwner = Symbol("provider-probe");
    let acquired = false;
    const assertCircuit = () => {
      const health = this.health();
      if (health.state === "open") throw new ProviderCircuitOpenError(this.config.providerId, health.nextRetryAt ?? this.now() + this.options.circuitCooldownMs);
      if (health.state === "half-open") {
        if (this.halfOpenProbe !== undefined && this.halfOpenProbe !== probeOwner) throw new ProviderCircuitOpenError(this.config.providerId, this.now() + this.options.circuitCooldownMs);
        this.halfOpenProbe = probeOwner;
      }
    };
    try {
      assertCircuit();
      const quota = this.options.quota;
      if (quota && this.quotaCalls.length >= quota.maxCalls) throw new ProviderQuotaExceededError(this.config.providerId, this.quotaCalls[0] + quota.windowMs);
      if(quota)this.quotaCalls.push(this.now());
      this.state.totalCalls += 1;

      await this.acquire(signal);
      acquired = true;
      if(signal.aborted)throw abortError(signal);
      // An earlier concurrent operation may have opened the circuit while
      // this call waited. Recheck before the callback can reserve or send.
      assertCircuit();
      let lastError: unknown;
      for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
        const controller = new AbortController();
        const combined=AbortSignal.any([controller.signal,signal]);
        const timer = setTimeout(() => controller.abort(new ProviderTimeoutError(this.config.providerId, this.options.timeoutMs)), this.options.timeoutMs);
        try {
          if(signal.aborted)throw abortError(signal);
          const result = await withAbort(operation(combined),combined);
          clearTimeout(timer);
          this.state.consecutiveFailures = 0;
          this.state.state = "closed";
          this.state.nextRetryAt = undefined;
          return result;
        } catch (error) {
          clearTimeout(timer);
          // A local durable budget denial made no upstream attempt and must
          // not open its circuit or turn future quota responses into 503s.
          if (error instanceof ProviderAdmissionQuotaError || error instanceof ProviderBindingStaleError || error instanceof ProviderCredentialsChangedError) throw error;
          lastError = error;
          if (signal.aborted || attempt >= this.options.maxRetries || !retryable(error)) break;
          await withAbort(this.sleep(Math.min(60_000, this.options.retryBaseMs * 2 ** attempt)),signal);
        }
      }
      this.state.totalFailures += 1;
      this.state.consecutiveFailures += 1;
      this.state.lastFailureAt = this.now();
      if (this.state.consecutiveFailures >= this.options.circuitFailureThreshold) {
        this.state.state = "open";
        this.state.nextRetryAt = this.now() + this.options.circuitCooldownMs;
      }
      throw lastError instanceof Error ? lastError : new ProviderUnavailableError(`Provider '${this.config.providerId}' failed`);
    } finally {
      // Only this invocation can release its probe reservation. In particular,
      // an unrelated cancelled waiter must not unlock another half-open probe.
      if (this.halfOpenProbe === probeOwner) this.halfOpenProbe = undefined;
      if (acquired) this.release();
    }
  }

  private async acquire(signal:AbortSignal): Promise<void> {
    if(signal.aborted)throw abortError(signal);
    const limit = this.options.concurrency;
    if (limit === undefined || this.running < limit) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve,reject) => {
      const wake=()=>{signal.removeEventListener("abort",abort);resolve();};
      const abort=()=>{const index=this.queue.indexOf(wake);if(index>=0)this.queue.splice(index,1);reject(abortError(signal));};
      this.queue.push(wake);signal.addEventListener("abort",abort,{once:true});
    });
  }

  private release(): void {
    this.running-=1;
    if(this.options.concurrency===undefined||this.running<this.options.concurrency){
      const next=this.queue.shift();if(next){this.running++;next();}
    }
  }
}

export interface RegisteredProvider<T> {
  config: ProviderConfig;
  provider: T;
  policy: ProviderPolicy;
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderKind, RegisteredProvider<unknown>>();
  constructor(private readonly policyOptions: ProviderPolicyOptions = {}) {}

  register<T extends EmbeddingProvider | RerankProvider | InferenceProvider | RedactionProvider>(kind: ProviderKind, provider: T, config?: Partial<ProviderConfig>): void {
    const capabilities = provider.capabilities;
    const normalized: ProviderConfig = {
      kind,
      providerId: config?.providerId ?? `${kind}:${capabilities.modelId}`,
      modelId: config?.modelId ?? capabilities.modelId,
      dimensions: config?.dimensions ?? capabilities.dimensions,
      dataPolicy: config?.dataPolicy ?? capabilities.dataPolicy,
      endpoint: config?.endpoint,
      secretRef: config?.secretRef,
      timeoutMs: config?.timeoutMs,
      maxRetries: config?.maxRetries,
      retryBaseMs: config?.retryBaseMs,
      circuitFailureThreshold: config?.circuitFailureThreshold,
      circuitCooldownMs: config?.circuitCooldownMs,
      concurrency: config?.concurrency,
      quota: config?.quota,
    };
    this.providers.set(kind, { config: normalized, provider, policy: new ProviderPolicy(normalized, this.policyOptions) });
  }

  get<T>(kind: ProviderKind): RegisteredProvider<T> | undefined { return this.providers.get(kind) as RegisteredProvider<T> | undefined; }
  health(): ProviderHealth[] { return [...this.providers.values()].map((entry) => entry.policy.health()); }
  configs(): Array<Omit<ProviderConfig, "secretRef"> & { secretConfigured: boolean }> { return [...this.providers.values()].map(({ config }) => ({ ...config, secretConfigured: Boolean(config.secretRef), secretRef: undefined } as Omit<ProviderConfig, "secretRef"> & { secretConfigured: boolean })); }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const entry = this.get<EmbeddingProvider>("embedding"); if (!entry) throw new ProviderUnavailableError("Embedding provider is not configured");
    return entry.policy.execute((providerSignal) => entry.provider.embed(texts, mergeSignals(providerSignal, signal)));
  }
  async rerank(query: string, documents: Array<{ id: string; text: string; score: number }>, signal?: AbortSignal) {
    const entry = this.get<RerankProvider>("rerank"); if (!entry) throw new ProviderUnavailableError("Rerank provider is not configured");
    return entry.policy.execute((providerSignal) => entry.provider.rerank(query, documents, mergeSignals(providerSignal, signal)));
  }
  async complete(prompt: string, signal?: AbortSignal): Promise<string> {
    const entry = this.get<InferenceProvider>("inference"); if (!entry) throw new ProviderUnavailableError("Inference provider is not configured");
    return entry.policy.execute((providerSignal) => entry.provider.complete(prompt, mergeSignals(providerSignal, signal)));
  }
  async redact(text: string, signal?: AbortSignal) {
    const entry = this.get<RedactionProvider>("redaction"); if (!entry) throw new ProviderUnavailableError("Redaction provider is not configured");
    return entry.policy.execute((providerSignal) => entry.provider.redact(text, mergeSignals(providerSignal, signal)));
  }
}

function mergeSignals(first: AbortSignal, second?: AbortSignal): AbortSignal {
  if (!second) return first;
  if (first.aborted) return first;
  if (second.aborted) return second;
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => controller.abort(signal.reason);
  first.addEventListener("abort", () => abort(first), { once: true });
  second.addEventListener("abort", () => abort(second), { once: true });
  return controller.signal;
}

export function assertProviderConfig(config: ProviderConfig): void {
  if (!config.providerId.trim() || !config.modelId.trim()) throw new Error("Provider id and model id are required");
  if (!["local", "enterprise", "cloud"].includes(config.dataPolicy)) throw new Error("Provider data policy is invalid");
  if (/key|token|secret|password|credential|authorization/i.test(config.endpoint ?? "")) throw new Error("Provider endpoint must not contain credentials");
  const candidate = config as unknown as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (/apiKey|accessToken|secretValue|password|credentialValue/i.test(key) && candidate[key] !== undefined) throw new Error(`Provider config field '${key}' must use secretRef, not a raw secret`);
  }
  if (config.secretRef !== undefined && (!config.secretRef.trim() || /[\r\n]/.test(config.secretRef))) throw new Error("Provider secretRef is invalid");
}

export function embeddingModelChanged(previous: ProviderConfig | undefined, next: ProviderConfig): boolean {
  return Boolean(previous && (previous.modelId !== next.modelId || previous.dimensions !== next.dimensions));
}

export function providerConfigMetadata(config: ProviderConfig): Omit<ProviderConfig, "secretRef"> & { secretConfigured: boolean } {
  const { secretRef: _secretRef, ...safe } = config;
  return { ...safe, secretConfigured: Boolean(config.secretRef) };
}

/** Failure-injectable fake used by integration and contract tests. */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly capabilities: ProviderCapabilities;
  calls = 0;
  constructor(private readonly options: { failTimes?: number; delayMs?: number; dimensions?: number } = {}) {
    this.capabilities = { modelId: "fake-embedding-v1", dimensions: options.dimensions ?? 4, dataPolicy: "local" };
  }
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    this.calls += 1;
    if (this.options.delayMs) await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, this.options.delayMs); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(abortError(signal)); }, { once: true }); });
    if (this.calls <= (this.options.failTimes ?? 0)) throw new Error("fake provider failure");
    if (signal?.aborted) throw abortError(signal);
    return texts.map((text) => Array.from({ length: this.capabilities.dimensions ?? 4 }, (_, index) => (text.length + index) / 100));
  }
}

export function createProviderRegistry(providers: KnowledgeProviders = {}, options: ProviderPolicyOptions = {}): ProviderRegistry {
  const registry = new ProviderRegistry(options);
  if (providers.embedding) registry.register("embedding", providers.embedding);
  if (providers.rerank) registry.register("rerank", providers.rerank);
  if (providers.inference) registry.register("inference", providers.inference);
  if (providers.redaction) registry.register("redaction", providers.redaction);
  return registry;
}
