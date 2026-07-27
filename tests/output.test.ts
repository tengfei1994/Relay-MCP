import assert from "node:assert/strict";
import test from "node:test";
import { compactTextWithMetadata, sanitizeStructuredOutput, summarizeJson } from "../src/shared/output.ts";

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

test("sanitizeStructuredOutput reports large fields and prunes depth and arrays", () => {
  const result = sanitizeStructuredOutput({
    command: { parameters: { nested: { value: "x".repeat(500) } } },
    items: Array.from({ length: 10 }, (_, index) => index),
  }, { maxDepth: 3, maxArrayItems: 3, maxStringLength: 100 });

  assert.ok(result.truncatedPaths.some((path) => path === "command.parameters.nested"));
  assert.ok(result.truncatedPaths.some((path) => path === "items"));
  assert.equal((result.value as any).items.length, 3);
  assert.equal(result.largestFields[0].path, "command");
});

test("sanitizeStructuredOutput applies a default whitelist to PowerShell command objects", () => {
  const result = sanitizeStructuredOutput({
    Name: "Get-Command",
    CommandType: "Cmdlet",
    Version: "7.0",
    Source: "Microsoft.PowerShell.Core",
    Parameters: { Huge: "x".repeat(5000) },
    ParameterSets: Array.from({ length: 100 }, () => ({ value: "large" })),
  });

  assert.deepEqual(Object.keys(result.value as any), ["Name", "CommandType", "Version", "Source"]);
  assert.ok(result.truncatedPaths.some((path) => path.includes("non-whitelisted properties")));
});
