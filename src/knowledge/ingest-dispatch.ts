import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { setPriority } from "node:os";
import type { KnowledgeStore } from "./store.js";
import type { IngestJob } from "./ingest-worker.js";

const active = new Map<string, Promise<number>>();
const running = new Map<string, Promise<IngestJob>>();
const children = new Set<ChildProcess>();
let stopping = false;
export async function stopIngestJobs(): Promise<void> {
  stopping = true;
  for (const child of children) child.kill("SIGKILL");
  await Promise.allSettled([...running.values()]);
}
function fail(store: KnowledgeStore, id: string, error: string): void {
  const now = new Date().toISOString();
  const row = store.db.prepare("SELECT result_json FROM knowledge_ingest_jobs WHERE id=?").get(id) as { result_json?: string } | undefined;
  const progress = JSON.parse(row?.result_json ?? "{}");
  if (progress.runId) store.db.prepare("UPDATE knowledge_ingest_runs SET status='failed',failed=failed+1,finished_at=?,error=? WHERE id=? AND status='running'").run(now, JSON.stringify([{ error }]), progress.runId);
  store.db.prepare("UPDATE knowledge_ingest_jobs SET status='failed',error=?,finished_at=?,updated_at=? WHERE id=? AND status IN ('queued','running')").run(error, now, now, id);
}

export function runIngestJob(store: KnowledgeStore, id: string): Promise<IngestJob> {
  const key = `${store.db.name}:${id}`;
  if (running.has(key)) return running.get(key)!;
  const promise = new Promise<IngestJob>((resolve, reject) => {
    const source = import.meta.url.endsWith(".ts");
    const child = fork(fileURLToPath(new URL(source ? "./ingest-process.ts" : "./ingest-process.js", import.meta.url)), [store.db.name, id], {
      execArgv: ["--max-old-space-size=512", "--expose-gc", ...(source ? ["--import", "tsx"] : [])],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.add(child);
    let diagnostic = ""; let timedOut = false; let memoryExceeded = false;
    if (child.pid && process.platform !== "win32") { try { setPriority(child.pid, 10); } catch { /* priority is best effort */ } }
    child.stderr?.on("data", (chunk) => { diagnostic = (diagnostic + String(chunk)).slice(-2000); });
    const configured = Number(process.env.RELAY_INGEST_TIMEOUT_MS);
    const timeout = Number.isFinite(configured) && configured > 0 ? configured : 30 * 60_000;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    // V8's heap limit does not include ZIP buffers. Bound resident memory too on Linux.
    const memoryTimer = setInterval(() => {
      if (process.platform !== "linux" || !child.pid) return;
      try {
        const rss = Number(readFileSync(`/proc/${child.pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
        if (rss > 900 * 1024) { memoryExceeded = true; child.kill("SIGKILL"); }
      } catch { /* process may have just exited */ }
    }, 1000);
    // Parent shutdown disconnects IPC; kill rather than orphaning a CPU-bound importer.
    const kill = () => { child.kill("SIGKILL"); };
    process.once("exit", kill);
    child.once("error", (error) => { diagnostic = error.message; });
    child.once("close", (code, signal) => {
      children.delete(child);
      clearTimeout(timer); clearInterval(memoryTimer); process.removeListener("exit", kill);
      try {
        if (timedOut || memoryExceeded || code !== 0) fail(store, id, memoryExceeded ? "Import exceeded 900 MiB resident memory and was stopped" : timedOut ? `Import exceeded ${timeout} ms and was stopped` : `Import process exited (${signal ?? code}): ${diagnostic}`);
        const row = store.db.prepare("SELECT id,kind,status,error,result_json FROM knowledge_ingest_jobs WHERE id=?").get(id) as IngestJob & { result_json?: string };
        if (row.status === "running") { fail(store, id, "Import process exited without a terminal result"); row.status = "failed"; }
        resolve({ ...row, result: row.result_json ? JSON.parse(row.result_json) : undefined });
      } catch (error) { reject(error); }
    });
  }).finally(() => { running.delete(key); });
  running.set(key, promise);
  return promise;
}

export function scheduleIngestJobs(store: KnowledgeStore): void {
  setImmediate(() => { if (!stopping && store.db.open) void runPendingIngestJobs(store).catch((error) => console.error("Ingest dispatcher failed", error)); });
}

export function runPendingIngestJobs(store: KnowledgeStore, limit = 100): Promise<number> {
  if (active.has(store.db.name)) return active.get(store.db.name)!;
  const work = (async () => {
    let count = 0;
    while (!stopping && store.db.open && count < limit) {
      const row = store.db.prepare("SELECT id FROM knowledge_ingest_jobs WHERE status='queued' AND available_at<=? ORDER BY created_at LIMIT 1").get(new Date().toISOString()) as { id: string } | undefined;
      if (!row) break;
      await runIngestJob(store, row.id); count++;
    }
    return count;
  })().finally(() => { active.delete(store.db.name); if (store.db.open && store.db.prepare("SELECT 1 FROM knowledge_ingest_jobs WHERE status='queued' AND available_at<=?").get(new Date().toISOString())) scheduleIngestJobs(store); });
  active.set(store.db.name, work);
  return work;
}

// Startup only. Interrupted work is visible as failed and is not silently replayed.
export function recoverInterruptedIngestJobs(store: KnowledgeStore): void {
  const rows = store.db.prepare("SELECT id FROM knowledge_ingest_jobs WHERE status='running'").all() as Array<{ id: string }>;
  for (const row of rows) fail(store, row.id, "Import interrupted by server restart; retry explicitly");
}
