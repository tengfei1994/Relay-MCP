import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { extname, relative, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { unzipSync } from "fflate";
import { PDFParse } from "pdf-parse";
import type { KnowledgeStore } from "./store.js";

export interface ProductDocumentImportOptions {
  root: string; product?: string; sampleManagerVersion: string; solution?: string; module?: string; language?: string; authority?: string; documentFamilyId?: string; manifestPath?: string;
}
export interface ProductDocumentImportReport { runId: string; imported: number; unchanged: number; failed: number; warnings: string[]; documents: string[]; }
type InferredMetadata = { module?: string; documentType: string; documentFamilyId: string; confidence: number; reasons: string[] };
function files(root: string): string[] { const out: string[] = []; for (const entry of readdirSync(root)) { const path = join(root, entry); const stat = statSync(path); if (stat.isDirectory()) out.push(...files(path)); else if ([".md", ".markdown", ".html", ".htm", ".pdf"].includes(extname(entry).toLowerCase())) out.push(path); } return out; }
function title(path: string, body: string): string { const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim(); return heading || path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ""); }
function sections(body: string): Array<{ key: string; title: string; text: string }> { const matches = [...body.matchAll(/^(#{1,6})\s+(.+)$/gm)]; return matches.map((m, i) => ({ key: `${m[1].length}:${m[2].trim().toLowerCase().replace(/\W+/g, "-")}`, title: m[2].trim(), text: body.slice(m.index! + m[0].length, matches[i + 1]?.index ?? body.length).trim() })); }
function inferMetadata(path: string, body: string, explicitFamily?: string): InferredMetadata {
  const normalized = `${path}\n${body.slice(0, 4000)}`.toLowerCase();
  const module = ["samplemanager", "lims", "stability", "inventory", "quality", "environmental", "process", "security"].find((candidate) => normalized.includes(candidate));
  const documentType = path.toLowerCase().endsWith(".pdf") ? "pdf" : /release\s*note|what's\s*new|changelog/.test(normalized) ? "release_notes" : /install|upgrade|deployment/.test(normalized) ? "deployment_guide" : /api|reference|command/.test(normalized) ? "reference" : "guide";
  const family = explicitFamily ?? `family-${path.replace(/\.[^.]+$/, "").replace(/(?:[-_])?v?\d+(?:\.\d+)+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const reasons = [`document type inferred from ${path.toLowerCase().endsWith(".pdf") ? "file extension" : "filename and content"}`];
  if (module) reasons.push(`module keyword '${module}' found in source`); else reasons.push("no known module keyword found");
  return { module, documentType, documentFamilyId: family, confidence: module ? 0.82 : 0.58, reasons };
}
export async function importProductDocuments(store: KnowledgeStore, options: ProductDocumentImportOptions): Promise<ProductDocumentImportReport> {
  if (statSync(options.root).isFile() && extname(options.root).toLowerCase() === ".zip") {
    const expanded = `${options.root}.expanded-${createHash("sha256").update(options.root).digest("hex").slice(0, 12)}`;
    mkdirSync(expanded, { recursive: true });
    try {
      const archive = unzipSync(readFileSync(options.root));
      const rootResolved = resolve(expanded);
      for (const [entry, content] of Object.entries(archive)) {
        const target = resolve(expanded, entry);
        if (target !== rootResolved && !target.startsWith(rootResolved + sep)) throw new Error(`ZIP entry escapes extraction root: ${entry}`);
        if (entry.endsWith("/")) continue;
        const extension = extname(entry).toLowerCase();
        if (![".md", ".markdown", ".html", ".htm", ".pdf", ".yaml", ".yml"].includes(extension)) continue;
        mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, content);
      }
      return await importProductDocuments(store, { ...options, root: expanded, manifestPath: options.manifestPath ? resolve(expanded, options.manifestPath) : undefined });
    } finally { rmSync(expanded, { recursive: true, force: true }); }
  }
  const runId = `product-docs-${createHash("sha256").update(JSON.stringify(options)).digest("hex").slice(0, 16)}`;
  const report: ProductDocumentImportReport = { runId, imported: 0, unchanged: 0, failed: 0, warnings: [], documents: [] };
  const now = new Date().toISOString();
  let manifest: Record<string, unknown> = {};
  const manifestFile = options.manifestPath ?? join(options.root, "manifest.yaml");
  try { if (statSync(manifestFile).isFile()) manifest = parseYaml(readFileSync(manifestFile, "utf8")) as Record<string, unknown> ?? {}; } catch { /* manifest is optional */ }
  const defaults = {
    product: options.product ?? (typeof manifest.product === "string" ? manifest.product : undefined),
    sampleManagerVersion: options.sampleManagerVersion || (manifest.sampleManagerVersion === undefined ? "" : String(manifest.sampleManagerVersion)),
    solution: options.solution ?? (typeof manifest.solution === "string" ? manifest.solution : undefined),
    module: options.module ?? (typeof manifest.module === "string" ? manifest.module : undefined),
    language: options.language ?? (typeof manifest.language === "string" ? manifest.language : undefined),
    authority: options.authority ?? (typeof manifest.authority === "string" ? manifest.authority : undefined),
    documentFamilyId: options.documentFamilyId,
  };
  if (!defaults.sampleManagerVersion) throw new Error("sampleManagerVersion is required (or provide it in manifest.yaml)");
  store.db.prepare("INSERT OR IGNORE INTO knowledge_ingest_runs(id,source_locator,status,started_at) VALUES (?,?,?,?)").run(runId, `product-docs:${options.root}`, "running", now);
  for (const path of files(options.root)) {
    try {
      const ext = extname(path).toLowerCase(); const raw = readFileSync(path); let body = raw.toString("utf8");
      if (ext === ".pdf") { const parser = new PDFParse({ data: raw }); try { body = (await parser.getText()).text; } finally { await parser.destroy(); } }
      const hash = createHash("sha256").update(raw).digest("hex"); const locator = `product-doc:${relative(options.root, path).replaceAll("\\", "/")}`;
      const id = `product-document-${hash}`; const inferred = inferMetadata(relative(options.root, path), body, defaults.documentFamilyId);
      const existing = store.db.prepare("SELECT source_sha256 FROM knowledge_product_documents WHERE id = ?").get(id) as { source_sha256?: string } | undefined;
      if (existing) { report.unchanged++; report.documents.push(id); continue; }
      store.upsertDocument({ id, kind: "product_document", title: title(path, body), body, lifecycle: "approved", projectNameSnapshot: defaults.product, sampleManagerVersion: defaults.sampleManagerVersion, solution: defaults.solution, module: defaults.module ?? inferred.module, visibility: "global", scopeType: "version", scopeKey: defaults.sampleManagerVersion, locator, sha256: hash, createdAt: now, updatedAt: now });
      store.db.prepare(`INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,authority,source_path,source_sha256,version,sections_json,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sections_json=excluded.sections_json,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`).run(id, inferred.documentFamilyId, inferred.documentType, defaults.language ?? "en", defaults.authority ?? "official", relative(options.root, path), hash, defaults.sampleManagerVersion, JSON.stringify(sections(body)), JSON.stringify({ ...inferred, module: defaults.module ?? inferred.module, explicit: defaults }), now, now);
      report.imported++; report.documents.push(id);
    } catch (error) { report.failed++; report.warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  store.db.prepare("UPDATE knowledge_ingest_runs SET status=?,imported=?,skipped=?,failed=?,finished_at=?,error=? WHERE id=? AND status='running'")
    .run(report.failed ? (report.imported ? "partial" : "failed") : "succeeded", report.imported, report.unchanged, report.failed, new Date().toISOString(), report.warnings.length ? JSON.stringify(report.warnings) : null, runId);
  return report;
}
export function productDocumentDiff(store: KnowledgeStore, leftId: string, rightId: string): { leftId: string; rightId: string; changes: Array<{ key: string; status: "added" | "removed" | "modified" | "unchanged" | "moved" | "renamed" | "metadata_only"; left?: unknown; right?: unknown }> } {
  const load = (id: string) => { const row = store.db.prepare("SELECT sections_json FROM knowledge_product_documents WHERE id = ?").get(id) as { sections_json?: string } | undefined; try { return new Map((JSON.parse(row?.sections_json ?? "[]") as Array<{ key: string }>).map((s: any) => [s.key, s])); } catch { return new Map(); } };
  const left = load(leftId), right = load(rightId); const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changes: Array<{ key: string; status: "added" | "removed" | "modified" | "unchanged" | "moved" | "renamed" | "metadata_only"; left?: unknown; right?: unknown }> = keys.map((key) => { const l = left.get(key), r = right.get(key); if (!l) return { key, status: "added" as const, right: r }; if (!r) return { key, status: "removed" as const, left: l }; return { key, status: JSON.stringify(l) === JSON.stringify(r) ? "unchanged" as const : "modified" as const, left: l, right: r }; });
  const unmatchedLeft = changes.filter((c) => c.status === "removed");
  const unmatchedRight = changes.filter((c) => c.status === "added");
  for (const removed of unmatchedLeft) {
    const match = unmatchedRight.find((added) => JSON.stringify(removed.left && (removed.left as any).text) === JSON.stringify(added.right && (added.right as any).text));
    if (!match) continue;
    const oldTitle = String((removed.left as any)?.title ?? ""); const newTitle = String((match.right as any)?.title ?? "");
    removed.status = oldTitle === newTitle ? "moved" : "renamed";
    match.status = "metadata_only";
  }
  return { leftId, rightId, changes };
}


