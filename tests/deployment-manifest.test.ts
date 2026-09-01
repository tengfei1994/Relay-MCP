import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDeploymentManifest } from "../src/shared/deployment-manifest.ts";

test("deployment manifest records bounded workspace file hashes without deploying", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-manifest-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "Task.cs"), "class Task {}", "utf8");
  const result = createDeploymentManifest({
    workspaceRoot: root,
    outputPath: "manifests/demo.json",
    deploymentId: "deploy-123",
    target: { project: "PT35", environment: "Demo", serverId: 1, instance: "VGSM" },
    sourceFiles: ["src/Task.cs"],
    label: "Form task update",
  });
  assert.equal(result.manifest.readOnly, true);
  assert.equal(result.manifest.mutationAttempted, false);
  assert.equal(result.manifest.sourceFiles.length, 1);
  assert.match(result.manifest.sourceFiles[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(readFileSync(result.path, "utf8")), result.manifest);
});

test("deployment manifest rejects missing files and traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-manifest-invalid-"));
  assert.throws(() => createDeploymentManifest({ workspaceRoot: root, outputPath: "../x.json", target: {}, sourceFiles: [] }), /workspace path|traversal/i);
  assert.throws(() => createDeploymentManifest({ workspaceRoot: root, outputPath: "manifests/x.json", target: {}, sourceFiles: ["missing.cs"] }), /does not exist/i);
});
