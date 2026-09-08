import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { captureKnowledgeCandidates, evaluateObservationPool } from "../src/knowledge/capture-worker.ts";
import { OBSERVATION_REVIEW_INTERVAL_MS } from "../src/knowledge/observation-review.ts";

test("capture cycles continuously evaluate unlinked observations", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-observation-pool-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    const event = { id: "event-pool", type: "job.finished" as const, occurredAt: "2026-09-08T00:00:00.000Z", projectId: "p1", jobId: "job-pool", payload: { status: "succeeded", warning: "partial output", log: "warning details" } };
    store.append(event);
    assert.equal(await captureKnowledgeCandidates(store), 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_observations").get().count, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_candidates").get().count, 1);
    assert.equal(await evaluateObservationPool(store), 0);
    const candidate = store.db.prepare("SELECT source_observation_id FROM knowledge_candidates WHERE event_id = ?").get(event.id) as { source_observation_id: string };
    assert.match(candidate.source_observation_id, /^observation-/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function seed(store: ReturnType<typeof createKnowledgeStore>, id: string, payload: Record<string, unknown>) {
  const now = "2026-09-08T00:00:00.000Z";
  store.append({ id: `event-${id}`, jobId: `job-${id}`, type: "job.finished", occurredAt: now, projectId: "p1", payload });
  store.saveObservation({ id, eventId: `event-${id}`, projectId: "p1", eventClass: "observation", captureReason: "test observation", facts: [], evidenceRefs: [], sourceLocator: `event:${id}`, createdAt: now, updatedAt: now });
}

test("pool traverses past a full harmless batch, persists decisions and periodically revisits them", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-observation-review-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    for (let index = 0; index < 25; index++) seed(store, `observation-${String(index).padStart(3, "0")}`, { status: "succeeded", stdout: "service running" });
    seed(store, "observation-999", { status: "succeeded", warning: "missing runtime dependency" });
    const now = new Date("2026-09-08T01:00:00.000Z");
    assert.equal(await evaluateObservationPool(store, 20, now), 0);
    assert.equal(await evaluateObservationPool(store, 20, now), 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM knowledge_observation_reviews").get().count, 26);
    const review = store.db.prepare("SELECT * FROM knowledge_observation_reviews WHERE observation_id='observation-999'").get() as any;
    assert.equal(review.outcome, "promoted");
    assert.equal(review.next_review_at, null);
    assert.ok(store.getCandidateCard(review.candidate_id));
    assert.equal(await evaluateObservationPool(store, 20, now), 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM knowledge_candidates").get().count, 1);
    const later = new Date(now.getTime() + OBSERVATION_REVIEW_INTERVAL_MS + 1);
    await evaluateObservationPool(store, 20, later);
    await evaluateObservationPool(store, 20, later);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM knowledge_observation_reviews WHERE review_count=2").get().count, 25);
    // Unchanged reviews update their counters without flooding the audit table.
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM knowledge_audit WHERE action='knowledge.observation.reviewed'").get().count, 26);
    assert.equal(store.db.prepare("SELECT human_status FROM knowledge_observations WHERE id='observation-999'").get().human_status, "candidate_created");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed materialization rolls back and does not block later rows; retry is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-observation-retry-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    seed(store, "a", { status: "succeeded", warning: "missing dependency" });
    seed(store, "b", { status: "succeeded", stdout: "running" });
    const now = new Date("2026-09-08T01:00:00.000Z");
    const saveCard = store.saveCandidateCard.bind(store);
    store.saveCandidateCard = () => { throw new Error("test card failure"); };
    assert.equal(await evaluateObservationPool(store, 20, now), 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM knowledge_candidates").get().count, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM knowledge_documents WHERE kind='candidate'").get().count, 0);
    assert.deepEqual(store.db.prepare("SELECT outcome FROM knowledge_observation_reviews ORDER BY observation_id").all(), [{ outcome: "error" }, { outcome: "deferred" }]);
    store.saveCandidateCard = saveCard;
    const later = new Date(now.getTime() + OBSERVATION_REVIEW_INTERVAL_MS + 1);
    assert.equal(await evaluateObservationPool(store, 20, later), 1);
    assert.equal(await evaluateObservationPool(store, 20, later), 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM knowledge_candidates").get().count, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("existing candidates are reconciled without resetting their reviewed lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-observation-existing-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    seed(store, "a", { status: "succeeded", warning: "missing dependency" });
    await evaluateObservationPool(store);
    store.db.prepare("DELETE FROM knowledge_observation_reviews").run();
    store.db.prepare("UPDATE knowledge_candidates SET status='deprecated'").run();
    await evaluateObservationPool(store);
    assert.equal(store.db.prepare("SELECT status FROM knowledge_candidates").get().status, "deprecated");
    assert.equal(store.db.prepare("SELECT outcome FROM knowledge_observation_reviews").get().outcome, "promoted");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("empty warning collections and zero-error build output remain observations", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-observation-benign-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    seed(store, "a", { status: "succeeded", warnings: [], stdout: "Build succeeded. 0 Warning(s) 0 Error(s)" });
    assert.equal(await evaluateObservationPool(store), 0);
    assert.equal(store.db.prepare("SELECT outcome FROM knowledge_observation_reviews").get().outcome, "deferred");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("promoted observations expose the concrete warning instead of a generic review statement", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-observation-readable-card-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    seed(store, "warning", {
      status: "succeeded",
      warning: "Waiting for service smpSTATvgsm to start after 30 seconds",
      stdout: "Deployment completed with a warning",
    });
    assert.equal(await evaluateObservationPool(store), 1);
    const review = store.db.prepare("SELECT candidate_id FROM knowledge_observation_reviews WHERE observation_id='warning'").get() as { candidate_id: string };
    const card = store.getCandidateCard(review.candidate_id)!;
    assert.match(card.problemStatement, /Waiting for service smpSTATvgsm/);
    assert.doesNotMatch(card.problemStatement, /derived from an observed runtime problem signal/i);
    assert.ok(card.symptoms.some((symptom) => /smpSTATvgsm/.test(symptom)));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("idle capture cycles review historical observations and replay preserves their review state", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-observation-idle-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    seed(store, "a", { status: "succeeded", warning: "missing dependency" });
    for (const event of store.claim("knowledge-capture", 20)) store.acknowledge("knowledge-capture", event.id, event.claimToken);
    assert.equal(await captureKnowledgeCandidates(store), 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM knowledge_candidates").get().count, 1);
    seed(store, "a", { status: "succeeded", warning: "missing dependency" });
    assert.equal(store.db.prepare("SELECT human_status FROM knowledge_observations WHERE id='a'").get().human_status, "candidate_created");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("multiple long observations create searchable candidates without document/chunk rowid collisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-observation-fts-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    for (let i=0; i<4; i++) seed(store, `long-${i}`, { status: "succeeded", stdout: "warning compilerdiagnostic " + "runtime details ".repeat(800) });
    assert.equal(await evaluateObservationPool(store), 4);
    assert.equal(store.db.prepare("SELECT COUNT(DISTINCT document_id) count FROM knowledge_fts WHERE knowledge_fts MATCH 'compilerdiagnostic'").get().count, 4);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM knowledge_observation_reviews WHERE outcome='error'").get().count, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
