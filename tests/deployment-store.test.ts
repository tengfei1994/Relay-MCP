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

    const updated = store.updateDeployment(started.id, {
      steps: [{ name: "deploy", status: "succeeded", summary: "hash verified" }],
      artifacts: { sha256: "abc", backupPath: "C:\\backup.dll" },
    });
    assert.equal(updated.steps?.[0].status, "succeeded");
    assert.equal(updated.artifacts?.sha256, "abc");

    const merged = store.updateDeployment(started.id, {
      artifacts: { deployedTarget: "C:\\SolutionAssemblies\\sample.dll" },
    });
    assert.equal(merged.artifacts?.sha256, "abc");
    assert.equal(merged.artifacts?.backupPath, "C:\\backup.dll");
    assert.equal(merged.artifacts?.deployedTarget, "C:\\SolutionAssemblies\\sample.dll");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment store validates an existing running deployment for reuse", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-deploy-reuse-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/deployment-store.ts?reuse=${Date.now()}`);
    assert.equal(typeof store.requireRunningDeployment, "function");
    const started = store.startDeployment({
      userId: 7,
      username: "tester",
      project: "PT35",
      environment: "Demo",
      host: "server-1",
      kind: "samplemanager-change-set",
      instance: "VGSM",
      steps: [{ name: "sql", status: "succeeded" }],
      rollbackRequested: true,
    });

    const reused = store.requireRunningDeployment(started.id, {
      userId: 7,
      project: "PT35",
      environment: "demo",
      instance: "vgsm",
    });
    assert.equal(reused.id, started.id);
    assert.equal(reused.steps?.[0].name, "sql");
    assert.throws(() => store.requireRunningDeployment(started.id, {
      userId: 7,
      project: "PT35",
      environment: "production",
      instance: "VGSM",
    }), /environment/i);

    const instanceLess = store.startDeployment({
      userId: 7,
      username: "tester",
      project: "PT35",
      environment: "Demo",
      host: "server-1",
      rollbackRequested: false,
    });
    assert.throws(() => store.requireRunningDeployment(instanceLess.id, {
      userId: 7,
      project: "PT35",
      environment: "Demo",
      instance: "VGSM",
    }), /instance/i);

    store.finishDeployment(started.id, {
      status: "succeeded",
      rollback: { requested: true, attempted: false, status: "not-needed" },
    });
    assert.throws(() => store.requireRunningDeployment(started.id, {
      userId: 7,
      project: "PT35",
      environment: "Demo",
      instance: "VGSM",
    }), /cannot accept/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment timeout disposition is unknown and never permits automatic rollback", async () => {
  const store = await import(`../src/shared/deployment-store.ts?disposition=${Date.now()}`);
  const disposition = store.deploymentFailureDisposition(
    Object.assign(new Error("agent timed out"), { category: "timeout" }),
    { rollbackRequested: true, backupAvailable: true }
  );
  assert.deepEqual(disposition, {
    status: "unknown",
    stepStatus: "unknown",
    rollbackAllowed: false,
    retrySafe: false,
    category: "timeout",
  });
});

test("deployment operation artifacts append history while compatibility fields track latest evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-deploy-history-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/deployment-store.ts?history=${Date.now()}`);
    const started = store.startDeployment({
      userId: 7,
      username: "tester",
      project: "PT35",
      environment: "Demo",
      host: "server-1",
      instance: "VGSM",
      rollbackRequested: true,
      artifacts: {
        sha256: "old-hash",
        operations: [{ id: "op-1", status: "failed", rollback: { status: "succeeded", backupPath: "old.bak" } }],
      },
    });

    store.appendDeploymentOperationArtifact(started.id, {
      id: "op-2",
      status: "succeeded",
      deploy: { sha256: "new-hash", backupPath: "new.bak" },
      rollback: { status: "not-needed" },
    }, { sha256: "new-hash", backupPath: "new.bak" });

    const artifacts = store.getDeployment(started.id)?.artifacts as any;
    assert.equal(artifacts.operations.length, 2);
    assert.equal(artifacts.operations[0].rollback.backupPath, "old.bak");
    assert.equal(artifacts.operations[1].deploy.sha256, "new-hash");
    assert.equal(artifacts.sha256, "new-hash");
    assert.equal(artifacts.backupPath, "new.bak");
    assert.equal(store.getDeployment(started.id)?.rollback.status, "not-needed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
