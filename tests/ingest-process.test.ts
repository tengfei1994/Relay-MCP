import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { createServer } from "node:http";
import { createKnowledgeStore } from "../src/knowledge/store.js";
import { enqueueProductImport, runPendingIngestJobs, recoverInterruptedIngestJobs } from "../src/knowledge/ingest-worker.js";
import { importKnowledgeProducts } from "../src/knowledge/knowledge-products.js";

test("nested archives import completely, report progress and do not block HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "ingest-process-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  const entries = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`guide${i}.md`, strToU8(`# Guide ${i}\n${"Content ".repeat(100)}`)]));
  const source = join(root, "docs.zip");
  writeFileSync(source, zipSync({ "first.zip": zipSync(entries), "second.zip": zipSync({ "extra.md": strToU8("# Extra") }) }));
  const server = createServer((_req, res) => res.end("healthy"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const job = enqueueProductImport(store, { root: source, sampleManagerVersion: "21.3" });
    let done = false; let probes = 0; let maxLatency = 0;
    const work = runPendingIngestJobs(store).finally(() => { done = true; });
    while (!done) {
      const start = Date.now();
      assert.equal(await (await fetch(`http://127.0.0.1:${address.port}/`, { signal: AbortSignal.timeout(2000) })).text(), "healthy");
      maxLatency = Math.max(maxLatency, Date.now() - start); probes++;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await work;
    const row = store.db.prepare("SELECT status,result_json FROM knowledge_ingest_jobs WHERE id=?").get(job.id) as any;
    assert.equal(row.status, "succeeded");
    assert.equal(JSON.parse(row.result_json).imported, 201);
    assert.ok(probes > 2); assert.ok(maxLatency < 2000);
    const repeat = enqueueProductImport(store, { root: source, sampleManagerVersion: "21.3" });
    await runPendingIngestJobs(store);
    const retried = store.db.prepare("SELECT result_json FROM knowledge_ingest_jobs WHERE id=?").get(repeat.id) as any;
    assert.equal(JSON.parse(retried.result_json).unchanged, 201);
  } finally { server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("timeout terminates the child and records failure; startup does not replay running jobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "ingest-timeout-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  const source = join(root, "docs"); mkdirSync(source); writeFileSync(join(source, "a.md"), "# Guide");
  const previous = process.env.RELAY_INGEST_TIMEOUT_MS;
  try {
    process.env.RELAY_INGEST_TIMEOUT_MS = "1";
    const job = enqueueProductImport(store, { root: source, sampleManagerVersion: "21.3" });
    await runPendingIngestJobs(store);
    const row = store.db.prepare("SELECT status,error FROM knowledge_ingest_jobs WHERE id=?").get(job.id) as any;
    assert.equal(row.status, "failed"); assert.match(row.error, /exceeded/);
    store.db.prepare("UPDATE knowledge_ingest_jobs SET status='running' WHERE id=?").run(job.id);
    recoverInterruptedIngestJobs(store);
    assert.equal((store.db.prepare("SELECT status FROM knowledge_ingest_jobs WHERE id=?").get(job.id) as any).status, "failed");
  } finally { if (previous === undefined) delete process.env.RELAY_INGEST_TIMEOUT_MS; else process.env.RELAY_INGEST_TIMEOUT_MS = previous; store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("nested ZIP traversal and excessive nesting are reported as failed", () => {
  const root = mkdtempSync(join(tmpdir(), "ingest-zip-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    const source = join(root, "bad.zip");
    writeFileSync(source, zipSync({ "nested.zip": zipSync({ "../escape.md": strToU8("escape") }) }));
    assert.equal(importKnowledgeProducts(store, { root: source, sampleManagerVersion: "21.3" }).status, "failed");
    let bytes = zipSync({ "doc.md": strToU8("# Guide") });
    for (let i = 0; i < 7; i++) bytes = zipSync({ "nested.zip": bytes });
    writeFileSync(source, bytes);
    const result = importKnowledgeProducts(store, { root: source, sampleManagerVersion: "21.3" });
    assert.equal(result.status, "failed"); assert.match(result.errors[0].error, /nesting/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
