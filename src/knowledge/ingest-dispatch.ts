import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { setPriority } from "node:os";
import type { KnowledgeStore } from "./store.js";
import type { IngestJob } from "./ingest-worker.js";

const active = new Map<string, Promise<number>>();
const running = new Map<string, Promise<IngestJob>>();
const children = new Set<ChildProcess>();
const wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const scheduled = new Map<string, ReturnType<typeof setImmediate>>();
function clearWake(key: string): void {
  const timer = wakeTimers.get(key);
  if (timer) clearTimeout(timer);
  wakeTimers.delete(key);
}
function armNextWake(store: KnowledgeStore): void {
  const key = store.db.name;
  clearWake(key);
  if (stopping || !store.db.open) return;
  const next = store.db.prepare("SELECT MIN(available_at) AS available_at FROM knowledge_ingest_jobs WHERE status='queued'").get() as { available_at?: string | null };
  if (!next.available_at) return;
  const at = Date.parse(next.available_at);
  if (!Number.isFinite(at)) return;
  // One unref timer per database, never a setImmediate spin for future work.
  // Re-check long delays at most once a minute so closed stores are released.
  const timer = setTimeout(() => {
    wakeTimers.delete(key);
    if (!stopping && store.db.open) scheduleIngestJobs(store);
  }, Math.max(100, Math.min(60_000, at - Date.now())));
  timer.unref();
  wakeTimers.set(key, timer);
}
let stopping = false;
export async function stopIngestJobs(): Promise<void> {
  stopping = true;
  for (const timer of wakeTimers.values()) clearTimeout(timer);
  wakeTimers.clear();
  for (const immediate of scheduled.values()) clearImmediate(immediate);
  scheduled.clear();
  for (const child of children) child.kill("SIGKILL");
  await Promise.allSettled([...running.values()]);
}
export function claimIngestJob(store: KnowledgeStore, id: string, token: string): boolean {
  const now = new Date().toISOString();
  return Boolean(store.db.prepare("UPDATE knowledge_ingest_jobs SET status='running',attempts=attempts+1,started_at=?,updated_at=?,owner_token=?,owner_pid=? WHERE id=? AND status='queued' AND available_at<=?").run(now, now, token, process.pid, id, now).changes);
}
export function ingestJobSnapshot(store: KnowledgeStore, id: string): IngestJob {
  if (!store.db.open) return { id, kind: "unknown", status: "unknown", error: "Knowledge store closed; query persisted job status after reopening" };
  const row = store.db.prepare("SELECT id,kind,status,error,result_json FROM knowledge_ingest_jobs WHERE id=?").get(id) as IngestJob & { result_json?: string } | undefined;
  if (!row) throw new Error("Ingest job not found");
  return { id: row.id, kind: row.kind, status: row.status, ...(row.error ? { error: row.error } : {}), ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}) };
}
function fail(store: KnowledgeStore, id: string, error: string, token: string | null): boolean {
  return store.db.transaction(() => {
    const now = new Date().toISOString();
    const row = store.db.prepare("SELECT kind,result_json FROM knowledge_ingest_jobs WHERE id=? AND status='running' AND owner_token IS ?").get(id, token) as { kind?: string; result_json?: string } | undefined;
    if (!row) return false;
    if (row.kind === "product_migration") error = "Migration worker interrupted or failed; progress is preserved, retry explicitly";
    const changed = store.db.prepare("UPDATE knowledge_ingest_jobs SET status='failed',error=?,finished_at=?,updated_at=? WHERE id=? AND status='running' AND owner_token IS ?").run(error, now, now, id, token);
    if (!changed.changes) return false;
    const progress = JSON.parse(row.result_json ?? "{}");
    if (progress.runId) store.db.prepare("UPDATE knowledge_ingest_runs SET status='failed',failed=failed+1,finished_at=?,error=? WHERE id=? AND status='running'").run(now, JSON.stringify([{ error }]), progress.runId);
    return true;
  }).immediate();
}

export function runIngestJob(store: KnowledgeStore, id: string): Promise<IngestJob> {
  const key = `${store.db.name}:${id}`;
  if (running.has(key)) return running.get(key)!;
  const kind = store.db.open ? (store.db.prepare("SELECT kind FROM knowledge_ingest_jobs WHERE id=?").get(id) as { kind?: string } | undefined)?.kind ?? "unknown" : "unknown";
  const closedResult = (): IngestJob => ({ id, kind, status: "unknown", error: "Knowledge store closed; query persisted job status after reopening" });
  if (!store.db.open) return Promise.resolve(closedResult());
  // The parent claims durably before fork, so a crash before IPC still has a
  // recoverable owner. Other Web/MCP dispatchers never launch the same attempt.
  const ownerToken = randomUUID();
  if (!claimIngestJob(store, id, ownerToken)) return Promise.resolve(ingestJobSnapshot(store, id));
  const promise = new Promise<IngestJob>((resolve, reject) => {
    const source = import.meta.url.endsWith(".ts");
    const child = fork(fileURLToPath(new URL(source ? "./ingest-process.ts" : "./ingest-process.js", import.meta.url)), [store.db.name, id, ownerToken], {
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
        if (!store.db.open) { clearWake(store.db.name); resolve(closedResult()); return; }
        if (timedOut || memoryExceeded || code !== 0) fail(store, id, memoryExceeded ? "Import exceeded 900 MiB resident memory and was stopped" : timedOut ? `Import exceeded ${timeout} ms and was stopped` : `Import process exited (${signal ?? code}): ${diagnostic}`, ownerToken);
        const row = store.db.prepare("SELECT status,owner_token FROM knowledge_ingest_jobs WHERE id=?").get(id) as { status: string; owner_token: string | null };
        if (row.status === "running" && row.owner_token === ownerToken) fail(store, id, "Import process exited without a terminal result", ownerToken);
        resolve(ingestJobSnapshot(store, id));
      } catch (error) { reject(error); }
    });
  }).catch(error => {
    if (store.db.open) fail(store, id, "Import process could not start", ownerToken);
    throw error;
  }).finally(() => { running.delete(key); });
  running.set(key, promise);
  return promise;
}

export function scheduleIngestJobs(store: KnowledgeStore): void {
  const key = store.db.name;
  if (stopping || !store.db.open || scheduled.has(key)) return;
  scheduled.set(key, setImmediate(() => {
    scheduled.delete(key);
    if (!stopping && store.db.open) void runPendingIngestJobs(store).catch((error) => console.error("Ingest dispatcher failed", error));
  }));
}

export function runPendingIngestJobs(store: KnowledgeStore, limit = 100): Promise<number> {
  if (active.has(store.db.name)) return active.get(store.db.name)!;
  clearWake(store.db.name);
  const work = (async () => {
    let count = 0;
    while (!stopping && store.db.open && count < limit) {
      const row = store.db.prepare("SELECT id FROM knowledge_ingest_jobs WHERE status='queued' AND available_at<=? ORDER BY created_at LIMIT 1").get(new Date().toISOString()) as { id: string } | undefined;
      if (!row) break;
      await runIngestJob(store, row.id); count++;
    }
    return count;
  })().finally(() => { active.delete(store.db.name); armNextWake(store); });
  active.set(store.db.name, work);
  return work;
}

// Startup recovery must not fail another live Web/MCP dispatcher's work.
// PID reuse is deliberately conservative: an apparently live owner is retained
// for operator review rather than risking a duplicate upstream upload.
export function recoverInterruptedIngestJobs(store: KnowledgeStore): void {
  const rows = store.db.prepare("SELECT id,owner_token,owner_pid FROM knowledge_ingest_jobs WHERE status='running'").all() as Array<{ id: string; owner_token: string | null; owner_pid: number | null }>;
  for (const row of rows) {
    if (row.owner_token && row.owner_pid && row.owner_pid > 0) {
      try { process.kill(row.owner_pid, 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    }
    fail(store, row.id, "Import interrupted by server restart; retry explicitly", row.owner_token);
  }
}
