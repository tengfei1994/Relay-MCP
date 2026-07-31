import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { buildQueryArtifactPayload } from "../src/shared/query-artifact-store.ts";

test("query artifacts preserve raw response and provenance", () => {
  const payload = buildQueryArtifactPayload({
    queryId: "query-test",
    rawResponse: '{"ok":true,"rows":[{"id":1}]}',
    provenance: {
      project: "HKJC",
      environment: "production",
      databaseName: "VGSM",
      mutationAttempted: false,
    },
  });
  const parsed = JSON.parse(payload);
  assert.equal(parsed.queryId, "query-test");
  assert.equal(parsed.rawResponse, '{"ok":true,"rows":[{"id":1}]}');
  assert.equal(parsed.provenance.mutationAttempted, false);
  assert.equal(
    createHash("sha256").update(payload, "utf8").digest("hex").length,
    64
  );
});
