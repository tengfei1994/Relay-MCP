import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { RemoteCommandTimeoutError } from "../src/shared/remote-runner.ts";
import { readFileSync } from "fs";
import { summarizeExec } from "../src/shared/output.ts";

test("job store records logs and cancels an active job", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-job-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/job-store.ts?test=${Date.now()}`);
    const events: any[] = [];
    store.configureJobStore({ eventSink: { append: (event: any) => events.push(event) } });
    const job = store.startJob(
      { id: 7, username: "tester" },
      "project",
      "test_job",
      {},
      async ({ signal, log }) => {
        log("working");
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return "done";
      }
    );
    assert.ok(store.getJob(job.id)?.startedEventEmittedAt, "the started event marker is persisted after the spool accepts the event");
    store.cancelJob(job.id, 7, "operator requested cancellation");

    const deadline = Date.now() + 2000;
    let record = store.getJob(job.id);
    while (record?.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      record = store.getJob(job.id);
    }
    assert.equal(record?.status, "cancelled");
    assert.ok(record?.logs?.some((entry) => entry.message === "Cancellation requested"));
    const eventDeadline = Date.now() + 1000;
    while (!events.some((event) => event.type === "job.cancelled") && Date.now() < eventDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cancelledEvent = events.find((event) => event.type === "job.cancelled");
    assert.ok(cancelledEvent);
    assert.equal(cancelledEvent.payload.cancelReason, "operator requested cancellation");
    store.configureJobStore({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeAudit sanitizes credentials written by internal tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-audit-sanitized-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/job-store.ts?audit-sanitized=${Date.now()}`);
    store.writeAudit({ tool: "exec_remote", command: "curl --token=top-secret", connectionString: "Server=db;Password=hidden" });
    const audit = readFileSync(join(root, "audit.jsonl"), "utf8");
    assert.doesNotMatch(audit, /top-secret|hidden/);
    assert.match(audit, /\"redacted\":true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("job store marks a timed out remote operation as unknown and unsafe to retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-job-timeout-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/job-store.ts?timeout=${Date.now()}`);
    const events: any[] = [];
    store.configureJobStore({ eventSink: { append: (event: any) => events.push(event) } });
    const job = store.startJob(
      { id: 8, username: "tester" },
      "project",
      "timeout_job",
      {},
      async () => {
        throw new RemoteCommandTimeoutError(10);
      }
    );
    const deadline = Date.now() + 2000;
    let record = store.getJob(job.id);
    while (record?.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      record = store.getJob(job.id);
    }
    assert.equal(record?.status, "unknown");
    assert.equal(record?.errorCategory, "timeout");
    assert.equal(record?.retrySafe, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const event = events.find((candidate) => candidate.type === "job.unknown" && candidate.eventKey === `job:${job.id}:unknown`);
    assert.ok(event);
    assert.equal(event.payload.status, "unknown");
    assert.equal(event.payload.errorCategory, "timeout");
    assert.equal(event.payload.phase, "unknown");
    assert.equal(event.payload.retrySafe, false);
    assert.match(event.payload.error, /timed out/);
    store.configureJobStore({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("job store waits for terminal state without throwing on wait timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-job-wait-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/job-store.ts?wait=${Date.now()}`);
    assert.equal(typeof store.waitForJobRecord, "function");
    const job = store.startJob(
      { id: 9, username: "tester" },
      "project",
      "wait_job",
      {},
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return "done";
      }
    );

    const timed = await store.waitForJobRecord(job.id, 9, { waitMs: 10, pollMs: 5 });
    assert.equal(timed.reason, "wait_timeout");
    assert.equal(timed.job.status, "running");

    const completed = await store.waitForJobRecord(job.id, 9, { waitMs: 1000, pollMs: 10 });
    assert.equal(completed.reason, "terminal");
    assert.equal(completed.job.status, "succeeded");
    assert.equal(completed.job.summary, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("job store persists structured error evidence in a failed job summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-job-evidence-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/job-store.ts?evidence=${Date.now()}`);
    const events: any[] = [];
    store.configureJobStore({ eventSink: { append: (event: any) => events.push(event) } });
    const failure = Object.assign(new Error("Restart failed: SM22.Queue"), {
      evidence: {
        instance: "SM22",
        failure: { stage: "start", service: "SM22.Queue" },
        failedServices: [{ service: "SM22.Queue", desiredState: "Running", lastState: "Stopped" }],
      },
    });
    const job = store.startJob(
      { id: 10, username: "tester" },
      "project",
      "restart_job",
      {},
      async () => { throw failure; }
    );
    const deadline = Date.now() + 2000;
    let record = store.getJob(job.id);
    while (record?.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      record = store.getJob(job.id);
    }
    assert.equal(record?.status, "failed");
    assert.equal(record?.error, "Restart failed: SM22.Queue");
    assert.deepEqual(JSON.parse(record?.summary ?? "{}"), failure.evidence);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const event = events.find((candidate) => candidate.type === "job.failed" && candidate.jobId === job.id);
    assert.ok(event);
    assert.equal(event.payload.error, "Restart failed: SM22.Queue");
    assert.equal(event.payload.phase, "failed");
    assert.equal(event.payload.retrySafe, true);
    assert.deepEqual(JSON.parse(event.payload.summary), failure.evidence);
    store.configureJobStore({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("job terminal events expose streams embedded in execution summaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-job-structured-output-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/job-store.ts?structured-output=${Date.now()}`);
    const events: any[] = [];
    store.configureJobStore({ eventSink: { append: (event: any) => events.push(event) } });
    const job = store.startJob(
      { id: 13, username: "tester" },
      "project",
      "exec_remote_script",
      {},
      async () => summarizeExec("powershell -File <remote script>", { stdout: "observed output", stderr: "", code: 0 }),
    );
    const completed = await store.waitForJobRecord(job.id, 13, { waitMs: 2000, pollMs: 10 });
    assert.equal(completed.job.status, "succeeded");
    const event = events.find((candidate) => candidate.type === "job.finished" && candidate.jobId === job.id);
    assert.ok(event);
    assert.equal(event.payload.stdout, "observed output");
    assert.equal(event.payload.exitCode, 0);
    assert.equal("stderr" in event.payload, false, "empty stderr should not be persisted as a signal");
    store.configureJobStore({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("job store emits a bounded, sanitized retry event and rejects non-finite attempt metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-job-retry-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/job-store.ts?retry=${Date.now()}`);
    const events: any[] = [];
    store.configureJobStore({ eventSink: { append: (event: any) => events.push(event) } });
    const retry = store.startJob(
      { id: 12, username: "tester" },
      "project",
      "retry_job",
      {},
      async () => "retried",
      { retryOf: "job-original", retryAttempt: Number.NaN, retryReason: "token=top-secret\n" + "x".repeat(5000) },
    );

    assert.equal(retry.retryOf, "job-original");
    assert.equal(retry.retryAttempt, 2, "NaN must fall back to a valid attempt number");
    assert.ok((retry.retryReason?.length ?? 0) <= 2_000);
    const completed = await store.waitForJobRecord(retry.id, 12, { waitMs: 2000, pollMs: 10 });
    assert.equal(completed.job.status, "succeeded");

    const deadline = Date.now() + 1000;
    while (!events.some((event) => event.type === "job.retry") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const event = events.find((candidate) => candidate.type === "job.retry");
    assert.ok(event);
    assert.equal(event.payload.retryOf, "job-original");
    assert.equal(event.payload.retryAttempt, 2);
    assert.deepEqual(event.payload.retryReason, { redacted: true, length: retry.retryReason?.length });
    assert.ok(Buffer.byteLength(JSON.stringify(event.payload), "utf8") < 10_000);
    store.configureJobStore({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("job store preserves timeout semantics for structured restart errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-job-timeout-evidence-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/job-store.ts?timeout-evidence=${Date.now()}`);
    const evidence = { instance: "SM22", failure: { stage: "start", service: "SM22.Queue" } };
    const timeout = Object.assign(new Error("Restart timed out while starting SM22.Queue"), {
      category: "timeout",
      evidence,
    });
    const job = store.startJob(
      { id: 11, username: "tester" },
      "project",
      "restart_timeout_job",
      {},
      async () => { throw timeout; }
    );
    const deadline = Date.now() + 2000;
    let record = store.getJob(job.id);
    while (record?.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      record = store.getJob(job.id);
    }
    assert.equal(record?.status, "unknown");
    assert.equal(record?.errorCategory, "timeout");
    assert.equal(record?.retrySafe, false);
    assert.deepEqual(JSON.parse(record?.summary ?? "{}"), evidence);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restarted Relay marks running jobs unknown and spools a job.interrupted event exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-job-restart-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    // Seed a job that was still running when the previous Relay process died.
    mkdirSync(join(root, "jobs"), { recursive: true });
    writeFileSync(join(root, "jobs", "job-interrupted.json"), JSON.stringify({
      id: "job-interrupted",
      userId: 7,
      username: "tester",
      project: "PT35",
      kind: "exec_remote",
      status: "running",
      phase: "running",
      startedAt: "2026-09-03T00:00:00.000Z",
      logs: [],
    }), "utf8");

    // A fresh module scan marks the job on load (before any sink is configured).
    const restarted = await import(`../src/shared/job-store.ts?restart=${Date.now()}`);
    const recovered = restarted.getJob("job-interrupted");
    assert.equal(recovered?.status, "unknown");
    assert.equal(recovered?.phase, "unknown");
    assert.equal(recovered?.errorCategory, "relay_restart");
    assert.equal(recovered?.retrySafe, false);
    assert.ok(recovered?.finishedAt);

    // A second restart must not duplicate the recovery or the event.
    await import(`../src/shared/job-store.ts?restart-again=${Date.now()}`);

    const { drainRelayEventSpool } = await import("../src/knowledge/event-sink.ts");
    const drained: any[] = [];
    drainRelayEventSpool({ append: (event: any) => drained.push(event) });
    const interrupted = drained.filter((event) => event.type === "job.interrupted" && event.jobId === "job-interrupted");
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0].eventKey, "job:job-interrupted:interrupted");
    assert.equal(interrupted[0].projectNameSnapshot, "PT35");
    assert.equal(interrupted[0].actorId, 7);
    assert.equal(interrupted[0].payload.errorCategory, "relay_restart");
    const started = drained.filter((event) => event.type === "job.started" && event.jobId === "job-interrupted");
    assert.equal(started.length, 1, "a running record without a started marker is compensated before interruption");
    assert.equal(started[0].occurredAt, "2026-09-03T00:00:00.000Z", "started-event replay keeps the original startedAt");
    assert.ok(recovered?.startedEventEmittedAt, "startup compensation persists the started-event marker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup compensation re-emits an unmarked terminal job event with immutable provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-job-terminal-compensation-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/job-store.ts?terminal-compensation=${Date.now()}`);
    const finishedAt = "2026-09-03T12:34:56.000Z";
    store.saveJob({
      id: "job-terminal-gap",
      userId: 7,
      username: "tester",
      project: "PT35",
      projectIdSnapshot: "77",
      kind: "exec_remote",
      status: "failed",
      terminalEventKind: "failed",
      errorCategory: "remote_exit",
      error: "remote command failed",
      retrySafe: false,
      input: { command: "safe metadata" },
      startedAt: "2026-09-03T12:34:00.000Z",
      finishedAt,
      logs: [],
    });

    const events: any[] = [];
    store.configureJobStore({ eventSink: { append: (event: any) => events.push(event) } });
    const marked = store.getJob("job-terminal-gap");
    assert.ok(marked?.terminalEventEmittedAt, "the event marker is written only after the spool accepts the event");

    const { drainRelayEventSpool } = await import("../src/knowledge/event-sink.ts");
    drainRelayEventSpool({ append: (event: any) => events.push(event) });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "job.failed");
    assert.equal(events[0].eventKey, "job:job-terminal-gap:failed");
    assert.equal(events[0].occurredAt, finishedAt);
    assert.equal(events[0].projectId, "77");

    // Reconfiguration/restart sees the marker and does not enqueue a second
    // immutable event.
    store.configureJobStore({ eventSink: { append: (event: any) => events.push(event) } });
    drainRelayEventSpool({ append: (event: any) => events.push(event) });
    assert.equal(events.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
