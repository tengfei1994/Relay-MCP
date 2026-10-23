import { createHash } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import { WorkSessionService } from "./work-session.js";
import {
  canonicalCandidateJson,
  redactCandidateInput,
  type CandidateInsight,
  type CandidateInsightCompiler,
} from "./candidate-insight.js";

export type CandidateInsightJobStatus = "queued" | "done" | "failed";

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
    evidenceRefs, context, status: String(row.status) as CandidateInsightJobStatus,
    insightId: row.insight_id ? String(row.insight_id) : undefined,
    error: row.error ? String(row.error) : undefined,
    attempts: Number(row.attempts), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function jobErrorLabel(error: unknown): string {
  const candidate = error as { code?: unknown; name?: unknown } | undefined;
  const code = typeof candidate?.code === "string" ? candidate.code : typeof candidate?.name === "string" ? candidate.name : "Error";
  return code.slice(0, 200);
}

/**
 * Queue an asynchronous compile request. The job id is derived from the
 * sanitized input so replays of the same request are idempotent.
 */
export function enqueueCandidateInsight(
  store: KnowledgeStore,
  input: { actorId: number; sessionId: string; evidenceRefs: string[]; context: Record<string, unknown> },
  clock: () => Date = () => new Date(),
): { job: CandidateInsightJob; enqueued: boolean } {
  const sessions = new WorkSessionService(store, clock);
  const session = sessions.get({ actorId: input.actorId, sessionId: input.sessionId });
  const evidenceRefs = [...new Set((input.evidenceRefs ?? []).map((ref) => String(ref).trim()).filter(Boolean))].sort().slice(0, 100);
  const context = redactCandidateInput(input.context ?? {}) as Record<string, unknown>;
  const id = `insight-job-${createHash("sha256").update(canonicalCandidateJson({ actorId: input.actorId, sessionId: session.id, evidenceRefs, context })).digest("hex").slice(0, 32)}`;
  const now = clock().toISOString();
  const write = store.db.prepare(`INSERT OR IGNORE INTO knowledge_candidate_insight_jobs
    (id,work_session_id,actor_id,evidence_refs_json,context_json,status,attempts,created_at,updated_at)
    VALUES (?,?,?,?,?,'queued',0,?,?)`)
    .run(id, session.id, input.actorId, JSON.stringify(evidenceRefs), JSON.stringify(context), now, now);
  if (write.changes === 1) {
    store.audit({ actorId: input.actorId, projectId: session.projectId, action: "candidate_insight_job.enqueued", entityType: "candidate_insight_job", entityId: id, details: { workSessionId: session.id, evidenceCount: evidenceRefs.length } });
  }
  const row = store.db.prepare("SELECT * FROM knowledge_candidate_insight_jobs WHERE id = ?").get(id) as Record<string, unknown>;
  return { job: jobFromRow(row), enqueued: write.changes === 1 };
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

  constructor(
    private readonly store: KnowledgeStore,
    private readonly compiler: Pick<CandidateInsightCompiler, "compile">,
    options: { clock?: () => Date; maxAttempts?: number } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.maxAttempts = Number.isFinite(options.maxAttempts) ? Math.max(1, Math.min(20, Math.trunc(options.maxAttempts!))) : DEFAULT_MAX_ATTEMPTS;
  }

  async runOnce(limit = 10): Promise<CandidateInsightWorkerResult> {
    const rows = this.store.db.prepare("SELECT * FROM knowledge_candidate_insight_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT ?")
      .all(Math.max(1, Math.min(100, Math.trunc(limit)))) as Array<Record<string, unknown>>;
    const result: CandidateInsightWorkerResult = { claimed: rows.length, completed: 0, failed: 0, retried: 0 };
    for (const row of rows) {
      const job = jobFromRow(row);
      let insight: CandidateInsight | undefined;
      let failure: unknown;
      try {
        insight = await this.compiler.compile({ actorId: job.actorId, sessionId: job.workSessionId, evidenceRefs: job.evidenceRefs, context: job.context });
      } catch (error) {
        failure = error;
      }
      const now = this.clock().toISOString();
      if (insight) {
        this.store.db.prepare("UPDATE knowledge_candidate_insight_jobs SET status = 'done', insight_id = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'queued'")
          .run(insight.persisted ? insight.id : null, now, job.id);
        result.completed += 1;
      } else {
        const attempts = job.attempts + 1;
        const terminal = attempts >= this.maxAttempts;
        this.store.db.prepare("UPDATE knowledge_candidate_insight_jobs SET status = ?, error = ?, attempts = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
          .run(terminal ? "failed" : "queued", jobErrorLabel(failure), attempts, now, job.id);
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
