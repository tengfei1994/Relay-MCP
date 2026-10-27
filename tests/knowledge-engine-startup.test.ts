import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createEngineStartupReconciler } from "../src/server/knowledge-engine-startup.ts";

test("startup recovers when the engine becomes healthy after its first initialization fails", async () => {
  let attempts = 0;
  const events: unknown[] = [];
  const startup = createEngineStartupReconciler({
    installed: () => true, retryDelaysMs: [1, 2],
    initialize: async () => { if (++attempts === 1) throw new Error("private-owner-password"); },
    report: event => events.push(event),
  });
  assert.equal(await startup.start(), "ready");
  assert.equal(attempts, 2);
  assert.doesNotMatch(JSON.stringify(events), /private-owner-password/);
  await startup.stop();
});

test("startup has a finite retry budget and emits no exception or credential details", async () => {
  let attempts = 0;
  const events: unknown[] = [];
  const startup = createEngineStartupReconciler({
    installed: () => true, retryDelaysMs: [1, 2],
    initialize: async () => { attempts++; throw new Error("Bearer secret-owner-token"); },
    report: event => events.push(event),
  });
  assert.equal(await startup.start(), "exhausted");
  assert.equal(attempts, 3);
  await delay(10);
  assert.equal(attempts, 3);
  assert.doesNotMatch(JSON.stringify(events), /secret-owner-token|Bearer/);
});

test("shutdown cancels scheduled retry and start cannot restart a stopped reconciler", async () => {
  let attempts = 0;
  let failed!: () => void;
  const failure = new Promise<void>(resolve => { failed = resolve; });
  const startup = createEngineStartupReconciler({
    installed: () => true, retryDelaysMs: [60_000],
    initialize: async () => { attempts++; throw new Error("not ready"); },
    report: () => failed(),
  });
  const running = startup.start();
  await failure;
  await startup.stop();
  assert.equal(await running, "stopped");
  assert.equal(await startup.start(), "stopped");
  assert.equal(attempts, 1);
});

test("concurrent starts share one initialization and shutdown drains it without retrying", async () => {
  let attempts = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const startup = createEngineStartupReconciler({
    installed: () => true, retryDelaysMs: [1],
    initialize: async () => { attempts++; await blocked; throw new Error("unavailable"); },
    report: () => {},
  });
  const first = startup.start(), second = startup.start();
  assert.equal(first, second);
  let stopped = false;
  const stopping = startup.stop().then(() => { stopped = true; });
  await delay(1);
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(await first, "stopped");
  assert.equal(attempts, 1);
});

test("installations without a bundled runtime do not attempt bootstrap", async () => {
  const startup = createEngineStartupReconciler({
    installed: () => false, initialize: async () => { assert.fail("must not initialize"); }, report: () => {},
  });
  assert.equal(await startup.start(), "not_installed");
  await startup.stop();
});
