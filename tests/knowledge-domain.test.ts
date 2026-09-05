import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore, KnowledgeRepository } from "../src/knowledge/store.ts";
import { assertLifecycleTransition } from "../src/knowledge/domain.ts";

test("domain migration creates type projections and lifecycle rejects skips", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-domain-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    for (const table of ["knowledge_cases", "knowledge_patterns", "knowledge_playbooks", "knowledge_candidates", "knowledge_entity_evidence", "knowledge_ingest_runs"]) {
      assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
    }
    assert.throws(() => assertLifecycleTransition("draft", "approved"), /Invalid knowledge lifecycle/);
    assert.doesNotThrow(() => assertLifecycleTransition("draft", "reproduced"));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("repository persists case/pattern/playbook/candidate projections and feedback", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-domain-repo-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    const repository = new KnowledgeRepository(store);
    const now = new Date().toISOString();
    const base = { projectId: "p1", locator: "test:domain", createdAt: now, updatedAt: now };
    repository.saveCase({ ...base, id: "case-1", kind: "case", title: "Case", body: "symptom", lifecycle: "draft" });
    repository.savePattern({ ...base, id: "pattern-1", kind: "pattern", title: "Pattern", body: "pattern", lifecycle: "draft", caseRefs: ["case-1"] });
    repository.savePlaybook({ ...base, id: "playbook-1", kind: "playbook", title: "Playbook", body: "steps", lifecycle: "draft", steps: ["check"] });
    repository.saveCandidate({ ...base, id: "candidate-1", kind: "candidate", title: "Candidate", body: "event", lifecycle: "draft", eventId: "event-1" });
    repository.recordFeedback({ entityId: "case-1", userId: 7, helpful: true, comment: "useful" });
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM knowledge_cases").get().count, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM knowledge_patterns").get().count, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM knowledge_playbooks").get().count, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM knowledge_candidates").get().count, 1);
    assert.equal(store.db.prepare("SELECT helpful FROM knowledge_feedback WHERE entity_id='case-1'").get().helpful, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
