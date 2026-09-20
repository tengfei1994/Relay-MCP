import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("both product import HTTP endpoints and retry return durable background jobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "product-http-"));
  const previous = { DB_PATH: process.env.DB_PATH, KNOWLEDGE_DB_PATH: process.env.KNOWLEDGE_DB_PATH };
  process.env.DB_PATH = join(root, "app.db"); process.env.KNOWLEDGE_DB_PATH = join(root, "knowledge.db");
  const { default: Fastify } = await import("fastify");
  const { db, runMigrations } = await import("../src/server/db/index.js");
  const { users } = await import("../src/server/db/schema.js");
  const { knowledgeRoutes } = await import("../src/server/routes/knowledge.js");
  const { getKnowledgeStore } = await import("../src/server/knowledge-context.js");
  const { runPendingIngestJobs } = await import("../src/knowledge/ingest-worker.js");
  runMigrations(); db.insert(users).values({ id: 1, username: "import-test", passwordHash: "not-used", isAdmin: true }).run();
  const source = join(root, "docs"); mkdirSync(source); writeFileSync(join(source, "guide.md"), "# Guide\nHello");
  const store = getKnowledgeStore();
  const app = Fastify();
  app.decorate("authenticate", async (req: any) => { req.user = { id: 1, isAdmin: !req.headers["x-nonadmin"] }; });
  await app.register(knowledgeRoutes);
  try {
    const payload = { root: source, sampleManagerVersion: "21.3", asynchronous: false };
    for (const endpoint of ["product-docs", "product-documents"]) {
      const request = { method: "POST" as const, url: `/api/knowledge/${endpoint}/import`, payload, headers: { "idempotency-key": endpoint } };
      const response = await app.inject(request);
      assert.equal(response.statusCode, 202, response.body);
      assert.equal(response.json().status, "queued");
      assert.equal((await app.inject(request)).json().id, response.json().id);
      await runPendingIngestJobs(store);
      const state = await app.inject({ url: `/api/knowledge/ingest-jobs/${response.json().id}` });
      assert.equal(state.json().job.status, "succeeded", state.body);
      const retry = await app.inject({ method: "POST", url: `/api/knowledge/product-documents/imports/${state.json().job.result.runId}/retry`, payload: {}, headers: { "idempotency-key": `retry-${endpoint}` } });
      assert.equal(retry.statusCode, 202, retry.body);
      await runPendingIngestJobs(store);
    }
    assert.equal((await app.inject({ method: "POST", url: "/api/knowledge/product-documents/import", payload, headers: { "x-nonadmin": "1" } })).statusCode, 403);
  } finally {
    await runPendingIngestJobs(store); await app.close(); store.close(); (db as any).session.client.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
