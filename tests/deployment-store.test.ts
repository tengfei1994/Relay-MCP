import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

test("deployment store records commits and rollback state", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-deploy-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/deployment-store.ts?test=${Date.now()}`);
    const started = store.startDeployment({
      userId: 7,
      username: "tester",
      project: "demo",
      environment: "production",
      host: "server",
      branch: "main",
      rollbackRequested: true,
    });
    const finished = store.finishDeployment(started.id, {
      status: "succeeded",
      commitBefore: "a",
      commitAfter: "b",
      rollback: { requested: true, attempted: false, status: "not-needed" },
    });
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.commitAfter, "b");
    assert.equal(store.getDeployment(started.id)?.rollback.status, "not-needed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
