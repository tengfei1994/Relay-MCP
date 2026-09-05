import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { drainRelayEventSpool, emitRelayEvent, relayEventSpoolHealth } from "../src/knowledge/event-sink.ts";

test("domain events spool while Knowledge is unavailable and drain with redacted payload", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-event-spool-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  try {
    emitRelayEvent(undefined, { type: "job.started", projectId: "17", projectNameSnapshot: "Demo", jobId: "job-1", payload: { token: "secret-token", command: "safe metadata" } });
    const spool = join(root, "knowledge-event-spool.jsonl");
    assert.equal(existsSync(spool), true);
    assert.doesNotMatch(readFileSync(spool, "utf8"), /secret-token/);
    const events: any[] = [];
    assert.equal(drainRelayEventSpool({ append: (event) => events.push(event) }), 1);
    assert.equal(events[0].projectId, "17");
    assert.equal(events[0].projectNameSnapshot, "Demo");
    assert.deepEqual(events[0].payload.token, { redacted: true, length: 12 });
    assert.equal(relayEventSpoolHealth().pending, false);
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("event emission accepts a persisted occurredAt and reports durable spool status", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-event-occurred-at-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  try {
    const occurredAt = "2026-09-03T12:34:56.000Z";
    assert.equal(emitRelayEvent(undefined, { type: "job.finished", jobId: "job-fixed-time", occurredAt, payload: {} }), true);
    const events: any[] = [];
    assert.equal(drainRelayEventSpool({ append: (event) => events.push(event) }), 1);
    assert.equal(events[0].occurredAt, occurredAt);
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed drain preserves the event for a later retry", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-event-retry-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  try {
    emitRelayEvent(undefined, { type: "deployment.failed", deploymentId: "deploy-1", payload: { status: "failed" } });
    assert.throws(() => drainRelayEventSpool({ append: () => { throw new Error("database locked"); } }), /database locked/);
    const events: any[] = [];
    assert.equal(drainRelayEventSpool({ append: (event) => events.push(event) }), 1);
    assert.equal(events[0].deploymentId, "deploy-1");
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed spool line is dead-lettered while later valid events still drain", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-event-malformed-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  try {
    emitRelayEvent(undefined, { type: "job.started", jobId: "job-good", payload: {} });
    const spool = join(root, "knowledge-event-spool.jsonl");
    appendFileSync(spool, "{this is not json\n", "utf8");
    emitRelayEvent(undefined, { type: "job.finished", jobId: "job-later", payload: {} });
    const events: any[] = [];
    assert.equal(drainRelayEventSpool({ append: (event) => events.push(event) }), 3);
    assert.deepEqual(events.map((event) => event.jobId), ["job-good", "job-later"]);
    const dead = readFileSync(`${spool}.dead-letter`, "utf8");
    assert.match(dead, /"line":2/);
    assert.equal(relayEventSpoolHealth().pending, false);
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a held drain lock blocks a concurrent drain without losing spooled events", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-event-lock-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  try {
    emitRelayEvent(undefined, { type: "job.started", jobId: "job-locked", payload: {} });
    const spool = join(root, "knowledge-event-spool.jsonl");
    writeFileSync(`${spool}.lock`, JSON.stringify({ pid: 99999, at: new Date().toISOString() }), "utf8");
    assert.equal(drainRelayEventSpool({ append: () => { throw new Error("must not be reached"); } }), 0);
    assert.equal(existsSync(spool), true, "a locked drain must leave the spool untouched");
    rmSync(`${spool}.lock`);
    const events: any[] = [];
    assert.equal(drainRelayEventSpool({ append: (event) => events.push(event) }), 1);
    assert.equal(events[0].jobId, "job-locked");
    assert.equal(existsSync(`${spool}.lock`), false, "the lock is released after draining");
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale drain lock is taken over so recovery cannot wedge forever", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-event-stale-lock-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  try {
    emitRelayEvent(undefined, { type: "job.started", jobId: "job-stale", payload: {} });
    const spool = join(root, "knowledge-event-spool.jsonl");
    const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
    writeFileSync(`${spool}.lock`, JSON.stringify({ pid: 4242, at: staleAt }), "utf8");
    const events: any[] = [];
    assert.equal(drainRelayEventSpool({ append: (event) => events.push(event) }), 1);
    assert.equal(events[0].jobId, "job-stale");
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a valid JSON line with an invalid event structure is dead-lettered instead of poisoning the drain", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-event-structure-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  try {
    emitRelayEvent(undefined, { type: "job.started", jobId: "job-before", payload: {} });
    const spool = join(root, "knowledge-event-spool.jsonl");
    // Valid JSON, but no id/type/occurredAt/payload — would throw inside
    // KnowledgeStore.append() and wedge every later drain attempt.
    appendFileSync(spool, JSON.stringify({ foo: "bar" }) + "\n", "utf8");
    appendFileSync(spool, JSON.stringify({ id: "x", type: "job.exploded", occurredAt: "now", payload: {} }) + "\n", "utf8");
    emitRelayEvent(undefined, { type: "job.finished", jobId: "job-after", payload: {} });
    const events: any[] = [];
    assert.equal(drainRelayEventSpool({ append: (event) => events.push(event) }), 4);
    assert.deepEqual(events.map((event) => event.jobId), ["job-before", "job-after"]);
    const dead = readFileSync(`${spool}.dead-letter`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(dead.length, 2);
    assert.match(dead[0].error, /invalid relay event structure/);
    assert.match(dead[1].error, /invalid relay event structure/);
    assert.equal(relayEventSpoolHealth().pending, false, "the spool must drain completely with no poisoned suffix");
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("dead-letter write failure does not poison later valid events", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-event-dead-letter-failure-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  try {
    const spool = join(root, "knowledge-event-spool.jsonl");
    writeFileSync(spool, JSON.stringify({ foo: "bar" }) + "\n", "utf8");
    mkdirSync(`${spool}.dead-letter`);
    const valid = JSON.stringify({ id: "event-valid", eventKey: "job:valid:finished", type: "job.finished", occurredAt: new Date().toISOString(), payload: {}, jobId: "valid" });
    appendFileSync(spool, valid + "\n", "utf8");
    const events: any[] = [];
    assert.throws(() => drainRelayEventSpool({ append: (event) => events.push(event) }), /dead-letter/);
    assert.equal(existsSync(spool), true, "the malformed line must remain recoverable when dead-letter persistence fails");
    assert.deepEqual(events.map((event) => event.id), []);
    assert.equal(relayEventSpoolHealth().degraded, true);
    assert.equal(relayEventSpoolHealth().eventLossRisk, true);
    assert.ok(relayEventSpoolHealth().deadLetterFailures >= 1);
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitRelayEvent survives circular and BigInt payloads without breaking the caller", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-event-circular-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  try {
    const circular: any = { command: "deploy" };
    circular.self = circular;
    assert.doesNotThrow(() => emitRelayEvent(undefined, { type: "job.started", jobId: "job-circular", payload: circular }));
    assert.doesNotThrow(() => emitRelayEvent(undefined, { type: "job.started", jobId: "job-bigint", payload: { rows: BigInt("9007199254740993") } }));
    const events: any[] = [];
    assert.equal(drainRelayEventSpool({ append: (event) => events.push(event) }), 2);
    const [circularEvent, bigintEvent] = events;
    assert.deepEqual(circularEvent.payload.self, { circular: true });
    assert.deepEqual(bigintEvent.payload.rows, { bigint: "9007199254740993" });
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitRelayEvent bounds oversized sanitized payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-event-large-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  try {
    assert.doesNotThrow(() => emitRelayEvent(undefined, { type: "job.started", jobId: "job-large", payload: { output: "x".repeat(400_000) } }));
    const events: any[] = [];
    assert.equal(drainRelayEventSpool({ append: (event) => events.push(event) }), 1);
    assert.equal(events[0].payload.redacted, true);
    assert.equal(events[0].payload.reason, "payload_too_large");
    assert.ok(events[0].payload.bytes > 256 * 1024);
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an async drain failure marks the spool degraded with an error class and timestamp", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-event-degraded-"));
  const previous = process.env.RELAY_STATE_ROOT;
  process.env.RELAY_STATE_ROOT = root;
  try {
    emitRelayEvent({ append: () => { throw new Error("SQLITE_BUSY: database is locked"); } }, { type: "job.started", jobId: "job-degraded", payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const health = relayEventSpoolHealth();
    assert.equal(health.degraded, true);
    assert.ok(health.drainFailures >= 1);
    assert.equal(health.lastDrainErrorClass, "knowledge_db");
    assert.ok(health.lastDrainErrorAt);
    // Recover the spool with a working sink so no pending state leaks onward.
    const events: any[] = [];
    drainRelayEventSpool({ append: (event) => events.push(event) });
    assert.equal(events.length, 1);
  } finally {
    if (previous === undefined) delete process.env.RELAY_STATE_ROOT; else process.env.RELAY_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
