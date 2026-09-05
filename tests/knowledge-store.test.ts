import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { INITIAL_KNOWLEDGE_SCHEMA } from "../src/knowledge/migrations/001-initial.ts";
import { KNOWLEDGE_DOMAIN_SCHEMA } from "../src/knowledge/migrations/002-domain.ts";

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}

const eventDefaults = {
  occurredAt: "2026-09-03T00:00:00.000Z",
  projectId: "project-7",
  jobId: "job-1",
  payload: { status: "succeeded" },
};

test("read-path ACL mirroring preserves an existing reviewer grant", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-acl-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    store.grantAcl("project-7", 7, true);
    store.grantAcl("project-7", 7, false);
    const row = store.db.prepare("SELECT can_read, can_review FROM knowledge_acl WHERE project_id = ? AND user_id = ?").get("project-7", 7) as { can_read: number; can_review: number };
    assert.equal(row.can_read, 1);
    assert.equal(row.can_review, 1);
  } finally {
    store.close();
    cleanup(root);
  }
});

test("knowledge migrations are repeatable and consumer checkpoints make event replay idempotent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-"));
  const dbPath = join(root, "knowledge.db");
  const open: Array<{ close(): void }> = [];
  try {
    let store;
    try {
      store = createKnowledgeStore({ dbPath, clock: () => new Date("2026-09-03T00:00:00.000Z") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Could not locate the bindings file|better-sqlite3/i.test(message)) t.skip(`better-sqlite3 binding unavailable: ${message.split("\n")[0]}`);
      else throw error;
      return;
    }
    open.push(store);
    store.append({ id: "event-1", type: "job.finished", occurredAt: "2026-09-03T00:00:00.000Z", projectId: "project-7", jobId: "job-1", payload: { status: "succeeded" } });
    store.append({ id: "event-1", type: "job.finished", occurredAt: "2026-09-03T00:00:00.000Z", projectId: "project-7", jobId: "job-1", payload: { status: "succeeded" } });
    // claim() hands out leased batches, so the same consumer must process its
    // claim result instead of re-claiming while the lease is held.
    const claimed = store.claim("capture");
    assert.equal(claimed.length, 1);
    store.acknowledge("capture", claimed[0].id, claimed[0].claimToken);
    assert.equal(store.claim("capture").length, 0);
    store.close();

    const reopened = createKnowledgeStore({ dbPath });
    open.push(reopened);
    assert.equal(reopened.claim("capture").length, 0);
    reopened.close();
  } finally {
    for (const handle of open) { try { handle.close(); } catch { /* already closed */ } }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("expired outbox leases can be reclaimed and stale claim tokens are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-lease-"));
  let now = new Date("2026-09-03T00:00:00.000Z");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), clock: () => now });
  try {
    store.append({ id: "event-lease", type: "job.finished", ...eventDefaults });
    const first = store.claim("capture");
    assert.equal(first.length, 1);
    assert.equal(store.claim("capture").length, 0, "an active lease hides the event from the same consumer");
    now = new Date("2026-09-03T00:00:31.000Z");
    const second = store.claim("capture");
    assert.equal(second.length, 1, "the event becomes claimable again after the lease expires");
    assert.throws(() => store.acknowledge("capture", first[0].id, first[0].claimToken), /no longer owned/);
    store.acknowledge("capture", second[0].id, second[0].claimToken);
    now = new Date("2026-09-03T00:01:02.000Z");
    assert.equal(store.claim("capture").length, 0);
  } finally {
    store.close();
    cleanup(root);
  }
});

test("outbox fail() requires consumer ownership and honours retryAfter", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-fail-"));
  let now = new Date("2026-09-03T00:00:00.000Z");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), clock: () => now });
  try {
    store.append({ id: "event-fail", type: "job.failed", ...eventDefaults });
    const claimed = store.claim("capture");
    assert.equal(claimed.length, 1);
    assert.throws(() => store.fail(claimed[0].id, new Error("boom")), /consumerName and claimToken/);
    assert.throws(() => store.fail(claimed[0].id, new Error("boom"), 1000, "capture"), /consumerName and claimToken/);
    store.fail(claimed[0].id, new Error("boom"), 1000, "capture", claimed[0].claimToken);
    now = new Date("2026-09-03T00:00:31.000Z");
    const retried = store.claim("capture");
    assert.equal(retried.length, 1, "a failed event becomes claimable again after retryAfter");
    assert.equal(retried[0].attempts, 1);
    store.acknowledge("capture", retried[0].id, retried[0].claimToken);
  } finally {
    store.close();
    cleanup(root);
  }
});

test("independent consumers checkpoint separately for the same event", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-consumers-"));
  let now = new Date("2026-09-03T00:00:00.000Z");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), clock: () => now });
  try {
    store.append({ id: "event-multi", type: "deployment.finished", ...eventDefaults, deploymentId: "deploy-1" });
    const a = store.claim("consumer-a");
    const b = store.claim("consumer-b");
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].id, b[0].id);
    assert.notEqual(a[0].claimToken, b[0].claimToken);
    store.acknowledge("consumer-a", a[0].id, a[0].claimToken);
    now = new Date("2026-09-03T00:00:31.000Z");
    assert.equal(store.claim("consumer-a").length, 0, "consumer-a checkpoint survives the lease expiry");
    const bRetry = store.claim("consumer-b");
    assert.equal(bRetry.length, 1, "consumer-b still owes the event until it acknowledges");
    store.acknowledge("consumer-b", bRetry[0].id, bRetry[0].claimToken);
    now = new Date("2026-09-03T00:01:02.000Z");
    assert.equal(store.claim("consumer-a").length, 0);
    assert.equal(store.claim("consumer-b").length, 0);
  } finally {
    store.close();
    cleanup(root);
  }
});

test("pruning one consumer never deletes another consumer's pending delivery", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-prune-consumers-"));
  let now = new Date("2026-09-03T00:00:00.000Z");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), clock: () => now });
  try {
    store.append({ id: "event-prune-multi", type: "job.finished", ...eventDefaults });
    const a = store.claim("knowledge-capture");
    const b = store.claim("consumer-b");
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    store.acknowledge("knowledge-capture", a[0].id, a[0].claimToken);

    now = new Date("2026-09-03T00:02:00.000Z");
    const firstPrune = store.pruneOutbox(60_000);
    assert.equal(firstPrune.outbox, 0, "the outbox row remains while consumer-b is incomplete");
    assert.equal(store.claim("knowledge-capture").length, 0, "the completed consumer remains checkpointed");
    const bRetry = store.claim("consumer-b");
    assert.equal(bRetry.length, 1, "consumer-b still receives the event after pruning");
    store.acknowledge("consumer-b", bRetry[0].id, bRetry[0].claimToken);

    now = new Date("2026-09-03T00:03:00.000Z");
    const secondPrune = store.pruneOutbox(60_000);
    assert.equal(secondPrune.outbox, 1, "the outbox row is removed only after all known consumers complete");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_outbox_claims WHERE event_id = ?").get("event-prune-multi").count, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_consumer_checkpoint WHERE event_id = ?").get("event-prune-multi").count, 0);
  } finally {
    store.close();
    cleanup(root);
  }
});

test("an orphaned consumer claim stops blocking retention after its heartbeat expires", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-prune-orphan-"));
  let now = new Date("2026-09-03T00:00:00.000Z");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), clock: () => now });
  try {
    store.append({ id: "event-orphan-consumer", type: "job.finished", ...eventDefaults });
    const primary = store.claim("knowledge-capture");
    const orphan = store.claim("consumer-orphan");
    assert.equal(primary.length, 1);
    assert.equal(orphan.length, 1);
    store.heartbeatConsumer("consumer-orphan", 1_000);
    store.acknowledge("knowledge-capture", primary[0].id, primary[0].claimToken);

    now = new Date("2026-09-03T00:02:00.000Z");
    const afterExpiry = store.pruneOutbox(60_000);
    assert.equal(afterExpiry.outbox, 1, "a consumer with no live heartbeat no longer blocks retention");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_outbox WHERE event_id = ?").get("event-orphan-consumer").count, 0);
  } finally {
    store.close();
    cleanup(root);
  }
});

test("eventKey collisions converge on one canonical event and replayed duplicates stay idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-eventkey-"));
  let now = new Date("2026-09-03T00:00:00.000Z");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), clock: () => now });
  try {
    store.append({ id: "event-a", type: "job.finished", eventKey: "job:dup:finished", ...eventDefaults });
    store.append({ id: "event-b", type: "job.finished", eventKey: "job:dup:finished", ...eventDefaults });
    const claimed = store.claim("capture");
    assert.equal(claimed.length, 1, "a duplicate eventKey must not create a second outbox entry");
    assert.equal(claimed[0].id, "event-a");
    store.acknowledge("capture", claimed[0].id, claimed[0].claimToken);
    store.append({ id: "event-b", type: "job.finished", eventKey: "job:dup:finished", ...eventDefaults });
    now = new Date("2026-09-03T00:00:31.000Z");
    assert.equal(store.claim("capture").length, 0, "a replayed duplicate does not reopen the outbox");
  } finally {
    store.close();
    cleanup(root);
  }
});

test("conflicting eventKey metadata is rejected instead of silently merged", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-eventkey-conflict-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    store.append({ id: "event-conflict-a", type: "job.finished", eventKey: "job:conflict:finished", projectId: "p1", jobId: "job-conflict", ...eventDefaults });
    assert.throws(() => store.append({ id: "event-conflict-b", type: "job.failed", eventKey: "job:conflict:finished", projectId: "p2", jobId: "job-conflict", ...eventDefaults }), /conflicts with existing event/);
  } finally {
    store.close();
    cleanup(root);
  }
});

test("events without a deterministic identity are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-eventkey-required-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    assert.throws(() => store.append({ id: "event-no-key", type: "job.finished", occurredAt: new Date().toISOString(), payload: {} }), /eventKey or jobId\/deploymentId/);
  } finally {
    store.close();
    cleanup(root);
  }
});

test("blank event keys never escape through claim", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-blank-key-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    store.db.prepare("INSERT INTO relay_domain_events(id,type,occurred_at,payload_json,event_key) VALUES (?,?,?,?,?)").run("blank-key", "job.finished", new Date().toISOString(), "{}", "   ");
    store.db.prepare("INSERT INTO knowledge_outbox(event_id,available_at) VALUES (?,?)").run("blank-key", new Date().toISOString());
    assert.equal(store.claim("capture").length, 0);
  } finally {
    store.close();
    cleanup(root);
  }
});

test("a partially applied 005 migration with duplicate stored keys reaches 007 cleanup", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-partial-005-"));
  try {
    let Database: any;
    try {
      Database = (await import("better-sqlite3")).default;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Could not locate the bindings file|better-sqlite3/i.test(message)) t.skip(`better-sqlite3 binding unavailable: ${message.split("\n")[0]}`);
      else throw error;
      return;
    }
    const dbPath = join(root, "knowledge.db");
    const raw = new Database(dbPath);
    raw.exec(INITIAL_KNOWLEDGE_SCHEMA);
    raw.exec(KNOWLEDGE_DOMAIN_SCHEMA);
    raw.exec("ALTER TABLE relay_domain_events ADD COLUMN project_name_snapshot TEXT");
    // Simulate 005 having added the column, then failing while its former
    // unique-index DDL encountered historical duplicate values.
    raw.exec("ALTER TABLE relay_domain_events ADD COLUMN event_key TEXT");
    raw.exec("INSERT INTO relay_domain_events(id,type,occurred_at,job_id,payload_json,event_key) VALUES ('old-canonical','job.finished','2026-09-03T00:00:00.000Z','job-old','{}','legacy:job-old:finished'),('old-duplicate','job.finished','2026-09-03T00:00:01.000Z','job-old','{}','legacy:job-old:finished')");
    raw.exec("INSERT INTO knowledge_outbox(event_id,available_at) VALUES ('old-canonical','2026-09-03T00:00:00.000Z'),('old-duplicate','2026-09-03T00:00:01.000Z')");
    assert.throws(
      () => raw.exec("CREATE UNIQUE INDEX idx_relay_domain_events_event_key ON relay_domain_events(event_key) WHERE event_key IS NOT NULL"),
      /UNIQUE constraint failed/i,
    );
    raw.close();

    const store = createKnowledgeStore({ dbPath });
    try {
      const events = store.db.prepare("SELECT id,event_key FROM relay_domain_events WHERE id IN ('old-canonical','old-duplicate') ORDER BY id").all() as Array<{ id: string; event_key: string | null }>;
      assert.deepEqual(events, [
        { id: "old-canonical", event_key: "legacy:job-old:finished" },
        { id: "old-duplicate", event_key: null },
      ]);
      assert.deepEqual(
        store.db.prepare("SELECT event_id,reason FROM knowledge_migration_dead_letter WHERE event_id = 'old-duplicate'").all(),
        [{ event_id: "old-duplicate", reason: "duplicate_event_key" }],
      );
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_outbox WHERE event_id = 'old-duplicate'").get().count, 0);
      const claimed = store.claim("capture");
      assert.deepEqual(claimed.map((event) => event.id), ["old-canonical"]);
    } finally {
      store.close();
    }
  } finally {
    cleanup(root);
  }
});

test("migrations tolerate a partially applied event_key column", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-partial-"));
  try {
    let Database: any;
    try {
      Database = (await import("better-sqlite3")).default;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Could not locate the bindings file|better-sqlite3/i.test(message)) t.skip(`better-sqlite3 binding unavailable: ${message.split("\n")[0]}`);
      else throw error;
      return;
    }
    const dbPath = join(root, "knowledge.db");
    const raw = new Database(dbPath);
    raw.exec(INITIAL_KNOWLEDGE_SCHEMA);
    raw.exec(KNOWLEDGE_DOMAIN_SCHEMA);
    // Simulate a crash after the DDL ran but before the migration marker was written.
    raw.exec("ALTER TABLE relay_domain_events ADD COLUMN event_key TEXT");
    raw.close();

    const store = createKnowledgeStore({ dbPath });
    try {
      const versions = store.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row: any) => String(row.version));
      assert.deepEqual(versions, [
        "001-initial",
        "002-domain",
        "003-event-project-identity",
        "004-governance-audit",
        "005-event-reliability",
        "006-event-actor",
        "007-event-key-backfill",
        "008-consumer-heartbeats",
        "009-search",
        "010-facts-search",
        "011-api-governance",
        "011-hybrid-retrieval",
        "012-candidate-card",
        "013-knowledge-scope",
        "014-deterministic-compiler",
      ]);
      store.append({ id: "event-partial", type: "job.finished", eventKey: "job:partial:finished", ...eventDefaults });
      assert.equal(store.claim("capture").length, 1);
    } finally {
      store.close();
    }
  } finally {
    cleanup(root);
  }
});

test("event-key backfill deduplicates historical events and dead-letters unidentifiable rows", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-backfill-"));
  try {
    let Database: any;
    try {
      Database = (await import("better-sqlite3")).default;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Could not locate the bindings file|better-sqlite3/i.test(message)) t.skip(`better-sqlite3 binding unavailable: ${message.split("\n")[0]}`);
      else throw error;
      return;
    }
    const dbPath = join(root, "knowledge.db");
    const raw = new Database(dbPath);
    raw.exec(INITIAL_KNOWLEDGE_SCHEMA);
    raw.exec(KNOWLEDGE_DOMAIN_SCHEMA);
    raw.exec("ALTER TABLE relay_domain_events ADD COLUMN project_name_snapshot TEXT");
    raw.exec("ALTER TABLE relay_domain_events ADD COLUMN event_key TEXT");
    raw.exec("INSERT INTO relay_domain_events(id,type,occurred_at,job_id,payload_json) VALUES ('old-a','job.finished','2026-09-03T00:00:00.000Z','job-old','{}'),('old-b','job.finished','2026-09-03T00:00:01.000Z','job-old','{}'),('old-unrecoverable','job.finished','2026-09-03T00:00:02.000Z',NULL,'{}')");
    raw.exec("INSERT INTO knowledge_outbox(event_id,available_at) VALUES ('old-a','2026-09-03T00:00:00.000Z'),('old-b','2026-09-03T00:00:01.000Z'),('old-unrecoverable','2026-09-03T00:00:02.000Z')");
    raw.close();

    const store = createKnowledgeStore({ dbPath });
    try {
      const old = store.db.prepare("SELECT id,event_key FROM relay_domain_events WHERE id IN ('old-a','old-b') ORDER BY id").all() as Array<{ id: string; event_key?: string }>;
      assert.equal(old[0].event_key, "job:job-old:finished");
      assert.equal(old[1].event_key, null);
      const dead = store.db.prepare("SELECT event_id,reason FROM knowledge_migration_dead_letter ORDER BY event_id").all() as Array<{ event_id: string; reason: string }>;
      assert.deepEqual(dead, [
        { event_id: "old-b", reason: "duplicate_derived_event_key" },
        { event_id: "old-unrecoverable", reason: "event_key_unrecoverable" },
      ]);
      const claimed = store.claim("capture");
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].id, "old-a");
      store.acknowledge("capture", claimed[0].id, claimed[0].claimToken);
    } finally {
      store.close();
    }
  } finally {
    cleanup(root);
  }
});
