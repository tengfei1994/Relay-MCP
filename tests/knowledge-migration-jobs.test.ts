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

function localIngestor(store: KnowledgeStore, calls: string[], after?: () => void) {
  return new WeKnoraIngestor(store, { async upsertDocument(value) { calls.push(value.idempotencyKey); after?.(); return { externalDocumentId: `ext-${value.idempotencyKey}`, knowledgeBaseId: "kb", parseStatus: "completed", externalChunkIds: [`chunk-${value.idempotencyKey}`] }; } });
}

test("a provider fault stops before the next source after persisting the failed checkpoint",async()=>{
 const f=fixture(),calls:string[]=[];try{
  const controller=new MigrationController(f.store),ingestor=new WeKnoraIngestor(f.store,{async upsertDocument(value){calls.push(value.idempotencyKey);throw new Error("upstream_failed");}});
  let progress:any;
  await assert.rejects(controller.createFromLocal(input,ingestor,value=>{progress=value;},{afterDocumentFailure:async()=>{throw new Error("provider_unavailable_stop");}}),/provider_unavailable_stop/);
  assert.deepEqual(calls,["async-migration:a"]);
  assert.equal(progress.failed,1);assert.equal(progress.pending,1);
  const row=f.store.db.prepare("SELECT status FROM knowledge_migration_documents WHERE local_document_id='a'").get() as any;
  assert.equal(row.status,"failed");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM knowledge_migration_documents WHERE local_document_id='b'").get().n,0);
 }finally{f.clean();}
});

test("bounded migration checkpoints a document limit and resumes without uploading mapped sources", async () => {
  const f=fixture(), calls:string[]=[], checked:string[]=[];
  try {
    const controller=new MigrationController(f.store), ingestor=localIngestor(f.store,calls);
    const options={maxDocumentsPerPass:1,beforeDocument:async(document:any)=>{checked.push(document.localDocumentId);return undefined;}};
    const first=await controller.createFromLocal(input,ingestor,undefined,options);
    assert.equal(first.status,"created");assert.equal(first.report.yielded,true);assert.equal(first.report.pending,1);assert.equal(first.report.failed,0);assert.equal(first.mappingCounts.total,1);
    assert.throws(()=>controller.publish(first.id,7),/staged/);
    const second=await controller.createFromLocal(input,ingestor,undefined,options);
    assert.equal(second.id,first.id);assert.equal(second.status,"staged");assert.equal(second.report.pending,0);assert.equal(second.report.yielded,false);
    assert.deepEqual(checked,["a","b"]);assert.deepEqual(calls,["async-migration:a","async-migration:b"]);
  } finally {f.clean();}
});

test("capacity deferral preserves a pending source and never increments failure",async()=>{
 const f=fixture(),calls:string[]=[];try{
  const controller=new MigrationController(f.store),ingestor=localIngestor(f.store,calls),until=new Date(Date.now()+60_000).toISOString();
  const first=await controller.createFromLocal(input,ingestor,undefined,{beforeDocument:async(document:any)=>document.localDocumentId==="b"?{deferUntil:until,reason:"provider_capacity"}:undefined});
  assert.equal(first.status,"created");assert.equal(first.report.deferredUntil,until);assert.equal(first.report.reason,"provider_capacity");assert.equal(first.report.pending,1);assert.equal(first.report.failed,0);assert.equal(first.mappingCounts.total,1);
  const second=await controller.createFromLocal(input,ingestor,undefined,{beforeDocument:async(document:any)=>{assert.equal(document.localDocumentId,"b");return undefined;}});
  assert.equal(second.status,"staged");assert.deepEqual(calls,["async-migration:a","async-migration:b"]);
 }finally{f.clean();}
});

test("migration time budget is checked between documents and keeps the completed checkpoint",async()=>{
 const f=fixture(),calls:string[]=[];let tick=Date.now();try{
  const controller=new MigrationController(f.store,()=>new Date(tick)),ingestor=localIngestor(f.store,calls,()=>{tick+=301;});
  const first=await controller.createFromLocal(input,ingestor,undefined,{maxDurationMs:300});
  assert.equal(first.status,"created");assert.equal(first.report.pending,1);assert.equal(first.report.reason,"max_duration");assert.equal(first.mappingCounts.staged,1);
 }finally{f.clean();}
});

test("worker yields after 25 sources and child exit zero preserves queued progress",()=>withUpstream(async state=>{
 const f=fixture();try{
  for(let i=0;i<24;i++)f.store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,source_locator,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(`c${i}`,"product_document",`Guide c${i}`,`Body c${i}`,"approved","p1",`c${i}.md`,"now","now");
  const queued=enqueue(f.store);const result=await worker.runIngestJob(f.store,queued.job.id);
  assert.equal(result.status,"queued");assert.equal((result.result as any).yielded,true);assert.equal((result.result as any).pending,1);assert.equal(state.uploads.length,25);
  const row=f.store.db.prepare("SELECT status,available_at,finished_at,result_json FROM knowledge_ingest_jobs WHERE id=?").get(queued.job.id) as any;
  assert.equal(row.status,"queued");assert.equal(row.finished_at,null);assert.ok(Date.parse(row.available_at)>Date.now());assert.equal(new MigrationController(f.store).get(queued.migrationId)?.status,"created");
 }finally{f.clean();}
}));

test("future queued jobs wake automatically without being claimed before available_at",()=>withUpstream(async state=>{
 const f=fixture();try{
  const queued=enqueue(f.store);const until=new Date(Date.now()+350).toISOString();f.store.db.prepare("UPDATE knowledge_ingest_jobs SET available_at=? WHERE id=?").run(until,queued.job.id);
  const early=await worker.executeIngestJob(f.store,queued.job.id);assert.equal(early.status,"queued");assert.equal(state.uploads.length,0);
  assert.equal(await worker.runPendingIngestJobs(f.store),0);await delay(100);assert.equal(state.uploads.length,0);
  const deadline=Date.now()+10_000;while(Date.now()<deadline){const row=f.store.db.prepare("SELECT status FROM knowledge_ingest_jobs WHERE id=?").get(queued.job.id) as any;if(row.status==="succeeded")break;await delay(50);}
  assert.equal(f.store.db.prepare("SELECT status FROM knowledge_ingest_jobs WHERE id=?").get(queued.job.id).status,"succeeded");assert.deepEqual(state.uploads,["a.md","b.md"]);
 }finally{f.clean();}
}));

test("queued jobs pin safe managed bindings and refuse changed bindings before upload",async()=>{
 const f=fixture(),previous=process.env.KNOWLEDGE_ENGINE_HOME;
 const {mkdirSync,writeFileSync}=await import("node:fs"); const home=join(f.root,"engine");mkdirSync(home);
 try{
  process.env.KNOWLEDGE_ENGINE_HOME=home;
  writeFileSync(join(home,"engine.json"),JSON.stringify({schemaVersion:1,version:"v0.8.3",baseUrl:"http://127.0.0.1:18190",relayGatewayUrl:"http://127.0.0.1:18300/internal/knowledge-engine/v1",gatewayToken:"private-gateway",ownerEmail:"owner@example.invalid",ownerPassword:"private-password"}));
  const binding={kind:"embedding",providerId:"qwen",modelId:"embedding",dimensions:1024,indexVersion:1,alias:"alias",engineModelId:"engine-model",secret:"must-not-save"};
  const control={schemaVersion:1,phase:"ready",apiKey:"private-api",knowledgeBaseId:"kb",ingestionProfile:"bulk",bindings:[binding]};writeFileSync(join(home,"control.json"),JSON.stringify(control));
  const queued=enqueue(f.store);const payload=JSON.parse(f.store.db.prepare("SELECT payload_json FROM knowledge_ingest_jobs WHERE id=?").get(queued.job.id).payload_json);
  assert.equal(payload.runtimeBinding.knowledgeBaseId,"kb");assert.equal(payload.runtimeBinding.ingestionProfile,"bulk");assert.equal(payload.runtimeBinding.embeddingBinding.dimensions,1024);assert.doesNotMatch(JSON.stringify(payload),/private-|must-not-save/);
  writeFileSync(join(home,"control.json"),JSON.stringify({...control,bindings:[{...binding,indexVersion:2}]}));
  const result=await worker.executeIngestJob(f.store,queued.job.id);assert.equal(result.status,"failed");assert.match(result.error??"",/binding changed/i);assert.equal(f.store.db.prepare("SELECT count(*) n FROM knowledge_migration_documents").get().n,0);
 }finally{if(previous===undefined)delete process.env.KNOWLEDGE_ENGINE_HOME;else process.env.KNOWLEDGE_ENGINE_HOME=previous;f.clean();}
});

test("explicit failed-source retry is attempted once across bounded continuations",async()=>{
 const f=fixture(),calls:string[]=[];try{
  f.store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,source_locator,created_at,updated_at) VALUES ('c','product_document','Guide c','Body c','approved','p1','c.md','now','now')").run();
  const controller=new MigrationController(f.store),ingestor=new WeKnoraIngestor(f.store,{async upsertDocument(value){calls.push(value.idempotencyKey);throw new Error("temporary upstream failure");}});
  await controller.createFromLocal(input,ingestor);
  for(let pass=0;pass<3;pass++){
   const result=await controller.createFromLocal({...input,retry:true},ingestor,undefined,{maxDocumentsPerPass:1});
   assert.equal(result.report.pending,2-pass);assert.equal(result.status,pass===2?"staged":"created");assert.equal(result.report.failed,3);
  }
  assert.deepEqual(calls,["async-migration:a","async-migration:b","async-migration:c","async-migration:a","async-migration:b","async-migration:c"]);
 }finally{f.clean();}
});

test("closing the parent store during child completion does not query a closed connection or rewrite success",()=>withUpstream(async state=>{
 const f=fixture();let reopened:KnowledgeStore|undefined;
 try{
  const queued=enqueue(f.store);state.blockB=true;const running=worker.runIngestJob(f.store,queued.job.id);
  const deadline=Date.now()+10_000;while(!state.releaseB&&Date.now()<deadline)await delay(20);assert.ok(state.releaseB);
  f.store.close();state.releaseB();const result=await running;assert.equal(result.status,"unknown");assert.match(result.error??"",/closed/i);
  reopened=createKnowledgeStore({dbPath:f.path});assert.equal(reopened.db.prepare("SELECT status FROM knowledge_ingest_jobs WHERE id=?").get(queued.job.id).status,"succeeded");
 }finally{state.releaseB?.();reopened?.close();f.clean();}
}));

test("a second dispatcher cannot fail a job already running under another owner", async()=>{
 const f=fixture();try{
  const queued=enqueue(f.store);f.store.db.prepare("UPDATE knowledge_ingest_jobs SET status='running' WHERE id=?").run(queued.job.id);
  const result=await worker.runIngestJob(f.store,queued.job.id);
  assert.equal(result.status,"running");assert.equal(f.store.db.prepare("SELECT status FROM knowledge_ingest_jobs WHERE id=?").get(queued.job.id).status,"running");
 }finally{f.clean();}
});

test("startup preserves a live dispatcher owner and only fails an orphan attempt",async()=>{
 const f=fixture();try{
  const {spawn}=await import("node:child_process");const dead=spawn(process.execPath,["-e",""]);const deadPid=dead.pid!;await new Promise<void>(resolve=>dead.once("exit",()=>resolve()));
  const queued=enqueue(f.store);f.store.db.prepare("UPDATE knowledge_ingest_jobs SET status='running',owner_token='live',owner_pid=? WHERE id=?").run(process.pid,queued.job.id);
  const orphan=enqueue(f.store,{...input,idempotencyKey:"orphan"});f.store.db.prepare("UPDATE knowledge_ingest_jobs SET status='running',owner_token='orphan',owner_pid=? WHERE id=?").run(deadPid,orphan.job.id);
  worker.recoverInterruptedIngestJobs(f.store);
  assert.equal(f.store.db.prepare("SELECT status FROM knowledge_ingest_jobs WHERE id=?").get(queued.job.id).status,"running");
  assert.equal(f.store.db.prepare("SELECT status,owner_token FROM knowledge_ingest_jobs WHERE id=?").get(orphan.job.id).status,"failed");
 }finally{f.clean();}
});

test("a stale attempt cannot overwrite a replacement owner after an upstream wait",()=>withUpstream(async state=>{
 const f=fixture();try{
  const queued=enqueue(f.store);state.blockB=true;const attempt=worker.executeIngestJob(f.store,queued.job.id);
  const deadline=Date.now()+10_000;while(!state.releaseB&&Date.now()<deadline)await delay(20);assert.ok(state.releaseB);
  const sentinel=JSON.stringify({replacement:true});f.store.db.prepare("UPDATE knowledge_ingest_jobs SET owner_token='replacement',owner_pid=?,result_json=? WHERE id=?").run(process.pid,sentinel,queued.job.id);
  state.releaseB();await attempt;
  const row=f.store.db.prepare("SELECT status,owner_token,result_json FROM knowledge_ingest_jobs WHERE id=?").get(queued.job.id) as any;
  assert.equal(row.status,"running");assert.equal(row.owner_token,"replacement");assert.equal(row.result_json,sentinel);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM knowledge_migration_documents WHERE migration_id=? AND local_document_id='b'").get(queued.migrationId).n,0);
 }finally{state.releaseB?.();f.clean();}
}));

test("independent dispatcher processes leave a live claimed migration with its original owner",()=>withUpstream(async state=>{
 const f=fixture();try{
  const queued=enqueue(f.store);state.blockB=true;const winner=worker.runIngestJob(f.store,queued.job.id);
  const deadline=Date.now()+10_000;while(!state.releaseB&&Date.now()<deadline)await delay(20);assert.ok(state.releaseB);
  const owner=f.store.db.prepare("SELECT owner_token,owner_pid FROM knowledge_ingest_jobs WHERE id=?").get(queued.job.id) as any;assert.equal(owner.owner_pid,process.pid);assert.ok(owner.owner_token);
  const {spawn}=await import("node:child_process");
  const script=`import {createKnowledgeStore} from ${JSON.stringify(new URL("../src/knowledge/store.ts",import.meta.url).href)};import {runIngestJob} from ${JSON.stringify(new URL("../src/knowledge/ingest-dispatch.ts",import.meta.url).href)};const store=createKnowledgeStore({dbPath:process.argv[1]});try{const result=await runIngestJob(store,process.argv[2]);console.log(JSON.stringify({status:result.status}));}finally{store.close();}`;
  const loser=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script,f.path,queued.job.id],{stdio:["ignore","pipe","pipe"]});let output="";loser.stdout.on("data",chunk=>{output+=chunk;});
  assert.equal(await new Promise<number|null>(resolve=>loser.once("exit",resolve)),0);assert.equal(JSON.parse(output).status,"running");
  const current=f.store.db.prepare("SELECT status,owner_token,owner_pid FROM knowledge_ingest_jobs WHERE id=?").get(queued.job.id) as any;assert.equal(current.status,"running");assert.equal(current.owner_token,owner.owner_token);assert.equal(current.owner_pid,owner.owner_pid);
  state.releaseB();assert.equal((await winner).status,"succeeded");assert.deepEqual(state.uploads,["a.md","b.md"]);
 }finally{state.releaseB?.();f.clean();}
}));

test("future wake timers are unref, bounded, and do not query a closed store",async t=>{
 const f=fixture();const captured:Array<{callback:()=>void;delay:number;timer:ReturnType<typeof setTimeout>}>=[];
 const originalTimeout=globalThis.setTimeout;
 t.mock.method(globalThis,"setTimeout",((callback:()=>void,ms:number,...args:any[])=>{const timer=originalTimeout(callback,ms,...args);captured.push({callback,delay:ms,timer});return timer;}) as typeof setTimeout);
 try{
  const queued=enqueue(f.store);f.store.db.prepare("UPDATE knowledge_ingest_jobs SET available_at=? WHERE id=?").run(new Date(Date.now()+3*3600_000).toISOString(),queued.job.id);
  assert.equal(await worker.runPendingIngestJobs(f.store),0);
  const wake=captured.find(x=>x.delay===60_000);assert.ok(wake);assert.equal(wake.timer.hasRef(),false);
  f.store.close();clearTimeout(wake.timer);assert.doesNotThrow(()=>wake.callback());
 }finally{for(const item of captured)clearTimeout(item.timer);f.clean();}
});

test("stopping the dispatcher clears future wakeups without executing queued work",async()=>{
 const f=fixture();try{
  const queued=enqueue(f.store);f.store.db.prepare("UPDATE knowledge_ingest_jobs SET available_at=? WHERE id=?").run(new Date(Date.now()+150).toISOString(),queued.job.id);
  assert.equal(await worker.runPendingIngestJobs(f.store),0);
  const {stopIngestJobs}=await import("../src/knowledge/ingest-dispatch.ts");await stopIngestJobs();await delay(250);
  const row=f.store.db.prepare("SELECT status,attempts FROM knowledge_ingest_jobs WHERE id=?").get(queued.job.id) as any;
  assert.equal(row.status,"queued");assert.equal(row.attempts,0);
 }finally{f.clean();}
});
