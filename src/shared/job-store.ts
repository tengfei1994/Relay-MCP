import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import "dotenv/config";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const STATE_ROOT = process.env.RELAY_STATE_ROOT ?? join(WORKSPACE_ROOT, ".relay-mcp");
const JOB_ROOT = join(STATE_ROOT, "jobs");
const AUDIT_PATH = join(STATE_ROOT, "audit.jsonl");
const MAX_JOB_LOGS = Number(process.env.RELAY_JOB_LOG_LIMIT ?? 200);

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface JobLogEntry {
  at: string;
  level: "info" | "stdout" | "stderr";
  message: string;
}

export interface JobRecord {
  id: string;
  userId: number;
  username: string;
  project: string;
  kind: string;
  status: JobStatus;
  input: unknown;
  summary?: string;
  error?: string;
  logs?: JobLogEntry[];
  startedAt: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
}

export interface JobContext {
  signal: AbortSignal;
  log: (message: string, level?: JobLogEntry["level"]) => void;
}

const activeJobs = new Map<string, AbortController>();

function ensureState(): void {
  mkdirSync(JOB_ROOT, { recursive: true });
  mkdirSync(STATE_ROOT, { recursive: true });
}

function jobPath(id: string): string {
  return join(JOB_ROOT, `${id}.json`);
}

export function writeAudit(entry: Record<string, unknown>): void {
  ensureState();
  appendFileSync(AUDIT_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
}

export function saveJob(job: JobRecord): void {
  ensureState();
  writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2), "utf8");
}

export function getJob(id: string): JobRecord | undefined {
  ensureState();
  const path = jobPath(id);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as JobRecord;
}

export function listJobs(userId: number, limit = 20): JobRecord[] {
  ensureState();
  return readdirSync(JOB_ROOT)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(JOB_ROOT, name), "utf8")) as JobRecord)
    .filter((job) => job.userId === userId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, Math.max(1, Math.min(limit, 100)));
}

export function appendJobLog(id: string, message: string, level: JobLogEntry["level"] = "info"): void {
  const job = getJob(id);
  if (!job) return;
  const logs = [...(job.logs ?? []), { at: new Date().toISOString(), level, message }];
  saveJob({ ...job, logs: logs.slice(-MAX_JOB_LOGS) });
}

export function startJob(
  user: { id: number; username: string },
  project: string,
  kind: string,
  input: unknown,
  work: (context: JobContext) => Promise<string>
): JobRecord {
  const job: JobRecord = {
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId: user.id,
    username: user.username,
    project,
    kind,
    status: "running",
    input,
    logs: [],
    startedAt: new Date().toISOString(),
  };
  const controller = new AbortController();
  activeJobs.set(job.id, controller);
  saveJob(job);
  writeAudit({ userId: user.id, username: user.username, project, kind, jobId: job.id, event: "job_started" });

  const log = (message: string, level: JobLogEntry["level"] = "info") => appendJobLog(job.id, message, level);
  log("Job started");

  void work({ signal: controller.signal, log })
    .then((summary) => {
      const current = getJob(job.id) ?? job;
      const cancelled = Boolean(controller.signal.aborted || current.cancelRequestedAt);
      saveJob({
        ...current,
        status: cancelled ? "cancelled" : "succeeded",
        summary: cancelled ? undefined : summary,
        error: cancelled ? "Job cancelled" : undefined,
        finishedAt: new Date().toISOString(),
      });
      log(cancelled ? "Job cancelled" : "Job succeeded");
      writeAudit({
        userId: user.id,
        username: user.username,
        project,
        kind,
        jobId: job.id,
        event: cancelled ? "job_cancelled" : "job_succeeded",
      });
    })
    .catch((err) => {
      const current = getJob(job.id) ?? job;
      const cancelled = Boolean(controller.signal.aborted || current.cancelRequestedAt);
      const error = cancelled ? "Job cancelled" : err instanceof Error ? err.message : String(err);
      saveJob({
        ...current,
        status: cancelled ? "cancelled" : "failed",
        error,
        finishedAt: new Date().toISOString(),
      });
      log(error, "stderr");
      writeAudit({
        userId: user.id,
        username: user.username,
        project,
        kind,
        jobId: job.id,
        event: cancelled ? "job_cancelled" : "job_failed",
      });
    })
    .finally(() => {
      activeJobs.delete(job.id);
    });

  return job;
}

export function cancelJob(id: string, userId: number): JobRecord {
  const job = getJob(id);
  if (!job || job.userId !== userId) throw new Error(`Job '${id}' not found`);
  if (job.status !== "running") return job;

  const updated: JobRecord = {
    ...job,
    cancelRequestedAt: new Date().toISOString(),
  };
  saveJob(updated);
  appendJobLog(id, "Cancellation requested");
  activeJobs.get(id)?.abort();
  writeAudit({ userId, project: job.project, kind: job.kind, jobId: id, event: "job_cancel_requested" });
  return getJob(id) ?? updated;
}

export function markInterruptedJobs(): number {
  ensureState();
  let count = 0;
  for (const name of readdirSync(JOB_ROOT)) {
    if (!name.endsWith(".json")) continue;
    const path = join(JOB_ROOT, name);
    try {
      const job = JSON.parse(readFileSync(path, "utf8")) as JobRecord;
      if (job.status !== "running") continue;
      saveJob({
        ...job,
        status: "interrupted",
        error: "Relay MCP restarted before this in-process job completed",
        finishedAt: new Date().toISOString(),
      });
      count += 1;
    } catch {
      // Preserve malformed records for manual inspection.
    }
  }
  return count;
}

markInterruptedJobs();
