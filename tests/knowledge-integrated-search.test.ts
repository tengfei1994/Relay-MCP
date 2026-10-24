import assert from "node:assert/strict";
import test from "node:test";
import { buildWeknoraSearchBody } from "../frontend/src/knowledge/integrated-search.ts";

test("WeKnora retrieval request carries the selected project scope", () => {
  assert.deepEqual(buildWeknoraSearchBody({ q: "provider probe", productVersion: "21.1", solution: "SampleManager", module: "Instruments", limit: "10" }, "e2e-browser"), {
    query: "provider probe",
    limit: 10,
    projectId: "e2e-browser",
    productVersion: "21.1",
    solution: "SampleManager",
    module: "Instruments",
  });
});
