import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

export type SourceChangeStatus = "UNCHANGED" | "PROJECT_ONLY" | "BASELINE_ONLY" | "BOTH_CHANGED" | "ADDED" | "DELETED";

export interface SourceManifestFile {
  path: string;
  sha256: string;
  size: number;
  language?: string;
}

export interface SourceManifest {
  root: string;
  files: SourceManifestFile[];
  sha256: string;
}

export interface ThreeWayChange {
  path: string;
  status: SourceChangeStatus;
  old?: SourceManifestFile;
  project?: SourceManifestFile;
  next?: SourceManifestFile;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".cs": "csharp", ".vgl": "vgl", ".sql": "sql", ".xml": "xml", ".json": "json",
  ".config": "xml", ".js": "javascript", ".ts": "typescript", ".ps1": "powershell",
};

function hash(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function walk(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    return entry.isDirectory() ? walk(root, path) : [path];
  });
}

export function buildSourceManifest(rootPath: string): SourceManifest {
  const root = resolve(rootPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error("Source manifest root must be an existing directory");
  const files = walk(root).map((path) => {
    const content = readFileSync(path);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    return { path: relativePath, sha256: hash(content), size: content.length, language: LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] };
  }).sort((a, b) => a.path.localeCompare(b.path));
  return { root, files, sha256: hash(JSON.stringify(files)) };
}

export function compareSourceBaselines(oldBaseline: SourceManifest, project: SourceManifest, newBaseline: SourceManifest): ThreeWayChange[] {
  const oldFiles = new Map(oldBaseline.files.map((file) => [file.path, file]));
  const projectFiles = new Map(project.files.map((file) => [file.path, file]));
  const newFiles = new Map(newBaseline.files.map((file) => [file.path, file]));
  const paths = [...new Set([...oldFiles.keys(), ...projectFiles.keys(), ...newFiles.keys()])].sort();
  return paths.map((path) => {
    const oldFile = oldFiles.get(path); const projectFile = projectFiles.get(path); const newFile = newFiles.get(path);
    const oldHash = oldFile?.sha256; const projectHash = projectFile?.sha256; const newHash = newFile?.sha256;
    let status: SourceChangeStatus;
    if (!oldFile && projectFile && !newFile) status = "PROJECT_ONLY";
    else if (!oldFile && !projectFile && newFile) status = "ADDED";
    else if (oldFile && !projectFile && !newFile) status = "DELETED";
    else if (oldHash === projectHash && projectHash === newHash) status = "UNCHANGED";
    else if (oldHash === projectHash && projectHash !== newHash) status = "BASELINE_ONLY";
    else if (oldHash !== projectHash && projectHash === newHash) status = "PROJECT_ONLY";
    else status = "BOTH_CHANGED";
    return { path, status, ...(oldFile ? { old: oldFile } : {}), ...(projectFile ? { project: projectFile } : {}), ...(newFile ? { next: newFile } : {}) };
  });
}
