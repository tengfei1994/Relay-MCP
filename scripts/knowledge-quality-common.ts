import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Row = Record<string, unknown>;
export class QualityError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function requireQuality(condition: unknown, code: string): asserts condition {
  if (!condition) throw new QualityError(code);
}
export const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
export const text = (value: unknown): string => typeof value === "string" ? value : "";
export const nullable = (value: unknown): string | null => text(value).trim() || null;
export function record(value: unknown): Row {
  requireQuality(Boolean(value) && typeof value === "object" && !Array.isArray(value), "invalid_object");
  return value as Row;
}
export function argumentsFor(allowed: string[]): Map<string, string> {
  const result = new Map<string, string>(), args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    requireQuality(allowed.includes(args[i]) && args[i + 1] !== undefined && !result.has(args[i]), "invalid_arguments");
    result.set(args[i], args[i + 1]);
  }
  return result;
}
export const NONPROD_ROOT = "/home/ftd/relay-knowledge-engine-nonprod";
export function isolatedPath(value: string | undefined, output = false): string {
  requireQuality(process.env.RELAY_QUALITY_ISOLATED === "1" && process.platform === "linux", "explicit_nonproduction_mode_required");
  requireQuality(value && path.isAbsolute(value), "absolute_path_required");
  const root = fs.realpathSync(NONPROD_ROOT);
  requireQuality(root === NONPROD_ROOT, "nonproduction_root_symlink_rejected");
  const resolved = output ? path.join(fs.realpathSync(path.dirname(value)), path.basename(value)) : fs.realpathSync(value);
  requireQuality(resolved.startsWith(root + path.sep), "path_outside_nonproduction_root");
  requireQuality(!output || !fs.existsSync(resolved), "output_already_exists");
  return resolved;
}
export function openReadOnly(file: string): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}
export function readJson(file: string): unknown {
  requireQuality(fs.statSync(file).size <= 128 * 1024 * 1024, "input_too_large");
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as unknown; }
  catch { throw new QualityError("invalid_json"); }
}
export function savePrivate(file: string, value: unknown): { path: string; sha256: string; bytes: number } {
  const data = JSON.stringify(value, null, 2) + "\n";
  fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 });
  return { path: file, sha256: sha(data), bytes: Buffer.byteLength(data) };
}
/** Diagnostics never include SQL, source bodies, queries or underlying exception messages. */
export function safeFailure(error: unknown): void {
  process.stderr.write(JSON.stringify({ status: "failed", code: error instanceof QualityError ? error.code : "unexpected_error_no_content_logged" }) + "\n");
  process.exitCode = 1;
}
export interface Source {
  sourceDbId?: string; sourceMetadataSha256?: string; sectionsSha256?: string;
  id: string; title: string; body: string; bodySha256: string; sourceSha256: string;
  sourcePath: string; version: string | null; solution: string | null; module: string | null;
  language: string | null; projectId: string | null; environment: string | null; lifecycle: string;
  parserVersion: string | null; sourceFormat: string | null; citationSha256: string;
}
export function loadSources(db: Database.Database, selectedIds?: string[]): Source[] {
  const sql = "SELECT d.id,d.title,d.body,d.lifecycle,d.project_id,d.environment,d.samplemanager_version,d.solution,d.module,p.version,p.language,p.source_path,p.source_sha256,p.metadata_json,p.sections_json FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id ";
  const statement = db.prepare(sql + (selectedIds ? " WHERE d.id=?" : " ORDER BY d.id"));
  const rows = selectedIds ? selectedIds.map(id => statement.get(id)).filter(Boolean) as Row[] : statement.all() as Row[];
  return rows.map(row => {
    let metadata: Row = {};
    try { metadata = record(JSON.parse(text(row.metadata_json) || "{}")); } catch { /* Source metadata coverage is reported separately. */ }
    const id = text(row.id), sourcePath = text(row.source_path), sourceSha256 = text(row.source_sha256);
    return { id, sourceMetadataSha256: sha(text(row.metadata_json) || "{}"), sectionsSha256: sha(text(row.sections_json) || "[]"), title: text(row.title), body: text(row.body), bodySha256: sha(text(row.body)), sourceSha256, sourcePath,
      version: nullable(row.version) ?? nullable(row.samplemanager_version), solution: nullable(row.solution), module: nullable(row.module),
      language: nullable(row.language), projectId: nullable(row.project_id), environment: nullable(row.environment), lifecycle: text(row.lifecycle),
      parserVersion: nullable(metadata.parserVersion), sourceFormat: nullable(metadata.sourceFormat),
      citationSha256: sha(JSON.stringify([id, sourcePath, sourceSha256])) };
  });
}
export function selectFrozenSources(all: Source[], value: unknown): Source[] {
  const outer = record(value), manifest = outer.sourceManifest ? record(outer.sourceManifest) : outer;
  requireQuality(Array.isArray(manifest.documents) && manifest.documents.length > 0, "source_manifest_documents_required");
  const byId = new Map(all.map(source => [source.id, source])), seen = new Set<string>();
  const selected = manifest.documents.map(value => {
    const row = record(value), id = text(row.localDocumentId) || text(row.id), source = byId.get(id);
    requireQuality(source && !seen.has(id), "manifest_unknown_or_duplicate_source");
    seen.add(id);
    const bodySha256 = text(row.bodySha256) || text(row.normalizedBodySha256);
    requireQuality(/^[a-f0-9]{64}$/.test(bodySha256) && bodySha256 === source.bodySha256, "manifest_body_hash_mismatch");
    requireQuality(/^[a-f0-9]{64}$/.test(text(row.sourceSha256)) && row.sourceSha256 === source.sourceSha256, "manifest_raw_hash_mismatch");
    requireQuality(row.sourcePath === source.sourcePath, "manifest_source_path_mismatch");
    requireQuality((nullable(row.productVersion) ?? nullable(row.version)) === source.version, "manifest_version_mismatch");
    requireQuality(nullable(row.projectId) === source.projectId && nullable(row.environment) === source.environment, "manifest_scope_mismatch");
    for (const key of ["language", "solution", "module"] as const) {
      if (Object.hasOwn(row, key)) requireQuality(nullable(row[key]) === source[key], "manifest_metadata_mismatch");
    }
    requireQuality(["approved", "published", "active"].includes(source.lifecycle), "source_not_approved_active_or_published");
    return source;
  });
  return selected.sort((a, b) => a.id.localeCompare(b.id));
}
export function sourceFingerprint(sources: Source[]): string {
  return sha(JSON.stringify(sources.map(source => [
    source.id, source.bodySha256, source.sourceSha256, source.sourcePath, source.version,
    source.projectId, source.environment, source.language, source.solution, source.module, source.parserVersion,
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))));
}
export function countBy(values: Array<string | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value ?? "(absent)"] = (out[value ?? "(absent)"] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
export interface CodeBlock { language: string; content: string; sha256: string; }
export function codeBlocks(body: string): CodeBlock[] {
  // CommonMark fences: closing delimiter has same character and at least opener length.
  const lines = body.replace(/\r\n/g, "\n").split("\n"), result: CodeBlock[] = [];
  let open: { delimiter: string; size: number; language: string; content: string[] } | undefined;
  for (const line of lines) {
    if (!open) {
      const match = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
      if (match && !(match[1][0] === "\x60" && match[2].includes("\x60"))) {
        open = { delimiter: match[1][0], size: match[1].length, language: match[2].trim().split(/\s+/)[0].toLowerCase(), content: [] };
      }
    } else {
      const closing = /^ {0,3}(\x60+|~+)\s*$/.exec(line);
      if (closing && closing[1][0] === open.delimiter && closing[1].length >= open.size) {
        const content = open.content.join("\n");
        result.push({ language: open.language, content, sha256: sha(content) });
        open = undefined;
      } else open.content.push(line);
    }
  }
  if (open) {
    const content = open.content.join("\n");
    result.push({ language: open.language, content, sha256: sha(content) });
  }
  return result;
}
export function parseReferences(value: unknown): { values: string[]; malformed: boolean } {
  try {
    const encoded = Buffer.isBuffer(value) ? value.toString("utf8") : value;
    const parsed = typeof encoded === "string" ? JSON.parse(encoded) as unknown : encoded;
    if (parsed == null) return { values: [], malformed: false };
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string" || !item.trim())) return { values: [], malformed: true };
    return { values: [...new Set(parsed as string[])], malformed: false };
  } catch { return { values: [], malformed: true }; }
}
export function sameOrGlobal(source: Pick<Source, "projectId" | "environment">, context: Pick<Source, "projectId" | "environment">): boolean {
  return (!source.projectId && !source.environment) || (source.projectId === context.projectId && source.environment === context.environment);
}

/** Frozen planning manifest projects immutable bulk sources to intended target IDs/scope.
 * This is not evidence that those targets have been imported or indexed. */
export function projectFrozenJsonl(sources: Source[], rows: Row[]): Source[] {
  requireQuality(rows.length > 0, "empty_frozen_projection");
  const byId = new Map(sources.map(source => [source.id, source])), targets = new Set<string>(), originals = new Set<string>();
  return rows.map(row => {
    const originalId = text(row.bulkSourceId), targetId = text(row.targetLocalId), source = byId.get(originalId);
    requireQuality(source && targetId && !targets.has(targetId) && !originals.has(originalId), "projection_unknown_or_duplicate_identity");
    targets.add(targetId); originals.add(originalId);
    requireQuality(source.bodySha256 === row.bodySha256, "projection_body_hash_mismatch");
    requireQuality(source.sourceSha256 === row.rawSha256 && /^[a-f0-9]{64}$/.test(source.sourceSha256), "projection_raw_hash_mismatch");
    requireQuality(source.sourcePath === row.sourcePath && source.version === nullable(row.version), "projection_source_metadata_mismatch");
    requireQuality(source.sourceMetadataSha256 === row.sourceMetadataSha256 && source.sectionsSha256 === row.sectionsSha256, "projection_structure_hash_mismatch");
    for (const key of ["language", "solution", "module"] as const)
      requireQuality(source[key] === nullable(row[key]), "projection_source_metadata_mismatch");
    const projectId = nullable(row.projectId), environment = nullable(row.environment);
    requireQuality(Boolean(projectId) && Boolean(environment) && environment!.startsWith("nonprod"), "projection_nonproduction_scope_required");
    return { ...source, id: targetId, sourceDbId: originalId, projectId, environment,
      citationSha256: sha(JSON.stringify([targetId, source.sourcePath, source.sourceSha256])) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
