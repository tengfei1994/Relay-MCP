import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sanitizeToolAuditArguments } from "../src/shared/retrieval-audit.ts";

const tools = ["open", "update", "close", "get", "list"].map(operation => `knowledge_work_session_${operation}`);
const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

test("Work Session audit keeps metadata and hashes while leaving handler arguments untouched", () => {
  const input = {
    sessionId: `session-${"a".repeat(32)}`, idempotencyKey: "private-idempotency-marker", limit: 10,
    intent: { projectId: "7", actions: ["understand"], phase: "explore", risk: "read_only", knowledgeMode: "capture", objective: "private-objective-marker", hiddenReasoning: "private-intent-marker" },
    patch: { phase: "validation", summary: "private-patch-marker", hiddenReasoning: "private-rejected-marker" },
    summary: "private-summary-marker 🧪", result: { summary: "private-result-marker", acceptanceResults: { "private-key-marker": true } },
    unexpected: { privateData: "private-unknown-marker" },
  };
  const before = structuredClone(input);
  for (const tool of tools) {
    const audit = sanitizeToolAuditArguments(tool, input) as Record<string, unknown>;
    assert.doesNotMatch(JSON.stringify(audit), /private-/);
    assert.equal(audit.schemaVersion, 1);
    assert.equal(audit.sessionId, input.sessionId);
    assert.equal(audit.limit, 10);
    for (const field of ["intent", "patch", "summary", "result", "idempotencyKey"] as const) {
      const serialized = typeof input[field] === "string" ? input[field] : JSON.stringify(input[field]);
      assert.equal(audit[`${field}Hash`], hash(input[field]));
      assert.equal(audit[`${field}Length`], [...serialized].length);
      assert.equal(audit[`${field}Bytes`], Buffer.byteLength(serialized));
      assert.equal(audit[field], undefined);
    }
    assert.equal(audit.unexpected, undefined);
  }
  assert.deepEqual(input, before);
});

test("Work Session audit allowlists actual metadata and does not echo rejected or malformed values", () => {
  const safe = sanitizeToolAuditArguments("knowledge_work_session_open", { intent: { projectId: "7", actions: ["understand", "verify"], phase: "explore", risk: "read_only", knowledgeMode: "capture" } }) as any;
  assert.equal(safe.projectId, "7");
  assert.deepEqual(safe.actions, ["understand", "verify"]);
  assert.equal(safe.phase, "explore");
  assert.equal(safe.risk, "read_only");
  assert.equal(safe.knowledgeMode, "capture");
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const input of [undefined, null, "private-raw-marker", ["private-array-marker"], { sessionId: "private-id-marker", intent: { projectId: "private-project-marker", actions: ["private-action-marker"], phase: "private-phase-marker" }, patch: cycle, summary: 5n }]) {
    assert.doesNotMatch(JSON.stringify(sanitizeToolAuditArguments("knowledge_work_session_update", input)), /private-|self/);
  }
});
