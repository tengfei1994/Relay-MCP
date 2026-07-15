import assert from "node:assert/strict";
import test from "node:test";
import {
  quotePosix,
  quotePowerShell,
  validateGitRef,
  validateRelativeRemotePath,
  validateServiceName,
} from "../src/shared/shell-utils.ts";

test("shell quoting escapes embedded single quotes", () => {
  assert.equal(quotePosix("a'b"), "'a'\\''b'");
  assert.equal(quotePowerShell("a'b"), "'a''b'");
});

test("validateGitRef accepts normal refs and rejects option or revision injection", () => {
  assert.equal(validateGitRef("feature/relay-1.0"), "feature/relay-1.0");
  assert.throws(() => validateGitRef("--help"), /Invalid Git ref/);
  assert.throws(() => validateGitRef("main..other"), /Invalid Git ref/);
  assert.throws(() => validateGitRef("main;shutdown"), /Invalid Git ref/);
});

test("service and relative path validators reject command and traversal input", () => {
  assert.equal(validateServiceName("windows:Spooler"), "windows:Spooler");
  assert.throws(() => validateServiceName("svc;whoami"), /Invalid service name/);
  assert.equal(validateRelativeRemotePath("folder/file.dll", "target"), "folder/file.dll");
  assert.throws(() => validateRelativeRemotePath("../file.dll", "target"), /relative path/);
  assert.throws(() => validateRelativeRemotePath("C:\\file.dll", "target"), /relative path/);
});
