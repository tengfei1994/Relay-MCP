import { existsSync, realpathSync } from "fs";
import { basename, dirname, normalize, resolve } from "path";

/**
 * Resolve an existing path through symlinks. For a path that does not exist,
 * resolve its nearest existing ancestor so aliases such as `./data/../data`
 * and symlinked state roots still compare consistently.
 */
export function canonicalPath(filePath: string): string {
  if (!filePath || filePath.includes("\0")) throw new Error("Database path is invalid");

  const absolute = resolve(filePath);
  let existing = absolute;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }

  const realExisting = existsSync(existing)
    ? realpathSync.native(existing)
    : existing;
  return normalize(resolve(realExisting, ...missing));
}

function comparablePath(filePath: string): string {
  const canonical = canonicalPath(filePath);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function pathsEqual(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

export function assertDistinctPaths(leftName: string, left: string, rightName: string, right: string): void {
  if (pathsEqual(left, right)) {
    throw new Error(`${leftName} and ${rightName} must point to different files`);
  }
}

export function assertKnowledgeDbIsolated(knowledgeDbPath: string, appDbPath: string): void {
  assertDistinctPaths("KNOWLEDGE_DB_PATH", knowledgeDbPath, "DB_PATH", appDbPath);
}

