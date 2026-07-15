import assert from "node:assert/strict";
import test from "node:test";
import { compactTextWithMetadata } from "../src/shared/output.ts";

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
