import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("observation API exposes review outcome and candidate transition within project ACL", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-observation-http-"));
  const previous = { DB_PATH: process.env.DB_PATH, KNOWLEDGE_DB_PATH: process.env.KNOWLEDGE_DB_PATH };
  process.env.DB_PATH = join(root, "app.db");
  process.env.KNOWLEDGE_DB_PATH = join(root, "knowledge.db");
  const { default: Fastify } = await import("fastify");
  const { db, runMigrations } = await import("../src/server/db/index.ts");
  const { users, projects } = await import("../src/server/db/schema.ts");
  const { knowledgeRoutes } = await import("../src/server/routes/knowledge.ts");
  const { getKnowledgeStore } = await import("../src/server/knowledge-context.ts");
  const { evaluateObservationPool } = await import("../src/knowledge/capture-worker.ts");
  runMigrations();
  db.insert(users).values({ id: 1, username: "review-test", passwordHash: "not-used" }).run();
  db.insert(projects).values({ id: 1, name: "Review test", userId: 1, workspacePath: root }).run();
  const store = getKnowledgeStore();
  store.grantAcl("1", 1, true);
  const app = Fastify();
  app.decorate("authenticate", async (req: any) => { req.user = { id: req.headers["x-outsider"] ? 2 : 1, isAdmin: false }; });
  await app.register(knowledgeRoutes);
  try {
    const now = new Date().toISOString();
    store.append({ id: "event-review", jobId: "review-job", projectId: "1", type: "job.finished", occurredAt: now, payload: { status: "succeeded", warning: "missing dependency" } });
    store.saveObservation({ id: "review-observation", eventId: "event-review", projectId: "1", eventClass: "observation", captureReason: "warning", sourceLocator: "event:review", createdAt: now, updatedAt: now });
    await evaluateObservationPool(store);
    const result = await app.inject({ url: "/api/knowledge/observations/review-observation" });
    assert.equal(result.statusCode, 200, result.body);
    const observation = result.json().observation;
    assert.equal(observation.review.outcome, "promoted");
    assert.equal(observation.review.count, 1);
    assert.equal(observation.humanStatus, "candidate_created");
    assert.match(observation.review.candidateId, /^candidate-/);
    const list = await app.inject({ url: "/api/knowledge/observations?projectId=1" });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().observations[0].review.candidateId, observation.review.candidateId);
    assert.equal((await app.inject({ url: "/api/knowledge/observations/review-observation", headers: { "x-outsider": "true" } })).statusCode, 404);
  } finally {
    await app.close(); store.close(); (db as any).session.client.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
