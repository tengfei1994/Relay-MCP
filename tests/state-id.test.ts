import assert from "node:assert/strict";
import test from "node:test";
import { validateStateId } from "../src/shared/state-id.ts";

test("state ids reject path traversal and separators", () => {
  assert.equal(validateStateId("deploy-123-abc"), "deploy-123-abc");
  assert.throws(() => validateStateId("../audit"), /Invalid state id/);
  assert.throws(() => validateStateId("jobs/item"), /Invalid state id/);
  assert.throws(() => validateStateId("jobs\\item"), /Invalid state id/);
});
