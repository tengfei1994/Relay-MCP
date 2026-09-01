import { createHash } from "crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname } from "path";
import { resolveWorkspacePath } from "./workspace-path.js";

export interface DeploymentManifestInput {
  workspaceRoot: string;
  outputPath: string;
  deploymentId?: string;
  label?: string;
  target: Record<string, unknown>;
  sourceFiles: string[];
  notes?: string[];
}

export function createDeploymentManifest(input: DeploymentManifestInput) {
  if (input.sourceFiles.length > 500) throw new Error("sourceFiles is limited to 500 entries");
  const files = input.sourceFiles.map((workspacePath) => {
    const absolutePath = resolveWorkspacePath(input.workspaceRoot, workspacePath);
    const stat = statSync(absolutePath, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`Workspace source file does not exist: ${workspacePath}`);
    const bytes = readFileSync(absolutePath);
    return {
      workspacePath,
      bytes: stat.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      modifiedAt: stat.mtime.toISOString(),
    };
  });
  const output = resolveWorkspacePath(input.workspaceRoot, input.outputPath);
  const manifest = {
    schema: "relay/samplemanager-deployment-manifest/v1",
    createdAt: new Date().toISOString(),
    deploymentId: input.deploymentId ?? null,
    label: input.label ?? null,
    readOnly: true,
    mutationAttempted: false,
    target: input.target,
    sourceFiles: files,
    notes: input.notes ?? [],
    verification: { build: "not_run", deployment: "not_run", runtime: "not_run", userAcceptance: "not_run" },
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(manifest, null, 2), "utf8");
  return { path: output, manifest };
}
