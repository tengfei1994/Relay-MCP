import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { acceptCandidate, editDocument, mergeCandidates, promoteCaseToPattern, proposePlaybook, reviewDocument } from "../src/knowledge/review-service.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-review-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  store.grantAcl("p1", 7, true);
  const now = new Date().toISOString();
  for (const [id, kind] of [["c1", "candidate"], ["c2", "candidate"], ["case1", "case"]] as const) store.upsertDocument({ id, kind, title: id, body: "body", lifecycle: "draft", projectId: "p1", locator: `test:${id}`, createdAt: now, updatedAt: now });
  store.db.prepare("INSERT INTO knowledge_evidence(id,sha256,storage_path,mime_type,size_bytes,source_kind,project_id,source_locator,retention,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("ev-1", "hash-1", join(root, "ev-1"), "text/plain", 1, "test", "p1", "test:ev-1", "standard", now);
  store.db.prepare("INSERT INTO knowledge_entity_evidence(entity_type,entity_id,evidence_id,created_at) VALUES ('candidate','c2','ev-1',?)").run(now);
  return { root, store };
}

test("review service enforces ACL, records history and supports candidate merge", () => {
  const { root, store } = fixture();
  try {
    assert.throws(() => reviewDocument(store, 99, "c1", "reproduced", "no"), /access denied|authorized reviewer/);
    acceptCandidate(store, 7, "c1", "looks valid");
    editDocument(store, 7, "c1", { title: "Edited" }, "clarify title");
    mergeCandidates(store, 7, "c2", "c1", "duplicate");
    assert.equal(store.db.prepare("SELECT lifecycle FROM knowledge_documents WHERE id='c2'").get().lifecycle, "deprecated");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM knowledge_reviews WHERE entity_id IN ('c1','c2')").get().n, 3);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM knowledge_relations WHERE relation_type='supersedes'").get().n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM knowledge_entity_evidence WHERE entity_type='candidate' AND entity_id='c1' AND evidence_id='ev-1'").get().n, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("case promotion and playbook proposal stay drafts and require reviewer", () => {
  const { root, store } = fixture();
  try {
    reviewDocument(store, 7, "case1", "reproduced", "reproduced");
    reviewDocument(store, 7, "case1", "verified", "verified");
    const pattern = promoteCaseToPattern(store, 7, "case1", { id: "pattern1", title: "Pattern", reason: "generalize" });
    assert.equal(pattern.lifecycle, "draft");
    const playbook = proposePlaybook(store, 7, { id: "pb1", projectId: "p1", title: "PB", body: "steps", skillDiff: "diff", reason: "proposal" });
    assert.equal(playbook.lifecycle, "draft");
    assert.equal(store.db.prepare("SELECT case_refs_json FROM knowledge_patterns WHERE id='pattern1'").get().case_refs_json, '["case1"]');
    assert.equal(store.db.prepare("SELECT lifecycle FROM knowledge_documents WHERE id='pb1'").get().lifecycle, "draft");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
