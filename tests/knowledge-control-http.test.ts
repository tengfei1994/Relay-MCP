import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("HTTP migration and release-gate reads require an administrator", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-control-http-"));
  const previous = { DB_PATH: process.env.DB_PATH, KNOWLEDGE_DB_PATH: process.env.KNOWLEDGE_DB_PATH };
  process.env.DB_PATH = join(root, "app.db");
  process.env.KNOWLEDGE_DB_PATH = join(root, "knowledge.db");
  const { default: Fastify } = await import("fastify");
  const { db, runMigrations } = await import("../src/server/db/index.js");
  const { users } = await import("../src/server/db/schema.js");
  const { knowledgeRoutes } = await import("../src/server/routes/knowledge.js");
  const { getKnowledgeStore } = await import("../src/server/knowledge-context.js");
  const { MigrationController } = await import("../src/knowledge/migration-control.js");
  runMigrations();
  db.insert(users).values({ id: 1, username: "control-test", passwordHash: "not-used", isAdmin: true }).run();
  const store = getKnowledgeStore();
  const migration = new MigrationController(store).create({ actorId: 1, idempotencyKey: "control-1", sourceManifest: { documents: [] } });
  const app = Fastify();
  app.decorate("authenticate", async (req: any) => { req.user = { id: 1, isAdmin: !req.headers["x-nonadmin"] }; });
  await app.register(knowledgeRoutes);
  try {
    assert.equal((await app.inject({ url: `/api/knowledge/migrations/${migration.id}`, headers: { "x-nonadmin": "1" } })).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/knowledge/release-gates", headers: { "x-nonadmin": "1" } })).statusCode, 403);
    assert.equal((await app.inject({ url: `/api/knowledge/migrations/${migration.id}` })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/knowledge/release-gates" })).statusCode, 200);
  } finally {
    await app.close();
    store.close();
    (db as any).session.client.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
