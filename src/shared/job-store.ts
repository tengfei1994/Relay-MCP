import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import "dotenv/config";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const STATE_ROOT = process.env.RELAY_STATE_ROOT ?? join(WORKSPACE_ROOT, ".relay-mcp");
const JOB_ROOT = join(STATE_ROOT, "jobs");
const AUDIT_PATH = join(STATE_ROOT, "audit.jsonl");

export type JobStatus = "running" | "succeeded" | "failed";

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
  startedAt: string;
  finishedAt?: string;
}

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
    .slice(0, limit);
}

export function startJob(
  user: { id: number; username: string },
  project: string,
  kind: string,
  input: unknown,
  work: () => Promise<string>
): JobRecord {
  const job: JobRecord = {
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId: user.id,
    username: user.username,
    project,
    kind,
    status: "running",
    input,
    startedAt: new Date().toISOString(),
  };
  saveJob(job);
  writeAudit({ userId: user.id, username: user.username, project, kind, jobId: job.id, event: "job_started" });

  void work()
    .then((summary) => {
      saveJob({ ...job, status: "succeeded", summary, finishedAt: new Date().toISOString() });
      writeAudit({ userId: user.id, username: user.username, project, kind, jobId: job.id, event: "job_succeeded" });
    })
    .catch((err) => {
      saveJob({
        ...job,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date().toISOString(),
      });
      writeAudit({ userId: user.id, username: user.username, project, kind, jobId: job.id, event: "job_failed" });
    });

  return job;
}
