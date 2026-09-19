import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { unzipSync } from "fflate";
import type { KnowledgeStore } from "./store.js";

export type ArtifactCategory = "documentation" | "source" | "sql" | "configuration" | "installer" | "binary" | "other";
export interface ArtifactFile { relativePath: string; category: ArtifactCategory; mimeType?: string; sizeBytes: number; sha256: string; metadata?: Record<string, unknown>; }
export interface ArtifactIngestReport { setId: string; baselineId?: string; files: ArtifactFile[]; reused: boolean; }
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const ext = (p: string) => extname(p).toLowerCase();
function category(path: string): ArtifactCategory {
  const e = ext(path);
  if ([".html", ".htm", ".md", ".pdf", ".docx", ".chm"].includes(e)) return "documentation";
  if (e === ".sql") return "sql";
  if ([".cs", ".vgl", ".js", ".ts", ".ps1", ".java"].includes(e)) return "source";
  if ([".xml", ".json", ".config", ".yaml", ".yml", ".ini", ".cfg"].includes(e)) return "configuration";
  if ([".msi", ".exe", ".dmg", ".pkg"].includes(e)) return "installer";
  if ([".dll", ".so", ".jar", ".zip"].includes(e)) return "binary";
  return "other";
}
function language(path: string): string | undefined {
  const e = ext(path); return ({ ".cs": "csharp", ".vgl": "vgl", ".sql": "sql", ".xml": "xml", ".json": "json", ".js": "javascript", ".ts": "typescript", ".ps1": "powershell" } as Record<string, string>)[e];
}
function safePath(path: string): string { const p = path.replaceAll("\\", "/"); if (!p || p.startsWith("/") || p.split("/").includes("..")) throw new Error(`Unsafe artifact path: ${path}`); return p; }
function filesFromDirectory(root: string): Array<{ path: string; bytes: Uint8Array }> {
  const out: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = (dir: string) => readdirSync(dir, { withFileTypes: true }).forEach((entry) => { const full = join(dir, entry.name); if (entry.isDirectory()) walk(full); else out.push({ path: safePath(relative(root, full)), bytes: readFileSync(full) }); });
  walk(root); return out;
}
function filesFromInput(input: string): Array<{ path: string; bytes: Uint8Array }> {
  if (!existsSync(input)) throw new Error("Artifact source does not exist");
  if (statSync(input).isDirectory()) return filesFromDirectory(resolve(input));
  if (ext(input) !== ".zip") throw new Error("Artifact source must be a directory or ZIP");
  return Object.entries(unzipSync(readFileSync(input))).filter(([p]) => !p.endsWith("/")).map(([p, bytes]) => ({ path: safePath(p), bytes }));
}

/** Ingests metadata and hashes only. Installers and binaries are never executed. */
export function ingestArtifactSet(store: KnowledgeStore, options: { source: string; kind?: string; name: string; version?: string; solution?: string; storageUri?: string }): ArtifactIngestReport {
  const files = filesFromInput(options.source).map(({ path, bytes }) => ({ relativePath: path, category: category(path), mimeType: undefined, sizeBytes: bytes.byteLength, sha256: hash(bytes), metadata: language(path) ? { language: language(path) } : undefined }));
  const setHash = hash(JSON.stringify(files.map(({ relativePath, sha256, sizeBytes }) => ({ relativePath, sha256, sizeBytes }))));
  const now = new Date().toISOString();
  const existing = store.db.prepare("SELECT id FROM knowledge_artifact_sets WHERE sha256=?").get(setHash) as { id?: string } | undefined;
  if (existing?.id) return { setId: existing.id, files, reused: true };
  const setId = randomUUID();
  store.db.prepare(`INSERT INTO knowledge_artifact_sets(id,kind,name,version,source_locator,storage_uri,sha256,status,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(setId, options.kind ?? "solution", options.name, options.version ?? null, options.source, options.storageUri ?? null, setHash, "ready", JSON.stringify({ solution: options.solution, fileCount: files.length }), now, now);
  const insert = store.db.prepare(`INSERT INTO knowledge_artifacts(id,set_id,relative_path,category,mime_type,size_bytes,sha256,storage_uri,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  for (const file of files) insert.run(randomUUID(), setId, file.relativePath, file.category, file.mimeType ?? null, file.sizeBytes, file.sha256, options.storageUri ? `${options.storageUri}/${file.relativePath}` : null, JSON.stringify(file.metadata ?? {}), now);
  let baselineId: string | undefined;
  if (options.kind === "solution" && options.version) {
    baselineId = randomUUID();
    store.db.prepare(`INSERT INTO knowledge_source_baselines(id,artifact_set_id,solution,version,manifest_sha256,root_locator,created_at) VALUES(?,?,?,?,?,?,?)`).run(baselineId, setId, options.solution ?? options.name, options.version, setHash, options.source, now);
    const sourceInsert = store.db.prepare(`INSERT INTO knowledge_source_files(id,baseline_id,relative_path,language,sha256,size_bytes,storage_uri,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`);
    for (const file of files.filter((f) => ["source", "sql", "configuration"].includes(f.category))) sourceInsert.run(randomUUID(), baselineId, file.relativePath, language(file.relativePath) ?? file.category, file.sha256, file.sizeBytes, options.storageUri ? `${options.storageUri}/${file.relativePath}` : null, JSON.stringify({ category: file.category }), now);
  }
  return { setId, baselineId, files, reused: false };
}

export function ingestProjectSnapshot(store: KnowledgeStore, options: { source: string; name: string; projectId?: string; version?: string; storageUri?: string }): { snapshotId: string; fileCount: number; manifestSha256: string } {
  const files = filesFromInput(options.source).map(({ path, bytes }) => ({ path, bytes, sha256: hash(bytes) }));
  const manifestSha256 = hash(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 })))); const now = new Date().toISOString(); const snapshotId = randomUUID();
  store.db.prepare(`INSERT INTO knowledge_project_snapshots(id,project_id,name,version,source_locator,manifest_sha256,created_at) VALUES(?,?,?,?,?,?,?)`).run(snapshotId, options.projectId ?? null, options.name, options.version ?? null, options.source, manifestSha256, now);
  const insert = store.db.prepare(`INSERT INTO knowledge_project_snapshot_files(id,snapshot_id,relative_path,language,sha256,size_bytes,storage_uri,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const file of files) insert.run(randomUUID(), snapshotId, file.path, language(file.path) ?? category(file.path), file.sha256, file.bytes.byteLength, options.storageUri ? `${options.storageUri}/${file.path}` : null, JSON.stringify({ category: category(file.path) }), now);
  return { snapshotId, fileCount: files.length, manifestSha256 };
}
