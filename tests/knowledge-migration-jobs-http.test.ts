import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

test("async migration HTTP returns durable 202, protects status, deduplicates and explicitly retries; sync defaults to 200", async () => {
  const root = mkdtempSync(join(tmpdir(), "migration-jobs-http-"));
  const keys = ["DB_PATH", "KNOWLEDGE_DB_PATH", "KNOWLEDGE_ENGINE_HOME", "WEKNORA_BASE_URL", "WEKNORA_KNOWLEDGE_BASE_ID"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.DB_PATH = join(root, "app.db"); process.env.KNOWLEDGE_DB_PATH = join(root, "knowledge.db");
  process.env.KNOWLEDGE_ENGINE_HOME = join(root, "uninstalled");
  process.env.WEKNORA_BASE_URL = "http://127.0.0.1:1"; process.env.WEKNORA_KNOWLEDGE_BASE_ID = "fixture";
  const { default: Fastify } = await import("fastify");
  const { db, runMigrations } = await import("../src/server/db/index.js");
  const { users } = await import("../src/server/db/schema.js");
  const { knowledgeRoutes } = await import("../src/server/routes/knowledge.js");
  const { getKnowledgeStore } = await import("../src/server/knowledge-context.js");
  const { stopIngestJobs } = await import("../src/knowledge/ingest-dispatch.js");
  // Exercise the durable HTTP boundary independently of dispatch execution,
  // covered by the real child-process/HTTP fixture in migration-jobs.test.ts.
  await stopIngestJobs();
  runMigrations(); db.insert(users).values({ id: 1, username: "migration-http", passwordHash: "unused", isAdmin: true }).run();
  const store = getKnowledgeStore(); const app = Fastify();
  app.decorate("authenticate", async (req: any) => { req.user = { id: 1, isAdmin: !req.headers["x-nonadmin"] }; });
  await app.register(knowledgeRoutes);
  const payload = { idempotencyKey: "http-async", parserVersion: "v1", asynchronous: true };
  try {
    const post = (body = payload, headers = {}) => app.inject({ method: "POST", url: "/api/knowledge/migrations/from-local", payload: body, headers });
    assert.equal((await post(payload, { "x-nonadmin": "1" })).statusCode, 403);
    const first = await post(); assert.equal(first.statusCode, 202); const value = first.json();
    assert.equal(value.migrationId, value.migration.id); assert.equal(value.job.status, "queued");
    assert.equal(value.job.result.migrationId, value.migrationId);
    assert.equal((await post()).json().job.id, value.job.id);
    assert.equal((await post({ ...payload, parserVersion: "v2" })).statusCode, 400);
    assert.equal((await post({ ...payload, asynchronous: false })).statusCode, 400, "sync callers must not duplicate an owned background migration");
    const url = `/api/knowledge/ingest-jobs/${value.job.id}`;
    assert.equal((await app.inject({ url, headers: { "x-nonadmin": "1" } })).statusCode, 403);
    const status = await app.inject({ url }); assert.equal(status.statusCode, 200); assert.equal(status.json().job.result.migrationId, value.migrationId);
    store.db.prepare("UPDATE knowledge_ingest_jobs SET status='failed' WHERE id=?").run(value.job.id);
    assert.equal((await post()).json().job.status, "failed");
    const retry = await app.inject({ method: "POST", url: "/api/knowledge/migrations/from-local", payload: { ...payload, retry: true } });
    assert.equal(retry.statusCode, 202); assert.equal(retry.json().job.id, value.job.id); assert.equal(retry.json().job.status, "queued");
    const sync = await app.inject({ method: "POST", url: "/api/knowledge/migrations/from-local", payload: { idempotencyKey: "sync-default", parserVersion: "v1" } });
    assert.equal(sync.statusCode, 200); assert.equal(sync.json().migration.status, "staged"); assert.equal(sync.json().job, undefined);
    const competing = new Database(join(root, "knowledge.db"));
    store.db.pragma("busy_timeout = 20"); competing.exec("BEGIN IMMEDIATE");
    try {
      const busy = await post({ ...payload, idempotencyKey: "busy-http" });
      assert.equal(busy.statusCode, 503); assert.equal(busy.headers["retry-after"], "1");
      assert.equal(busy.json().code, "migration_queue_busy");
      assert.ok(!busy.body.includes("SQLITE"));
      competing.exec("ROLLBACK");
      assert.equal((await post({ ...payload, idempotencyKey: "busy-http" })).statusCode, 202);
    } finally { if (competing.inTransaction) competing.exec("ROLLBACK"); competing.close(); }
  } finally {
    await app.close(); store.close(); (db as any).session.client.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
