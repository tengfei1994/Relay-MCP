import assert from "node:assert/strict";
import test from "node:test";
import { compactTextWithMetadata, summarizeJson } from "../src/shared/output.ts";

test("compactTextWithMetadata reports truncation without hiding original size", () => {
  const result = compactTextWithMetadata("abcdefghij", 6);
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength, 10);
  assert.match(result.text, /truncated 4 character/);
});

test("compactTextWithMetadata preserves short output", () => {
  assert.deepEqual(compactTextWithMetadata("ok", 10), {
    text: "ok",
    originalLength: 2,
    truncated: false,
  });
});

test("summarizeJson keeps truncated status responses valid JSON", () => {
  const parsed = JSON.parse(summarizeJson({ values: "x".repeat(500) }, 80));
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.originalLength > 80, true);
});
