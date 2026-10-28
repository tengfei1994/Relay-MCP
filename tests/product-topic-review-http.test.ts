import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyRequest } from "fastify";

test("low-confidence topic bindings require an audited administrative review", async () => {
  const root = mkdtempSync(join(tmpdir(), "product-topic-review-http-"));
  const previous = { DB_PATH: process.env.DB_PATH, KNOWLEDGE_DB_PATH: process.env.KNOWLEDGE_DB_PATH, RELAY_STATE_ROOT: process.env.RELAY_STATE_ROOT };
  process.env.DB_PATH = join(root, "app.db");
  process.env.KNOWLEDGE_DB_PATH = join(root, "knowledge.db");
  process.env.RELAY_STATE_ROOT = root;
  // Intentional dynamic imports: database paths must be isolated before module initialization.
  const { default: Fastify } = await import("fastify");
  const { db, runMigrations } = await import("../src/server/db/index.js");
  const { knowledgeRoutes } = await import("../src/server/routes/knowledge.js");
  const { getKnowledgeStore } = await import("../src/server/knowledge-context.js");
  const { importKnowledgeProducts } = await import("../src/knowledge/knowledge-products.js");
  runMigrations();
  const store = getKnowledgeStore();
  const source = join(root, "docs"); mkdirSync(source);
  writeFileSync(join(source, "guide.md"), "# Unmapped Guide\n\nConfigure the guide.\n");
  const report = importKnowledgeProducts(store, { root: source, sampleManagerVersion: "21.3", product: "SampleManager" });
  const binding = store.db.prepare("SELECT id,status FROM knowledge_product_document_bindings WHERE document_id=?").get(report.documents[0]) as { id: string; status: string };
  assert.equal(binding.status, "pending_review");
  const app = Fastify();
  app.decorate("authenticate", async (request: FastifyRequest) => { Object.assign(request, { user: { id: 7, isAdmin: request.headers["x-admin"] === "true" } }); });
  await app.register(knowledgeRoutes);
  try {
    assert.equal((await app.inject({ method: "POST", url: `/api/knowledge/product-topic-bindings/${binding.id}/review`, payload: { status: "active", reason: "Verified" } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: `/api/knowledge/product-topic-bindings/${binding.id}/review`, headers: { "x-admin": "true" }, payload: { status: "active", reason: "" } })).statusCode, 400);
    const approved = await app.inject({ method: "POST", url: `/api/knowledge/product-topic-bindings/${binding.id}/review`, headers: { "x-admin": "true" }, payload: { status: "active", reason: "Verified official topic identity" } });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(store.db.prepare("SELECT status FROM knowledge_product_document_bindings WHERE id=?").get(binding.id).status, "active");
    const rejected = await app.inject({ method: "POST", url: `/api/knowledge/product-topic-bindings/${binding.id}/review`, headers: { "x-admin": "true" }, payload: { status: "rejected", reason: "Reject ambiguous automatic merge" } });
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.equal(store.db.prepare("SELECT status FROM knowledge_product_document_bindings WHERE id=?").get(binding.id).status, "rejected");
    const audits = store.db.prepare("SELECT action,details_json FROM knowledge_audit WHERE entity_id=? AND action='knowledge.product_topic_binding.review' ORDER BY rowid").all(binding.id) as Array<{ details_json: string }>;
    assert.equal(audits.length, 2);
    assert.match(audits[0].details_json, /Verified official topic identity/);
    assert.match(audits[1].details_json, /Reject ambiguous automatic merge/);
  } finally {
    await app.close(); store.close();
    // Drizzle exposes the underlying better-sqlite3 client only through this internal test boundary.
    (db as unknown as { session: { client: { close(): void } } }).session.client.close();
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
