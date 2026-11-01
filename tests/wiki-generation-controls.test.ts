import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeStore } from "../src/knowledge/store.ts";
import { enqueueWikiGeneration, enqueueWikiGenerationDetailed, executeIngestJob } from "../src/knowledge/ingest-worker.ts";
import { claimIngestJob, normalizeWikiGenerationJob } from "../src/knowledge/ingest-dispatch.ts";
import { controlWikiGenerationJob, WikiGenerationControlError } from "../src/knowledge/ingest-controls.ts";
import { WikiGenerationService } from "../src/knowledge/wiki-generation.ts";

async function withStore<T>(fn: (store: KnowledgeStore) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(process.cwd(), ".tmp-wiki-controls-"));
  const store = new KnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try { return await fn(store); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

test("manual and automatic Wiki jobs persist trigger kind and normalize progress", () => withStore((store) => {
  const manual = enqueueWikiGeneration(store, { topicGroupIds: ["topic-b", "topic-a"], triggerId: "manual-123", triggerKind: "manual" });
  const automatic = enqueueWikiGeneration(store, { topicGroupIds: ["topic-c"], triggerId: "run-123", triggerKind: "automatic" });
  assert.ok(manual); assert.ok(automatic);
  const rows = store.db.prepare("SELECT id,trigger_kind,control_state FROM knowledge_ingest_jobs ORDER BY id").all() as Array<{ id: string; trigger_kind: string; control_state: string }>;
  assert.deepEqual(rows.map((row) => row.trigger_kind).sort(), ["automatic", "manual"]);
  assert.deepEqual(rows.map((row) => row.control_state).sort(), ["active", "active"]);
  store.db.prepare("UPDATE knowledge_ingest_jobs SET result_json=? WHERE id=?").run(JSON.stringify({ processed: 2, total: 5, generated: [{ id: "page-1" }], failures: [{ topicGroupId: "topic-x", error: "bad" }] }), manual!.id);
  const normalized = normalizeWikiGenerationJob(store.db.prepare("SELECT * FROM knowledge_ingest_jobs WHERE id=?").get(manual!.id) as Record<string, unknown>);
  assert.equal(normalized.processed, 2);
  assert.equal(normalized.total, 5);
  assert.equal(normalized.percent, 40);
  assert.equal(normalized.generated, 1);
  assert.equal(normalized.failures, 1);
  assert.equal(normalized.triggerKind, "manual");
  assert.equal(normalized.controlState, "active");
}));

test("overlapping Wiki enqueue is durable and skips topics already covered by an active job", () => withStore((store) => {
  const first = enqueueWikiGenerationDetailed(store, { topicGroupIds: ["topic-a", "topic-b"], triggerId: "manual-overlap-1", triggerKind: "manual" });
  assert.ok(first.job);
  assert.deepEqual(first.queuedTopicGroupIds, ["topic-a", "topic-b"]);
  const second = enqueueWikiGenerationDetailed(store, { topicGroupIds: ["topic-a", "topic-b", "topic-c"], triggerId: "manual-overlap-2", triggerKind: "manual" });
  assert.ok(second.job);
  assert.deepEqual(second.skippedTopicGroupIds, ["topic-a", "topic-b"]);
  assert.deepEqual(second.queuedTopicGroupIds, ["topic-c"]);
  const third = enqueueWikiGenerationDetailed(store, { topicGroupIds: ["topic-a", "topic-b"], triggerId: "manual-overlap-3", triggerKind: "manual" });
  assert.equal(third.queuedTopicGroupIds.length, 0);
  assert.deepEqual(third.skippedTopicGroupIds, ["topic-a", "topic-b"]);
  assert.equal(third.coveredByJobId, first.job!.id);
  assert.equal(third.job?.id, first.job!.id);
}));

test("legacy Wiki jobs default to automatic active control", () => withStore((store) => {
  const job = enqueueWikiGeneration(store, { topicGroupIds: ["topic-a"], triggerId: "manual-legacy" });
  assert.ok(job);
  const row = store.db.prepare("SELECT * FROM knowledge_ingest_jobs WHERE id=?").get(job!.id) as Record<string, unknown>;
  delete row.trigger_kind; delete row.control_state;
  const normalized = normalizeWikiGenerationJob(row);
  assert.equal(normalized.triggerKind, "manual");
  assert.equal(normalized.controlState, "active");
}));

test("queued Wiki jobs pause before claim and resume without resetting progress", () => withStore((store) => {
  const job = enqueueWikiGeneration(store, { topicGroupIds: ["topic-a", "topic-b"], triggerId: "manual-queued", triggerKind: "manual" });
  assert.ok(job);
  const paused = controlWikiGenerationJob(store, job!.id, "pause", 7);
  assert.equal(paused.controlState, "paused");
  assert.equal(claimIngestJob(store, job!.id, "claim-after-pause"), false);
  store.db.prepare("UPDATE knowledge_ingest_jobs SET result_json=? WHERE id=?").run(JSON.stringify({ processed: 1, total: 2, generated: [{ id: "page-a" }], failures: [] }), job!.id);
  const resumed = controlWikiGenerationJob(store, job!.id, "resume", 7);
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.controlState, "active");
  assert.equal(resumed.processed, 1);
  assert.equal(resumed.percent, 50);
}));

test("running Wiki jobs pause at the batch boundary and preserve cursor", async () => withStore(async (store) => {
  const job = enqueueWikiGeneration(store, { topicGroupIds: ["topic-a", "topic-b", "topic-c", "topic-d", "topic-e", "topic-f"], triggerId: "manual-running", triggerKind: "manual" });
  assert.ok(job);
  const ownerToken = "owner-running";
  const now = new Date().toISOString();
  store.db.prepare("UPDATE knowledge_ingest_jobs SET status='running',owner_token=?,owner_pid=?,started_at=?,updated_at=? WHERE id=?").run(ownerToken, process.ppid, now, now, job!.id);
  const original = WikiGenerationService.prototype.generate;
  let calls = 0;
  WikiGenerationService.prototype.generate = async function(input) {
    calls += 1;
    if (calls === 1) store.db.prepare("UPDATE knowledge_ingest_jobs SET control_state='pause_requested',pause_requested_at=? WHERE id=?").run(new Date().toISOString(), job!.id);
    return { topicGroupId: input.topicGroupId, pageId: `page-${input.topicGroupId}`, title: input.topicGroupId, supportedVersions: [], sectionCount: 0, sourceCount: 0, fingerprint: "test" };
  };
  try {
    const result = await executeIngestJob(store, job!.id, { ownerToken });
    assert.equal(result.controlState, "paused");
    const row = store.db.prepare("SELECT status,control_state,owner_token,payload_json,result_json FROM knowledge_ingest_jobs WHERE id=?").get(job!.id) as { status: string; control_state: string; owner_token: string | null; payload_json: string; result_json: string };
    assert.equal(row.status, "queued");
    assert.equal(row.control_state, "paused");
    assert.equal(row.owner_token, null);
    assert.equal(JSON.parse(row.payload_json).cursor, 5);
    assert.equal(JSON.parse(row.result_json).processed, 5);
    assert.equal(calls, 5);
  } finally { WikiGenerationService.prototype.generate = original; }
}));

test("terminal and non-Wiki jobs reject job controls", () => withStore((store) => {
  const wiki = enqueueWikiGeneration(store, { topicGroupIds: ["topic-a"], triggerId: "manual-terminal", triggerKind: "manual" });
  assert.ok(wiki);
  store.db.prepare("UPDATE knowledge_ingest_jobs SET status='succeeded' WHERE id=?").run(wiki!.id);
  assert.throws(() => controlWikiGenerationJob(store, wiki!.id, "pause", 7), (error: unknown) => error instanceof WikiGenerationControlError && error.code === "terminal");
  const product = `product-${Date.now()}`;
  const now = new Date().toISOString();
  store.db.prepare("INSERT INTO knowledge_ingest_jobs(id,kind,payload_json,status,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(product, "product_documents", "{}", "queued", now, now, now);
  assert.throws(() => controlWikiGenerationJob(store, product, "pause", 7), (error: unknown) => error instanceof WikiGenerationControlError && error.code === "unsupported_kind");
}));
