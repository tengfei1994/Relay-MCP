import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { captureKnowledgeCandidates, evaluateObservationPool } from "../src/knowledge/capture-worker.ts";

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
