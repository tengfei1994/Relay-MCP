/** Isolated, freeze-gated HTML reparse and native CPU-only indexing budget. Never embeds or changes a quota. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { argumentsFor, isolatedPath, openReadOnly, readJson, record, requireQuality, safeFailure, savePrivate, sha, text, NONPROD_ROOT, type Row } from "./knowledge-quality-common.js";

export const SOURCE_PREFIX = "21.3 Docs/SampleManager Documentation.zip.expanded-e5be60ab1138/";
export const TARGET_ENVIRONMENT = "nonprod-full-213-v3";
export const ORIGINAL_MANIFEST_SHA256 = "712d0e78e9928123c402b748a3e966ef99eaf30121a7ff4ac76be3fe0ab30009";
export const ARCHIVE_SHA256 = "256b2a52562f321f2788205605436e5e00272060ad76c20263c637672c4b7342";
export const BASE_DIRECTORY = NONPROD_ROOT + "/bulk-structured-v3";
export function candidateLayout(candidate?: string) {
  requireQuality(candidate === undefined || /^v3-[b-z]$/.test(candidate), "invalid_candidate");
  const directory = candidate === undefined ? BASE_DIRECTORY : BASE_DIRECTORY + "/candidate-" + candidate;
  return Object.freeze({ candidate: candidate ?? "v3-a", baseDirectory: BASE_DIRECTORY, directory,
    codeRoot: directory + "/parser-runtime", inputs: BASE_DIRECTORY + "/inputs",
    preparation: BASE_DIRECTORY + "/preparation.json", plan: BASE_DIRECTORY + "/plan.json",
    sharedInputsReadOnly: candidate !== undefined });
}
let layout = candidateLayout();
let DIRECTORY = layout.directory;
let CODE_ROOT = layout.codeRoot;
const APP_REPO = NONPROD_ROOT + "/relay";
const ORIGINAL_MANIFEST = NONPROD_ROOT + "/runtime/full-213/manifest.jsonl";
const ENGINE = NONPROD_ROOT + "/runtime/knowledge-engine";
const NATIVE_SOURCE = ENGINE + "/build-log-safety-v1/regression-source";
const SOURCE_COUNT = 5372;
const byteSha = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export function validateFrozenRows(rows: Row[], expectedCount = SOURCE_COUNT): Row[] {
  requireQuality(rows.length === expectedCount, "source_count_mismatch");
  const paths = new Set<string>(), ids = new Set<string>();
  for (const row of rows) {
    const inner = text(row.innerPath), source = text(row.sourcePath);
    requireQuality(inner && !inner.startsWith("/") && !inner.includes("\\") && !inner.split("/").some(part => !part || part === "." || part === "..") && !inner.includes("\0"), "unsafe_inner_path");
    requireQuality(source === SOURCE_PREFIX + inner && /\.html?$/i.test(inner), "source_layout_changed");
    requireQuality(!paths.has(source), "duplicate_source_path"); paths.add(source);
    requireQuality(text(row.bulkSourceId) && !ids.has(text(row.bulkSourceId)), "duplicate_source_identity"); ids.add(text(row.bulkSourceId));
    requireQuality(/^[a-f0-9]{64}$/.test(text(row.rawSha256)), "invalid_raw_hash");
    requireQuality(row.version === "21.3" && row.projectId === "1" && row.environment === "nonprod-full-213", "original_scope_changed");
  }
  return [...rows].sort((a, b) => compare(text(a.sourcePath), text(b.sourcePath)));
}
export function verifySourceIdentity(original: Row[], reparsed: Row[], expectedCount = SOURCE_COUNT): void {
  requireQuality(original.length === expectedCount && reparsed.length === expectedCount, "source_count_mismatch");
  const expected = new Map(original.map(row => [text(row.sourcePath), row])); const seen = new Set<string>();
  for (const row of reparsed) {
    const source = expected.get(text(row.sourcePath));
    requireQuality(source && !seen.has(text(row.sourcePath)) && source.rawSha256 === row.rawSha256, "raw_identity_changed");
    requireQuality(row.sourceParserVersion === "html-3" && row.projectId === "1" && row.environment === TARGET_ENVIRONMENT, "reparsed_scope_or_parser_mismatch");
    seen.add(text(row.sourcePath));
  }
}
export function targetIdentity(sourcePath: string, rawSha256: string, bodySha256: string): string {
  return "product-document-full213-v3-" + sha(JSON.stringify([sourcePath, rawSha256, "html-3", bodySha256, "1", TARGET_ENVIRONMENT])).slice(0, 32);
}
export function budgetSummary(rows: Row[], priorDurableCalls: number) {
  requireQuality(Number.isSafeInteger(priorDurableCalls) && priorDurableCalls >= 2719, "prior_ledger_count_below_frozen_floor");
  let rawPreviewChunks = 0, indexableChunks = 0, logicalCallsNoRetry = 0, unindexableDocuments = 0;
  for (const row of rows) {
    const raw = Number(row.chunkCount), indexed = Number(row.indexableChunks), batches = Number(row.embeddingBatches);
    requireQuality(Number.isSafeInteger(raw) && raw >= 0 && Number.isSafeInteger(indexed) && indexed >= 0 && indexed <= raw, "invalid_native_chunk_counts");
    requireQuality(batches === Math.ceil(indexed / 5), "embedding_batch_count_mismatch");
    rawPreviewChunks += raw; indexableChunks += indexed; logicalCallsNoRetry += batches;
    if (indexed === 0) unindexableDocuments++;
  }
  const cumulativeCallsNoRetry = priorDurableCalls + logicalCallsNoRetry;
  return { sourceCount: rows.length, rawPreviewChunks, indexableChunks, discardedWhitespaceChunks: rawPreviewChunks - indexableChunks,
    unindexableDocuments, batchEmbedSize: 5, logicalCallsNoRetry, priorDurableCalls, authorizedCallCap: 12000,
    remainingAuthorizedCalls: Math.max(0, 12000 - priorDurableCalls), cumulativeCallsNoRetry,
    worstCaseCallsWithOneRetry: priorDurableCalls + logicalCallsNoRetry * 2,
    deficitCallsNoRetry: Math.max(0, cumulativeCallsNoRetry - 12000), requiresAdditionalAuthorization: cumulativeCallsNoRetry > 12000,
    modelCallsPerformed: 0, retrievalCallsPerformed: 0, quotaMutations: 0, ledgerMutations: 0 };
}
export function previewRequest(content: string) {
  return { text: content, chunking_config: { chunk_size: 0, chunk_overlap: 0, separators: null, enable_parent_child: false } };
}
export function verifyPreviewCalibration(expected: Row, response: Row) {
  requireQuality(response.success === true, "preview_response_failed");
  const data = record(response.data), stats = record(data.stats);
  requireQuality(!stats.truncated_to, "preview_truncated");
  requireQuality(Array.isArray(data.chunks) && data.chunks.length === Number(expected.chunkCount) && stats.count === expected.chunkCount, "preview_chunk_count_mismatch");
  const contents = data.chunks.map(chunk => { const content = record(chunk).content; requireQuality(typeof content === "string", "preview_chunk_content_invalid"); return content; });
  requireQuality(JSON.stringify(contents.map(sha)) === JSON.stringify(expected.rawChunkHashes), "preview_chunk_bytes_differ");
  // Go strings.TrimSpace uses Unicode White Space; JS trim differs for U+0085 and U+FEFF.
  const indexable = contents.filter(content => !/^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$/u.test(content));
  requireQuality(indexable.length === expected.indexableChunks && JSON.stringify(indexable.map(sha)) === JSON.stringify(expected.indexableChunkHashes), "preview_indexable_bytes_differ");
  return { rawPreviewChunks: contents.length, indexableChunks: indexable.length, embeddingBatches: Math.ceil(indexable.length / 5), exactByteParity: true };
}
export function validatePreparationIdentity(preparation: Row): void {
  requireQuality(preparation.sourceCount === SOURCE_COUNT && preparation.rawBytes === 237579395 &&
    preparation.archiveSha256 === ARCHIVE_SHA256 && preparation.sourceManifestSha256 === ORIGINAL_MANIFEST_SHA256 &&
    preparation.status === "raw_sources_prepared_no_parser_execution" && preparation.targetProjectId === "1" &&
    preparation.targetEnvironment === TARGET_ENVIRONMENT, "shared_preparation_identity_changed");
}
function sharedInputIdentity() {
  const preparationBytes = fs.readFileSync(isolatedPath(layout.preparation));
  validatePreparationIdentity(record(JSON.parse(preparationBytes.toString("utf8"))));
  const planBytes = fs.readFileSync(isolatedPath(layout.plan));
  const inputs = isolatedPath(layout.inputs);
  requireQuality(inputs === layout.inputs, "shared_inputs_symlink_rejected");
  return { inputs, preparation: { path: layout.preparation, sha256: byteSha(preparationBytes) },
    plan: { path: layout.plan, sha256: byteSha(planBytes) }, sourceCount: SOURCE_COUNT,
    archiveSha256: ARCHIVE_SHA256, sourceManifestSha256: ORIGINAL_MANIFEST_SHA256 };
}
function frozenRows(): Row[] {
  const data = fs.readFileSync(isolatedPath(ORIGINAL_MANIFEST));
  requireQuality(byteSha(data) === ORIGINAL_MANIFEST_SHA256, "frozen_manifest_changed");
  return validateFrozenRows(data.toString("utf8").trim().split(/\r?\n/).map(line => record(JSON.parse(line))));
}
function privateDirectory(): void {
  isolatedPath(CODE_ROOT);
  if (!fs.existsSync(DIRECTORY)) fs.mkdirSync(DIRECTORY, { mode: 0o700 });
  requireQuality(fs.realpathSync(DIRECTORY) === DIRECTORY, "output_directory_symlink_rejected");
  fs.chmodSync(DIRECTORY, 0o700);
}
function save(name: string, value: unknown) { return savePrivate(isolatedPath(DIRECTORY + "/" + name, true), value); }
function saveJsonl(name: string, rows: Row[]) {
  const file = isolatedPath(DIRECTORY + "/" + name, true), bytes = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 }); return { path: file, sha256: sha(bytes), count: rows.length };
}
function readJsonl(name: string): Row[] { return fs.readFileSync(isolatedPath(DIRECTORY + "/" + name), "utf8").trim().split(/\r?\n/).map(line => record(JSON.parse(line))); }
function durableCalls(): number {
  const db = openReadOnly(isolatedPath(APP_REPO + "/data/knowledge.db"));
  try { const count = Number(record(db.prepare("SELECT COUNT(*) AS n FROM knowledge_provider_admissions WHERE provider_id='qwen'").get()).n); requireQuality(count >= 2719, "prior_ledger_count_below_frozen_floor"); return count; }
  finally { db.close(); }
}
function filesBelow(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    requireQuality(!entry.isSymbolicLink(), "code_symlink_rejected");
    const child = path.join(root, entry.name); return entry.isDirectory() ? filesBelow(child) : [child];
  });
}
function codeSnapshot(): Row[] {
  const source = filesBelow(isolatedPath(CODE_ROOT + "/src")).filter(file => file.endsWith(".ts"));
  const native = filesBelow(isolatedPath(NATIVE_SOURCE + "/internal/infrastructure/chunker")).filter(file => file.endsWith(".go") && !file.endsWith("_test.go"));
  native.push(NATIVE_SOURCE + "/internal/infrastructure/docparser/html_table_normalizer.go", NATIVE_SOURCE + "/internal/application/service/knowledge_process.go");
  const all = [...source, ...native, CODE_ROOT + "/package.json", CODE_ROOT + "/package-lock.json", CODE_ROOT + "/scripts/knowledge-quality-common.ts", CODE_ROOT + "/scripts/knowledge-quality-structured-v3.ts"];
  return all.sort(compare).map(file => ({ path: file.slice(NONPROD_ROOT.length + 1), sha256: byteSha(fs.readFileSync(isolatedPath(file))) }));
}
function assertFreeze(expected: string | undefined): Row {
  requireQuality(expected && /^[a-f0-9]{64}$/.test(expected), "explicit_freeze_sha_required");
  const bytes = fs.readFileSync(isolatedPath(DIRECTORY + "/freeze.json"));
  requireQuality(byteSha(bytes) === expected, "freeze_sha_mismatch");
  const freeze = record(JSON.parse(bytes.toString("utf8")));
  requireQuality(freeze.candidate === layout.candidate && freeze.directory === DIRECTORY && freeze.codeRoot === CODE_ROOT, "freeze_candidate_mismatch");
  requireQuality(JSON.stringify(freeze.sharedInputs) === JSON.stringify(sharedInputIdentity()), "shared_inputs_changed_after_freeze");
  requireQuality(freeze.parserVersion === "html-3" && freeze.sourceManifestSha256 === ORIGINAL_MANIFEST_SHA256, "invalid_freeze_contract");
  requireQuality(JSON.stringify(freeze.files) === JSON.stringify(codeSnapshot()), "code_changed_after_freeze");
  frozenRows(); return freeze;
}

const extractionPython = String.raw`
import hashlib,json,pathlib,sys,zipfile,tempfile,os,shutil
R=pathlib.Path('/home/ftd/relay-knowledge-engine-nonprod');D=R/'bulk-structured-v3';prefix='21.3 Docs/SampleManager Documentation.zip.expanded-e5be60ab1138/'
def require(ok,code):
 if not ok: raise RuntimeError(code)
def digest_file(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for data in iter(lambda:f.read(1024*1024),b''):h.update(data)
 return h.hexdigest()
def main():
 os.umask(0o077);require(R.resolve()==R and D.resolve()==D and sys.platform=='linux','nonproduction_path_required')
 archive=R/'sources/21.3 Docs.zip';require(digest_file(archive)=='256b2a52562f321f2788205605436e5e00272060ad76c20263c637672c4b7342','archive_hash_changed')
 raw=(R/'runtime/full-213/manifest.jsonl').read_bytes();require(hashlib.sha256(raw).hexdigest()=='712d0e78e9928123c402b748a3e966ef99eaf30121a7ff4ac76be3fe0ab30009','manifest_hash_changed')
 rows=[json.loads(line) for line in raw.decode().splitlines() if line];require(len(rows)==5372 and len({x['sourcePath'] for x in rows})==5372,'source_count_mismatch')
 inputs=D/'inputs';inputs.mkdir(mode=0o700,exist_ok=True);require(inputs.resolve()==inputs,'input_symlink_rejected');total=0
 with zipfile.ZipFile(archive) as outer,tempfile.TemporaryFile(dir=D) as innerfile:
  matches=[z for z in outer.infolist() if z.filename=='21.3 Docs/SampleManager Documentation.zip'];require(len(matches)==1,'inner_archive_missing_or_duplicate')
  with outer.open(matches[0]) as src:shutil.copyfileobj(src,innerfile)
  innerfile.seek(0)
  with zipfile.ZipFile(innerfile) as inner:
   entries={}
   for z in inner.infolist():entries.setdefault(z.filename,[]).append(z)
   for row in rows:
    innerpath=row['innerPath'];source=row['sourcePath'];parts=pathlib.PurePosixPath(innerpath).parts
    require(parts and not innerpath.startswith('/') and '\\' not in innerpath and all(p not in ('.','..','') for p in parts),'unsafe_inner_path')
    require(source==prefix+innerpath and source.lower().endswith(('.htm','.html')),'source_layout_changed');require(len(entries.get(innerpath,[]))==1,'archive_source_missing_or_duplicate')
    target=inputs/source;target.parent.mkdir(parents=True,mode=0o700,exist_ok=True);require(str(target.resolve()).startswith(str(inputs)+'/') and not target.is_symlink(),'target_path_escape')
    if not target.exists():
     with inner.open(entries[innerpath][0]) as src,open(target,'xb') as dst:shutil.copyfileobj(src,dst)
    require(digest_file(target)==row['rawSha256'],'raw_hash_mismatch');total+=target.stat().st_size
 print(json.dumps({'sourceCount':len(rows),'rawBytes':total,'archiveSha256':'256b2a52562f321f2788205605436e5e00272060ad76c20263c637672c4b7342','sourceManifestSha256':'712d0e78e9928123c402b748a3e966ef99eaf30121a7ff4ac76be3fe0ab30009','modelCalls':0}))
try:main()
except Exception as e:
 print(json.dumps({'error':str(e) if isinstance(e,RuntimeError) else 'extraction_failed_no_content_logged'}),file=sys.stderr);sys.exit(1)
`;
function prepare(): void {
  requireQuality(!layout.sharedInputsReadOnly, "candidate_preparation_is_read_only");
  frozenRows(); privateDirectory(); requireQuality(!fs.existsSync(DIRECTORY + "/preparation.json"), "preparation_already_complete");
  const result = spawnSync("python3", ["-c", extractionPython], { encoding: "utf8", timeout: 600000, maxBuffer: 1024 * 1024 });
  requireQuality(result.status === 0, "private_raw_extraction_failed");
  const report = record(JSON.parse(result.stdout)); requireQuality(report.sourceCount === SOURCE_COUNT, "source_count_mismatch");
  const output = save("preparation.json", { ...report, status: "raw_sources_prepared_no_parser_execution", preparedAt: new Date().toISOString(),
    targetDatabase: DIRECTORY + "/knowledge.db", targetProjectId: "1", targetEnvironment: TARGET_ENVIRONMENT,
    oldDatabaseMutations: 0, credentialReads: 0, modelCalls: 0 });
  save("plan.json", { schemaVersion: 1, stages: ["prepare: verify frozen ZIP and exactly 5372 raw hashes; extract private allowlist only", "freeze: capture html-3, 046 and all source/dependency hashes after root confirms implementation frozen", "import: explicit freeze SHA; real importKnowledgeProducts with prepared inputFiles into new isolated DB; exact-scope binding; parsed manifest", "budget: same freeze SHA; native pinned chunker; TrimSpace filtering; batch 5; durable prior calls retained; calibration samples", "calibration: compare representative real HTTP preview samples; no model endpoint", "approval: root must request additional budget if cumulative forecast exceeds 12000; this driver cannot grant or enqueue"],
    immutableInputs: { archiveSha256: ARCHIVE_SHA256, manifestSha256: ORIGINAL_MANIFEST_SHA256, rawSourceCount: SOURCE_COUNT },
    authorizedCallCap: 12000, priorCallFloor: 2719, parserVersion: "html-3", expectedMigrationPrefix: "046-", targetEnvironment: TARGET_ENVIRONMENT,
    forbids: ["model calls", "quota changes", "ledger resets", "old DB writes", "executing unfrozen parser code", "publication", "enqueue"] });
  process.stdout.write(JSON.stringify({ stage: "prepared", ...output, sourceCount: SOURCE_COUNT, modelCalls: 0 }) + "\n");
}
function captureFreeze(): void {
  privateDirectory(); frozenRows();
  requireQuality(fs.readFileSync(isolatedPath(CODE_ROOT + "/src/knowledge/knowledge-products.ts"), "utf8").includes('"html-3"'), "html_3_not_installed");
  requireQuality(fs.readdirSync(isolatedPath(CODE_ROOT + "/src/knowledge/migrations")).some(name => name.startsWith("046-") && name.endsWith(".ts")), "migration_046_not_installed");
  const output = save("freeze.json", { schemaVersion: 1, candidate: layout.candidate, directory: DIRECTORY, codeRoot: CODE_ROOT, sharedInputs: sharedInputIdentity(), capturedAt: new Date().toISOString(), parserVersion: "html-3", sourceManifestSha256: ORIGINAL_MANIFEST_SHA256,
    archiveSha256: ARCHIVE_SHA256, nativeCommit: "3e22822c1d2397be730c458c7539d0eb8c113a24", files: codeSnapshot(), sourceCount: SOURCE_COUNT });
  process.stdout.write(JSON.stringify({ stage: "code_freeze_captured_import_not_executed", ...output, modelCalls: 0 }) + "\n");
}
async function reparse(freezeSha: string | undefined): Promise<void> {
  assertFreeze(freezeSha); const original = frozenRows(); const byPath = new Map(original.map(row => [text(row.sourcePath), row]));
  sharedInputIdentity();
  const inputs = isolatedPath(layout.inputs);
  const inputFiles = original.map(row => { const file = isolatedPath(inputs + "/" + text(row.sourcePath)); requireQuality(file.startsWith(inputs + "/") && byteSha(fs.readFileSync(file)) === row.rawSha256, "raw_source_changed_after_preparation"); return file; });
  const dbPath = isolatedPath(DIRECTORY + "/knowledge.db", true); const startedAt = new Date().toISOString(); const priorCalls = durableCalls();
  globalThis.fetch = async () => { throw new Error("network_disabled_in_cpu_only_import"); };
  const [{ KnowledgeStore }, { importKnowledgeProducts }, { normalizeProductMarkup }] = await Promise.all([
    import("../src/knowledge/store.js"), import("../src/knowledge/knowledge-products.js"), import("../src/knowledge/weknora-markdown.js"),
  ]);
  const store = new KnowledgeStore({ dbPath, appDbPath: DIRECTORY + "/never-opened-app-guard.db" });
  try {
    requireQuality(Boolean(store.db.prepare("SELECT 1 FROM schema_migrations WHERE version LIKE '046-%'").get()), "migration_046_not_applied");
    const report = importKnowledgeProducts(store, { root: inputs, product: "SampleManager", sampleManagerVersion: "21.3", language: "en", authority: "official", idempotencyKey: "structured-v3-" + freezeSha,
      onProgress: progress => { if (progress.processed % 500 === 0 || progress.processed === SOURCE_COUNT) process.stdout.write(JSON.stringify({ stage: "real_cpu_import", processed: progress.processed, total: progress.total, modelCalls: 0 }) + "\n"); } }, { root: inputs, inputFiles });
    save("import-report.json", { candidate: layout.candidate, startedAt, completedAt: new Date().toISOString(), status: report.status, imported: report.imported, updated: report.updated, unchanged: report.unchanged, failed: report.failed,
      errors: report.errors.map(error => ({ pathSha256: sha(error.path), messageSha256: sha(error.error) })), warningCount: report.warnings.length, runId: report.runId, sourceCount: SOURCE_COUNT, freezeSha256: freezeSha, modelCalls: 0 });
    requireQuality(report.status === "succeeded" && report.imported === SOURCE_COUNT && report.failed === 0 && report.unchanged === 0, "real_import_incomplete");
    store.db.transaction(() => {
      store.db.prepare("UPDATE knowledge_documents SET project_id='1',environment=? WHERE kind='product_document'").run(TARGET_ENVIRONMENT);
      store.db.prepare("UPDATE knowledge_scope_bindings SET scope_type='environment',scope_key=?,visibility='project',source_project_id='1' WHERE document_id IN (SELECT id FROM knowledge_documents WHERE kind='product_document')").run(TARGET_ENVIRONMENT);
    })();
    const rows = store.db.prepare("SELECT d.*,p.source_path,p.source_sha256 AS raw_sha256,p.version,p.document_family_id,p.document_type,p.language,p.authority,p.sections_json,p.metadata_json,p.revision_id FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE d.kind='product_document' ORDER BY p.source_path").all() as Row[];
    const manifest = rows.map(row => {
      const prior = byPath.get(text(row.source_path)); requireQuality(prior && prior.rawSha256 === row.raw_sha256, "raw_identity_changed");
      const body = text(row.body), normalized = normalizeProductMarkup(body), metadata = record(JSON.parse(text(row.metadata_json))), sections = JSON.parse(text(row.sections_json)) as unknown[];
      requireQuality(metadata.parserVersion === "html-3", "html_3_output_required");
      requireQuality(Boolean(row.revision_id), "revision_binding_missing");
      const revision = record(store.db.prepare("SELECT body,parser_version FROM knowledge_product_revisions WHERE id=?").get(row.revision_id));
      requireQuality(revision.body === body && revision.parser_version === "html-3", "revision_body_or_parser_mismatch");
      return { ...prior, previousBulkSourceId: prior.bulkSourceId, previousBodySha256: prior.bodySha256, bulkSourceId: row.id,
        targetLocalId: targetIdentity(text(row.source_path), text(row.raw_sha256), sha(body)), projectId: "1", environment: TARGET_ENVIRONMENT,
        title: row.title, bodySha256: sha(body), normalizedSha256: sha(normalized), bodyChars: [...body].length, bodyBytes: Buffer.byteLength(body), normalizedChars: [...normalized].length, normalizedBytes: Buffer.byteLength(normalized),
        sourceParserVersion: "html-3", sourceMetadataSha256: sha(text(row.metadata_json)), sectionsSha256: sha(text(row.sections_json)), sectionCount: sections.length,
        structuralFeatures: { tableElements: (body.match(/<table/gi) ?? []).length, codeFences: (body.match(/^\s*(?:`{3,}|~{3,})/gm) ?? []).length, anchors: (body.match(/<a[^>]*id=/gi) ?? []).length },
        sourceFormat: metadata.sourceFormat, documentFamilyId: row.document_family_id, documentType: row.document_type, language: row.language, authority: row.authority,
        solution: row.solution ?? null, module: row.module ?? null, revisionId: row.revision_id, links: Array.isArray(metadata.links) ? metadata.links.length : 0, images: Array.isArray(metadata.images) ? metadata.images.length : 0,
        localChunkCount: Number(record(store.db.prepare("SELECT COUNT(*) n FROM knowledge_chunks WHERE document_id=?").get(row.id)).n),
        topicBindings: store.db.prepare("SELECT * FROM knowledge_product_document_bindings WHERE document_id=? ORDER BY id").all(row.id),
        preview: { status: "pending_native_cpu_budget" } };
    });
    verifySourceIdentity(original, manifest); assertFreeze(freezeSha);
    requireQuality(durableCalls() === priorCalls, "concurrent_model_activity_during_cpu_import");
    const output = saveJsonl("parsed-manifest.jsonl", manifest); store.db.pragma("wal_checkpoint(TRUNCATE)"); fs.chmodSync(dbPath, 0o600);
    process.stdout.write(JSON.stringify({ stage: "real_import_complete", ...output, sourceCount: manifest.length, modelCalls: 0, priorDurableCalls: priorCalls }) + "\n");
  } finally { store.db.close(); }
}

const nativeHelper = String.raw`package main
import("bufio";"crypto/sha256";"encoding/hex";"encoding/json";"os";"strings";"unicode/utf8";"github.com/Tencent/WeKnora/internal/infrastructure/chunker";"github.com/Tencent/WeKnora/internal/infrastructure/docparser")
func hash(s string)string{h:=sha256.Sum256([]byte(s));return hex.EncodeToString(h[:])}
func main(){in:=json.NewDecoder(bufio.NewReader(os.Stdin));out:=json.NewEncoder(os.Stdout);for in.More(){var input map[string]string;if in.Decode(&input)!=nil{os.Exit(2)};content:=docparser.NormalizeHTMLTables(chunker.NormalizeLineEndings(input["content"]));cfg:=chunker.NormalizeSplitterConfig(chunker.SplitterConfig{});chunks,diag:=chunker.SplitWithDiagnostics(content,cfg);rawHashes:=[]string{};indexedHashes:=[]string{};tokens:=0;lang:=chunker.DetectLanguage(content)
for _,c:=range chunks{rawHashes=append(rawHashes,hash(c.Content));if strings.TrimSpace(c.Content)==""{continue};indexedHashes=append(indexedHashes,hash(c.Content));tokens+=chunker.ApproxTokenCount(c.EmbeddingContent(),lang)}
n:=len(indexedHashes);v:=map[string]interface{}{"bulkSourceId":input["id"],"normalizedSha256":hash(input["content"]),"chunkingInputSha256":hash(content),"chunkingInputChars":utf8.RuneCountInString(content),"chunkCount":len(chunks),"indexableChunks":n,"embeddingBatches":(n+4)/5,"batchEmbedSize":5,"approxTokens":tokens,"rawChunkHashes":rawHashes,"indexableChunkHashes":indexedHashes,"selectedTier":diag.SelectedTier,"config":map[string]interface{}{"chunkSize":cfg.ChunkSize,"chunkOverlap":cfg.ChunkOverlap,"separators":cfg.Separators,"strategy":cfg.Strategy,"tokenLimit":cfg.TokenLimit,"enableParentChild":false}};if out.Encode(v)!=nil{os.Exit(3)}}}
`;
async function budget(freezeSha: string | undefined): Promise<void> {
  const freeze = assertFreeze(freezeSha); const manifest = readJsonl("parsed-manifest.jsonl"); verifySourceIdentity(frozenRows(), manifest);
  const priorCalls = durableCalls(); const { normalizeProductMarkup } = await import("../src/knowledge/weknora-markdown.js");
  const db = openReadOnly(isolatedPath(DIRECTORY + "/knowledge.db")); const inputs: Array<{id: string; content: string}> = [];
  try { for (const entry of manifest) { const body = text(record(db.prepare("SELECT body FROM knowledge_documents WHERE id=?").get(entry.bulkSourceId)).body); requireQuality(sha(body) === entry.bodySha256, "parsed_body_hash_changed"); const content = normalizeProductMarkup(body); requireQuality(sha(content) === entry.normalizedSha256, "normalized_body_hash_changed"); inputs.push({ id: text(entry.bulkSourceId), content }); } } finally { db.close(); }
  const helperDir = NATIVE_SOURCE + "/cmd/relay-quality-structured-v3";
  if (!fs.existsSync(helperDir)) fs.mkdirSync(helperDir, { mode: 0o700 });
  requireQuality(fs.realpathSync(helperDir) === helperDir, "native_helper_directory_symlink_rejected");
  const helper = helperDir + "/main.go";
  if (fs.existsSync(helper)) requireQuality(sha(fs.readFileSync(helper, "utf8")) === sha(nativeHelper), "native_helper_changed");
  else fs.writeFileSync(helper, nativeHelper, { flag: "wx", mode: 0o600 });
  const binary = isolatedPath(DIRECTORY + "/native-chunker", true);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off", GOPATH: ENGINE + "/build/cache/gopath", GOCACHE: ENGINE + "/build/cache/go-build", GOMAXPROCS: "2", GOMEMLIMIT: "2GiB", LOG_LEVEL: "warn", LLM_DEBUG_LOG: "false", WEKNORA_LLM_STREAM_RAW_DUMP: "false" };
  const compiled = spawnSync(isolatedPath(ENGINE + "/build/toolchain/go/bin/go"), ["build", "-mod=readonly", "-o", binary, "./cmd/relay-quality-structured-v3"], { cwd: isolatedPath(NATIVE_SOURCE), env, encoding: "utf8", timeout: 300000, maxBuffer: 1024 * 1024 });
  requireQuality(compiled.status === 0, "native_cpu_helper_compile_failed"); fs.chmodSync(binary, 0o700);
  const result = spawnSync(binary, [], { cwd: DIRECTORY, env, input: inputs.map(input => JSON.stringify(input)).join("\n") + "\n", encoding: "utf8", timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
  requireQuality(result.status === 0, "native_cpu_chunking_failed");
  const rows = result.stdout.trim().split(/\r?\n/).map(line => record(JSON.parse(line))); requireQuality(rows.length === SOURCE_COUNT, "native_output_count_mismatch");
  const byId = new Map(rows.map(row => [text(row.bulkSourceId), row])); requireQuality(byId.size === SOURCE_COUNT, "native_duplicate_id");
  for (const entry of manifest) { const row = byId.get(text(entry.bulkSourceId)); requireQuality(row && row.normalizedSha256 === entry.normalizedSha256, "native_input_hash_mismatch"); const cfg = record(row.config); requireQuality(cfg.chunkSize === 512 && cfg.chunkOverlap === 80 && cfg.enableParentChild === false && row.batchEmbedSize === 5, "native_default_config_changed"); }
  const summary = budgetSummary(rows, priorCalls); assertFreeze(freezeSha); requireQuality(durableCalls() === priorCalls, "concurrent_model_activity_during_cpu_budget");
  const nativeOutput = saveJsonl("native-budget.jsonl", rows);
  const finalManifest = manifest.map(entry => ({ ...entry, preview: { ...byId.get(text(entry.bulkSourceId)), status: "ok", method: "native_cpu_only_not_http", modelCalls: 0 } }));
  const output = saveJsonl("manifest.jsonl", finalManifest);
  const sampleIds = new Set<string>();
  const pick = (ordered: Row[], count: number) => { for (const row of ordered.slice(0, count)) sampleIds.add(text(row.bulkSourceId)); };
  pick([...manifest].sort((a,b)=>Number(b.normalizedChars)-Number(a.normalizedChars)),2);
  pick([...manifest].filter(row=>Number(row.normalizedChars)<=65536).sort((a,b)=>Number(b.normalizedChars)-Number(a.normalizedChars)),2);
  pick([...manifest].sort((a,b)=>Number(b.links)-Number(a.links)),2); pick([...manifest].sort((a,b)=>Number(b.images)-Number(a.images)),2);
  pick([...manifest].sort((a,b)=>Number(b.sectionCount)-Number(a.sectionCount)),2);
  for (const field of ["tableElements", "codeFences", "anchors"]) pick([...manifest].sort((a,b)=>Number(record(b.structuralFeatures)[field])-Number(record(a.structuralFeatures)[field])),2);
  pick(rows.filter(row=>Number(row.chunkCount)>Number(row.indexableChunks)),3);
  const inputMap = new Map(inputs.map(input=>[input.id,input]));
  saveJsonl("http-preview-calibration-inputs.jsonl", [...sampleIds].map(id=>({ bulkSourceId:id, ...byId.get(id), eligibleForHttp:[...inputMap.get(id)!.content].length<=65536 && Number(byId.get(id)!.chunkCount)<=500, request:{path:"/api/v1/chunker/preview",body:previewRequest(inputMap.get(id)!.content)} })));
  const lease = record(readJson(isolatedPath(NONPROD_ROOT + "/runtime/full-213/budget-lease.json")));
  const report = save("budget-report.json", { schemaVersion:1,candidate:layout.candidate,status:"computed_cpu_only_pending_http_calibration_and_root_budget_review",computedAt:new Date().toISOString(), ...summary,
    freezeSha256:freezeSha, sourceManifestSha256:ORIGINAL_MANIFEST_SHA256, structuredManifest:output, nativeOutput, nativeSourceCommit:freeze.nativeCommit,
    method:"NormalizeLineEndings -> NormalizeHTMLTables -> NormalizeSplitterConfig({}) -> SplitWithDiagnostics -> strings.TrimSpace(Content) filter -> ceil(indexableChunks / 5)",
    changedParsedBodies:manifest.filter(entry=>entry.bodySha256!==entry.previousBodySha256).length,
    helperSha256:sha(nativeHelper), helperBinarySha256:byteSha(fs.readFileSync(binary)), calibrationSampleCount:sampleIds.size, httpCalibrationComplete:false,
    budgetLease:{id:lease.id,status:lease.status,expiresAt:lease.expiresAt}, modelCalls:0, credentialReads:0,
    exclusions:["Wiki generation","query embedding","rerank calls","billing tokenizer exactness"], executionAuthorized:false });
  process.stdout.write(JSON.stringify({ stage:"cpu_budget_complete", ...summary, report, modelCalls:0, executionAuthorized:false })+"\n");
}
function validateCalibration(freezeSha: string | undefined): void {
  assertFreeze(freezeSha);
  const samples = readJsonl("http-preview-calibration-inputs.jsonl").filter(row=>row.eligibleForHttp === true);
  const responses = readJsonl("http-preview-responses.jsonl"), byId = new Map(responses.map(row=>[text(row.bulkSourceId),row]));
  requireQuality(samples.length > 0 && byId.size === samples.length && responses.length === samples.length, "calibration_response_set_mismatch");
  const results = samples.map(sample=>{ const response=byId.get(text(sample.bulkSourceId)); requireQuality(response,"calibration_sample_missing"); return { bulkSourceId:sample.bulkSourceId, normalizedSha256:sample.normalizedSha256, ...verifyPreviewCalibration(sample, record(response.response)) }; });
  const originalBudget = record(readJson(isolatedPath(DIRECTORY + "/budget-report.json")));
  const count = durableCalls(); requireQuality(count === originalBudget.priorDurableCalls,"model_calls_changed_since_budget");
  const output = save("http-preview-calibration-report.json", { schemaVersion:1,candidate:layout.candidate,status:"native_http_preview_exact_parity_verified",calibratedAt:new Date().toISOString(),freezeSha256:freezeSha,
    samples:results,sourceCount:SOURCE_COUNT,structuredManifest:originalBudget.structuredManifest,priorDurableCalls:count,modelCalls:0,
    requiresAdditionalAuthorization:originalBudget.requiresAdditionalAuthorization,executionAuthorized:false });
  process.stdout.write(JSON.stringify({stage:"http_preview_calibration_verified",sampleCount:results.length,...output,modelCalls:0,executionAuthorized:false})+"\n");
}
async function main(): Promise<void> {
  const args = argumentsFor(["--phase", "--freeze-sha", "--candidate"]); const phase = args.get("--phase");
  layout = candidateLayout(args.get("--candidate")); DIRECTORY = layout.directory; CODE_ROOT = layout.codeRoot;
  requireQuality(phase !== "prepare" || !layout.sharedInputsReadOnly, "candidate_preparation_is_read_only");
  requireQuality(["prepare","freeze","import","budget","validate-calibration"].includes(phase ?? ""), "unknown_phase");
  requireQuality(process.env.RELAY_QUALITY_ISOLATED === "1" && process.platform === "linux", "explicit_nonproduction_mode_required");
  process.umask(0o077);
  requireQuality(fs.realpathSync(path.dirname(fileURLToPath(import.meta.url))) === CODE_ROOT + "/scripts", "installed_isolated_parser_driver_required");
  if (phase === "prepare") prepare(); else if (phase === "freeze") captureFreeze(); else if (phase === "import") await reparse(args.get("--freeze-sha")); else if (phase === "budget") await budget(args.get("--freeze-sha")); else validateCalibration(args.get("--freeze-sha"));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) { main().catch(safeFailure); }
