import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync, openSync, closeSync, readSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join, relative, resolve, sep } from "node:path";
import { Unzip, UnzipInflate } from "fflate";
import { parse as parseYaml } from "yaml";
import { diffLines } from "diff";
import type { KnowledgeStore } from "./store.js";
import type { KnowledgeDocument } from "./domain.js";
import { parseHelpHtml, parseToc, parsePdfBytes, type ParsedHelpHtml } from "./parsers.js";
import { resolveChmExtractor, chmExtractionArguments } from "./chm-extractor.js";

const SUPPORTED = new Set([".md", ".markdown", ".html", ".htm", ".pdf", ".chm"]);

export interface ProductDocumentImportOptions {
  onProgress?: (progress: { runId: string; processed: number; total: number; imported: number; unchanged: number; currentFile?: string }) => void;
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
  /** Async worker supplied real PDF text; sync callers retain bounded fallback behavior. */
  pdfText?: Record<string, string>;
}

export interface ProductDocumentImportReport {
  runId: string;
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  imported: number;
  updated: number;
  unchanged: number;
  deprecated: number;
  failed: number;
  parsing?: { pdfFiles: number; chmArchives: number; chmHtmlFiles: number; zipArchives: number };
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
  stableIdentifiers: Record<string, string>;
}

export const HTML_PARSER_VERSION = "html-3";

function sha256(content: Buffer | string): string { return createHash("sha256").update(content).digest("hex"); }
function safeJson(value: unknown, fallback: unknown): unknown { try { return JSON.parse(String(value ?? "")); } catch { return fallback; } }
function hasColumn(store: KnowledgeStore, table: string, column: string): boolean { return (store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column); }
/** Advance the current version pointer only along the same source lineage. */
function advanceCurrentProductBinding(store: KnowledgeStore, documentId: string, familyId: string, version: string, sourcePath: string, now: string): boolean {
  // Preserve the binding's identity and reviewed matching metadata. The old
  // document and revision remain addressable; only the current pointer moves.
  // A replay of a deprecated source must not roll a later current source back.
  store.db.prepare(`UPDATE knowledge_product_document_bindings
    SET document_id=?,updated_at=?
    WHERE document_id<>? AND product_version=? AND source_path=?
      AND EXISTS (SELECT 1 FROM knowledge_product_documents previous
        WHERE previous.id=knowledge_product_document_bindings.document_id
          AND previous.document_family_id=? AND previous.version=? AND previous.source_path=?)
      AND EXISTS (SELECT 1 FROM knowledge_documents current WHERE current.id=? AND current.lifecycle<>'deprecated')
      AND NOT EXISTS (SELECT 1 FROM knowledge_product_document_bindings assigned WHERE assigned.document_id=?)`)
    .run(documentId, now, documentId, version, sourcePath, familyId, version, sourcePath, documentId, documentId);
  return Boolean(store.db.prepare("SELECT 1 FROM knowledge_product_document_bindings WHERE document_id=?").get(documentId));
}

function files(root: string): string[] {
  const result: string[] = [];
  if (statSync(root).isFile()) return [root];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const info = statSync(path);
    if (info.isDirectory()) result.push(...files(path));
    else if (SUPPORTED.has(extname(entry).toLowerCase()) || (extname(entry).toLowerCase() === ".js" && /(?:^|[\\/])(?:_toc|Data[\\/]Tocs)(?:[\\/]|$)/i.test(relative(root, path)))) result.push(path);
  }
  return result;
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
  const matches: Array<{depth:number;title:string;index:number;length:number;anchor?:string}> = [];
  let offset=0,fence:string|undefined,anchor:string|undefined;
  for(const line of body.split(/(?<=\n)/)){
    const bare=line.replace(/\r?\n$/,"");
    const delimiter=bare.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if(fence){if(delimiter&&delimiter[1][0]===fence[0]&&delimiter[1].length>=fence.length&&!delimiter[2].trim())fence=undefined;}
    else if(delimiter){fence=delimiter[1];anchor=undefined;}
    else{
      const explicit=bare.match(/^\s*<a\s+id="([^"]+)"\s*><\/a>\s*$/i),heading=bare.match(/^(#{1,6})\s+(.+)$/);
      if(explicit)anchor=explicit[1].replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
      else if(heading){matches.push({depth:heading[1].length,title:heading[2].trim(),index:offset,length:bare.length,anchor});anchor=undefined;}
      else if(bare.trim())anchor=undefined;
    }
    offset+=line.length;
  }
  const stack: string[] = [];
  return matches.map((match, index) => {
    const depth = match.depth;
    stack.splice(depth - 1);
    stack[depth - 1] = match.title;
    const path = stack.filter(Boolean).join(" / ");
    const title = match.title;
    const anchor = match.anchor??title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return { key: `${depth}:${path.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, path, title, anchor, text: body.slice(match.index + match.length, matches[index + 1]?.index ?? body.length).trim() };
  });
}
function infer(relativePath: string, body: string, familyOverride?: string, typeOverride?: string, moduleOverride?: string, sourceMarkup?: string, htmlMetadata?: ParsedHelpHtml): ParsedDocument {
  const lower = `${relativePath}\n${body.slice(0, 6000)}`.toLowerCase();
  const sourceFormat = extname(relativePath).slice(1).toLowerCase();
  const module = moduleOverride ?? ["samplemanager", "lims", "stability", "inventory", "quality", "environmental", "process", "security"].find((item) => lower.includes(item));
  const documentType = typeOverride ?? (sourceFormat === "pdf" ? "pdf" : /release\s*note|what['’]s\s*new|changelog/.test(lower) ? "release_notes" : /install|upgrade|deployment/.test(lower) ? "deployment_guide" : /api|reference|command/.test(lower) ? "reference" : "guide");
  const stableIdentifiers: Record<string, string> = {...htmlMetadata?.stableIdentifiers};
  for (const match of (sourceMarkup ?? "").matchAll(/<meta\s+[^>]*name=["']([^"']+)["'][^>]*content=["']([^"']*)["'][^>]*>/gi)) {
    const key = match[1].toLowerCase();
    if (["ait_topic_id", "microsoft.help.id", "microsoft.help.f1", "title", "product"].includes(key)) stableIdentifiers[key] ??= match[2].trim();
  }
  // Version directories are common in vendor documentation batches (for
  // example `21.1 Docs/` and `21.3 Docs/`). Remove those segments before
  // deriving the family so equivalent topics across releases compare.
  const withoutVersion = relativePath
    .replace(/\.[^.]+$/, "")
    .replace(/(?:^|[\\/])v?\d+(?:\.\d+)+(?:[-_ ]+docs?)?(?=[\\/]|$)/gi, "$1")
    .replace(/(?:[-_])?v?\d+(?:\.\d+)+$/i, "");
  const stableFamily = stableIdentifiers["ait_topic_id"] ? `ait:${stableIdentifiers["ait_topic_id"]}` : stableIdentifiers["microsoft.help.id"] ? `help:${stableIdentifiers["microsoft.help.id"]}` : undefined;
  const familyId = familyOverride ?? stableFamily ?? `family-${withoutVersion.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const reasons = [`document type inferred from ${sourceFormat || "source"}`];
  if (module) reasons.push(`module keyword '${module}' found in source`); else reasons.push("no known module keyword found");
  if (familyOverride) reasons.push("document family supplied by batch metadata or manifest"); else reasons.push("document family inferred from normalized source path");
  if (stableFamily) reasons.push(`stable documentation identifier '${stableFamily}' extracted from source metadata`);
  return { title: htmlMetadata?.title ?? body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? stableIdentifiers.title ?? relativePath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ""), body, sections: headingSections(body), documentType, familyId, module, confidence: module ? (familyOverride || stableFamily ? 0.95 : 0.82) : (familyOverride || stableFamily ? 0.9 : 0.58), reasons, sourceFormat, stableIdentifiers };
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
function expandZip(path: string, budget = { bytes: 0, entries: 0 }): string {
  // ZIP byte buffers live outside V8's heap. Release the previous archive's
  // buffers before opening the next one in a memory-limited worker.
  global.gc?.();
  const output = `${path}.expanded-${sha256(path).slice(0, 12)}`;
  mkdirSync(output, { recursive: true });
  const root = resolve(output);
  const handles = new Set<number>();
  const unzip = new Unzip((file) => {
    budget.entries++;
    if (budget.entries > 150_000) throw new Error("ZIP exceeds entry limit");
    const entry = file.name.replaceAll("\\", "/");
    const target = resolve(output, entry);
    if (entry.includes("\0") || /^[a-z]:/i.test(entry) || (target !== root && !target.startsWith(root + sep))) throw new Error(`ZIP entry escapes extraction root: ${entry}`);
    const entryExt = extname(entry).toLowerCase();
    const isToc = entryExt === ".js" && /(?:^|\/)(?:_toc|Data\/Tocs)(?:\/|$)/i.test(entry);
    if (entry.endsWith("/") || (![...SUPPORTED, ".zip", ".yaml", ".yml"].includes(entryExt) && !isToc)) return;
    if ((file.originalSize ?? 0) > 512 * 1024 ** 2) throw new Error("ZIP entry exceeds size limit");
    mkdirSync(join(target, ".."), { recursive: true });
    const fd = openSync(target, "w"); handles.add(fd);
    let written = 0;
    file.ondata = (error, data, final) => {
      if (error) throw error;
      budget.bytes += data.length; written += data.length;
      if (budget.bytes > 2 * 1024 ** 3 || written > 512 * 1024 ** 2) throw new Error("ZIP exceeds extraction limits");
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
      if (final) { closeSync(fd); handles.delete(fd); }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const input = openSync(path, "r");
  try {
    // Feed bounded chunks; never hold the full outer ZIP and its inner ZIPs
    // together in memory. Each entry is written directly to disk.
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const count = readSync(input, chunk, 0, chunk.length, null);
      if (!count) break;
      unzip.push(chunk.subarray(0, count));
    }
    unzip.push(new Uint8Array(), true);
    if (handles.size) throw new Error("Truncated ZIP archive");
  } finally { closeSync(input); for (const fd of handles) closeSync(fd); }
  return output;
}
function expandNestedZips(root: string, expanded: string[], depth = 0, budget = { bytes: 0, entries: 0 }): void {
  if (depth > 5) throw new Error("ZIP nesting exceeds 5 levels");
  if (!statSync(root).isDirectory()) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && !entry.name.includes(".expanded-")) expandNestedZips(path, expanded, depth, budget);
    else if (entry.isFile() && extname(path).toLowerCase() === ".zip") {
      const output = `${path}.expanded-${sha256(path).slice(0, 12)}`; expanded.push(output); expandZip(path, budget);
      expandNestedZips(output, expanded, depth + 1, budget);
    }
  }
}
function expandChm(path: string): string | undefined {
  const output = `${path}.expanded-${sha256(path).slice(0, 12)}`; mkdirSync(output, { recursive: true });
  const extractor = resolveChmExtractor();
  const args = chmExtractionArguments(extractor, output, path);
  try { execFileSync(extractor, args, { timeout: 120_000, stdio: "ignore", windowsHide: true }); return files(output).some((file) => /\.html?$/i.test(file)) ? output : undefined; }
  catch { rmSync(output, { recursive: true, force: true }); return undefined; }
}

interface PreparedProductSource { root: string; inputFiles: string[]; }

/** Expand the actual archive entry point before PDF parsing, then reuse the same persisted source identities. */
export async function importKnowledgeProductsAsync(store: KnowledgeStore, options: ProductDocumentImportOptions): Promise<ProductDocumentImportReport> {
  let root = resolve(options.root);
  const expanded: string[] = [];
  try {
    if (statSync(root).isFile() && extname(root).toLowerCase() === ".zip") {
      const destination = `${root}.expanded-${sha256(root).slice(0, 12)}`;
      expanded.push(destination); root = expandZip(root);
    }
    expandNestedZips(root, expanded);
    const parsing = { pdfFiles: 0, chmArchives: 0, chmHtmlFiles: 0, zipArchives: expanded.length };
    const inputFiles = files(root);
    for (const path of inputFiles.filter(path => extname(path).toLowerCase() === ".chm")) {
      const extracted = expandChm(path);
      if (!extracted) throw new Error("CHM extraction failed; configure RELAY_CHM_EXTRACTOR with 7zz or the native Windows help extractor");
      expanded.push(extracted); const extractedFiles = files(extracted); inputFiles.push(...extractedFiles);
      parsing.chmArchives++; parsing.chmHtmlFiles += extractedFiles.filter(file => /\.html?$/i.test(file)).length;
    }
    const pdfText: Record<string, string> = {};
    for (const path of inputFiles.filter(path => extname(path).toLowerCase() === ".pdf")) {
      const text = await parsePdfBytes(readFileSync(path));
      if (!text.trim()) throw new Error("PDF contains no extractable text; OCR is required before import");
      pdfText[path] = text; parsing.pdfFiles++;
    }
    return { ...importKnowledgeProducts(store, { ...options, pdfText }, { root, inputFiles }), parsing };
  } finally {
    for (const path of expanded.reverse()) rmSync(path, { recursive: true, force: true });
  }
}

export function importKnowledgeProducts(store: KnowledgeStore, options: ProductDocumentImportOptions, prepared?: PreparedProductSource): ProductDocumentImportReport {
  let root = prepared?.root ?? resolve(options.root);
  let expanded: string | undefined;
  if (!prepared && statSync(root).isFile() && extname(root).toLowerCase() === ".zip") { expanded = expandZip(root); root = expanded; }
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
  if (hasIdempotencyColumn && hasColumn(store, "knowledge_ingest_runs", "batch_metadata_json") && hasColumn(store, "knowledge_ingest_runs", "source_root") && hasColumn(store, "knowledge_ingest_runs", "source_commit")) store.db.prepare("INSERT OR IGNORE INTO knowledge_ingest_runs(id,source_locator,status,started_at,operation_idempotency_key,batch_metadata_json,source_root,source_commit) VALUES (?,?,?,?,?,?,?,?)").run(runId, `product-docs:${options.root}`, "queued", now, options.idempotencyKey ?? null, batchMeta, options.root, options.sourceCommit ?? null);
  else store.db.prepare("INSERT OR IGNORE INTO knowledge_ingest_runs(id,source_locator,status,started_at) VALUES (?,?,?,?)").run(runId, `product-docs:${options.root}`, "queued", now);
  store.db.prepare("UPDATE knowledge_ingest_runs SET status=? WHERE id=?").run("running", runId); report.status = "running";
  const sourceHashes: string[] = []; const expandedChm: string[] = []; let nestedZipPaths: string[] = [];
  try {
    if (!base.sampleManagerVersion) throw new Error("sampleManagerVersion is required (or provide it in manifest.yaml)");
    if (!prepared) expandNestedZips(root, nestedZipPaths);
    global.gc?.();
    const inputFiles = prepared?.inputFiles ?? files(root); for (const chm of (prepared ? [] : inputFiles).filter((path) => extname(path).toLowerCase() === ".chm")) { const expandedPath = expandChm(chm); if (expandedPath) { expandedChm.push(expandedPath); inputFiles.push(...files(expandedPath)); } else report.warnings.push(`${chm}: CHM extraction unavailable; metadata-only placeholder retained`); }
    store.db.exec("CREATE INDEX IF NOT EXISTS idx_knowledge_topics_lower_title ON knowledge_topics(lower(canonical_title))");
    let processed = 0;
    const progress = (currentFile?: string) => {
      store.db.prepare("UPDATE knowledge_ingest_runs SET imported=?,skipped=? WHERE id=?").run(report.imported + report.updated, report.unchanged, runId);
      options.onProgress?.({ runId, processed, total: inputFiles.length, imported: report.imported + report.updated, unchanged: report.unchanged, currentFile });
    };
    progress();
    for (const path of inputFiles) {
      if (processed % 100 === 0) progress(relative(root, path));
      processed++;
      const relativePath = relative(root, path).replaceAll("\\", "/");
      const rule = matchRule(relativePath, loaded.rules) ?? {};
      const local = { ...base, ...rule };
      const raw = readFileSync(path);
      const ext = extname(path).toLowerCase();
      const htmlParsed = ext === ".html" || ext === ".htm" ? parseHelpHtml(raw.toString("utf8")) : undefined;
      const tocEntries = ext === ".js" ? parseToc(raw.toString("utf8")) : [];
      const body = ext === ".pdf" ? (options.pdfText?.[path] ?? pdfToText(raw)) : ext === ".chm" ? `[CHM archive: ${raw.length} bytes; extraction is staged for the CHM parser]` : tocEntries.length ? `# Navigation\n\n${tocEntries.map((entry) => `- ${entry.title} -> ${entry.path}`).join("\n")}` : htmlParsed?.text ?? raw.toString("utf8");
      const sourceHash = sha256(raw);
      sourceHashes.push(`${relativePath}:${sourceHash}`);
      const parsed = infer(relativePath, body, local.documentFamilyId, local.documentType, local.module, ext === ".html" || ext === ".htm" ? raw.toString("utf8") : undefined, htmlParsed);
      const familyId = parsed.familyId;
      const version = String(local.sampleManagerVersion);
      // Code case, indentation, string whitespace and structural Markdown are
      // part of content identity. Parser generations must never share a cache
      // entry merely because the old text-only normalizer collapsed them.
      const normalizedContentSha256 = sha256(parsed.body);
      const proposedRevisionId = `product-revision-${sha256(`${HTML_PARSER_VERSION}\0${normalizedContentSha256}`).slice(0, 32)}`;
      store.db.transaction(() => {
      store.db.prepare(`INSERT INTO knowledge_product_revisions(id,normalized_content_sha256,raw_sha256,title,body,sections_json,parser_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(normalized_content_sha256,parser_version) DO UPDATE SET updated_at=excluded.updated_at`).run(proposedRevisionId, normalizedContentSha256, sourceHash, parsed.title, parsed.body, JSON.stringify(parsed.sections), HTML_PARSER_VERSION, now, now);
      // Restored or seeded revisions may have an earlier ID for these exact
      // bytes. Reference the persisted identity rather than the proposed ID.
      const revisionId = (store.db.prepare("SELECT id FROM knowledge_product_revisions WHERE normalized_content_sha256=? AND parser_version=?").get(normalizedContentSha256, HTML_PARSER_VERSION) as {id:string}).id;
      const id = `product-document-${sha256(`${familyId}\0${version}\0${relativePath}\0${sourceHash}${htmlParsed?`\0${HTML_PARSER_VERSION}`:""}`).slice(0, 32)}`;
      const existing = store.db.prepare("SELECT source_sha256 FROM knowledge_product_documents WHERE id = ?").get(id) as { source_sha256?: string } | undefined;
      if (existing) {
        advanceCurrentProductBinding(store, id, familyId, version, relativePath, now);
        // Re-run native extraction for legacy PDF rows without changing their
        // source identity, review state or access scope. Only replace output
        // that is still exactly the old fallback; preserve authored corrections.
        if (ext === ".pdf" && options.pdfText?.[path] !== undefined) {
          const current = store.db.prepare("SELECT d.*,p.metadata_json FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE d.id=?").get(id) as Record<string, unknown>;
          const oldMetadata = safeJson(current.metadata_json, {}) as Record<string, unknown>;
          if (oldMetadata.pdfExtraction !== "pdf-parse" && current.body !== body && current.body === pdfToText(raw)) {
            const scope = store.db.prepare("SELECT * FROM knowledge_scope_bindings WHERE document_id=? ORDER BY id LIMIT 1").get(id) as Record<string, unknown> | undefined;
            const optional = (value: unknown) => value == null ? undefined : String(value);
            store.upsertDocument({
              id, kind: "product_document", title: String(current.title), body, lifecycle: current.lifecycle as KnowledgeDocument["lifecycle"],
              projectId: optional(current.project_id), projectNameSnapshot: optional(current.project_name_snapshot), sampleManagerVersion: optional(current.samplemanager_version), solution: optional(current.solution), module: optional(current.module), environment: optional(current.environment),
              locator: String(current.source_locator), commit: optional(current.source_commit), sha256: optional(current.source_sha256), createdAt: String(current.created_at), updatedAt: now,
              ...(scope ? { scopeType: scope.scope_type as KnowledgeDocument["scopeType"], scopeKey: String(scope.scope_key), visibility: scope.visibility as KnowledgeDocument["visibility"], sourceProjectId: optional(scope.source_project_id), sourceCaseId: optional(scope.source_case_id), sourceDeploymentId: optional(scope.source_deployment_id), redactionStatus: scope.redaction_status as KnowledgeDocument["redactionStatus"] } : {}),
            });
            const metadata = { ...oldMetadata, normalizedContentSha256, parserVersion: HTML_PARSER_VERSION, pdfExtraction: "pdf-parse" };
            store.db.prepare("UPDATE knowledge_product_documents SET revision_id=?,sections_json=?,metadata_json=?,updated_at=? WHERE id=?").run(revisionId, JSON.stringify(parsed.sections), JSON.stringify(metadata), now, id);
            report.updated++; report.documents.push(id); report.items.push({ path: relativePath, id, status: "updated" });
            if (hasBatchTables) store.db.prepare("INSERT OR REPLACE INTO knowledge_product_document_items(id,run_id,relative_path,document_id,status,source_sha256,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(`${runId}:${relativePath}`, runId, relativePath, id, "updated", sourceHash, JSON.stringify(metadata), now, now);
            return;
          }
        }
        report.unchanged++; report.documents.push(id); report.items.push({ path: relativePath, id, status: "unchanged" }); return;
      }
      const prior = store.db.prepare("SELECT d.id,d.lifecycle FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE p.document_family_id=? AND p.version=? AND p.source_path=? AND d.id<>?").get(familyId, version, relativePath, id) as { id?: string; lifecycle?: string } | undefined;
      const createdAt = now;
      store.upsertDocument({ id, kind: "product_document", title: parsed.title, body, lifecycle: "approved", projectNameSnapshot: local.product, sampleManagerVersion: version, solution: local.solution, module: parsed.module, visibility: "global", scopeType: "version", scopeKey: version, locator: `product-doc:${relativePath}`, commit: options.sourceCommit, sha256: sourceHash, createdAt, updatedAt: createdAt });
      const metadata = { confidence: parsed.confidence, reasons: parsed.reasons, module: parsed.module, sourceFormat: htmlParsed?.sourceFormat ?? (tocEntries.length ? "toc" : parsed.sourceFormat), sourcePath: relativePath, sourceHash, normalizedContentSha256, parserVersion: HTML_PARSER_VERSION, ...(ext === ".pdf" && options.pdfText?.[path] !== undefined ? { pdfExtraction: "pdf-parse" } : {}), stableIdentifiers: parsed.stableIdentifiers, links: htmlParsed?.links ?? [], images: htmlParsed?.images ?? [], tocEntries, manifestRule: rule };
      store.db.prepare(`INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,authority,source_path,source_sha256,version,sections_json,metadata_json,revision_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(id, familyId, parsed.documentType, local.language ?? "en", local.authority ?? "official", relativePath, sourceHash, version, JSON.stringify(parsed.sections), JSON.stringify(metadata), revisionId, createdAt, createdAt);
      if (!advanceCurrentProductBinding(store, id, familyId, version, relativePath, now)) {
        // A document family is the compatibility identity used by the first
        // generation importer. Keep it as the fallback topic identity while
        // allowing later stable-ID matching to merge families safely.
        const titleKey = parsed.title.toLowerCase().replace(/\s+/g, " ").trim();
        const titleMatch = store.db.prepare("SELECT id,canonical_key FROM knowledge_topics WHERE lower(canonical_title)=? LIMIT 1").get(titleKey) as { id?: string; canonical_key?: string } | undefined;
        const topicId = titleMatch?.id ?? `topic-${sha256(`product:${familyId}`).slice(0, 24)}`;
        const canonicalKey = titleMatch?.canonical_key ?? `product:${familyId}`;
        store.db.prepare(`INSERT INTO knowledge_topics(id,canonical_key,canonical_title,kind,domain,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(canonical_key) DO UPDATE SET canonical_title=excluded.canonical_title,updated_at=excluded.updated_at`)
          .run(topicId, canonicalKey, parsed.title, "product_document", "product", createdAt, createdAt);
        const persistedTopic = store.db.prepare("SELECT id FROM knowledge_topics WHERE canonical_key = ?").get(canonicalKey) as { id?: string } | undefined;
        const bindingTopicId = String(persistedTopic?.id ?? topicId);
        const matchConfidence = titleMatch ? 0.78 : (local.documentFamilyId ? 0.95 : 0.7);
        store.db.prepare(`INSERT OR IGNORE INTO knowledge_product_document_bindings
          (id,topic_id,document_id,product,product_version,source_path,match_method,match_confidence,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(`binding-${sha256(`${bindingTopicId}\0${version}\0${id}`).slice(0, 24)}`, bindingTopicId, id, local.product ?? null, version, relativePath, titleMatch ? "title_module" : "family_id", matchConfidence, matchConfidence < 0.8 ? "pending_review" : "active", createdAt, createdAt);
      }
      if (prior?.id) { store.db.prepare("UPDATE knowledge_documents SET lifecycle='deprecated',updated_at=? WHERE id=? AND lifecycle<>'deprecated'").run(now, prior.id); report.deprecated++; }
      if (prior?.id) report.updated++; else report.imported++;
      report.documents.push(id); report.items.push({ path: relativePath, id, status: prior?.id ? "updated" : "imported" });
      if (hasBatchTables) store.db.prepare("INSERT OR REPLACE INTO knowledge_product_document_items(id,run_id,relative_path,document_id,status,source_sha256,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(`${runId}:${relativePath}`, runId, relativePath, id, prior?.id ? "updated" : "imported", sourceHash, JSON.stringify(metadata), now, now);
      })();
    }
    progress();
    report.status = report.failed ? (report.imported || report.updated ? "partial" : "failed") : "succeeded";
  } catch (error) {
    report.failed++; report.status = "failed"; const message = error instanceof Error ? error.message : String(error); report.errors.push({ path: options.root, error: message }); report.warnings.push(message);
  } finally {
    const aggregateSourceHash = sourceHashes.length ? sha256(sourceHashes.sort().join("\n")) : null;
    if (hasColumn(store, "knowledge_ingest_runs", "source_sha256")) store.db.prepare("UPDATE knowledge_ingest_runs SET status=?,imported=?,skipped=?,failed=?,finished_at=?,error=?,source_sha256=COALESCE(?,source_sha256) WHERE id=?").run(report.status, report.imported + report.updated, report.unchanged, report.failed, new Date().toISOString(), report.errors.length ? JSON.stringify(report.errors) : report.warnings.length ? JSON.stringify(report.warnings) : null, aggregateSourceHash, runId);
    else store.db.prepare("UPDATE knowledge_ingest_runs SET status=?,imported=?,skipped=?,failed=?,finished_at=?,error=? WHERE id=?").run(report.status, report.imported + report.updated, report.unchanged, report.failed, new Date().toISOString(), report.errors.length ? JSON.stringify(report.errors) : report.warnings.length ? JSON.stringify(report.warnings) : null, runId);
    if (expanded) rmSync(expanded, { recursive: true, force: true }); for (const path of expandedChm) rmSync(path, { recursive: true, force: true }); for (const path of nestedZipPaths) rmSync(path, { recursive: true, force: true });
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
    try {
      // FTS5 auxiliary functions must run on the matching FTS cursor, before
      // aggregation/windowing. Materialize each scored chunk, then choose the
      // best chunk per document so its score and snippet stay paired.
      rows = store.db.prepare(`WITH scored AS MATERIALIZED (
        SELECT d.id,knowledge_fts.rowid AS match_rowid,
          snippet(knowledge_fts,2,'<mark>','</mark>','…',36) AS snippet,bm25(knowledge_fts) AS rank
        FROM knowledge_fts JOIN knowledge_documents d ON d.id=knowledge_fts.document_id
        JOIN knowledge_product_documents p ON p.id=d.id
        WHERE knowledge_fts MATCH @match AND ${conditions.join(" AND ")}
      ), best AS (
        SELECT *,ROW_NUMBER() OVER (PARTITION BY id ORDER BY rank,match_rowid) AS chunk_rank FROM scored
      )
      SELECT d.id,d.title,d.lifecycle,d.samplemanager_version,d.solution,d.module,d.project_name_snapshot,d.source_locator,d.source_commit,d.source_sha256,d.created_at,d.updated_at,p.document_family_id,p.document_type,p.language,p.authority,p.source_path,p.version,p.sections_json,p.metadata_json,p.diff_review_status,best.snippet,best.rank
      FROM best JOIN knowledge_documents d ON d.id=best.id JOIN knowledge_product_documents p ON p.id=d.id
      WHERE best.chunk_rank=1 ORDER BY best.rank,d.id LIMIT ${limit}`).all(params) as Array<Record<string, unknown>>;
    } catch {
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
      // Keep the stable DTO discriminator explicit so the native UI can
      // route Product results back to Product Knowledge instead of treating
      // them as project Cases.
      kind: "product_document",
      // Search results cross the SQL/API boundary, so expose the same
      // camelCase provenance fields used by the Product Knowledge UI while
      // retaining the raw columns above for compatibility.
      sampleManagerVersion: row.samplemanager_version,
      projectNameSnapshot: row.project_name_snapshot,
      sourceLocator: row.source_locator,
      sourceCommit: row.source_commit,
      sourceSha256: row.source_sha256,
      sourcePath: row.source_path,
      documentFamilyId: row.document_family_id,
      documentType: row.document_type,
      language: row.language,
      authority: row.authority,
      version: row.version,
      diffReviewStatus: row.diff_review_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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
  if (lifecycle === "deprecated") invalidateEngineProductMappings(store,[id],now);
  if (row.lifecycle === lifecycle) return { id, lifecycle, changed: false, updatedAt: now };
  if (lifecycle === "approved" && row.lifecycle !== "draft" && row.lifecycle !== "verified" && row.lifecycle !== "reproduced") throw new Error(`Cannot publish product document from ${row.lifecycle}`);
  store.db.prepare("UPDATE knowledge_documents SET lifecycle=?,updated_at=? WHERE id=?").run(lifecycle, now, id);
  return { id, lifecycle, changed: true, updatedAt: now };
}


/** A corrected/retired local source must be revalidated before its engine mapping can be published again. */
export function invalidateEngineProductMappings(store:KnowledgeStore,ids:string[],now=new Date().toISOString()):number {
  const update=store.db.prepare("UPDATE knowledge_weknora_documents SET status='deprecated',deprecated_at=?,updated_at=? WHERE status!='deprecated' AND id IN (SELECT document_id FROM knowledge_migration_documents WHERE local_document_id=?)");
  return store.db.transaction(()=>ids.reduce((count,id)=>count+Number(update.run(now,now,id).changes),0))();
}


export function correctProductMetadata(store:KnowledgeStore,input:{ids:string[];module?:string|null;documentType?:string|null;language?:string|null;authority?:string|null;reason:string},now=new Date().toISOString()) {
  return store.db.transaction(()=>{
    let updated=0,engineRepublishRequired=0;
    for(const id of input.ids){
      const row=store.db.prepare("SELECT p.document_type,p.language,p.authority,d.module FROM knowledge_product_documents p JOIN knowledge_documents d ON d.id=p.id WHERE p.id=?").get(id) as Record<string,unknown>|undefined;
      if(!row)continue;
      const module=input.module===undefined?row.module:input.module,language=input.language===undefined?row.language:input.language;
      updated+=Number(store.db.prepare("UPDATE knowledge_product_documents SET document_type=?,language=?,authority=?,metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.corrected',json('true'),'$.correctionReason',?),updated_at=? WHERE id=?").run(input.documentType===undefined?row.document_type:input.documentType,language,input.authority===undefined?row.authority:input.authority,input.reason,now,id).changes);
      if(input.module!==undefined)store.db.prepare("UPDATE knowledge_documents SET module=?,updated_at=? WHERE id=?").run(module,now,id);
      // Type/authority are read live from Relay; only an actual source-identity correction requires a new migration.
      if(module!==row.module||language!==row.language)engineRepublishRequired+=invalidateEngineProductMappings(store,[id],now);
    }
    return {ok:true,updated,correctedAt:now,engineRepublishRequired};
  })();
}
