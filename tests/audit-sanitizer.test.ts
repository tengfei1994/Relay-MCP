import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeAuditArguments } from "../src/shared/audit-sanitizer.ts";

test("audit sanitizer stores build setting names without raw values", () => {
  const sanitized = sanitizeAuditArguments({
    project: "PT35",
    msbuildProperties: { CUSTOM_ROOT: "D:\\Secret-ish Path" },
    environmentVariables: { FEATURE_FLAG: "enabled" },
  }) as any;

  assert.equal(sanitized.project, "PT35");
  assert.deepEqual(sanitized.msbuildProperties, { keys: ["CUSTOM_ROOT"], count: 1, valuesRedacted: true });
  assert.deepEqual(sanitized.environmentVariables, { keys: ["FEATURE_FLAG"], count: 1, valuesRedacted: true });
  assert.doesNotMatch(JSON.stringify(sanitized), /Secret-ish Path|enabled/);
});

test("audit sanitizer redacts variant-named credential keys by containment", () => {
  const input = {
    apiToken: "at-123",
    accessToken: "eyJhbGciOi",
    clientSecret: "shhh",
    privateKey: "-----BEGIN RSA PRIVATE KEY-----",
    authorization: "Basic dXNlcjpwYXNz",
    ConnectionString: "Server=db;Password=pw",
    sshKey: "AAAAB3Nza",
    sessionId: "opaque-but-harmless",
    nested: { uploadToken: "tok-9", serviceAccountPassword: "pw-9" },
  };
  const sanitized = sanitizeAuditArguments(input) as any;
  for (const key of ["apiToken", "accessToken", "clientSecret", "privateKey", "authorization", "ConnectionString", "sshKey"]) {
    assert.deepEqual(sanitized[key], { redacted: true, length: (input as any)[key].length }, `${key} must be redacted`);
  }
  assert.deepEqual(sanitized.nested.uploadToken, { redacted: true, length: "tok-9".length });
  assert.deepEqual(sanitized.nested.serviceAccountPassword, { redacted: true, length: "pw-9".length });
  assert.equal(sanitized.sessionId, "opaque-but-harmless", "non-credential keys must pass through");
  assert.doesNotMatch(JSON.stringify(sanitized), /eyJhbGciOi|shhh|BEGIN RSA|dXNlcjpwYXNz|AAAAB3Nza|pw-9|tok-9/);
});

test("audit sanitizer redacts exact legacy keys and credential-like strings", () => {
  const sanitized = sanitizeAuditArguments({
    script: "Get-Content secret.txt",
    sql: "UPDATE settings SET value='x'",
    parameters: { a: 1 },
    note: "use --password=hunter2 to connect",
  }) as any;
  assert.deepEqual(sanitized.script, { redacted: true, length: "Get-Content secret.txt".length });
  assert.deepEqual(sanitized.sql, { redacted: true, length: "UPDATE settings SET value='x'".length });
  assert.deepEqual(sanitized.parameters, { redacted: true, length: JSON.stringify({ a: 1 }).length });
  assert.deepEqual(sanitized.note, { redacted: true, length: "use --password=hunter2 to connect".length });
});

test("audit sanitizer summarizes circular structures and BigInt instead of throwing", () => {
  const circular: any = { name: "cycle" };
  circular.self = circular;
  const sanitized = sanitizeAuditArguments({ graph: circular, total: BigInt("9007199254740993") }) as any;
  assert.equal(sanitized.graph.name, "cycle");
  assert.deepEqual(sanitized.graph.self, { circular: true });
  assert.deepEqual(sanitized.total, { bigint: "9007199254740993" });
  assert.doesNotThrow(() => JSON.stringify(sanitized));
});

test("generic audit recursively redacts explicit hidden-reasoning keys while retaining ordinary unknown business fields", () => {
  const hidden = "SYNTHETIC_HIDDEN_REASONING_MARKER";
  const keys = ["hiddenReasoning", "hidden_reasoning", "reasoning", "reasoning_content", "reasoningContent", "chain_of_thought", "chainOfThought", "thinking", "scratchpad", "internal_monologue", "reflection", "deliberation", "thoughts", "cot"];
  const nested = Object.fromEntries(keys.map(key => [key, hidden]));
  const input = { ordinaryUnknown: "business-selector", reasoningSummary: "User-visible conclusion", analysisMode: "source", nested, rows: [{ nested }, { value: [{ hiddenReasoning: { text: hidden } }, { chain_of_thought: [hidden] }], businessFlag: true }] };
  const before = structuredClone(input), sanitized = sanitizeAuditArguments(input) as any;
  assert.equal(JSON.stringify(sanitized).includes(hidden), false, "hidden values must not persist at any object/array depth");
  for (const key of keys) {
    assert.deepEqual(sanitized.nested[key], { redacted: true, length: hidden.length });
    assert.deepEqual(sanitized.rows[0].nested[key], { redacted: true, length: hidden.length });
  }
  assert.deepEqual(sanitized.rows[1].value[0].hiddenReasoning, { redacted: true, length: JSON.stringify({ text: hidden }).length });
  assert.deepEqual(sanitized.rows[1].value[1].chain_of_thought, { redacted: true, length: JSON.stringify([hidden]).length });
  assert.equal(sanitized.ordinaryUnknown, input.ordinaryUnknown); assert.equal(sanitized.reasoningSummary, input.reasoningSummary); assert.equal(sanitized.analysisMode, "source"); assert.equal(sanitized.rows[1].businessFlag, true);
  assert.deepEqual(input, before);
});
