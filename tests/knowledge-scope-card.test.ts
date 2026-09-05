import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { captureKnowledgeCandidates } from "../src/knowledge/capture-worker.ts";
import { generateCandidateCard } from "../src/knowledge/candidate-card.ts";
import { editCandidateCard, promoteCaseToPattern, reviewDocument } from "../src/knowledge/review-service.ts";
import { searchKnowledge } from "../src/knowledge/retriever.ts";
import { KnowledgeRepository } from "../src/knowledge/repository.ts";
import { createKnowledgeStore } from "../src/knowledge/store.ts";

function cleanup(root: string): void { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); }

test("capture creates a readable Candidate Card while retaining Raw Event and Evidence provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-candidate-card-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db"), evidenceRoot: join(root, "evidence") });
  try {
    store.append({ id: "event-card-1", type: "deployment.failed", occurredAt: "2026-09-05T00:00:00.000Z", projectId: "p1", deploymentId: "deploy-card-1", payload: { status: "failed", error: "FormsBin cache is stale", symptoms: ["form load failed"], tags: ["FormsBin", "cache"], sampleManagerVersion: "21.1", solution: "PT 3.5", module: "Instrument", log: "error log" } });
    assert.equal(await captureKnowledgeCandidates(store, "capture"), 1);
    store.grantAcl("p1", 7);
    const document = store.listDocuments(7, "p1")[0];
    const card = store.getCandidateCard(document.id);
    assert.ok(card);
    assert.match(card.summary, /deployment\.failed/i);
    assert.doesNotMatch(card.summary, /^\{/);
    assert.match(card.hypothesis, /^unconfirmed:/i);
    assert.deepEqual(card.symptoms, ["FormsBin cache is stale", "form load failed"]);
    assert.equal(card.generatedBy, "deterministic-rule-v1");
    assert.ok(card.verificationPlan.length >= 1);
    assert.equal(JSON.parse(document.body).eventId, "event-card-1");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_entity_evidence WHERE entity_id = ?").get(document.id).count, 1);

    store.grantAcl("p1", 7, true);
    const edited = editCandidateCard(store, 7, document.id, { summary: "Reviewed FormsBin cache failure", hypothesis: "cache invalidation may be incomplete", actions: ["Inspect FormsBin cache"], confidence: 0.4 }, "Reviewer refined card");
    assert.equal(edited.summary, "Reviewed FormsBin cache failure");
    assert.match(edited.hypothesis, /^unconfirmed:/i);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_reviews WHERE entity_id = ? AND action = 'edit.card'").get(document.id).count, 1);
    assert.throws(() => editCandidateCard(store, 7, document.id, { verifiedConclusion: "confirmed" }, "Premature conclusion"), /verified or approved lifecycle/);
  } finally { store.close(); cleanup(root); }
});

test("inference-generated cards are schema-checked and reject unknown Evidence references", async () => {
  const event = { id: "event-provider", type: "job.failed" as const, occurredAt: "2026-09-05T00:00:00.000Z", projectId: "p1", jobId: "job-provider", payload: { error: "failure" }, eventKey: "job:job-provider:failed" };
  const inference = { capabilities: { modelId: "fake-card", dataPolicy: "local" as const }, complete: async () => JSON.stringify({ summary: "Provider summary", hypothesis: "cache issue", evidenceRefs: ["missing-evidence"] }) };
  const result = await generateCandidateCard({ event, projectId: "p1", evidenceRefs: ["real-evidence"], inference });
  assert.equal(result.card.inferenceStatus, "rejected");
  assert.ok(result.providerError);
  assert.match(result.card.hypothesis, /^unconfirmed:/i);
});

test("reviewed global Pattern is searchable from another Project without private source Evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-scope-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db"), evidenceRoot: join(root, "evidence") });
  try {
    store.grantAcl("p1", 7, true);
    store.grantAcl("p2", 7, false);
    const now = new Date().toISOString();
    const repo = new KnowledgeRepository(store);
    repo.saveCase({ id: "case-private", kind: "case", title: "Private FormsBin incident", body: "Customer A private cache details", lifecycle: "verified", projectId: "p1", sampleManagerVersion: "21.1", solution: "PT 3.5", module: "Instrument", locator: "case:p1", createdAt: now, updatedAt: now });
    const evidence = store.db.prepare("INSERT INTO knowledge_evidence(id,sha256,storage_path,mime_type,size_bytes,source_kind,project_id,source_locator,retention,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
    evidence.run("private-evidence", "hash-private", join(root, "private.log"), "text/plain", 10, "log", "p1", "private:p1", "standard", now);
    store.db.prepare("INSERT INTO knowledge_entity_evidence(entity_type,entity_id,evidence_id,created_at) VALUES (?,?,?,?)").run("case", "case-private", "private-evidence", now);
    const pattern = promoteCaseToPattern(store, 7, "case-private", { id: "pattern-global", title: "Reusable FormsBin cache recovery", body: "When a SampleManager FormsBin cache is stale, clear the scoped cache and validate the form contract before release.", reason: "Generalized and redacted for reuse", scopeType: "system", scopeKey: "samplemanager-formsbin-cache", visibility: "global", redactionStatus: "redacted" });
    reviewDocument(store, 7, "pattern-global", "reproduced", "Reviewer approved the generalized Pattern for reuse");
    reviewDocument(store, 7, "pattern-global", "verified", "Verified against sanitized Evidence and contract checks");
    assert.equal(pattern.projectId, "p1");
    const binding = store.getScopeBinding("pattern-global");
    assert.equal(binding?.visibility, "global");
    assert.equal(binding?.sourceProjectId, "p1");
    assert.equal(store.db.prepare("SELECT evidence_refs_json FROM knowledge_patterns WHERE id = ?").get("pattern-global").evidence_refs_json, "[]");
    const result = await searchKnowledge(store, { userId: 7, projectId: "p2", query: "FormsBin cache recovery", sampleManagerVersion: "21.1", solution: "PT 3.5" });
    assert.ok(result.results.some((item) => item.id === "pattern-global"));
    const shared = result.results.find((item) => item.id === "pattern-global");
    assert.equal(shared?.scope.visibility, "global");
    assert.deepEqual(shared?.evidenceRefs, []);
    assert.equal(result.results.some((item) => item.id === "case-private"), false);
    assert.throws(() => promoteCaseToPattern(store, 7, "case-private", { id: "pattern-unredacted", title: "Unsafe", body: "unsafe", reason: "not redacted", scopeType: "system", visibility: "global", redactionStatus: "unknown" }), /redactionStatus=redacted/);
  } finally { store.close(); cleanup(root); }
});
