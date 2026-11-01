import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

test("Wiki generation status exposes normalized progress and admin controls", async () => {
  const root = mkdtempSync(join(process.cwd(), ".tmp-wiki-controls-http-"));
  const previous = { DB_PATH: process.env.DB_PATH, KNOWLEDGE_DB_PATH: process.env.KNOWLEDGE_DB_PATH, KNOWLEDGE_ENGINE_HOME: process.env.KNOWLEDGE_ENGINE_HOME, WEKNORA_BASE_URL: process.env.WEKNORA_BASE_URL, WEKNORA_KNOWLEDGE_BASE_ID: process.env.WEKNORA_KNOWLEDGE_BASE_ID };
  process.env.DB_PATH = join(root, "app.db"); process.env.KNOWLEDGE_DB_PATH = join(root, "knowledge.db"); process.env.KNOWLEDGE_ENGINE_HOME = join(root, "engine"); process.env.WEKNORA_BASE_URL = "http://127.0.0.1:1"; process.env.WEKNORA_KNOWLEDGE_BASE_ID = "fixture-kb";
  const { default: Fastify } = await import("fastify");
  const { db, runMigrations } = await import("../src/server/db/index.js");
  const { knowledgeRoutes } = await import("../src/server/routes/knowledge.js");
  const { getKnowledgeStore } = await import("../src/server/knowledge-context.js");
  const { enqueueWikiGeneration } = await import("../src/knowledge/ingest-worker.js");
  runMigrations();
  const store = getKnowledgeStore();
  const app = Fastify();
  app.decorate("authenticate", async (request: any) => { request.user = request.headers["x-nonadmin"] ? { id: 8, isAdmin: false } : { id: 7, isAdmin: true }; });
  await app.register(knowledgeRoutes);
  try {
    const job = enqueueWikiGeneration(store, { topicGroupIds: ["topic-a", "topic-b", "topic-c", "topic-d"], triggerId: "manual-http", triggerKind: "manual" });
    assert.ok(job);
    store.db.prepare("UPDATE knowledge_ingest_jobs SET result_json=? WHERE id=?").run(JSON.stringify({ processed: 2, total: 4, generatedTotal: 2, failureTotal: 0, generated: [], failures: [] }), job!.id);
    const status = await app.inject({ method: "GET", url: "/api/knowledge/wiki/generation?limit=1&offset=0&topicLimit=1&topicOffset=0" });
    assert.equal(status.statusCode, 200, status.body);
    assert.equal(status.json().jobsPage.limit, 1);
    assert.equal(status.json().jobsPage.offset, 0);
    assert.ok(status.json().jobsPage.total >= 1);
    assert.equal(status.json().topicsPage.limit, 1);
    assert.ok(Array.isArray(status.json().topics));
    const listed = status.json().jobs.find((entry: any) => entry.id === job!.id);
    assert.equal(listed.percent, 50); assert.equal(listed.processed, 2); assert.equal(listed.total, 4); assert.equal(listed.generated, 2); assert.equal(listed.controlState, "active"); assert.equal(listed.triggerKind, "manual");
    const paused = await app.inject({ method: "POST", url: `/api/knowledge/ingest-jobs/${encodeURIComponent(job!.id)}/control`, payload: { action: "pause" } });
    assert.equal(paused.statusCode, 200, paused.body); assert.ok(["paused", "pause_requested"].includes(paused.json().job.controlState));
    const resumed = await app.inject({ method: "POST", url: `/api/knowledge/ingest-jobs/${encodeURIComponent(job!.id)}/control`, payload: { action: "resume" } });
    assert.equal(resumed.statusCode, 200, resumed.body); assert.equal(resumed.json().job.controlState, "active"); assert.equal(resumed.json().job.percent, 50);
    const denied = await app.inject({ method: "POST", url: `/api/knowledge/ingest-jobs/${encodeURIComponent(job!.id)}/control`, headers: { "x-nonadmin": "1" }, payload: { action: "pause" } });
    assert.equal(denied.statusCode, 403);
    store.db.prepare("UPDATE knowledge_ingest_jobs SET status='succeeded' WHERE id=?").run(job!.id);
    const terminal = await app.inject({ method: "POST", url: `/api/knowledge/ingest-jobs/${encodeURIComponent(job!.id)}/control`, payload: { action: "pause" } });
    assert.equal(terminal.statusCode, 409);
  } finally {
    await app.close(); store.close(); (db as any).session.client.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
