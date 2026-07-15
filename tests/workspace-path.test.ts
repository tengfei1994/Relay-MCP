import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isPathInside, resolveWorkspacePath } from "../src/shared/workspace-path.ts";

test("resolveWorkspacePath accepts contained relative paths", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-path-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "file.txt"), "ok");
    assert.equal(
      resolveWorkspacePath(root, "nested/file.txt", { mustExist: true }),
      join(root, "nested", "file.txt")
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveWorkspacePath rejects traversal, absolute paths, and root deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-path-"));
  try {
    assert.throws(() => resolveWorkspacePath(root, "../outside"), /traversal/);
    assert.throws(() => resolveWorkspacePath(root, join(root, "file.txt")), /relative/);
    assert.throws(() => resolveWorkspacePath(root, ""), /root cannot be used/);
    assert.equal(resolveWorkspacePath(root, "", { allowRoot: true }), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveWorkspacePath rejects symlink escape when supported", (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-path-"));
  const outside = mkdtempSync(join(tmpdir(), "relay-outside-"));
  try {
    try {
      symlinkSync(outside, join(root, "escape"), "junction");
    } catch {
      t.skip("Symlink creation is unavailable in this environment");
      return;
    }
    assert.throws(() => resolveWorkspacePath(root, "escape/file.bin"), /symbolic link outside/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("isPathInside does not accept sibling paths with a shared prefix", () => {
  assert.equal(isPathInside("C:\\workspace\\project", "C:\\workspace\\project2"), false);
});
