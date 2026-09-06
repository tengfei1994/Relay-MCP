import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import { parse as parseYaml } from "yaml";
import { diffLines } from "diff";
import type { KnowledgeStore } from "./store.js";

const SUPPORTED = new Set([".md", ".markdown", ".html", ".htm", ".pdf"]);

export interface ProductDocumentImportOptions {
  root: string;
  product?: string;
  sampleManagerVersion: string;
  solution?: string;
  module?: string;
  language?: string;
  authority?: string;
  documentFamilyId?: string;
  manifestPath?: string;
  idempotencyKey?: string;
  sourceCommit?: string;
}

export interface ProductDocumentImportReport {
  runId: string;
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  imported: number;
  updated: number;
  unchanged: number;
  deprecated: number;
  failed: number;
  warnings: string[];
  errors: Array<{ path: string; error: string }>;
  documents: string[];
  items: Array<{ path: string; id?: string; status: string; warning?: string; error?: string }>;
}

interface ManifestRule {
  path?: string;
  glob?: string;
  product?: string;
  sampleManagerVersion?: string;
  solution?: string;
  module?: string;
  language?: string;
  authority?: string;
  documentFamilyId?: string;
  documentType?: string;
}

interface ParsedDocument {
  title: string;
  body: string;
  sections: Array<{ key: string; path: string; title: string; text: string; anchor: string }>;
  documentType: string;
  familyId: string;
  module?: string;
  confidence: number;
  reasons: string[];
  sourceFormat: string;
}

function sha256(content: Buffer | string): string { return createHash("sha256").update(content).digest("hex"); }
function safeJson(value: unknown, fallback: unknown): unknown { try { return JSON.parse(String(value ?? "")); } catch { return fallback; } }
function hasColumn(store: KnowledgeStore, table: string, column: string): boolean { return (store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column); }
function files(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const info = statSync(path);
    if (info.isDirectory()) result.push(...files(path));
    else if (SUPPORTED.has(extname(entry).toLowerCase())) result.push(path);
  }
  return result;
}
function htmlToText(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}
function pdfToText(raw: Buffer): string {
  // The Knowledge Plane must retain and index PDFs even when a native PDF
  // parser is unavailable. This extracts common literal PDF strings and keeps
  // the original bytes/hash as the authoritative source.
  const source = raw.toString("latin1");
  const literals = [...source.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)].map((match) => match[1]
    .replace(/\\([\\()])/g, "$1").replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t"));
  return literals.filter((value) => /[A-Za-z0-9]/.test(value)).join(" ").replace(/\s+/g, " ").trim() || `[PDF source: ${raw.length} bytes; text extraction unavailable]`;
}
function headingSections(body: string): Array<{ key: string; path: string; title: string; text: string; anchor: string }> {
  const matches = [...body.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  const stack: string[] = [];
  return matches.map((match, index) => {
    const depth = match[1].length;
    stack.splice(depth - 1);
    stack[depth - 1] = match[2].trim();
    const path = stack.filter(Boolean).join(" / ");
    const title = match[2].trim();
    const anchor = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return { key: `${depth}:${path.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, path, title, anchor, text: body.slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? body.length).trim() };
  });
}
function infer(relativePath: string, body: string, familyOverride?: string, typeOverride?: string, moduleOverride?: string): ParsedDocument {
  const lower = `${relativePath}\n${body.slice(0, 6000)}`.toLowerCase();
  const sourceFormat = extname(relativePath).slice(1).toLowerCase();
  const module = moduleOverride ?? ["samplemanager", "lims", "stability", "inventory", "quality", "environmental", "process", "security"].find((item) => lower.includes(item));
  const documentType = typeOverride ?? (sourceFormat === "pdf" ? "pdf" : /release\s*note|what['’]s\s*new|changelog/.test(lower) ? "release_notes" : /install|upgrade|deployment/.test(lower) ? "deployment_guide" : /api|reference|command/.test(lower) ? "reference" : "guide");
  const withoutVersion = relativePath.replace(/\.[^.]+$/, "").replace(/(?:[-_])?v?\d+(?:\.\d+)+$/i, "");
  const familyId = familyOverride ?? `family-${withoutVersion.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const reasons = [`document type inferred from ${sourceFormat || "source"}`];
  if (module) reasons.push(`module keyword '${module}' found in source`); else reasons.push("no known module keyword found");
  if (familyOverride) reasons.push("document family supplied by batch metadata or manifest"); else reasons.push("document family inferred from normalized source path");
  return { title: body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? relativePath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ""), body, sections: headingSections(body), documentType, familyId, module, confidence: module ? (familyOverride ? 0.95 : 0.82) : (familyOverride ? 0.75 : 0.58), reasons, sourceFormat };
}
function matchRule(relativePath: string, rules: ManifestRule[]): ManifestRule | undefined {
  return rules.find((rule) => rule.path === relativePath || rule.path === relativePath.replaceAll("\\", "/") || (rule.glob && new RegExp(`^${rule.glob.replace(/[.+^${}()|[\]\\*]/g, "\\$&").replace(/\\\*/g, ".*")}$`).test(relativePath)));
}
function loadManifest(root: string, explicit?: string): { defaults: ManifestRule; rules: ManifestRule[] } {
  const path = explicit ?? ["manifest.yaml", "manifest.yml"].map((name) => join(root, name)).find(existsSync);
  if (!path || !existsSync(path)) return { defaults: {}, rules: [] };
  const parsed = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown> | null;
  const defaults = (parsed?.defaults ?? parsed ?? {}) as ManifestRule;
  const documents = Array.isArray(parsed?.documents) ? parsed?.documents : [];
  return { defaults, rules: documents.filter((value): value is ManifestRule => Boolean(value && typeof value === "object")) };
}
function expandZip(path: string): string {
  const output = `${path}.expanded-${sha256(path).slice(0, 12)}`;
  mkdirSync(output, { recursive: true });
  const root = resolve(output);
  for (const [entry, content] of Object.entries(unzipSync(readFileSync(path)))) {
    const target = resolve(output, entry);
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`ZIP entry escapes extraction root: ${entry}`);
    if (entry.endsWith("/") || ![...SUPPORTED, ".yaml", ".yml"].includes(extname(entry).toLowerCase())) continue;
    mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, content);
  }
  return output;
}

export function importKnowledgeProducts(store: KnowledgeStore, options: ProductDocumentImportOptions): ProductDocumentImportReport {
  let root = resolve(options.root);
  let expanded: string | undefined;
  if (statSync(root).isFile() && extname(root).toLowerCase() === ".zip") { expanded = expandZip(root); root = expanded; }
  const loaded = loadManifest(root, options.manifestPath ? resolve(root, options.manifestPath) : undefined);
  const base = { ...loaded.defaults, ...options };
  if (!options.sampleManagerVersion) base.sampleManagerVersion = loaded.defaults.sampleManagerVersion ?? "";
  const runId = `product-docs-${sha256(JSON.stringify({ root, product: base.product, version: base.sampleManagerVersion, solution: base.solution, module: base.module, language: base.language, authority: base.authority, family: base.documentFamilyId, idempotencyKey: options.idempotencyKey ?? null })).slice(0, 20)}`;
  const now = new Date().toISOString();
  const report: ProductDocumentImportReport = { runId, status: "queued", imported: 0, updated: 0, unchanged: 0, deprecated: 0, failed: 0, warnings: [], errors: [], documents: [], items: [] };
  const hasBatchTables = Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_product_document_items'").get());
  const hasIdempotencyColumn = hasColumn(store, "knowledge_ingest_runs", "operation_idempotency_key");
  const existingRun = options.idempotencyKey && hasIdempotencyColumn ? store.db.prepare("SELECT id,status,imported,skipped,failed,error FROM knowledge_ingest_runs WHERE operation_idempotency_key = ?").get(options.idempotencyKey) as Record<string, unknown> | undefined : undefined;
  if (existingRun) return { ...report, runId: String(existingRun.id), status: String(existingRun.status) as ProductDocumentImportReport["status"], imported: Number(existingRun.imported ?? 0), unchanged: Number(existingRun.skipped ?? 0), failed: Number(existingRun.failed ?? 0), errors: safeJson(existingRun.error, []) as ProductDocumentImportReport["errors"] };
  const batchMeta = JSON.stringify({ product: base.product, sampleManagerVersion: base.sampleManagerVersion, solution: base.solution, module: base.module, language: base.language, authority: base.authority, documentFamilyId: base.documentFamilyId, manifestPath: options.manifestPath });
  if (hasIdempotencyColumn && hasColumn(store, "knowledge_ingest_runs", "batch_metadata_json") && hasColumn(store, "knowledge_ingest_runs", "source_root") && hasColumn(store, "knowledge_ingest_runs", "source_commit")) store.db.prepare("INSERT OR IGNORE INTO knowledge_ingest_runs(id,source_locator,status,started_at,operation_idempotency_key,batch_metadata_json,source_root,source_commit) VALUES (?,?,?,?,?,?,?,?)").run(runId, `product-docs:${options.root}`, "queued", now, options.idempotencyKey ?? null, batchMeta, root, options.sourceCommit ?? null);
  else store.db.prepare("INSERT OR IGNORE INTO knowledge_ingest_runs(id,source_locator,status,started_at) VALUES (?,?,?,?)").run(runId, `product-docs:${options.root}`, "queued", now);
  store.db.prepare("UPDATE knowledge_ingest_runs SET status=? WHERE id=?").run("running", runId); report.status = "running";
  const sourceHashes: string[] = [];
  try {
    if (!base.sampleManagerVersion) throw new Error("sampleManagerVersion is required (or provide it in manifest.yaml)");
    for (const path of files(root)) {
      const relativePath = relative(root, path).replaceAll("\\", "/");
      const rule = matchRule(relativePath, loaded.rules) ?? {};
      const local = { ...base, ...rule };
      const raw = readFileSync(path);
      const ext = extname(path).toLowerCase();
      const body = ext === ".pdf" ? pdfToText(raw) : ext === ".html" || ext === ".htm" ? htmlToText(raw.toString("utf8")) : raw.toString("utf8");
      const sourceHash = sha256(raw);
      sourceHashes.push(`${relativePath}:${sourceHash}`);
      const parsed = infer(relativePath, body, local.documentFamilyId, local.documentType, local.module);
      const familyId = parsed.familyId;
      const version = String(local.sampleManagerVersion);
      const id = `product-document-${sha256(`${familyId}\0${version}\0${relativePath}\0${sourceHash}`).slice(0, 32)}`;
      const existing = store.db.prepare("SELECT source_sha256 FROM knowledge_product_documents WHERE id = ?").get(id) as { source_sha256?: string } | undefined;
      if (existing) { report.unchanged++; report.documents.push(id); report.items.push({ path: relativePath, id, status: "unchanged" }); continue; }
      const prior = store.db.prepare("SELECT d.id,d.lifecycle FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE p.document_family_id=? AND p.version=? AND p.source_path=? AND d.id<>?").get(familyId, version, relativePath, id) as { id?: string; lifecycle?: string } | undefined;
      const createdAt = now;
      store.upsertDocument({ id, kind: "product_document", title: parsed.title, body, lifecycle: "approved", projectNameSnapshot: local.product, sampleManagerVersion: version, solution: local.solution, module: parsed.module, visibility: "global", scopeType: "version", scopeKey: version, locator: `product-doc:${relativePath}`, commit: options.sourceCommit, sha256: sourceHash, createdAt, updatedAt: createdAt });
      const metadata = { confidence: parsed.confidence, reasons: parsed.reasons, module: parsed.module, sourceFormat: parsed.sourceFormat, sourcePath: relativePath, sourceHash, manifestRule: rule };
      store.db.prepare(`INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,authority,source_path,source_sha256,version,sections_json,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(id, familyId, parsed.documentType, local.language ?? "en", local.authority ?? "official", relativePath, sourceHash, version, JSON.stringify(parsed.sections), JSON.stringify(metadata), createdAt, createdAt);
      if (prior?.id) { store.db.prepare("UPDATE knowledge_documents SET lifecycle='deprecated',updated_at=? WHERE id=? AND lifecycle<>'deprecated'").run(now, prior.id); report.deprecated++; }
      if (prior?.id) report.updated++; else report.imported++;
      report.documents.push(id); report.items.push({ path: relativePath, id, status: prior?.id ? "updated" : "imported" });
      if (hasBatchTables) store.db.prepare("INSERT OR REPLACE INTO knowledge_product_document_items(id,run_id,relative_path,document_id,status,source_sha256,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(`${runId}:${relativePath}`, runId, relativePath, id, prior?.id ? "updated" : "imported", sourceHash, JSON.stringify(metadata), now, now);
    }
    report.status = report.failed ? (report.imported || report.updated ? "partial" : "failed") : "succeeded";
  } catch (error) {
    report.failed++; report.status = "failed"; const message = error instanceof Error ? error.message : String(error); report.errors.push({ path: options.root, error: message }); report.warnings.push(message);
  } finally {
    const aggregateSourceHash = sourceHashes.length ? sha256(sourceHashes.sort().join("\n")) : null;
    if (hasColumn(store, "knowledge_ingest_runs", "source_sha256")) store.db.prepare("UPDATE knowledge_ingest_runs SET status=?,imported=?,skipped=?,failed=?,finished_at=?,error=?,source_sha256=COALESCE(?,source_sha256) WHERE id=?").run(report.status, report.imported + report.updated, report.unchanged, report.failed, new Date().toISOString(), report.errors.length ? JSON.stringify(report.errors) : report.warnings.length ? JSON.stringify(report.warnings) : null, aggregateSourceHash, runId);
    else store.db.prepare("UPDATE knowledge_ingest_runs SET status=?,imported=?,skipped=?,failed=?,finished_at=?,error=? WHERE id=?").run(report.status, report.imported + report.updated, report.unchanged, report.failed, new Date().toISOString(), report.errors.length ? JSON.stringify(report.errors) : report.warnings.length ? JSON.stringify(report.warnings) : null, runId);
    if (expanded) rmSync(expanded, { recursive: true, force: true });
  }
  return report;
}

export interface ProductDocumentSearchRequest { query?: string; sampleManagerVersion?: string; product?: string; solution?: string; module?: string; documentType?: string; language?: string; authority?: string; limit?: number; includeDeprecated?: boolean; }
export function searchKnowledgeProducts(store: KnowledgeStore, request: ProductDocumentSearchRequest): Array<Record<string, unknown>> {
  const conditions = ["d.kind='product_document'"]; const params: Record<string, unknown> = {};
  const filters: Array<[string, string, string]> = [["d.samplemanager_version", "sampleManagerVersion", "version"], ["d.project_name_snapshot", "product", "product"], ["d.solution", "solution", "solution"], ["d.module", "module", "module"], ["p.document_type", "documentType", "documentType"], ["p.language", "language", "language"], ["p.authority", "authority", "authority"]];
  for (const [column, key] of filters) { const value = request[key as keyof ProductDocumentSearchRequest]; if (value) { conditions.push(`${column}=@${key}`); params[key] = value; } }
  if (!request.includeDeprecated) conditions.push("d.lifecycle<>'deprecated'");
  const limit = Math.max(1, Math.min(500, Math.trunc(request.limit ?? 50)));
  let rows: Array<Record<string, unknown>> = [];
  if (request.query?.trim()) {
    const tokens = request.query.trim().split(/\s+/).filter(Boolean).slice(0, 24).map((value) => `"${value.replaceAll('"', '""')}"`);
    params.match = tokens.join(" OR ");
    try { rows = store.db.prepare(`SELECT d.id,d.title,d.lifecycle,d.samplemanager_version,d.solution,d.module,d.project_name_snapshot,d.source_locator,d.source_commit,d.source_sha256,d.created_at,d.updated_at,p.document_family_id,p.document_type,p.language,p.authority,p.source_path,p.version,p.sections_json,p.metadata_json,p.diff_review_status,snippet(knowledge_fts,2,'<mark>','</mark>','…',36) AS snippet,bm25(knowledge_fts) AS rank FROM knowledge_fts JOIN knowledge_documents d ON d.id=knowledge_fts.document_id JOIN knowledge_product_documents p ON p.id=d.id WHERE knowledge_fts MATCH @match AND ${conditions.join(" AND ")} GROUP BY d.id ORDER BY rank LIMIT ${limit}`).all(params) as Array<Record<string, unknown>>; } catch {
      const likeTerms = request.query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
      const like = likeTerms.map((_, index) => `(lower(d.title) LIKE @like${index} OR lower(d.body) LIKE @like${index})`).join(" OR ");
      likeTerms.forEach((term, index) => { params[`like${index}`] = `%${term.toLowerCase()}%`; });
      rows = like ? store.db.prepare(`SELECT d.id,d.title,d.lifecycle,d.samplemanager_version,d.solution,d.module,d.project_name_snapshot,d.source_locator,d.source_commit,d.source_sha256,d.created_at,d.updated_at,p.document_family_id,p.document_type,p.language,p.authority,p.source_path,p.version,p.sections_json,p.metadata_json,p.diff_review_status,d.body AS snippet,0 AS rank FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE (${like}) AND ${conditions.join(" AND ")} ORDER BY d.updated_at DESC LIMIT ${limit}`).all(params) as Array<Record<string, unknown>> : [];
    }
  } else rows = store.db.prepare(`SELECT d.id,d.title,d.lifecycle,d.samplemanager_version,d.solution,d.module,d.project_name_snapshot,d.source_locator,d.source_commit,d.source_sha256,d.created_at,d.updated_at,p.document_family_id,p.document_type,p.language,p.authority,p.source_path,p.version,p.sections_json,p.metadata_json,p.diff_review_status FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE ${conditions.join(" AND ")} ORDER BY d.updated_at DESC LIMIT ${limit}`).all(params) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const sections = safeJson(row.sections_json, []) as Array<Record<string, unknown>>;
    const firstSection = Array.isArray(sections) ? sections[0] : undefined;
    return {
      ...row,
      summary: String(row.snippet ?? row.title ?? ""),
      sectionPath: firstSection?.path ? String(firstSection.path) : undefined,
      sectionTitle: firstSection?.title ? String(firstSection.title) : undefined,
      sectionAnchor: firstSection?.anchor ? String(firstSection.anchor) : undefined,
      sections,
      metadata: safeJson(row.metadata_json, {}),
    };
  });
}

export type ProductDiffStatus = "unchanged" | "added" | "removed" | "modified" | "moved" | "renamed" | "metadata_only";
export interface ProductDocumentDiff { leftId: string; rightId: string; leftVersion?: string; rightVersion?: string; leftSourceSha256?: string; rightSourceSha256?: string; changes: Array<{ key: string; path?: string; status: ProductDiffStatus; left?: unknown; right?: unknown; textDiff?: Array<{ value: string; added?: boolean; removed?: boolean }> }>; reviewStatus: string; }
export function diffKnowledgeProducts(store: KnowledgeStore, leftId: string, rightId: string): ProductDocumentDiff {
  const load = (id: string) => { const row = store.db.prepare("SELECT p.document_family_id,p.version,p.source_sha256,d.source_commit,d.source_sha256 AS document_source_sha256,p.sections_json,p.metadata_json,p.diff_review_status FROM knowledge_product_documents p JOIN knowledge_documents d ON d.id=p.id WHERE p.id=?").get(id) as Record<string, unknown> | undefined; if (!row) throw new Error("Product document not found"); const value = safeJson(row.sections_json, []) as Array<Record<string, unknown>>; return { familyId: String(row.document_family_id ?? ""), version: String(row.version ?? ""), sourceSha256: String(row.source_sha256 ?? row.document_source_sha256 ?? ""), sections: new Map(value.map((section) => [String(section.key), section])), metadata: safeJson(row.metadata_json, {}), reviewStatus: String(row.diff_review_status ?? "not_reviewed") }; };
  const left = load(leftId), right = load(rightId); const keys = [...new Set([...left.sections.keys(), ...right.sections.keys()])].sort();
  if (!left.familyId || left.familyId !== right.familyId) throw new Error("Product document diff requires the same document family");
  const changes: ProductDocumentDiff["changes"] = keys.map((key) => { const a = left.sections.get(key), b = right.sections.get(key); if (!a) return { key, path: String(b?.path ?? ""), status: "added", right: b }; if (!b) return { key, path: String(a?.path ?? ""), status: "removed", left: a }; const textDiff = diffLines(String(a.text ?? ""), String(b.text ?? "")).map((part) => ({ value: part.value, ...(part.added ? { added: true } : {}), ...(part.removed ? { removed: true } : {}) })); const same = JSON.stringify(a) === JSON.stringify(b); return { key, path: String(b.path ?? a.path ?? ""), status: same ? "unchanged" : "modified", left: a, right: b, ...(same ? {} : { textDiff }) }; });
  const removed = changes.filter((change) => change.status === "removed"); const added = changes.filter((change) => change.status === "added");
  for (const oldChange of removed) { const match = added.find((candidate) => String((candidate.right as Record<string, unknown> | undefined)?.text ?? "") === String((oldChange.left as Record<string, unknown> | undefined)?.text ?? "")); if (!match) continue; oldChange.status = String((oldChange.left as Record<string, unknown> | undefined)?.title ?? "") === String((match.right as Record<string, unknown> | undefined)?.title ?? "") ? "moved" : "renamed"; match.status = "metadata_only"; }
  const report = { leftId, rightId, leftVersion: left.version, rightVersion: right.version, leftSourceSha256: left.sourceSha256, rightSourceSha256: right.sourceSha256, changes, reviewStatus: right.reviewStatus };
  const revisionId = `product-revision-${sha256(`${leftId}\0${rightId}`).slice(0, 24)}`;
  if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_product_document_revisions'").get()) store.db.prepare("INSERT INTO knowledge_product_document_revisions(id,document_id,against_document_id,report_json,review_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(document_id,against_document_id) DO UPDATE SET report_json=excluded.report_json,updated_at=excluded.updated_at").run(revisionId, rightId, leftId, JSON.stringify(report), right.reviewStatus, new Date().toISOString(), new Date().toISOString());
  return report;
}

export function updateProductDocumentLifecycle(store: KnowledgeStore, id: string, lifecycle: "approved" | "deprecated", now = new Date().toISOString()): Record<string, unknown> {
  const row = store.db.prepare("SELECT lifecycle FROM knowledge_documents WHERE id=? AND kind='product_document'").get(id) as { lifecycle?: string } | undefined;
  if (!row) throw new Error("Product document not found");
  if (row.lifecycle === lifecycle) return { id, lifecycle, changed: false, updatedAt: now };
  if (lifecycle === "approved" && row.lifecycle !== "draft" && row.lifecycle !== "verified" && row.lifecycle !== "reproduced") throw new Error(`Cannot publish product document from ${row.lifecycle}`);
  store.db.prepare("UPDATE knowledge_documents SET lifecycle=?,updated_at=? WHERE id=?").run(lifecycle, now, id);
  return { id, lifecycle, changed: true, updatedAt: now };
}
