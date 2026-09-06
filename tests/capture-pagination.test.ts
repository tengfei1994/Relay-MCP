import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeadLetterPage } from "../src/knowledge/dead-letter-page.ts";

test("dead-letter pagination reaches beyond the former cap across both files", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-dead-pages-"));
  try {
    const a = join(root, "a.jsonl"); const b = join(root, "b.jsonl");
    const records = Array.from({ length: 235 }, (_, i) => JSON.stringify({ event: { id: `event-${i}`, projectId: i % 2 ? "p2" : "p1" }, reason: "max attempts exceeded" }));
    writeFileSync(a, records.slice(0, 205).join("\r\n") + "\r\n\r\n");
    writeFileSync(b, records.slice(205).join("\n") + "\ninvalid\n");
    const ids: unknown[] = [];
    for (let offset = 0; offset < 236; offset += 10) {
      const result = await readDeadLetterPage([a, b], 10, offset);
      assert.equal(result.page.total, 236);
      assert.ok(result.deadLetters.length <= 10);
      ids.push(...result.deadLetters.map((row) => row.eventId));
    }
    assert.equal(new Set(ids).size, 236);
    const last = await readDeadLetterPage([a, b], 10, 230);
    assert.equal(last.deadLetters.length, 6);
    assert.equal(last.deadLetters[0].eventId, "event-230");
    assert.equal(last.deadLetters[5].error, "invalid dead-letter record");
    assert.equal((await readDeadLetterPage([a, b], 10, 240)).deadLetters.length, 0);
    const scoped = await readDeadLetterPage([a, b], 10, 110, ["p1"]);
    assert.equal(scoped.page.total, 118);
    assert.equal(scoped.deadLetters.length, 8);
    assert.ok(scoped.deadLetters.every((row) => row.projectId === "p1"));
    assert.equal((await readDeadLetterPage([join(root, "missing")], 10, 0)).page.total, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Capture UI renders independent server-paged histories, not sliced arrays", () => {
  const page = readFileSync("frontend/src/pages/KnowledgeOperations.tsx", "utf8");
  const history = readFileSync("frontend/src/components/CaptureHistory.tsx", "utf8");
  assert.match(page, /CaptureHistory kind="events"/);
  assert.match(page, /CaptureHistory kind="dead-letter"/);
  assert.doesNotMatch(page, /events\.slice|deadLetters\.slice/);
  assert.match(history, /aria-current/);
  assert.match(history, /result\.page\.total/);
  assert.match(history, /\(page - 1\) \* size/);
});

test("capture HTTP pages expose all events with stable order and scoped counts", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-capture-http-pages-"));
  const previous = { DB_PATH: process.env.DB_PATH, KNOWLEDGE_DB_PATH: process.env.KNOWLEDGE_DB_PATH, KNOWLEDGE_EVIDENCE_ROOT: process.env.KNOWLEDGE_EVIDENCE_ROOT };
  process.env.DB_PATH = join(root, "app.db");
  process.env.KNOWLEDGE_DB_PATH = join(root, "knowledge.db");
  process.env.KNOWLEDGE_EVIDENCE_ROOT = join(root, "evidence");
  mkdirSync(join(root, "evidence"));
  const { default: Fastify } = await import("fastify");
  const { db, runMigrations } = await import("../src/server/db/index.ts");
  const { users, projects } = await import("../src/server/db/schema.ts");
  const { knowledgeRoutes } = await import("../src/server/routes/knowledge.ts");
  const { getKnowledgeStore } = await import("../src/server/knowledge-context.ts");
  runMigrations();
  db.insert(users).values({ id: 1, username: "test", passwordHash: "not-used" }).run();
  db.insert(projects).values({ id: 1, name: "Test", userId: 1, workspacePath: root }).run();
  const store = getKnowledgeStore();
  const app = Fastify();
  app.decorate("authenticate", async (req: any) => { req.user = { id: 1, isAdmin: req.headers["x-test-admin"] === "true" }; });
  await app.register(knowledgeRoutes);
  try {
    for (let i = 0; i < 235; i++) store.append({ id: `event-${String(i).padStart(3, "0")}`, type: "job.finished", occurredAt: "2026-09-06T12:00:00.000Z", projectId: i % 2 ? "2" : "1", jobId: `j-${i}`, payload: { status: "succeeded" } });
    const get = async (offset: number, admin = true) => {
      const reply = await app.inject({ url: `/api/knowledge/operations/capture/events?limit=10&offset=${offset}`, headers: { "x-test-admin": String(admin) } });
      assert.equal(reply.statusCode, 200, reply.body);
      return reply.json();
    };
    const first = await get(0); const second = await get(10); const last = await get(230);
    assert.equal(first.page.total, 235);
    assert.equal(first.events[0].id, "event-234");
    assert.equal(second.events[0].id, "event-224");
    assert.equal(last.events.length, 5);
    assert.ok(!first.events.some((a: any) => second.events.some((b: any) => a.id === b.id)));
    const scoped = await get(110, false);
    assert.equal(scoped.page.total, 118);
    assert.equal(scoped.events.length, 8);
    assert.ok(scoped.events.every((row: any) => row.projectId === "1"));
    writeFileSync(join(root, "knowledge-capture-dead-letter.jsonl"), Array.from({ length: 235 }, (_, i) => JSON.stringify({ event: { id: `dead-${i}`, projectId: "1" }, reason: "test" })).join("\n"));
    const dead = await app.inject({ url: "/api/knowledge/operations/capture/dead-letter?limit=10&offset=230", headers: { "x-test-admin": "true" } });
    assert.equal(dead.statusCode, 200, dead.body);
    assert.equal(dead.json().page.total, 235);
    assert.equal(dead.json().deadLetters.length, 5);
  } finally {
    await app.close(); store.close();
    (db as any).session.client.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
