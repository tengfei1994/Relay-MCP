import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { validateStateId } from "./state-id.js";
import { RemoteCommandTimeoutError } from "./remote-runner.js";
import "dotenv/config";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const STATE_ROOT = process.env.RELAY_STATE_ROOT ?? join(WORKSPACE_ROOT, ".relay-mcp");
const JOB_ROOT = join(STATE_ROOT, "jobs");
const AUDIT_PATH = join(STATE_ROOT, "audit.jsonl");
const MAX_JOB_LOGS = Number(process.env.RELAY_JOB_LOG_LIMIT ?? 200);

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";

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
  phase?: string;
  lastHeartbeatAt?: string;
  errorCategory?: string;
  retrySafe?: boolean;
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
  phase: (name: string) => void;
}

const activeJobs = new Map<string, AbortController>();

function ensureState(): void {
  mkdirSync(JOB_ROOT, { recursive: true });
  mkdirSync(STATE_ROOT, { recursive: true });
}

function jobPath(id: string): string {
  return join(JOB_ROOT, `${validateStateId(id, "job id")}.json`);
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
    phase: "not_started",
    input,
    logs: [],
    startedAt: new Date().toISOString(),
  };
  const controller = new AbortController();
  activeJobs.set(job.id, controller);
  saveJob(job);
  writeAudit({ userId: user.id, username: user.username, project, kind, jobId: job.id, event: "job_started" });

  const log = (message: string, level: JobLogEntry["level"] = "info") => {
    const current = getJob(job.id) ?? job;
    saveJob({ ...current, lastHeartbeatAt: new Date().toISOString() });
    appendJobLog(job.id, message, level);
  };
  const phase = (name: string) => {
    const current = getJob(job.id) ?? job;
    saveJob({ ...current, phase: name, lastHeartbeatAt: new Date().toISOString() });
    appendJobLog(job.id, `phase=${name}`);
  };
  void Promise.resolve()
    .then(() => {
      if (controller.signal.aborted) {
        throw new Error("Job cancelled before remote execution started");
      }
      phase("connecting");
      log("Job started");
      return work({ signal: controller.signal, log, phase });
    })
    .then((summary) => {
      const current = getJob(job.id) ?? job;
      const cancelled = Boolean(controller.signal.aborted || current.cancelRequestedAt);
      saveJob({
        ...current,
        status: cancelled ? "cancelled" : "succeeded",
        phase: cancelled ? "cancelled" : "completed",
        lastHeartbeatAt: new Date().toISOString(),
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
      const errorCategory = err instanceof Error && "category" in err
        ? String((err as Error & { category?: string }).category)
        : "remote_or_relay";
      const timedOut = err instanceof RemoteCommandTimeoutError;
      const error = cancelled
        ? "Job cancelled"
        : timedOut
          ? "Remote command timed out; execution state is unknown. Verify the target before retrying."
          : err instanceof Error ? err.message : String(err);
      saveJob({
        ...current,
        status: cancelled ? "cancelled" : timedOut ? "unknown" : "failed",
        phase: cancelled ? "cancelled" : timedOut ? "unknown" : "failed",
        lastHeartbeatAt: new Date().toISOString(),
        errorCategory: cancelled ? "cancelled" : timedOut ? "timeout" : errorCategory,
        retrySafe: timedOut || errorCategory === "remote_exit" ? false : true,
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
        status: "unknown",
        phase: "unknown",
        errorCategory: "relay_restart",
        retrySafe: false,
        error: "Relay MCP restarted before this in-process job completed; remote execution state is unknown",
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
