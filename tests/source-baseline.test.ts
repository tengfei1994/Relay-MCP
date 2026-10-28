import assert from "node:assert/strict";
import test from "node:test";
import { compareSourceBaselines, type SourceChangeStatus, type SourceManifest } from "../src/knowledge/source-baseline.ts";

function manifest(files: Record<string, string | undefined>): SourceManifest {
  return {
    root: "fixture",
    sha256: "manifest",
    files: Object.entries(files).flatMap(([path, sha256]) => sha256 === undefined ? [] : [{ path, sha256, size: 1 }]),
  };
}

function change(oldHash: string | undefined, projectHash: string | undefined, newHash: string | undefined) {
  const result = compareSourceBaselines(
    manifest({ "file.cs": oldHash }),
    manifest({ "file.cs": projectHash }),
    manifest({ "file.cs": newHash }),
  );
  assert.equal(result.length, 1);
  return result[0];
}

const cases: Array<[string, string | undefined, string | undefined, string | undefined, SourceChangeStatus, boolean]> = [
  ["unchanged", "A", "A", "A", "UNCHANGED", false],
  ["project added", undefined, "B", undefined, "PROJECT_ONLY", false],
  ["baseline added", undefined, undefined, "A", "ADDED", false],
  ["both added identically", undefined, "A", "A", "PROJECT_ONLY", false],
  ["both added differently", undefined, "B", "A", "BOTH_CHANGED", true],
  ["project deleted", "A", undefined, "A", "PROJECT_ONLY", false],
  ["baseline deleted", "A", "A", undefined, "BASELINE_ONLY", false],
  ["both deleted", "A", undefined, undefined, "DELETED", false],
  ["project modified", "A", "B", "A", "PROJECT_ONLY", false],
  ["baseline modified", "A", "A", "B", "BASELINE_ONLY", false],
  ["both modified identically", "A", "B", "B", "PROJECT_ONLY", false],
  ["both modified differently", "A", "B", "C", "BOTH_CHANGED", true],
  ["project deleted and baseline modified", "A", undefined, "B", "BOTH_CHANGED", true],
  ["project modified and baseline deleted", "A", "B", undefined, "BOTH_CHANGED", true],
];

for (const [name, oldHash, projectHash, newHash, status, potentialConflict] of cases) {
  test(`three-way source comparison: ${name}`, () => {
    const result = change(oldHash, projectHash, newHash);
    assert.equal(result.status, status);
    assert.equal(result.potentialConflict ?? false, potentialConflict);
    assert.equal(result.old?.sha256, oldHash);
    assert.equal(result.project?.sha256, projectHash);
    assert.equal(result.next?.sha256, newHash);
  });
}

test("project edit is not a conflict when the next baseline retains the old file", () => {
  const result = change("A", "B", "A");
  assert.equal(result.status, "PROJECT_ONLY");
  assert.equal(result.potentialConflict, undefined);
});
