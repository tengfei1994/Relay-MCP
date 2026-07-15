import { existsSync, realpathSync } from "fs";
import { dirname, isAbsolute, relative, resolve } from "path";

export interface WorkspacePathOptions {
  allowRoot?: boolean;
  mustExist?: boolean;
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
  options: WorkspacePathOptions = {}
): string {
  if (relativePath.includes("\0")) {
    throw new Error("Path contains a null byte");
  }
  if (isAbsolute(relativePath)) {
    throw new Error("Workspace paths must be relative");
  }

  const root = resolve(workspaceRoot);
  const target = resolve(root, relativePath || ".");
  if (!isPathInside(root, target)) {
    throw new Error("Path traversal outside the project workspace is not allowed");
  }
  if (!options.allowRoot && target === root) {
    throw new Error("The project workspace root cannot be used for this operation");
  }
  if (options.mustExist && !existsSync(target)) {
    throw new Error(`Workspace path does not exist: ${relativePath}`);
  }

  assertNoSymlinkEscape(root, target);
  return target;
}

function assertNoSymlinkEscape(root: string, target: string): void {
  const realRoot = existsSync(root) ? realpathSync.native(root) : root;
  let existingAncestor = target;
  while (!existsSync(existingAncestor) && existingAncestor !== root) {
    existingAncestor = dirname(existingAncestor);
  }

  if (!existsSync(existingAncestor)) return;
  const realAncestor = realpathSync.native(existingAncestor);
  if (!isPathInside(realRoot, realAncestor)) {
    throw new Error("Workspace path resolves through a symbolic link outside the project workspace");
  }

  if (existsSync(target)) {
    const realTarget = realpathSync.native(target);
    if (!isPathInside(realRoot, realTarget)) {
      throw new Error("Workspace path resolves outside the project workspace");
    }
  }
}
