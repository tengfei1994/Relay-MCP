import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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
