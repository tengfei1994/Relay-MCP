import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentOfflineError, AgentStore } from "../src/shared/agent-store.ts";

test("agent store shares heartbeat, queue, claim, and result state", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-agent-store-"));
  const dbPath = join(root, "app.db");
  let producer: AgentStore;
  let consumer: AgentStore;
  try {
    producer = new AgentStore(dbPath);
    consumer = new AgentStore(dbPath);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    t.skip(`better-sqlite3 binding unavailable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return;
  }
  try {
    const state = consumer.heartbeat({
      userId: 7,
      username: "tester",
      agentId: "HKJC_Demo",
      machine: "HKJC",
    });
    assert.equal(producer.assertOnline(7, "hkjc_demo").machine, "HKJC");
    assert.ok(state.lastSeenAt);

    const queued = producer.enqueueJob(7, "HKJC_Demo", "powershell", { script: "Get-Date" }, 5000);
    const claimed = consumer.claimNextJob(7, "hkjc_demo");
    assert.equal(claimed?.id, queued.id);
    assert.equal(claimed?.payload.script, "Get-Date");

    consumer.completeJob(7, "HKJC_Demo", queued.id, {
      status: "completed",
      exitCode: 0,
      stdout: "done",
    });
    const completed = await producer.waitForJob(queued.id, 1000);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.stdout, "done");
  } finally {
    producer.close();
    consumer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent store distinguishes a missing heartbeat from a missing project link", (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-agent-offline-"));
  let store: AgentStore;
  try {
    store = new AgentStore(join(root, "app.db"));
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    t.skip(`better-sqlite3 binding unavailable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return;
  }
  try {
    assert.throws(
      () => store.assertOnline(3, "never-seen"),
      (error: unknown) => error instanceof AgentOfflineError && /never checked in/.test(error.message)
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
