import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { captureKnowledgeCandidates, projectResolutionRetryDelay } from "../src/knowledge/capture-worker.ts";

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}

test("capture worker retries unresolved project identity then captures once resolvable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-capture-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  let now = new Date("2026-09-03T00:00:00.000Z");
  try {
    let store;
    try {
      store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), clock: () => now });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Could not locate the bindings file|better-sqlite3/i.test(message)) t.skip(`better-sqlite3 binding unavailable: ${message.split("\n")[0]}`);
      else throw error;
      return;
    }
    try {
      store.append({ id: "event-resolve", type: "job.finished", occurredAt: "2026-09-03T00:00:00.000Z", projectNameSnapshot: "Demo", jobId: "job-1", payload: { userId: 7 } });

      let failures = 0;
      assert.equal(await captureKnowledgeCandidates(store, "capture", 20, () => undefined, { onFailure: () => { failures++; } }), 0, "unresolvable project identity must not produce a candidate");
      assert.equal(failures, 1, "project resolution failures are observable through the worker hook");

      now = new Date("2026-09-03T00:00:31.000Z");
      assert.equal(await captureKnowledgeCandidates(store, "capture", 20, (actorId, projectName) => (projectName === "Demo" ? 42 : undefined)), 1, "the event is retried after the lease and becomes a candidate once resolvable");

      store.grantAcl("42", 7);
      const documents = store.listDocuments(7, "42");
      assert.equal(documents.length, 1);
      assert.equal(documents[0].kind, "candidate");
      assert.match(documents[0].locator, /^relay-event:/);
      const provenance = JSON.parse(documents[0].body) as Record<string, unknown>;
      assert.equal(provenance.eventKey, "job:job-1:finished");
      assert.equal(provenance.occurredAt, "2026-09-03T00:00:00.000Z");
      assert.equal(provenance.projectNameSnapshot, "Demo");
      assert.equal(documents[0].sha256, createHash("sha256").update(documents[0].body, "utf8").digest("hex"));
      assert.notEqual(documents[0].sha256, createHash("sha256").update("event-resolve", "utf8").digest("hex"));

      now = new Date("2026-09-03T00:01:02.000Z");
      assert.equal(store.claim("capture").length, 0, "captured events are checkpointed");
    } finally {
      store.close();
    }
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    cleanup(root);
  }
});

test("project resolution remains retryable after the ordinary poison-event limit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-capture-project-retry-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  let now = new Date("2026-09-03T00:00:00.000Z");
  try {
    let store;
    try {
      store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), clock: () => now });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Could not locate the bindings file|better-sqlite3/i.test(message)) t.skip(`better-sqlite3 binding unavailable: ${message.split("\n")[0]}`);
      else throw error;
      return;
    }
    try {
      store.append({ id: "event-project-retry", type: "job.finished", occurredAt: "2026-09-03T00:00:00.000Z", projectNameSnapshot: "Demo", jobId: "job-project-retry", payload: { userId: 7 } });
      for (let attempt = 0; attempt < 6; attempt++) {
        assert.equal(await captureKnowledgeCandidates(store, "capture", 20, () => { throw new Error("app.db unavailable"); }), 0);
        now = new Date(now.getTime() + projectResolutionRetryDelay(attempt) + 1);
      }
      assert.equal(existsSync(join(root, "knowledge-capture-dead-letter.jsonl")), false, "resolver outages must not create a poison dead-letter");
      const retry = store.claim("capture");
      assert.equal(retry.length, 1);
      assert.equal(retry[0].attempts, 6);
      store.fail(retry[0].id, new Error("still unavailable"), 1, "capture", retry[0].claimToken);
    } finally {
      store.close();
    }
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    cleanup(root);
  }
});

test("a database-level claim failure is surfaced through the capture failure hook", async () => {
  let failures = 0;
  const store = { claim: () => { throw new Error("database is locked"); } } as any;
  await assert.rejects(
    captureKnowledgeCandidates(store, "capture", 20, undefined, { onFailure: () => { failures++; } }),
    /database is locked/,
  );
  assert.equal(failures, 1);
});

test("capture worker generates candidates for interrupted terminal events", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-capture-interrupted-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  try {
    let store;
    try {
      store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Could not locate the bindings file|better-sqlite3/i.test(message)) t.skip(`better-sqlite3 binding unavailable: ${message.split("\n")[0]}`);
      else throw error;
      return;
    }
    try {
      store.append({ id: "event-job-int", type: "job.interrupted", occurredAt: "2026-09-03T00:00:00.000Z", projectId: "42", jobId: "job-int", payload: { status: "unknown", errorCategory: "relay_restart" } });
      store.append({ id: "event-deploy-int", type: "deployment.interrupted", occurredAt: "2026-09-03T00:00:00.000Z", projectId: "42", deploymentId: "deploy-int", payload: { status: "unknown", reason: "relay_restart" } });
      assert.equal(await captureKnowledgeCandidates(store, "capture", 20, () => undefined), 2, "interrupted events carry projectId and need no resolver");
    } finally {
      store.close();
    }
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    cleanup(root);
  }
});

test("capture worker generates a candidate for job cancellation events", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-capture-cancelled-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  try {
    let store;
    try {
      store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Could not locate the bindings file|better-sqlite3/i.test(message)) t.skip(`better-sqlite3 binding unavailable: ${message.split("\n")[0]}`);
      else throw error;
      return;
    }
    try {
      store.append({
        id: "event-job-cancelled",
        type: "job.cancelled",
        occurredAt: "2026-09-03T00:00:00.000Z",
        projectId: "42",
        projectNameSnapshot: "Demo",
        jobId: "job-cancelled",
        payload: { status: "cancelled", kind: "remote_command", error: "Job cancelled", phase: "cancelled", sampleManagerVersion: "21.1", solution: "PT 3.5", module: "Instrument", candidateType: "case", tags: ["cancelled", "remote"], summary: "Cancellation captured" },
      });
      assert.equal(await captureKnowledgeCandidates(store, "capture"), 1);
      store.grantAcl("42", 7);
      const documents = store.listDocuments(7, "42");
      assert.equal(documents.length, 1);
      assert.equal(documents[0].kind, "candidate");
      const projection = store.db.prepare("SELECT event_id, deployment_id, job_id, samplemanager_version, solution, module, candidate_type FROM knowledge_candidates WHERE id = ?").get(documents[0].id) as Record<string, unknown>;
      assert.equal(projection.event_id, "event-job-cancelled");
      assert.equal(projection.job_id, "job-cancelled");
      assert.equal(projection.samplemanager_version, "21.1");
      assert.equal(projection.solution, "PT 3.5");
      assert.equal(projection.module, "Instrument");
      assert.equal(projection.candidate_type, "case");
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_chunks WHERE document_id = ?").get(documents[0].id).count, 1);
      const provenance = JSON.parse(documents[0].body) as Record<string, unknown>;
      assert.equal(provenance.eventType, "job.cancelled");
      assert.equal((provenance.payload as Record<string, unknown>).status, "cancelled");
    } finally {
      store.close();
    }
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    cleanup(root);
  }
});

test("capture worker dead-letters poison events after the maximum attempts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-capture-dead-letter-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  let now = new Date("2026-09-03T00:00:00.000Z");
  try {
    let store;
    try {
      store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), clock: () => now });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Could not locate the bindings file|better-sqlite3/i.test(message)) t.skip(`better-sqlite3 binding unavailable: ${message.split("\n")[0]}`);
      else throw error;
      return;
    }
    try {
      store.append({ id: "event-poison", type: "job.finished", occurredAt: "2026-09-03T00:00:00.000Z", projectNameSnapshot: "Ghost", jobId: "job-poison", payload: { userId: 7 } });
      for (let attempt = 1; attempt <= 5; attempt++) {
        const claimed = store.claim("capture");
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0].attempts, attempt - 1);
        store.fail(claimed[0].id, new Error("transient failure"), 1000, "capture", claimed[0].claimToken);
        now = new Date(now.getTime() + 40_000);
      }
      assert.equal(await captureKnowledgeCandidates(store, "capture", 20, (actorId, projectName) => 1), 0, "a poison event must stop retrying at the attempt cap");
      const deadLetter = readFileSync(join(root, "knowledge-capture-dead-letter.jsonl"), "utf8");
      assert.match(deadLetter, /"event-poison"/);
      assert.match(deadLetter, /max attempts exceeded/);
      now = new Date(now.getTime() + 40_000);
      assert.equal(store.claim("capture").length, 0, "dead-lettered events are checkpointed out of the queue");
    } finally {
      store.close();
    }
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    cleanup(root);
  }
});

test("a permanently missing project is dead-lettered after finite retries", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-capture-project-missing-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  let now = new Date("2026-09-03T00:00:00.000Z");
  try {
    let store;
    try {
      store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), clock: () => now });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Could not locate the bindings file|better-sqlite3/i.test(message)) t.skip(`better-sqlite3 binding unavailable: ${message.split("\n")[0]}`);
      else throw error;
      return;
    }
    try {
      store.append({
        id: "event-project-missing",
        type: "job.finished",
        occurredAt: "2026-09-03T00:00:00.000Z",
        projectNameSnapshot: "DeletedProject",
        jobId: "job-project-missing",
        payload: { userId: 7, status: "succeeded" },
      });
      for (let attempt = 0; attempt <= 5; attempt++) {
        assert.equal(await captureKnowledgeCandidates(store, "capture", 20, () => undefined), 0);
        if (attempt < 5) now = new Date(now.getTime() + 40_000);
      }
      const deadLetter = readFileSync(join(root, "knowledge-capture-dead-letter.jsonl"), "utf8");
      assert.match(deadLetter, /"event-project-missing"/);
      assert.match(deadLetter, /project resolution not found/);
      assert.equal(store.claim("capture").length, 0, "the permanently missing project is checkpointed after dead-lettering");
    } finally {
      store.close();
    }
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    cleanup(root);
  }
});

test("a project snapshot without actor identity is dead-lettered instead of retrying forever", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-capture-project-no-actor-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  let now = new Date("2026-09-03T00:00:00.000Z");
  try {
    let store;
    try {
      store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), clock: () => now });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Could not locate the bindings file|better-sqlite3/i.test(message)) t.skip(`better-sqlite3 binding unavailable: ${message.split("\n")[0]}`);
      else throw error;
      return;
    }
    try {
      store.append({
        id: "event-project-no-actor",
        type: "job.finished",
        occurredAt: "2026-09-03T00:00:00.000Z",
        projectNameSnapshot: "NameOnlyProject",
        jobId: "job-project-no-actor",
        payload: { status: "succeeded" },
      });
      for (let attempt = 0; attempt <= 5; attempt++) {
        assert.equal(
          await captureKnowledgeCandidates(store, "capture", 20, () => {
            throw new Error("the resolver must not be called without actor identity");
          }),
          0,
        );
        if (attempt < 5) now = new Date(now.getTime() + 40_000);
      }
      const deadLetter = readFileSync(join(root, "knowledge-capture-dead-letter.jsonl"), "utf8");
      assert.match(deadLetter, /"event-project-no-actor"/);
      assert.match(deadLetter, /project resolution not found/);
      assert.equal(store.claim("capture").length, 0);
    } finally {
      store.close();
    }
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    cleanup(root);
  }
});
