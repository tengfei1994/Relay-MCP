import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createKnowledgeStore } from "../src/knowledge/store.js";
import { EvidenceStore } from "../src/knowledge/evidence-store.js";
import { ConfirmedMemoryService } from "../src/knowledge/confirmed-memory.js";
import { CandidateInsightCompiler } from "../src/knowledge/candidate-insight.js";
import { CandidateInsightReviewService } from "../src/knowledge/candidate-review.js";
import { WorkSessionService, type IntentEnvelope } from "../src/knowledge/work-session.js";
import { searchKnowledge } from "../src/knowledge/retriever.js";

const intent: IntentEnvelope = { actions: ["diagnose", "capture"], phase: "diagnosis", objective: "Record memory", constraints: [], acceptanceCriteria: ["Evidence linked"], projectId: "p1", risk: "read_only", knowledgeMode: "retrieve_and_capture", actorId: 7 };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-memory-review-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), evidenceRoot: join(root, "evidence") });
  store.grantAcl("p1", 7, true);
  const evidence = new EvidenceStore(store, store.evidenceRoot!).put({ content: Buffer.from("verified signal"), mimeType: "text/plain", sourceKind: "log", projectId: "p1", locator: `test:${randomUUID()}` });
  return { root, store, evidence };
}

test("all four Confirmed Memory types persist with provenance", () => {
  const { root, store, evidence } = fixture();
  try {
    const service = new ConfirmedMemoryService(store, () => new Date("2026-10-28T00:00:00.000Z"));
    const inputs = [
      { type: "Fact" as const, details: { subject: "signal", value: "verified" } },
      { type: "Decision" as const, details: { decision: "retry", rationale: "safe", alternatives: ["abort"] } },
      { type: "Case" as const, details: { symptoms: "stopped", rootCause: "power", resolution: "replace", verification: "passed" } },
      { type: "Pattern" as const, details: { statement: "power faults recur", applicability: "pump", signals: ["stop"], exceptions: [] } },
    ];
    for (const [index, value] of inputs.entries()) service.save({ id: `memory-${index}`, title: value.type, statement: value.type, ...value, scope: { projectId: "p1", scopeType: "project", scopeKey: "p1", visibility: "project" }, evidenceRefs: [evidence.id], source: { kind: "manual", locator: `test:${value.type}` }, confirmedBy: 7, confirmedAt: "2026-10-28T00:00:00.000Z", audit: { action: "manual", reason: "reviewed" } });
    assert.equal(service.list({ actorId: 7, projectId: "p1" }).length, 4);
    const detail = service.get({ actorId: 7, id: "memory-2" });
    assert.equal(detail.type, "Case");
    assert.deepEqual(detail.evidenceRefs, [evidence.id]);
    assert.equal(detail.confirmedBy, 7);
    assert.equal(detail.audit.reason, "reviewed");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Candidate Insight promotion creates Confirmed Memory and default search excludes the candidate", async () => {
  const { root, store, evidence } = fixture();
  try {
    const session = new WorkSessionService(store).open({ actorId: 7, idempotencyKey: randomUUID(), intent });
    const compiler = new CandidateInsightCompiler(store, async () => JSON.stringify({ kind: "fact", statement: "verified signal", whyProposed: "Evidence supports it", evidenceRefs: [evidence.id], intentRefs: [], unknowns: [], reuseBoundary: { scope: "project" } }));
    const insight = await compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidence.id], context: { variant: "verified" } });
    const review = new CandidateInsightReviewService(store);
    review.confirm({ actorId: 7, id: insight.id, reason: "reviewed" });
    const promotion = review.promote({ actorId: 7, id: insight.id, target: "fact", reason: "confirmed" });
    assert.equal(promotion.mode, "persisted");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_confirmed_memories WHERE id=?").get(promotion.targetId).n, 1);
    const results = await searchKnowledge(store, { userId: 7, projectId: "p1", query: "verified signal", limit: 20 });
    assert.equal(results.results.some((item) => item.kind === "candidate"), false);
    assert.equal(results.results.some((item) => item.kind === "confirmed_memory" && item.memoryType === "Fact"), true);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Confirmed Memory enforces project ACL and Evidence ACL isolation", () => {
  const { root, store, evidence } = fixture();
  try {
    const service = new ConfirmedMemoryService(store);
    assert.throws(() => service.save({ id: "foreign", type: "Fact", title: "foreign", statement: "foreign", details: { subject: "x", value: "y" }, scope: { projectId: "p2", scopeType: "project", scopeKey: "p2", visibility: "project" }, evidenceRefs: [evidence.id], source: { kind: "manual", locator: "foreign" }, confirmedBy: 7, confirmedAt: new Date().toISOString(), audit: { action: "manual", reason: "test" } }), /access denied|ACL/);
    assert.throws(() => service.list({ actorId: 9, projectId: "p1" }), /access denied/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Confirmed Memory rejects type substitution, missing timestamps and reader-only confirmation", () => {
  const { root, store, evidence } = fixture();
  try {
    const service = new ConfirmedMemoryService(store);
    const input = { id: "immutable", type: "Fact" as const, title: "signal", statement: "verified signal", details: { subject: "signal", value: "verified" }, scope: { projectId: "p1", scopeType: "project" as const, scopeKey: "p1", visibility: "project" as const }, evidenceRefs: [evidence.id], source: { kind: "manual" as const, locator: "test:signal" }, confirmedBy: 7, confirmedAt: new Date().toISOString(), audit: { action: "manual" as const, reason: "reviewed" } };
    assert.throws(() => service.save({ ...input, confirmedAt: "" }), /time|date/i);
    store.grantAcl("p1", 8, false);
    assert.throws(() => service.save({ ...input, confirmedBy: 8 }), /access denied|review/i);
    service.save(input);
    assert.throws(() => service.save({ ...input, type: "Decision", details: { decision: "replace", rationale: "safe", alternatives: [] } }), /type/i);
    assert.equal(service.get({ actorId: 7, id: input.id }).type, "Fact");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("promotion preserves session environment and does not invent Case conclusions", async () => {
  const { root, store, evidence } = fixture();
  try {
    const session = new WorkSessionService(store).open({ actorId: 7, idempotencyKey: randomUUID(), intent: { ...intent, environment: "dev" } });
    const missingCase = await new CandidateInsightCompiler(store, async () => JSON.stringify({ kind: "case", statement: "signal observed", whyProposed: "review needed", evidenceRefs: [evidence.id], unknowns: ["root cause"] })).compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidence.id], context: {} });
    const missingReview = new CandidateInsightReviewService(store);
    missingReview.confirm({ actorId: 7, id: missingCase.id, reason: "review observation" });
    assert.throws(() => missingReview.promote({ actorId: 7, id: missingCase.id, target: "case", reason: "do not infer" }), /hypothesis|verification/i);
    const compiler = new CandidateInsightCompiler(store, async () => JSON.stringify({ kind: "case", statement: "verified signal", whyProposed: "review needed", evidenceRefs: [evidence.id], hypothesis: "verified supply failure", confirmedFacts: ["signal restored"], observedBehavior: ["signal absent"], reusableStatement: { statement: "replace supply" }, unknowns: [] }));
    const insight = await compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidence.id], context: { variant: "verified" } });
    const review = new CandidateInsightReviewService(store);
    review.confirm({ actorId: 7, id: insight.id, reason: "accept investigation" });
    const promotion = review.promote({ actorId: 7, id: insight.id, target: "case", reason: "evidence verified" });
    const service = new ConfirmedMemoryService(store);
    assert.equal(service.get({ actorId: 7, id: promotion.targetId }).scope.environment, "dev");
    assert.equal(service.list({ actorId: 7, projectId: "p1", environment: "prod" }).length, 0);
    assert.equal((await searchKnowledge(store, { userId: 7, projectId: "p1", query: "signal", environment: "prod" })).results.length, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("retrieval keeps confirmed memory project, global scope and Evidence ACL boundaries", async () => {
  const { root, store, evidence } = fixture();
  try {
    store.grantAcl("p2", 7, true);
    const service = new ConfirmedMemoryService(store);
    service.save({ id: "private-p1", type: "Fact", title: "private signal", statement: "private signal", details: { subject: "scope", value: "p1" }, scope: { projectId: "p1", scopeType: "project", scopeKey: "p1", visibility: "project" }, evidenceRefs: [evidence.id], source: { kind: "manual", locator: "test:private" }, confirmedBy: 7, confirmedAt: new Date().toISOString(), audit: { action: "manual", reason: "scope" } });
    service.save({ id: "global-p1", type: "Fact", title: "global signal", statement: "global signal", details: { subject: "scope", value: "global" }, scope: { projectId: "p1", scopeType: "global", scopeKey: "global", visibility: "global" }, evidenceRefs: [evidence.id], source: { kind: "manual", locator: "test:global" }, confirmedBy: 7, confirmedAt: new Date().toISOString(), audit: { action: "manual", reason: "scope" } });
    const denied = await searchKnowledge(store, { userId: 7, projectId: "p2", query: "signal", limit: 20 });
    assert.equal(denied.results.some((item) => item.id === "private-p1"), false);
    assert.equal(denied.results.some((item) => item.id === "global-p1"), false);
    store.db.prepare("INSERT INTO knowledge_evidence_acl(evidence_id,project_id,created_at) VALUES (?,?,?)").run(evidence.id, "p2", new Date().toISOString());
    const allowed = await searchKnowledge(store, { userId: 7, projectId: "p2", query: "global signal", limit: 20 });
    assert.equal(allowed.results.some((item) => item.id === "global-p1"), true);
    assert.equal(allowed.results.find((item) => item.id === "global-p1")?.evidenceRefs.includes(evidence.id), true);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
