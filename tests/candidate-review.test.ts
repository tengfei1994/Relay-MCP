import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createKnowledgeStore, type KnowledgeStore } from "../src/knowledge/store.ts";
import { EvidenceStore } from "../src/knowledge/evidence-store.ts";
import {
  CandidateInsightCompiler,
  FALLBACK_GENERATED_BY,
  type CandidateInsight,
  type CandidateInsightProviderRequest,
  type ManagedCandidateInsightProvider,
} from "../src/knowledge/candidate-insight.ts";
import { CandidateInsightReviewService } from "../src/knowledge/candidate-review.ts";
import { CandidateInsightWorker, enqueueCandidateInsight } from "../src/knowledge/candidate-worker.ts";
import { WorkSessionService, type IntentEnvelope } from "../src/knowledge/work-session.ts";

const intent: IntentEnvelope = { actions: ["diagnose", "capture"], phase: "diagnosis", objective: "Find root cause", constraints: [], acceptanceCriteria: ["Evidence linked"], projectId: "p1", risk: "read_only", knowledgeMode: "retrieve_and_capture", actorId: 7 };

class FakeManagedProvider implements ManagedCandidateInsightProvider {
  readonly providerId = "fake-managed";
  readonly modelId = "fake-model-v1";
  constructor(private readonly handler: (prompt: string, request: CandidateInsightProviderRequest) => Promise<string> | string) {}
  complete(request: CandidateInsightProviderRequest): Promise<string> { return Promise.resolve(this.handler(request.prompt, request)); }
}

function validOutput(refs: string[]): string {
  return JSON.stringify({ kind: "fact", statement: "Root cause found", whyProposed: "Evidence supports it", evidenceRefs: refs, intentRefs: [], unknowns: [], reuseBoundary: { scope: "project" }, confidence: 0.7, confirmedFacts: ["Pump stopped"], observedBehavior: [], hypothesis: "Power supply fault" });
}

interface Fixture {
  store: KnowledgeStore;
  sessionId: string;
  evidenceId: string;
  insight: CandidateInsight;
  review: CandidateInsightReviewService;
}

function withFixture(fn: (fixture: Fixture) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "relay-insight-review-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), evidenceRoot: join(root, "evidence") });
  store.grantAcl("p1", 7, true);
  const clock = () => new Date("2026-10-23T00:00:00.000Z");
  return Promise.resolve((async () => {
    const session = new WorkSessionService(store, clock).open({ actorId: 7, idempotencyKey: randomUUID(), intent });
    const evidence = new EvidenceStore(store, store.evidenceRoot!).put({ content: Buffer.from("pump stopped at 12:00", "utf8"), mimeType: "text/plain", sourceKind: "log", projectId: "p1", locator: `test:${randomUUID()}` });
    const compiler = new CandidateInsightCompiler(store, new FakeManagedProvider(() => validOutput([evidence.id])), clock);
    const insight = await compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidence.id], context: { statement: "Root cause found" } });
    assert.equal(insight.persisted, true);
    await fn({ store, sessionId: session.id, evidenceId: evidence.id, insight, review: new CandidateInsightReviewService(store, clock) });
  })()).finally(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
}

test("Review service lists drafts with project ACL", () => withFixture(async ({ store, insight, review }) => {
  const drafts = review.listDrafts({ actorId: 7, projectId: "p1" });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].id, insight.id);
  assert.equal(review.get({ actorId: 7, id: insight.id }).status, "draft");
  assert.throws(() => review.listDrafts({ actorId: 9, projectId: "p1" }), /denied/);
  assert.throws(() => review.get({ actorId: 9, id: insight.id }), /denied/);
  store.grantAcl("p1", 9, false);
  assert.equal(review.get({ actorId: 9, id: insight.id }).id, insight.id);
}));

test("Confirm is explicit, reviewer-only, audited and idempotent", () => withFixture(async ({ store, insight, review }) => {
  store.grantAcl("p1", 8, false);
  assert.throws(() => review.confirm({ actorId: 8, id: insight.id, reason: "looks right" }), /reviewer/);
  const confirmed = review.confirm({ actorId: 7, id: insight.id, reason: "Verified against the evidence" });
  assert.equal(confirmed.status, "accepted");
  assert.equal(confirmed.reviewedBy, 7);
  const again = review.confirm({ actorId: 7, id: insight.id, reason: "Verified against the evidence" });
  assert.equal(again.status, "accepted");
  assert.equal(review.reviewHistory({ actorId: 7, id: insight.id }).length, 1);
  const audits = store.db.prepare("SELECT action FROM knowledge_audit WHERE entity_id = ? AND action = 'candidate_insight.confirm'").all(insight.id);
  assert.equal(audits.length, 1);
}));

test("Edit scans content, requires a reviewer and only applies to drafts", () => withFixture(async ({ insight, review }) => {
  const edited = review.edit({ actorId: 7, id: insight.id, patch: { statement: "Refined root cause", unknowns: ["Need a second run"] }, reason: "Reviewer refinement" });
  assert.equal(edited.status, "edited");
  assert.equal(edited.statement, "Refined root cause");
  assert.deepEqual(edited.unknowns, ["Need a second run"]);
  assert.throws(() => review.edit({ actorId: 7, id: insight.id, patch: { statement: "Set apiKey = sk-live-123 in the config" }, reason: "bad" }), /sensitive/);
  assert.equal(review.get({ actorId: 7, id: insight.id }).statement, "Refined root cause");
  assert.throws(() => review.edit({ actorId: 7, id: insight.id, patch: { evidenceRefs: ["missing-evidence"] }, reason: "bad refs" }), /Evidence/);
  review.confirm({ actorId: 7, id: insight.id, reason: "ok" });
  assert.throws(() => review.edit({ actorId: 7, id: insight.id, patch: { statement: "too late" }, reason: "bad" }), /cannot be edited/);
}));

test("Reject is terminal for confirmation and idempotent", () => withFixture(async ({ insight, review }) => {
  const rejected = review.reject({ actorId: 7, id: insight.id, reason: "Not reproducible" });
  assert.equal(rejected.status, "rejected");
  const again = review.reject({ actorId: 7, id: insight.id, reason: "Not reproducible" });
  assert.equal(again.status, "rejected");
  assert.equal(review.reviewHistory({ actorId: 7, id: insight.id }).length, 1);
  assert.throws(() => review.confirm({ actorId: 7, id: insight.id, reason: "changed my mind" }), /rejected/);
}));

test("Promotion to Case reuses the repository projection and is idempotent", () => withFixture(async ({ store, insight, review }) => {
  assert.throws(() => review.promote({ actorId: 7, id: insight.id, target: "case", reason: "premature" }), /confirmed/);
  review.confirm({ actorId: 7, id: insight.id, reason: "Verified" });
  const promotion = review.promote({ actorId: 7, id: insight.id, target: "case", reason: "Ready for the casebook" });
  assert.equal(promotion.mode, "persisted");
  assert.equal(promotion.targetId, `case-${insight.id}`);
  const document = store.db.prepare("SELECT kind, lifecycle, project_id FROM knowledge_documents WHERE id = ?").get(promotion.targetId) as Record<string, unknown>;
  assert.equal(document.kind, "case");
  assert.equal(document.lifecycle, "draft");
  const caseRow = store.db.prepare("SELECT evidence_refs_json FROM knowledge_cases WHERE id = ?").get(promotion.targetId) as { evidence_refs_json: string };
  assert.deepEqual(JSON.parse(caseRow.evidence_refs_json), [insight.evidenceRefs[0]]);
  const links = store.db.prepare("SELECT evidence_id FROM knowledge_entity_evidence WHERE entity_type = 'case' AND entity_id = ?").all(promotion.targetId);
  assert.equal(links.length, 1);
  const replay = review.promote({ actorId: 7, id: insight.id, target: "case", reason: "Ready for the casebook" });
  assert.equal(replay.targetId, promotion.targetId);
  const stored = review.get({ actorId: 7, id: insight.id });
  assert.equal((stored.promotion as { target?: string })?.target, "case");
}));

test("Promotion to Decision records explicit metadata without a store entity", () => withFixture(async ({ store, insight, review }) => {
  review.confirm({ actorId: 7, id: insight.id, reason: "Verified" });
  const promotion = review.promote({ actorId: 7, id: insight.id, target: "decision", reason: "Record the call" });
  assert.equal(promotion.mode, "metadata_only");
  assert.ok(promotion.note);
  const documents = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents").get() as { count: number };
  assert.equal(documents.count, 0);
  const stored = review.get({ actorId: 7, id: insight.id });
  assert.equal((stored.promotion as { mode?: string })?.mode, "metadata_only");
  const replay = review.promote({ actorId: 7, id: insight.id, target: "decision", reason: "Record the call" });
  assert.equal(replay.mode, "metadata_only");
  assert.equal(review.reviewHistory({ actorId: 7, id: insight.id }).filter((row) => row.action === "promote").length, 1);
}));

function withWorkerStore(fn: (store: KnowledgeStore, sessionId: string, evidenceId: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "relay-insight-worker-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), evidenceRoot: join(root, "evidence") });
  store.grantAcl("p1", 7, true);
  return Promise.resolve((async () => {
    const session = new WorkSessionService(store).open({ actorId: 7, idempotencyKey: randomUUID(), intent });
    const evidence = new EvidenceStore(store, store.evidenceRoot!).put({ content: Buffer.from("pump stopped", "utf8"), mimeType: "text/plain", sourceKind: "log", projectId: "p1", locator: `test:${randomUUID()}` });
    await fn(store, session.id, evidence.id);
  })()).finally(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
}

test("Worker enqueue is idempotent and runOnce persists the compiled insight", () => withWorkerStore(async (store, sessionId, evidenceId) => {
  const input = { actorId: 7, sessionId, evidenceRefs: [evidenceId], context: { statement: "Async compile" } };
  const first = enqueueCandidateInsight(store, input);
  const second = enqueueCandidateInsight(store, input);
  assert.equal(first.enqueued, true);
  assert.equal(second.enqueued, false);
  assert.equal(first.job.id, second.job.id);

  const compiler = new CandidateInsightCompiler(store, new FakeManagedProvider(() => validOutput([evidenceId])));
  const worker = new CandidateInsightWorker(store, compiler);
  const result = await worker.runOnce();
  assert.deepEqual(result, { claimed: 1, completed: 1, failed: 0, retried: 0 });
  const job = store.db.prepare("SELECT status, insight_id FROM knowledge_candidate_insight_jobs WHERE id = ?").get(first.job.id) as { status: string; insight_id: string };
  assert.equal(job.status, "done");
  const insight = store.db.prepare("SELECT id, generated_by FROM knowledge_candidate_insights WHERE id = ?").get(job.insight_id) as { id: string; generated_by: string };
  assert.equal(insight.generated_by, "managed-candidate-llm:fake-managed/fake-model-v1");
  const again = await worker.runOnce();
  assert.deepEqual(again, { claimed: 0, completed: 0, failed: 0, retried: 0 });
}));

test("Worker provider failure degrades to fallback without failing the job", () => withWorkerStore(async (store, sessionId, evidenceId) => {
  enqueueCandidateInsight(store, { actorId: 7, sessionId, evidenceRefs: [evidenceId], context: { statement: "Provider down" } });
  const compiler = new CandidateInsightCompiler(store, new FakeManagedProvider(() => { throw new Error("HTTP 429 rate limit"); }));
  const result = await new CandidateInsightWorker(store, compiler).runOnce();
  assert.equal(result.completed, 1);
  const row = store.db.prepare("SELECT generated_by, fallback_reason FROM knowledge_candidate_insights").get() as { generated_by: string; fallback_reason: string };
  assert.equal(row.generated_by, FALLBACK_GENERATED_BY);
  assert.equal(row.fallback_reason, "rate_limited");
}));

test("Worker retries validation failures and stops after the attempt cap", () => withWorkerStore(async (store, sessionId) => {
  const enqueued = enqueueCandidateInsight(store, { actorId: 7, sessionId, evidenceRefs: ["missing-evidence"], context: {} });
  const compiler = new CandidateInsightCompiler(store, new FakeManagedProvider(() => validOutput([])));
  const worker = new CandidateInsightWorker(store, compiler, { maxAttempts: 2 });
  const first = await worker.runOnce();
  assert.deepEqual(first, { claimed: 1, completed: 0, failed: 0, retried: 1 });
  const second = await worker.runOnce();
  assert.deepEqual(second, { claimed: 1, completed: 0, failed: 1, retried: 0 });
  const job = store.db.prepare("SELECT status, attempts, error FROM knowledge_candidate_insight_jobs WHERE id = ?").get(enqueued.job.id) as { status: string; attempts: number; error: string };
  assert.equal(job.status, "failed");
  assert.equal(job.attempts, 2);
  assert.ok(job.error.length > 0);
  const count = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_candidate_insights").get() as { count: number };
  assert.equal(count.count, 0);
}));

test("Enqueue requires session access", () => withWorkerStore(async (store, sessionId, evidenceId) => {
  assert.throws(() => enqueueCandidateInsight(store, { actorId: 9, sessionId, evidenceRefs: [evidenceId], context: {} }));
}));
