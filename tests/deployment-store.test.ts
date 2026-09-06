import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
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
    assert.ok(store.getDeployment(started.id)?.startedEventEmittedAt, "the started event marker is persisted after the spool accepts the event");
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
      target: {
        projectServerId: 11,
        serverId: 1,
        serverName: "PT35 Demo",
        connectionMode: "agent",
        instanceRoot: "C:\\Thermo\\SampleManager\\Server\\VGSM",
        databaseHost: "localhost\\SQLEXPRESS",
        databaseName: "VGSM",
      },
      steps: [{ name: "sql", status: "succeeded" }],
      rollbackRequested: true,
    });

    const reused = store.requireRunningDeployment(started.id, {
      userId: 7,
      project: "PT35",
      environment: "demo",
      instance: "vgsm",
      projectServerId: 11,
      serverId: 1,
      databaseHost: "localhost\\SQLEXPRESS",
      databaseName: "VGSM",
    });
    assert.equal(reused.id, started.id);
    assert.equal(reused.steps?.[0].name, "sql");
    assert.throws(() => store.requireRunningDeployment(started.id, {
      userId: 7,
      project: "PT35",
      environment: "production",
      instance: "VGSM",
      projectServerId: 11,
      serverId: 1,
      databaseHost: "localhost\\SQLEXPRESS",
      databaseName: "VGSM",
    }), /environment/i);
    assert.throws(() => store.requireRunningDeployment(started.id, {
      userId: 7,
      project: "PT35",
      environment: "Demo",
      instance: "VGSM",
      projectServerId: 11,
      serverId: 2,
      databaseHost: "localhost\\SQLEXPRESS",
      databaseName: "VGSM",
    }), /serverId/i);
    assert.throws(() => store.requireRunningDeployment(started.id, {
      userId: 7,
      project: "PT35",
      environment: "Demo",
      instance: "VGSM",
      projectServerId: 12,
      serverId: 1,
      databaseHost: "localhost\\SQLEXPRESS",
      databaseName: "VGSM",
    }), /server link/i);

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
      projectServerId: 11,
      serverId: 1,
      databaseHost: "localhost\\SQLEXPRESS",
      databaseName: "VGSM",
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

test("deployment lifecycle emits started, terminal, and rolled_back domain events", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-deploy-events-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/deployment-store.ts?events=${Date.now()}`);
    const events: any[] = [];
    store.configureDeploymentStore({ eventSink: { append: (event: any) => events.push(event) }, resolveProjectId: () => 77 });

    const started = store.startDeployment({
      userId: 7,
      username: "tester",
      project: "PT35",
      environment: "Demo",
      host: "server-1",
      instance: "VGSM",
      rollbackRequested: true,
    });
    store.finishDeployment(started.id, {
      status: "failed",
      error: "assembly load failed",
      rollback: { requested: true, attempted: true, status: "succeeded", commit: "abc123" },
    });

    // Events travel through the failure-isolated spool; flush it synchronously
    // so the assertions do not depend on the scheduled async drain.
    const { drainRelayEventSpool } = await import("../src/knowledge/event-sink.ts");
    drainRelayEventSpool({ append: (event: any) => events.push(event) });

    assert.deepEqual(events.map((event) => event.type), ["deployment.started", "deployment.failed", "deployment.rolled_back"]);
    const [startedEvent, failedEvent, rolledBackEvent] = events;
    assert.equal(startedEvent.eventKey, `deployment:${started.id}:started`);
    assert.equal(failedEvent.eventKey, `deployment:${started.id}:failed`);
    assert.equal(rolledBackEvent.eventKey, `deployment:${started.id}:rolled_back`);
    for (const event of events) {
      assert.equal(event.projectId, "77");
      assert.equal(event.projectNameSnapshot, "PT35");
      assert.equal(event.deploymentId, started.id);
      assert.equal(event.actorId, 7);
      assert.ok(event.occurredAt);
    }
    store.configureDeploymentStore({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown deployment status emits deployment.unknown instead of deployment.failed", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-deploy-unknown-event-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/deployment-store.ts?unknown-event=${Date.now()}`);
    const events: any[] = [];
    store.configureDeploymentStore({ eventSink: { append: (event: any) => events.push(event) }, resolveProjectId: () => 77 });
    const started = store.startDeployment({ userId: 7, username: "tester", project: "PT35", environment: "Demo", host: "server-1", rollbackRequested: false });
    store.finishDeployment(started.id, { status: "unknown", rollback: started.rollback, error: "remote state unknown" });
    const { drainRelayEventSpool } = await import("../src/knowledge/event-sink.ts");
    drainRelayEventSpool({ append: (event: any) => events.push(event) });
    assert.ok(events.some((event) => event.type === "deployment.unknown" && event.eventKey === `deployment:${started.id}:unknown`));
    assert.equal(events.some((event) => event.type === "deployment.failed"), false);
    store.configureDeploymentStore({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restarted Relay marks running deployments unknown, refuses reuse, and spools deployment.interrupted", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-deploy-restart-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/deployment-store.ts?restart=${Date.now()}`);
    const started = store.startDeployment({
      userId: 7,
      username: "tester",
      project: "PT35",
      environment: "Demo",
      host: "server-1",
      instance: "VGSM",
      rollbackRequested: false,
    });

    // Simulate a crash after the running record was written but before the
    // started event and its marker were durably recorded.
    const recordPath = join(root, "deployments", `${started.id}.json`);
    const unmarked = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    delete unmarked.startedEventEmittedAt;
    writeFileSync(recordPath, JSON.stringify(unmarked), "utf8");
    const spoolPath = join(root, "knowledge-event-spool.jsonl");
    if (readFileSync(spoolPath, "utf8")) {
      const remaining = readFileSync(spoolPath, "utf8")
        .split(/\r?\n/)
        .filter((line) => line && !line.includes(`\"eventKey\":\"deployment:${started.id}:started\"`));
      writeFileSync(spoolPath, remaining.length > 0 ? `${remaining.join("\n")}\n` : "", "utf8");
    }

    // Simulate a Relay restart: a fresh module instance scans the state root on load.
    const restarted = await import(`../src/shared/deployment-store.ts?restart-after=${Date.now()}`);
    const recovered = restarted.getDeployment(started.id);
    assert.equal(recovered?.status, "unknown");
    assert.ok(recovered?.finishedAt);
    assert.match(recovered?.recommendedResumeAction ?? "", /Relay restarted/);
    assert.throws(
      () => restarted.requireRunningDeployment(started.id, { userId: 7, project: "PT35", environment: "Demo", instance: "VGSM" }),
      /cannot accept new operations/
    );

    // The interrupted event was spooled at startup (no sink configured yet) and drains idempotently.
    const { drainRelayEventSpool } = await import("../src/knowledge/event-sink.ts");
    const drained: any[] = [];
    drainRelayEventSpool({ append: (event: any) => drained.push(event) });
    const interrupted = drained.filter((event) => event.type === "deployment.interrupted" && event.deploymentId === started.id);
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0].eventKey, `deployment:${started.id}:interrupted`);
    assert.equal(interrupted[0].projectNameSnapshot, "PT35");
    assert.equal(interrupted[0].payload.reason, "relay_restart");
    const startedEvent = drained.filter((event) => event.type === "deployment.started" && event.deploymentId === started.id);
    assert.equal(startedEvent.length, 1, "a running record without a started marker is compensated before interruption");
    assert.equal(startedEvent[0].occurredAt, started.startedAt, "started-event replay keeps the original startedAt");
    assert.ok(recovered?.startedEventEmittedAt, "startup compensation persists the started-event marker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup compensation re-emits an unmarked terminal deployment event with fixed occurredAt", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-deploy-terminal-compensation-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/deployment-store.ts?terminal-compensation=${Date.now()}`);
    const finishedAt = "2026-09-03T12:34:56.000Z";
    mkdirSync(join(root, "deployments"), { recursive: true });
    writeFileSync(join(root, "deployments", "deploy-terminal-gap.json"), JSON.stringify({
      id: "deploy-terminal-gap",
      userId: 7,
      username: "tester",
      project: "PT35",
      projectIdSnapshot: "77",
      environment: "Demo",
      host: "server-1",
      kind: "samplemanager-assembly",
      instance: "VGSM",
      status: "failed",
      terminalEventKind: "failed",
      startedAt: "2026-09-03T12:34:00.000Z",
      finishedAt,
      error: "assembly load failed",
      rollback: { requested: false, attempted: false, status: "not-requested" },
    }), "utf8");

    const events: any[] = [];
    store.configureDeploymentStore({ eventSink: { append: (event: any) => events.push(event) } });
    assert.ok(store.getDeployment("deploy-terminal-gap")?.terminalEventEmittedAt);

    const { drainRelayEventSpool } = await import("../src/knowledge/event-sink.ts");
    drainRelayEventSpool({ append: (event: any) => events.push(event) });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "deployment.failed");
    assert.equal(events[0].eventKey, "deployment:deploy-terminal-gap:failed");
    assert.equal(events[0].occurredAt, finishedAt);
    assert.equal(events[0].projectId, "77");

    store.configureDeploymentStore({ eventSink: { append: (event: any) => events.push(event) } });
    drainRelayEventSpool({ append: (event: any) => events.push(event) });
    assert.equal(events.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
