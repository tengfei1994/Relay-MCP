import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { RemoteCommandTimeoutError } from "../src/shared/remote-runner.ts";

test("job store records logs and cancels an active job", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-job-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/job-store.ts?test=${Date.now()}`);
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
    store.cancelJob(job.id, 7);

    const deadline = Date.now() + 2000;
    let record = store.getJob(job.id);
    while (record?.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      record = store.getJob(job.id);
    }
    assert.equal(record?.status, "cancelled");
    assert.ok(record?.logs?.some((entry) => entry.message === "Cancellation requested"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("job store marks a timed out remote operation as unknown and unsafe to retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-job-timeout-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/job-store.ts?timeout=${Date.now()}`);
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
