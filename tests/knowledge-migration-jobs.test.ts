import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createKnowledgeStore, type KnowledgeStore } from "../src/knowledge/store.ts";
import { MigrationController } from "../src/knowledge/migration-control.ts";
import * as worker from "../src/knowledge/ingest-worker.ts";
import Database from "better-sqlite3";
import { WeKnoraIngestor } from "../src/knowledge/weknora-ingest.ts";

const input = { actorId: 7, idempotencyKey: "async-migration", parserVersion: "parser-v1", projectId: "p1" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-migration-job-"));
  const path = join(root, "knowledge.db");
  const store = createKnowledgeStore({ dbPath: path });
  for (const id of ["a", "b"]) store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,source_locator,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, "product_document", `Guide ${id}`, `Body ${id}`, "approved", "p1", `${id}.md`, "now", "now");
  return { root, path, store, clean: () => { if (store.db.open) store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function enqueue(store: KnowledgeStore, value = input) {
  assert.equal(typeof worker.enqueueProductMigration, "function", "migration must use the durable ingest queue");
  return worker.enqueueProductMigration(store, value);
}

test("enqueue returns a persisted stable migration/job without starting an upstream request", () => {
  const f = fixture();
  try {
    const first = enqueue(f.store), again = enqueue(f.store);
    assert.equal(first.job.status, "queued");
    assert.equal(first.job.kind, "product_migration");
    assert.equal(first.migrationId, first.migration.id);
    assert.equal(first.migrationId, again.migrationId);
    assert.equal(first.job.id, again.job.id);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_ingest_jobs").get().n, 1);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_migrations").get().n, 1);
    assert.throws(() => enqueue(f.store, { ...input, parserVersion: "different" }), /idempotency|operation|different/i);
    assert.equal(new MigrationController(f.store).activeProductProvider(), "relay_local");
  } finally { f.clean(); }
});

test("migration enqueue reserves the WAL writer before reading its idempotency snapshot", () => {
  const f = fixture(); const other = new Database(f.path, { timeout: 0 });
  const originalPrepare = f.store.db.prepare.bind(f.store.db);
  let interleaved = false; let competingCode: string | undefined;
  // Both handles are real SQLite WAL connections. Interleave the second writer
  // exactly after enqueue's first read, reproducing snapshot upgrade contention.
  (f.store.db as any).prepare = (sql: string) => {
    const statement = originalPrepare(sql);
    if (sql === "SELECT * FROM knowledge_ingest_jobs WHERE id=?") {
      const get = statement.get.bind(statement);
      statement.get = ((...params: any[]) => {
        const row = get(...params);
        if (!interleaved) {
          interleaved = true;
          try { other.prepare("UPDATE knowledge_documents SET updated_at='concurrent writer' WHERE id='a'").run(); }
          catch (error) { competingCode = (error as { code?: string }).code; }
        }
        return row;
      }) as typeof statement.get;
    }
    return statement;
  };
  try {
    const first = enqueue(f.store);
    assert.ok(interleaved); assert.match(competingCode ?? "", /^SQLITE_BUSY/);
    assert.equal(first.job.status, "queued"); assert.equal(enqueue(f.store).job.id, first.job.id);
    assert.equal(other.prepare("SELECT COUNT(*) AS n FROM knowledge_ingest_jobs").get().n, 1);
    other.prepare("UPDATE knowledge_documents SET updated_at='writer resumes' WHERE id='a'").run();
  } finally { (f.store.db as any).prepare = originalPrepare; other.close(); f.clean(); }
});

test("exhausted writer contention is retryable and leaves no partial migration or job", () => {
  const f = fixture(); const other = new Database(f.path);
  f.store.db.pragma("busy_timeout = 20"); other.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => enqueue(f.store), (error: any) => error.code === "migration_queue_busy" && error.statusCode === 503 && error.retryAfterSeconds === 1);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_ingest_jobs").get().n, 0);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_migrations").get().n, 0);
    other.exec("ROLLBACK");
    assert.equal(enqueue(f.store).job.status, "queued");
  } finally { if (other.inTransaction) other.exec("ROLLBACK"); other.close(); f.clean(); }
});

async function withUpstream(fn: (state: { uploads: string[]; failB: boolean; releaseB?: () => void; blockB: boolean }) => Promise<void>) {
  const previous = Object.fromEntries(["KNOWLEDGE_ENGINE_HOME", "WEKNORA_BASE_URL", "WEKNORA_KNOWLEDGE_BASE_ID", "WEKNORA_API_TOKEN"].map(key => [key, process.env[key]]));
  const state = { uploads: [] as string[], failB: false, blockB: false, releaseB: undefined as (() => void) | undefined };
  const server = createServer(async (req, res) => {
    try {
      let value: unknown;
      if (req.method === "POST") {
        const bytes: Buffer[] = []; for await (const chunk of req) bytes.push(Buffer.from(chunk));
        const request = new Request("http://fixture/upload", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: Buffer.concat(bytes) });
        const form = await request.formData(); const name = String(form.get("fileName"));
        state.uploads.push(name);
        if (name === "b.md" && state.blockB) await new Promise<void>(resolve => { state.releaseB = resolve; });
        if (name === "b.md" && state.failB) { res.writeHead(503); res.end("private-error-token"); return; }
        value = { success: true, data: { id: name, knowledge_base_id: "kb", channel: form.get("channel"), metadata: JSON.parse(String(form.get("metadata"))), parse_status: "completed" } };
      } else if (req.url?.startsWith("/api/v1/chunks/")) {
        const id = decodeURIComponent(req.url.split("/").pop()!.split("?")[0]);
        value = { data: [{ id: "chunk-" + id, knowledge_id: id, content: "indexed source", seq: 0, chunk_type: "text", index_status: "ready", is_enabled: true }], total: 1 };
      } else {
        const id = decodeURIComponent(req.url!.split("/").pop()!);
        value = { success: true, data: { id, parse_status: "completed" } };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value));
    } catch { res.writeHead(500); res.end("fixture failure"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.KNOWLEDGE_ENGINE_HOME = join(tmpdir(), "absent-runtime-for-migration-jobs");
  process.env.WEKNORA_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.WEKNORA_KNOWLEDGE_BASE_ID = "kb"; process.env.WEKNORA_API_TOKEN = "fixture-key";
  try { await fn(state); }
  finally { state.releaseB?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test("withdrawal during an async migration is durable, counted, and never reported as success", () => withUpstream(async state => {
  const f=fixture();
  try {
    const queued=enqueue(f.store);state.blockB=true;
    const work=worker.executeIngestJob(f.store,queued.job.id);
    const deadline=Date.now()+10_000;while(!state.releaseB && Date.now()<deadline)await delay(20);
    assert.ok(state.releaseB);
    const mapped=f.store.db.prepare("SELECT document_id FROM knowledge_migration_documents WHERE migration_id=? AND local_document_id='a'").get(queued.migrationId) as {document_id:string};
    new WeKnoraIngestor(f.store,{upsertDocument:async()=>{throw new Error("unused");}}).deprecate(mapped.document_id,7);
    state.releaseB();const result=await work;
    assert.equal(result.status,"failed");assert.match(result.error??"",/withdrawn/);
    const summary=result.result as Record<string,unknown>;
    assert.equal(summary.withdrawn,1);assert.equal(summary.mapped,1);assert.equal(summary.processed,2);
    const controller=new MigrationController(f.store);assert.equal(controller.get(queued.migrationId)?.mappingCounts.withdrawn,1);
    assert.throws(()=>controller.publish(queued.migrationId,7),/withdrawn/);
    const uploads=state.uploads.length;enqueue(f.store,{...input,retry:true} as typeof input);
    const retry=await worker.executeIngestJob(f.store,queued.job.id);assert.equal(retry.status,"failed");assert.equal(state.uploads.length,uploads);
  } finally {state.releaseB?.();f.clean();}
}));

test("queued migration survives reopening the store and checkpoints each completed document without publication", () => withUpstream(async state => {
  const f = fixture(); let reopened: KnowledgeStore | undefined;
  try {
    const queued = enqueue(f.store); f.store.close();
    reopened = createKnowledgeStore({ dbPath: f.path }); state.blockB = true;
    const work = worker.runPendingIngestJobs(reopened);
    const deadline = Date.now() + 10_000;
    while (!state.releaseB && Date.now() < deadline) await delay(20);
    assert.ok(state.releaseB, "worker must reach second document");
    const row = reopened.db.prepare("SELECT status,result_json FROM knowledge_ingest_jobs WHERE id=?").get(queued.job.id) as any;
    assert.equal(row.status, "running");
    assert.equal(JSON.parse(row.result_json).mapped, 1);
    assert.equal(JSON.parse(row.result_json).migrationId, queued.migrationId);
    assert.equal(new MigrationController(reopened).get(queued.migrationId)?.report.mapped, 1);
    state.releaseB(); await work;
    assert.equal(reopened.db.prepare("SELECT status FROM knowledge_ingest_jobs WHERE id=?").get(queued.job.id).status, "succeeded");
    assert.equal(new MigrationController(reopened).get(queued.migrationId)?.status, "staged");
    assert.equal(new MigrationController(reopened).activeProductProvider(), "relay_local");
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM knowledge_weknora_documents WHERE status='published'").get().n, 0);
    assert.equal(enqueue(reopened).job.id, queued.job.id);
    assert.deepEqual(state.uploads, ["a.md", "b.md"]);
  } finally { state.releaseB?.(); reopened?.close(); f.clean(); }
}));

test("failure is durable and only explicit retry resumes the same job without reimporting successful documents", () => withUpstream(async state => {
  const f = fixture();
  try {
    state.failB = true; const queued = enqueue(f.store); await worker.runPendingIngestJobs(f.store);
    const failed = enqueue(f.store);
    assert.equal(failed.job.status, "failed");
    assert.doesNotMatch(JSON.stringify(failed.job), /private-error-token/);
    await worker.runPendingIngestJobs(f.store); assert.deepEqual(state.uploads, ["a.md", "b.md"]);
    state.failB = false;
    const retry = worker.enqueueProductMigration(f.store, { ...input, retry: true });
    assert.equal(retry.job.id, queued.job.id); assert.equal(retry.migrationId, queued.migrationId);
    assert.equal(retry.job.status, "queued"); await worker.runPendingIngestJobs(f.store);
    assert.deepEqual(state.uploads, ["a.md", "b.md", "b.md"]);
    const row = f.store.db.prepare("SELECT status,attempts FROM knowledge_ingest_jobs WHERE id=?").get(queued.job.id) as any;
    assert.equal(row.status, "succeeded"); assert.equal(row.attempts, 2);
    assert.equal(new MigrationController(f.store).get(queued.migrationId)?.report.failed, 0);
  } finally { f.clean(); }
}));

test("interrupted migration is not automatically replayed and explicit retry preserves stable identities", () => {
  const f = fixture();
  try {
    const queued = enqueue(f.store);
    f.store.db.prepare("UPDATE knowledge_ingest_jobs SET status='running' WHERE id=?").run(queued.job.id);
    worker.recoverInterruptedIngestJobs(f.store);
    assert.equal(enqueue(f.store).job.status, "failed");
    const retry = worker.enqueueProductMigration(f.store, { ...input, retry: true });
    assert.equal(retry.job.status, "queued"); assert.equal(retry.job.id, queued.job.id); assert.equal(retry.migrationId, queued.migrationId);
  } finally { f.clean(); }
});

test("retry preserves the original source manifest and refuses changed successful sources", () => withUpstream(async state => {
  const f = fixture();
  try {
    state.failB = true;
    const queued = enqueue(f.store); await worker.runPendingIngestJobs(f.store);
    f.store.db.prepare("UPDATE knowledge_documents SET body='changed after staging' WHERE id='a'").run();
    state.failB = false;
    worker.enqueueProductMigration(f.store, { ...input, retry: true });
    await worker.runPendingIngestJobs(f.store);
    assert.deepEqual(state.uploads, ["a.md", "b.md"], "changed corpus must fail before further upstream mutation");
    assert.equal(enqueue(f.store).job.status, "failed");
    assert.equal(new MigrationController(f.store).get(queued.migrationId)?.report.mapped, 1);
    f.store.db.prepare("UPDATE knowledge_documents SET body='Body a' WHERE id='a'").run();
    f.store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,source_locator,created_at,updated_at) VALUES ('c','product_document','new','new','approved','p1','c.md','now','now')").run();
    worker.enqueueProductMigration(f.store, { ...input, retry: true }); await worker.runPendingIngestJobs(f.store);
    assert.equal(enqueue(f.store).job.status, "succeeded");
    assert.deepEqual(state.uploads, ["a.md", "b.md", "b.md"]);
    assert.equal(new MigrationController(f.store).get(queued.migrationId)?.report.total, 2);
  } finally { f.clean(); }
}));
