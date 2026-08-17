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
