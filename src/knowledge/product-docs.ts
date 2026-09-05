import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, relative, join } from "node:path";
import type { KnowledgeStore } from "./store.js";

export interface ProductDocumentImportOptions {
  root: string; product?: string; sampleManagerVersion: string; solution?: string; module?: string; language?: string; authority?: string; documentFamilyId?: string;
}
export interface ProductDocumentImportReport { runId: string; imported: number; unchanged: number; failed: number; warnings: string[]; documents: string[]; }
function files(root: string): string[] { const out: string[] = []; for (const entry of readdirSync(root)) { const path = join(root, entry); const stat = statSync(path); if (stat.isDirectory()) out.push(...files(path)); else if ([".md", ".markdown", ".html", ".htm", ".pdf"].includes(extname(entry).toLowerCase())) out.push(path); } return out; }
function title(path: string, body: string): string { const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim(); return heading || path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ""); }
function sections(body: string): Array<{ key: string; title: string; text: string }> { const matches = [...body.matchAll(/^(#{1,6})\s+(.+)$/gm)]; return matches.map((m, i) => ({ key: `${m[1].length}:${m[2].trim().toLowerCase().replace(/\W+/g, "-")}`, title: m[2].trim(), text: body.slice(m.index! + m[0].length, matches[i + 1]?.index ?? body.length).trim() })); }
export function importProductDocuments(store: KnowledgeStore, options: ProductDocumentImportOptions): ProductDocumentImportReport {
  const runId = `product-docs-${createHash("sha256").update(JSON.stringify(options)).digest("hex").slice(0, 16)}`;
  const report: ProductDocumentImportReport = { runId, imported: 0, unchanged: 0, failed: 0, warnings: [], documents: [] };
  const now = new Date().toISOString();
  store.db.prepare("INSERT OR IGNORE INTO knowledge_ingest_runs(id,source_locator,status,started_at) VALUES (?,?,?,?)").run(runId, `product-docs:${options.root}`, "running", now);
  for (const path of files(options.root)) {
    try {
      const ext = extname(path).toLowerCase(); const raw = readFileSync(path); const body = ext === ".pdf" ? `[PDF source: ${relative(options.root, path)}]` : raw.toString("utf8");
      const hash = createHash("sha256").update(raw).digest("hex"); const locator = `product-doc:${relative(options.root, path).replaceAll("\\", "/")}`;
      const id = `product-document-${hash}`; const family = options.documentFamilyId ?? `family-${relative(options.root, path).replace(/\.[^.]+$/, "").replace(/(?:[-_])?v?\d+(?:\.\d+)+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const existing = store.db.prepare("SELECT source_sha256 FROM knowledge_product_documents WHERE id = ?").get(id) as { source_sha256?: string } | undefined;
      if (existing) { report.unchanged++; report.documents.push(id); continue; }
      store.upsertDocument({ id, kind: "product_document", title: title(path, body), body, lifecycle: "approved", projectNameSnapshot: options.product, sampleManagerVersion: options.sampleManagerVersion, solution: options.solution, module: options.module, visibility: "global", scopeType: "version", scopeKey: options.sampleManagerVersion, locator, sha256: hash, createdAt: now, updatedAt: now });
      store.db.prepare(`INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,authority,source_path,source_sha256,version,sections_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sections_json=excluded.sections_json,updated_at=excluded.updated_at`).run(id, family, ext === ".pdf" ? "pdf" : ext === ".html" || ext === ".htm" ? "html" : "markdown", options.language ?? "en", options.authority ?? "official", relative(options.root, path), hash, options.sampleManagerVersion, JSON.stringify(sections(body)), now, now);
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


