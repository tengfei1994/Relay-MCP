import { randomUUID } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import { ProviderUnavailableError } from "./providers.js";

const MAX_WINDOW_MS = 24 * 60 * 60_000;
export interface ProviderAdmission {
  used: number;
  remaining: number | null;
  maxCalls: number | null;
  windowMs: number | null;
  nextAvailableAt?: string;
  reason?: "upgrade_barrier" | "rolling_quota";
  /** Existing providers wait out their uncounted pre-044 window on upgrade. */
  blockedUntil?: string;
}
export class ProviderAdmissionQuotaError extends ProviderUnavailableError {
  readonly code = "provider_quota_exceeded";
  readonly retryable = false;
  constructor(readonly retryAt: string, readonly reason: "upgrade_barrier" | "rolling_quota" = "rolling_quota") {
    super("Provider invocation allowance is exhausted; retry after " + retryAt);
    this.name = "ProviderAdmissionQuotaError";
  }
}
function timestamp(now: Date): number {
  const ms = now.getTime();
  if (!Number.isSafeInteger(ms)) throw new Error("Invalid provider admission time");
  return ms;
}
function unavailable(code: string): never { throw Object.assign(new Error("Provider admission is unavailable (" + code + ")"), { code }); }
function inspect(store: KnowledgeStore, providerId: string, now: number, admission: "observe" | "runtime" | "configuration"): ProviderAdmission {
  const row = store.db.prepare("SELECT status,quota_max_calls,quota_window_ms FROM knowledge_provider_configs WHERE id=?").get(providerId) as {status:string;quota_max_calls:number|null;quota_window_ms:number|null}|undefined;
  if (!row) return unavailable("provider_unavailable");
  if (admission === "runtime" && row.status === "disabled") return unavailable("provider_disabled");
  const maxCalls=row.quota_max_calls, windowMs=row.quota_window_ms;
  if ((maxCalls === null) !== (windowMs === null) || (maxCalls !== null && (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 1_000_000 || !Number.isInteger(windowMs) || windowMs! < 1000 || windowMs! > MAX_WINDOW_MS))) return unavailable("provider_policy_invalid");
  // Count future timestamps conservatively if the system clock moved backward.
  const cutoff = now - (windowMs ?? MAX_WINDOW_MS);
  const used = (store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_provider_admissions WHERE provider_id=? AND admitted_at>?").get(providerId,cutoff) as {n:number}).n;
  let remaining = maxCalls === null ? null : Math.max(0,maxCalls-used);
  let next: number|undefined;
  let reason: ProviderAdmission["reason"];
  if (maxCalls !== null && used >= maxCalls) {
    // Lowering the quota may require several older admissions to expire.
    const expires = store.db.prepare("SELECT admitted_at FROM knowledge_provider_admissions WHERE provider_id=? AND admitted_at>? ORDER BY admitted_at LIMIT 1 OFFSET ?").get(providerId,cutoff,used-maxCalls) as {admitted_at:number};
    next = expires.admitted_at + windowMs!;
    reason = "rolling_quota";
  }
  const barrier = store.db.prepare("SELECT not_before FROM knowledge_provider_admission_barriers WHERE provider_id=? AND not_before>?").get(providerId,now) as {not_before:number}|undefined;
  if (barrier) { remaining=0; if(barrier.not_before >= (next??0)) { next=barrier.not_before;reason="upgrade_barrier"; } }
  return {used,remaining,maxCalls,windowMs,...(next===undefined?{}:{nextAvailableAt:new Date(next).toISOString(),reason}),...(barrier?{blockedUntil:new Date(barrier.not_before).toISOString()}:{})};
}

/** Read-only snapshot, not a reservation. Without a quota, used covers 24 hours. */
export function inspectProviderAdmission(store: KnowledgeStore, providerId: string, now: Date = new Date()): ProviderAdmission {
  return store.db.transaction(() => inspect(store,providerId,timestamp(now),"observe"))();
}

/** One logical invoke, including probe, reserves one durable admission after
 * circuit/concurrency gates and before transport. Retries do not reserve another.
 * Never refund ambiguous calls after crashes or timeouts; fail conservatively.
 */
export function admitProviderInvocation(store: KnowledgeStore, providerId: string, now: Date = new Date()): ProviderAdmission {
  return reserveAdmission(store, providerId, now, "runtime");
}

/** Only the administrator configuration flow may validate candidate credentials
 * while disabled. This does not enable the runtime or relax its existing quota,
 * upgrade barrier, or failed-call accounting; setup commits only after probe + CAS.
 */
export function admitProviderConfigurationProbe(store: KnowledgeStore, providerId: string, now: Date = new Date()): ProviderAdmission {
  return reserveAdmission(store, providerId, now, "configuration");
}

function reserveAdmission(store: KnowledgeStore, providerId: string, now: Date, admission: "runtime" | "configuration"): ProviderAdmission {
  return store.db.transaction(() => {
    const ms=timestamp(now), current=inspect(store,providerId,ms,admission);
    if (current.nextAvailableAt) throw new ProviderAdmissionQuotaError(current.nextAvailableAt,current.reason);
    store.db.prepare("INSERT INTO knowledge_provider_admissions(id,provider_id,admitted_at) VALUES(?,?,?)").run(randomUUID(),providerId,ms);
    // Retain the maximum supported policy window, even when today's window is
    // shorter or unlimited, so later quota changes cannot forget recent usage.
    store.db.prepare("DELETE FROM knowledge_provider_admissions WHERE id IN (SELECT id FROM knowledge_provider_admissions WHERE admitted_at<=? LIMIT 1000)").run(ms-MAX_WINDOW_MS);
    return inspect(store,providerId,ms,admission);
  }).immediate();
}
