import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import { WorkSessionService } from "./work-session.js";
import {
  canonicalCandidateJson,
  redactCandidateInput,
  type CandidateInsight,
  type CandidateInsightCompiler,
} from "./candidate-insight.js";

export type CandidateInsightJobStatus = "queued" | "running" | "done" | "failed";

export interface CandidateInsightJob {
  id: string;
  workSessionId: string;
  actorId: number;
  evidenceRefs: string[];
  context: Record<string, unknown>;
  status: CandidateInsightJobStatus;
  insightId?: string;
  error?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  providerId?: string;
  leaseUntil?: string;
  availableAt?: string;
}

export interface CandidateInsightWorkerResult {
  claimed: number;
  completed: number;
  failed: number;
  retried: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;

function jobFromRow(row: Record<string, unknown>): CandidateInsightJob {
  let evidenceRefs: string[] = [];
  let context: Record<string, unknown> = {};
  try { const parsed = JSON.parse(String(row.evidence_refs_json ?? "[]")); if (Array.isArray(parsed)) evidenceRefs = parsed.filter((item): item is string => typeof item === "string"); } catch { /* malformed rows stay empty */ }
  try { const parsed = JSON.parse(String(row.context_json ?? "{}")); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) context = parsed as Record<string, unknown>; } catch { /* malformed rows stay empty */ }
  return {
    id: String(row.id), workSessionId: String(row.work_session_id), actorId: Number(row.actor_id),
    evidenceRefs, context, status: row.status === "queued" && row.claim_token ? "running" : String(row.status) as CandidateInsightJobStatus,
    providerId: row.provider_id ? String(row.provider_id) : undefined,
    leaseUntil: row.lease_until ? String(row.lease_until) : undefined,
    availableAt: row.available_at ? String(row.available_at) : undefined,
    insightId: row.insight_id ? String(row.insight_id) : undefined,
    error: row.error ? String(row.error) : undefined,
    attempts: Number(row.attempts), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function jobErrorLabel(error: unknown): string {
  const candidate = error as { code?: unknown; name?: unknown } | undefined;
  const code = typeof candidate?.code === "string" ? candidate.code : typeof candidate?.name === "string" ? candidate.name : "Error";
  return /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(code) ? code : "Error";
}

/**
 * Queue an asynchronous compile request. The job id is derived from the
 * sanitized input so replays of the same request are idempotent.
 */
export function enqueueCandidateInsight(
  store: KnowledgeStore,
  input: { actorId: number; sessionId: string; evidenceRefs: string[]; context: Record<string, unknown>; providerId?: string; retry?: boolean },
  clock: () => Date = () => new Date(),
): { job: CandidateInsightJob; enqueued: boolean } {
  const sessions = new WorkSessionService(store, clock);
  const session = sessions.get({ actorId: input.actorId, sessionId: input.sessionId });
  const evidenceRefs = [...new Set((input.evidenceRefs ?? []).map((ref) => String(ref).trim()).filter(Boolean))].sort().slice(0, 100);
  const context = redactCandidateInput(input.context ?? {}) as Record<string, unknown>;
  const providerId = input.providerId?.trim() || undefined;
  const id = `insight-job-${createHash("sha256").update(canonicalCandidateJson({ actorId: input.actorId, sessionId: session.id, evidenceRefs, context, ...(providerId ? {providerId} : {}) })).digest("hex").slice(0, 32)}`;
  const now = clock().toISOString();
  return store.db.transaction(() => {
  // Recheck after acquiring the writer; a concurrent ACL revoke must win.
  sessions.get({ actorId: input.actorId, sessionId: input.sessionId });
  const write = store.db.prepare(`INSERT OR IGNORE INTO knowledge_candidate_insight_jobs
    (id,work_session_id,actor_id,evidence_refs_json,context_json,status,attempts,created_at,updated_at,provider_id,available_at)
    VALUES (?,?,?,?,?,'queued',0,?,?,?,?)`)
    .run(id, session.id, input.actorId, JSON.stringify(evidenceRefs), JSON.stringify(context), now, now, providerId ?? null, now);
  if (write.changes === 1) {
    store.audit({ actorId: input.actorId, projectId: session.projectId, action: "candidate_insight_job.enqueued", entityType: "candidate_insight_job", entityId: id, details: { workSessionId: session.id, evidenceCount: evidenceRefs.length } });
  }
  if(input.retry && store.db.prepare("UPDATE knowledge_candidate_insight_jobs SET status='queued',attempts=0,error=NULL,claim_token=NULL,lease_until=NULL,available_at=?,updated_at=? WHERE id=? AND status='failed'").run(now,now,id).changes) {
    store.audit({actorId:input.actorId,projectId:session.projectId,action:"candidate_insight_job.retried",entityType:"candidate_insight_job",entityId:id});
  }
  const row = store.db.prepare("SELECT * FROM knowledge_candidate_insight_jobs WHERE id = ?").get(id) as Record<string, unknown>;
  return { job: jobFromRow(row), enqueued: write.changes === 1 };
  }).immediate();
}

export function getCandidateInsightJob(store: KnowledgeStore, input: {actorId:number;id:string}): CandidateInsightJob {
  const row=store.db.prepare("SELECT * FROM knowledge_candidate_insight_jobs WHERE id=?").get(input.id) as Record<string,unknown>|undefined;
  if(!row) throw new Error("Candidate job not found");
  new WorkSessionService(store).get({actorId:input.actorId,sessionId:String(row.work_session_id)});
  return jobFromRow(row);
}

/**
 * Explicit, testable asynchronous compile worker. The provider is only ever
 * reached through the injected compiler, so tests never need a real model.
 * Provider failures degrade to the deterministic fallback inside compile()
 * and therefore never block or corrupt the Evidence/outbox main path.
 */
export class CandidateInsightWorker {
  private readonly maxAttempts: number;
  private readonly clock: () => Date;
  private readonly leaseMs: number;
  private readonly retryBaseMs: number;
  private stopped = false;
  private running?: Promise<CandidateInsightWorkerResult>;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly compiler: Pick<CandidateInsightCompiler, "compile"> | ((job:CandidateInsightJob)=>Pick<CandidateInsightCompiler,"compile">),
    options: { clock?: () => Date; maxAttempts?: number; leaseMs?: number; retryBaseMs?: number } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.maxAttempts = Number.isFinite(options.maxAttempts) ? Math.max(1, Math.min(20, Math.trunc(options.maxAttempts!))) : DEFAULT_MAX_ATTEMPTS;
    this.leaseMs = Math.max(100, Math.min(600_000, options.leaseMs ?? 90_000));
    this.retryBaseMs = Math.max(0, Math.min(60_000, options.retryBaseMs ?? 1_000));
  }

  runOnce(limit = 10): Promise<CandidateInsightWorkerResult> {
    if(this.running) return this.running;
    this.running=this.run(limit).finally(()=>{this.running=undefined;});
    return this.running;
  }
  async stop(): Promise<void> { this.stopped=true;await this.running; }

  private claim(exclude: string[]): {job:CandidateInsightJob;token:string}|undefined {
    return this.store.db.transaction(()=>{
      const now=this.clock().toISOString();
      const expired=this.store.db.prepare("SELECT * FROM knowledge_candidate_insight_jobs WHERE status='queued' AND claim_token IS NOT NULL AND lease_until<=?").all(now) as Array<Record<string,unknown>>;
      for(const row of expired){
        const job=jobFromRow(row),session=this.store.db.prepare("SELECT project_id FROM knowledge_work_sessions WHERE id=?").get(job.workSessionId) as {project_id:string}|undefined;
        const hash=createHash("sha256").update(canonicalCandidateJson({sessionId:job.workSessionId,projectId:session?.project_id,evidenceRefs:job.evidenceRefs,context:job.context})).digest("hex");
        const saved=this.store.db.prepare("SELECT id FROM knowledge_candidate_insights WHERE work_session_id=? AND input_hash=?").get(job.workSessionId,hash) as {id:string}|undefined;
        // A crash after a remote request has an uncertain billing outcome. Never
        // automatically charge again; only completed local results are recovered.
        this.store.db.prepare("UPDATE knowledge_candidate_insight_jobs SET status=?,insight_id=?,error=?,claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND claim_token=?").run(saved?"done":"failed",saved?.id??null,saved?null:"interrupted_uncertain_retry_required",now,job.id,row.claim_token);
        this.store.audit({actorId:job.actorId,action:"candidate_insight_job.recovered",entityType:"candidate_insight_job",entityId:job.id,details:{outcome:saved?"done":"failed",reason:saved?"persisted_result":"interrupted_uncertain_retry_required"}});
      }
      const row=this.store.db.prepare(`SELECT j.* FROM knowledge_candidate_insight_jobs j WHERE j.status='queued' AND j.claim_token IS NULL
        AND (j.available_at IS NULL OR j.available_at<=?) AND j.id NOT IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM knowledge_candidate_insight_jobs busy WHERE busy.work_session_id=j.work_session_id AND busy.status='queued' AND busy.claim_token IS NOT NULL)
        ORDER BY j.created_at,j.id LIMIT 1`).get(now,JSON.stringify(exclude)) as Record<string,unknown>|undefined;
      if(!row)return undefined;
      const token=randomUUID(),lease=new Date(this.clock().getTime()+this.leaseMs).toISOString();
      this.store.db.prepare("UPDATE knowledge_candidate_insight_jobs SET claim_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued' AND claim_token IS NULL").run(token,lease,now,row.id);
      return {job:jobFromRow({...row,claim_token:token,lease_until:lease,attempts:Number(row.attempts)+1}),token};
    }).immediate();
  }

  private async run(limit: number): Promise<CandidateInsightWorkerResult> {
    const result: CandidateInsightWorkerResult = { claimed: 0, completed: 0, failed: 0, retried: 0 }, seen:string[]=[];
    while(!this.stopped && this.store.db.open && seen.length<Math.max(1,Math.min(100,Math.trunc(limit)))) {
      const claimed=this.claim(seen);if(!claimed)break;
      const {job,token}=claimed;seen.push(job.id);result.claimed++;
      const heartbeat=setInterval(()=>{
        try {if(this.store.db.open)this.store.db.prepare("UPDATE knowledge_candidate_insight_jobs SET lease_until=? WHERE id=? AND claim_token=? AND status='queued'").run(new Date(this.clock().getTime()+this.leaseMs).toISOString(),job.id,token);}
        catch { /* A failed renewal never grants permission to another writer. */ }
      },Math.max(25,Math.floor(this.leaseMs/3)));
      heartbeat.unref?.();
      let insight: CandidateInsight | undefined;
      let failure: unknown;
      try {
        new WorkSessionService(this.store).get({actorId:job.actorId,sessionId:job.workSessionId});
        const compiler=typeof this.compiler==="function"?this.compiler(job):this.compiler;
        insight = await compiler.compile({ actorId: job.actorId, sessionId: job.workSessionId, evidenceRefs: job.evidenceRefs, context: job.context });
      } catch (error) {
        failure = error;
      } finally {clearInterval(heartbeat);}
      if(!this.store.db.open)break;
      const now = this.clock().toISOString();
      if (insight) {
        const write=this.store.db.prepare("UPDATE knowledge_candidate_insight_jobs SET status='done',insight_id=?,error=NULL,claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='queued' AND claim_token=?")
          .run(insight.persisted ? insight.id : null, now, job.id,token);
        result.completed += write.changes;
      } else {
        const attempts = job.attempts;
        const terminal = attempts >= this.maxAttempts;
        const available=new Date(this.clock().getTime()+Math.min(60_000,this.retryBaseMs*2**(attempts-1))).toISOString();
        const write=this.store.db.prepare("UPDATE knowledge_candidate_insight_jobs SET status=?,error=?,claim_token=NULL,lease_until=NULL,available_at=?,updated_at=? WHERE id=? AND status='queued' AND claim_token=?")
          .run(terminal ? "failed" : "queued", jobErrorLabel(failure),available,now,job.id,token);
        if(!write.changes)continue;
        if (terminal) {
          result.failed += 1;
          this.store.audit({ actorId: job.actorId, action: "candidate_insight_job.failed", entityType: "candidate_insight_job", entityId: job.id, details: { workSessionId: job.workSessionId, error: jobErrorLabel(failure), attempts } });
        } else {
          result.retried += 1;
        }
      }
    }
    return result;
  }
}
