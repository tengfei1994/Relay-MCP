import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { WorkSessionService, type IntentEnvelope } from "../src/knowledge/work-session.ts";

const intent: IntentEnvelope = {
  actions: ["understand", "diagnose", "verify"], phase: "explore", objective: "Trace the failed form", desiredOutcome: "A verified root cause", constraints: ["read only"], acceptanceCriteria: ["Evidence is linked"], projectId: "p1", environment: "test", sampleManagerVersion: "21.3", risk: "read_only", knowledgeMode: "retrieve_and_capture", actorId: 7,
};

function withStore(fn: (service: WorkSessionService, store: ReturnType<typeof createKnowledgeStore>) => void): void {
  const root = mkdtempSync(join(tmpdir(), "relay-session-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try { store.grantAcl("p1", 7, true); fn(new WorkSessionService(store, () => new Date("2026-10-23T00:00:00.000Z")), store); } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

test("Work Session validates IntentEnvelope and open is idempotent", () => {
  withStore((service) => {
    const first = service.open({ actorId: 7, idempotencyKey: "open-1", intent });
    const second = service.open({ actorId: 7, idempotencyKey: "open-1", intent: { ...intent, objective: "different" } });
    assert.equal(first.id, second.id);
    assert.equal(first.intent.objective, "Trace the failed form");
    assert.equal(first.status, "open");
  });
});

test("Work Session rejects invalid intent and cross-project access", () => {
  withStore((service) => {
    assert.throws(() => service.open({ actorId: 7, idempotencyKey: "bad", intent: { ...intent, actions: ["unknown"] as never } }), /actions/i);
    assert.throws(() => service.open({ actorId: 8, idempotencyKey: "x", intent: { ...intent, actorId: 8 } }), /access/i);
  });
});

test("Work Session update, close, and event correlation are durable and idempotent", () => {
  withStore((service, store) => {
    const session = service.open({ actorId: 7, idempotencyKey: "open-2", intent });
    const updated = service.update({ actorId: 7, sessionId: session.id, idempotencyKey: "update-1", patch: { phase: "validation", summary: "Validated in test" } });
    assert.equal(updated.status, "active");
    const closed = service.close({ actorId: 7, sessionId: session.id, idempotencyKey: "close-1", result: { summary: "done", unknowns: [], acceptanceResults: { "Evidence is linked": true } } });
    assert.equal(closed.status, "completed");
    assert.equal(service.close({ actorId: 7, sessionId: session.id, idempotencyKey: "close-1", result: { summary: "changed" } }).id, session.id);
    service.correlateEvent({ actorId: 7, sessionId: session.id, eventId: "event-1", eventType: "job.finished", intentStep: "verify" });
    service.correlateEvent({ actorId: 7, sessionId: session.id, eventId: "event-1", eventType: "job.finished", intentStep: "verify" });
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_work_session_events WHERE session_id=?").get(session.id) as any).count, 1);
    assert.equal(service.get({ actorId: 7, sessionId: session.id }).status, "completed");
  });
});

const clock = () => new Date("2026-10-23T00:00:00.000Z");

function auditCount(store: ReturnType<typeof createKnowledgeStore>, action: string, entityId: string): number {
  return (store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_audit WHERE action=? AND entity_id=?").get(action, entityId) as { count: number }).count;
}

test("Work Session open replay and racing connections never duplicate the effective audit", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-session-race-"));
  const dbPath = join(root, "knowledge.db");
  const storeA = createKnowledgeStore({ dbPath });
  try {
    storeA.grantAcl("p1", 7, true);
    const storeB = createKnowledgeStore({ dbPath });
    try {
      const a = new WorkSessionService(storeA, clock);
      const b = new WorkSessionService(storeB, clock);
      const first = a.open({ actorId: 7, idempotencyKey: "race-open", intent });
      const second = b.open({ actorId: 7, idempotencyKey: "race-open", intent: { ...intent, objective: "racing writer" } });
      assert.equal(second.id, first.id);
      assert.equal(second.intent.objective, "Trace the failed form");
      assert.equal(auditCount(storeA, "knowledge.work_session.open", first.id), 1);

      const c1 = a.close({ actorId: 7, sessionId: first.id, idempotencyKey: "race-close", result: { summary: "winner" } });
      const c2 = b.close({ actorId: 7, sessionId: first.id, idempotencyKey: "race-close", result: { summary: "loser" } });
      assert.equal(c1.status, "completed");
      assert.equal(c2.status, "completed");
      assert.equal(c2.summary, "winner");
      assert.equal(auditCount(storeA, "knowledge.work_session.close", first.id), 1);
    } finally {
      storeB.close();
    }
  } finally {
    storeA.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Work Session update is replay-safe through persisted idempotency records", () => {
  withStore((service, store) => {
    const session = service.open({ actorId: 7, idempotencyKey: "upd-0", intent });
    const updated = service.update({ actorId: 7, sessionId: session.id, idempotencyKey: "upd-1", patch: { phase: "diagnosis", summary: "Investigating" } });
    assert.equal(updated.status, "active");
    assert.equal(updated.intent.phase, "diagnosis");
    const replay = service.update({ actorId: 7, sessionId: session.id, idempotencyKey: "upd-1", patch: { phase: "closure", summary: "Forged replay" } });
    assert.equal(replay.intent.phase, "diagnosis", "a replayed key returns the original mutation");
    assert.equal(auditCount(store, "knowledge.work_session.update", session.id), 1);
    // A no-op patch without a key also avoids another effective audit entry.
    const noop = service.update({ actorId: 7, sessionId: session.id, patch: { phase: "diagnosis", summary: "Investigating" } });
    assert.equal(noop.intent.phase, "diagnosis");
    assert.equal(auditCount(store, "knowledge.work_session.update", session.id), 1);
    // Restart recovery: a fresh service on the same store still honours the persisted op log.
    const recovered = new WorkSessionService(store, clock);
    const afterRestart = recovered.update({ actorId: 7, sessionId: session.id, idempotencyKey: "upd-1", patch: { phase: "closure" } });
    assert.equal(afterRestart.intent.phase, "diagnosis");
    assert.equal(auditCount(store, "knowledge.work_session.update", session.id), 1);
  });
});

test("Work Session close is replay-safe and cannot be completed via update", () => {
  withStore((service, store) => {
    const session = service.open({ actorId: 7, idempotencyKey: "close-0", intent });
    assert.throws(() => service.update({ actorId: 7, sessionId: session.id, patch: { status: "completed" } }), /close operation/);
    const closed = service.close({ actorId: 7, sessionId: session.id, idempotencyKey: "close-key", result: { summary: "done" } });
    assert.equal(closed.status, "completed");
    const replay = service.close({ actorId: 7, sessionId: session.id, idempotencyKey: "close-key", result: { summary: "changed" } });
    assert.equal(replay.summary, "done");
    assert.equal(auditCount(store, "knowledge.work_session.close", session.id), 1);
    // Terminal sessions ignore further updates without audit noise.
    const untouched = service.update({ actorId: 7, sessionId: session.id, patch: { phase: "closure" } });
    assert.equal(untouched.status, "completed");
    assert.equal(auditCount(store, "knowledge.work_session.update", session.id), 0);
  });
});

test("Work Session enforces ACL revocation, foreign sessions, and scoped listing", () => {
  withStore((service, store) => {
    store.grantAcl("p1", 8, false);
    const mine = service.open({ actorId: 7, idempotencyKey: "acl-1", intent });
    const foreign = service.open({ actorId: 8, idempotencyKey: "acl-2", intent: { ...intent, actorId: 8 } });
    assert.throws(() => service.get({ actorId: 7, sessionId: foreign.id }), /not found/i);
    assert.throws(() => service.close({ actorId: 7, sessionId: foreign.id }), /not found/i);
    assert.deepEqual(service.list({ actorId: 7 }).map((s) => s.id), [mine.id]);

    // Revoke read access: every subsequent read or mutation is denied.
    store.db.prepare("UPDATE knowledge_acl SET can_read=0 WHERE project_id='p1' AND user_id=7").run();
    assert.throws(() => service.get({ actorId: 7, sessionId: mine.id }), /access denied/i);
    assert.throws(() => service.update({ actorId: 7, sessionId: mine.id, patch: { phase: "closure" } }), /access denied/i);
    assert.throws(() => service.close({ actorId: 7, sessionId: mine.id }), /access denied/i);
    assert.deepEqual(service.list({ actorId: 7 }), []);
    assert.throws(() => service.open({ actorId: 7, idempotencyKey: "acl-3", intent }), /access denied/i);
  });
});

test("high-risk intents without scope open as needs_clarification until satisfied", () => {
  withStore((service) => {
    const risky: IntentEnvelope = { ...intent, risk: "production", acceptanceCriteria: [], constraints: [] };
    const session = service.open({ actorId: 7, idempotencyKey: "risk-1", intent: risky });
    assert.equal(session.status, "needs_clarification");
    const clarified = service.update({ actorId: 7, sessionId: session.id, patch: { acceptanceCriteria: ["Rollback verified"], constraints: ["change window"] } });
    assert.equal(clarified.status, "active");
  });
});

test("sensitive fields and hidden reasoning are rejected instead of persisted", () => {
  withStore((service) => {
    const session = service.open({ actorId: 7, idempotencyKey: "sec-1", intent });
    assert.throws(() => service.update({ actorId: 7, sessionId: session.id, patch: { reasoning: "hidden chain" } as never }), /never persisted/);
    assert.throws(() => service.update({ actorId: 7, sessionId: session.id, patch: { chainOfThought: ["step"] } as never }), /never persisted/);
    assert.throws(() => service.close({ actorId: 7, sessionId: session.id, result: { acceptanceResults: { thinking: true } } }), /never persisted/);
    const stored = service.get({ actorId: 7, sessionId: session.id });
    assert.equal(JSON.stringify(stored).includes("hidden chain"), false);
  });
});

test("assertSessionUsable enforces actor, project, environment and lifecycle scope", () => {
  withStore((service) => {
    const session = service.open({ actorId: 7, idempotencyKey: "use-1", intent });
    assert.equal(service.assertSessionUsable({ actorId: 7, sessionId: session.id, projectId: "p1", environment: "test" }).id, session.id);
    assert.throws(() => service.assertSessionUsable({ actorId: 8, sessionId: session.id }), /not found/i);
    assert.throws(() => service.assertSessionUsable({ actorId: 7, sessionId: session.id, projectId: "other" }), /project does not match/i);
    assert.throws(() => service.assertSessionUsable({ actorId: 7, sessionId: session.id, environment: "prod" }), /environment does not match/i);
    service.close({ actorId: 7, sessionId: session.id });
    assert.throws(() => service.assertSessionUsable({ actorId: 7, sessionId: session.id }), /closed/i);
  });
});

test("summarize returns a time-ordered aggregation of correlated events", () => {
  withStore((service) => {
    const session = service.open({ actorId: 7, idempotencyKey: "sum-1", intent });
    service.correlateEvent({ actorId: 7, sessionId: session.id, eventId: "e-1", eventType: "job.started", intentStep: "diagnose" });
    service.correlateEvent({ actorId: 7, sessionId: session.id, eventId: "e-2", eventType: "job.finished", intentStep: "verify" });
    const summary = service.summarize({ actorId: 7, sessionId: session.id });
    assert.deepEqual(summary.eventCounts, { "job.started": 1, "job.finished": 1 });
    assert.deepEqual(summary.events.map((event) => event.event_id), ["e-1", "e-2"]);
  });
});
