/** Real original-format acceptance in a dedicated nonproduction database. Never invokes a model. */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, link, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = '/home/ftd/relay-knowledge-engine-nonprod';
const repository = root + '/relay', bulk = root + '/bulk', database = bulk + '/knowledge.db';
const reportPath = bulk + '/raw-formats-acceptance.json';
const extractor = bulk + '/tools/7zip-26.05/7zz';
const sources = [
  { version: '21.1', name: '21.1 Docs.zip', expected: { pdfFiles: 4, chmArchives: 3, zipArchives: 2 }, sizeBytes: 268002743, sha256: '1cff794c938afe3544d426f0fae9f4ec056caebae5513372c1c31a3ac6832908' },
  { version: '21.3', name: '21.3 Docs.zip', expected: { pdfFiles: 3, chmArchives: 0, zipArchives: 3 }, sizeBytes: 397941192, sha256: '256b2a52562f321f2788205605436e5e00272060ad76c20263c637672c4b7342' },
];
const report: any = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), database, sources, jobs: [], structure: {}, modelCalls: 0, structureMetricNotes: { tableRows: 'Parsed table-like lines, not source HTML table elements.', anchors: 'Parser section anchors; original HTML anchor identity is not asserted.', pdf: 'Native PDF text extraction; visual layout fidelity is not asserted.' } };
let safe = false, store: any;
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
async function fileHash(path: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function save() { if (!safe) return; const temp = reportPath + `.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); await rename(temp, reportPath); await chmod(reportPath, 0o600); }
function snapshot() {
  const count = (table: string) => Number(store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  const hash = createHash('sha256');
  for (const row of store.db.prepare('SELECT id,source_sha256 FROM knowledge_documents ORDER BY id').iterate()) hash.update(`${row.id}\0${row.source_sha256}\n`);
  for (const row of store.db.prepare('SELECT id,content_sha256 FROM knowledge_chunks ORDER BY id').iterate()) hash.update(`${row.id}\0${row.content_sha256}\n`);
  return { documents: count('knowledge_documents'), chunks: count('knowledge_chunks'), revisions: count('knowledge_product_revisions'), corpusSha256: hash.digest('hex') };
}
function structure(version: string) {
  const formats: Record<string, any> = {};
  for (const d of store.db.prepare('SELECT d.id,d.title,d.body,p.source_path,p.source_sha256,p.sections_json,p.metadata_json FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE p.version=? ORDER BY d.id').iterate(version)) {
    const metadata = JSON.parse(d.metadata_json), sections = JSON.parse(d.sections_json);
    const format = /\.chm\.expanded-[^/]+\//i.test(d.source_path) ? 'chm-html' : String(metadata.sourceFormat);
    const entry = formats[format] ??= { documents: 0, bodyBytes: 0, headings: 0, anchors: 0, tableRows: 0, codeBlocks: 0, links: 0, stableIdentifiers: 0, samples: [] };
    const headings = (d.body.match(/^#{1,6}\s+\S/gm) ?? []).length;
    const anchors = sections.filter((section: any) => section.anchor).length;
    const tableRows = (d.body.match(/^\s*\|[^\n]+\|/gm) ?? []).length;
    const codeBlocks = Math.floor((d.body.match(/^```/gm) ?? []).length / 2);
    const links = (metadata.links ?? []).length, stableIdentifiers = Object.keys(metadata.stableIdentifiers ?? {}).length;
    entry.documents++; entry.bodyBytes += Buffer.byteLength(d.body); entry.headings += headings; entry.anchors += anchors; entry.tableRows += tableRows; entry.codeBlocks += codeBlocks; entry.links += links; entry.stableIdentifiers += stableIdentifiers;
    if (format === 'pdf') check(d.body.trim().length > 20 && !d.body.startsWith('[PDF source:'), 'pdf_placeholder_or_empty_content');
    const proof = { documentId: d.id, sourcePath: d.source_path, sourceSha256: d.source_sha256, titleChars: d.title.length, titleSha256: sha(d.title), bodyBytes: Buffer.byteLength(d.body), bodySha256: sha(d.body), headings, sections: sections.length, anchors, anchorSha256: sha(JSON.stringify(sections.map((s: any) => s.anchor))), tableRows, codeBlocks, links, stableIdentifiers };
    if (entry.samples.length < 3 || (tableRows && !entry.samples.some((s: any) => s.tableRows)) || (codeBlocks && !entry.samples.some((s: any) => s.codeBlocks))) entry.samples.push(proof);
  }
  return formats;
}
async function main() {
  check(process.platform === 'linux' && process.env.RELAY_E2E_ISOLATED === '1', 'isolated_linux_required');
  check(await realpath(process.cwd()) === repository && await realpath(dirname(dirname(fileURLToPath(import.meta.url)))) === repository, 'exact_nonproduction_checkout_required');
  check(await realpath(root) === root, 'nonproduction_root_symlink');
  await mkdir(bulk, { recursive: true, mode: 0o700 }); await chmod(bulk, 0o700); check(await realpath(bulk) === bulk, 'bulk_symlink');
  const markerPath = bulk + '/raw-formats-owner.json';
  if (existsSync(database)) check(await realpath(database) === database && (await stat(database)).nlink === 1 && existsSync(markerPath) && JSON.parse(await readFile(markerPath, 'utf8')).database === database, 'unowned_bulk_database');
  else await writeFile(markerPath, JSON.stringify({ database, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  check(await fileHash(extractor) === 'd32657a7a0e4cdc0a8aa57cafe474746944d76e861e753e9c902b9c9356fa886', 'extractor_hash_mismatch');
  report.extractor = JSON.parse(await readFile(bulk + '/tools/7zip-26.05/manifest.json', 'utf8'));
  await mkdir(bulk + '/inputs', { recursive: true, mode: 0o700 });
  for (const source of sources) {
    const original = root + '/sources/' + source.name;
    check(await realpath(original) === original && (await stat(original)).size === source.sizeBytes && await fileHash(original) === source.sha256, 'source_verification_failed');
    const input = bulk + '/inputs/' + source.name;
    if (!existsSync(input)) await link(original, input);
    check(await realpath(input) === input && (await stat(input)).size === source.sizeBytes && await fileHash(input) === source.sha256, 'bulk_input_verification_failed');
  }
  process.env.DB_PATH = bulk + '/unused-app.db'; process.env.KNOWLEDGE_DB_PATH = database;
  process.env.RELAY_CHM_EXTRACTOR = extractor; process.env.KNOWLEDGE_ENGINE_ENABLED = 'false'; process.env.RELAY_INGEST_TIMEOUT_MS = '1800000';
  const { createKnowledgeStore } = await import('../src/knowledge/store.js');
  const { enqueueProductImport, runPendingIngestJobs } = await import('../src/knowledge/ingest-worker.js');
  store = createKnowledgeStore({ dbPath: database, appDbPath: process.env.DB_PATH }); await chmod(database, 0o600); safe = true;
  check(store.db.name === database, 'database_scope_mismatch');
  check(Number(store.db.prepare('SELECT COUNT(*) AS n FROM knowledge_provider_configs').get().n) === 0, 'bulk_providers_must_be_empty');
  if (existsSync(reportPath)) {
    const priorBytes = await readFile(reportPath, 'utf8'), prior = JSON.parse(priorBytes);
    check(prior.database === database && sources.every(source => prior.sources.some((p: any) => p.version === source.version && p.sha256 === source.sha256 && p.sizeBytes === source.sizeBytes)), 'resume_report_scope_mismatch');
    if (prior.failureCode === 'required_original_formats_not_parsed') {
      const backup = bulk + '/raw-formats-acceptance.initial-failure.json';
      if (!existsSync(backup)) await writeFile(backup, priorBytes, { mode: 0o600, flag: 'wx' });
    }
    Object.assign(report, prior); report.sources = sources; report.status = 'running';
    if (prior.failureCode) report.driverAmendments = [{ priorFailureCode: prior.failureCode, resolution: 'Verified exact package inventory: 21.3 contains PDF and nested HTML ZIPs but no CHM. Assertions now compare each pinned package against its actual formats.', at: new Date().toISOString() }];
    delete report.failureCode; delete report.finishedAt;
    for (const formats of Object.values(report.structure) as any[]) for (const value of Object.values(formats) as any[]) {
      if (value.tables !== undefined) { value.tableRows = value.tables; delete value.tables; }
      for (const sample of value.samples) if (sample.tables !== undefined) { sample.tableRows = sample.tables; delete sample.tables; }
    }
  }
  const verifyFormats = (parsing: any, source: typeof sources[number]) => check(parsing?.pdfFiles === source.expected.pdfFiles && parsing?.chmArchives === source.expected.chmArchives && parsing?.zipArchives === source.expected.zipArchives && (source.expected.chmArchives === 0 ? parsing?.chmHtmlFiles === 0 : parsing?.chmHtmlFiles > 0), 'required_original_formats_not_parsed');
  await save();
  for (const source of sources) {
    let first: any;
    for (const pass of [1, 2]) {
      const completed = report.jobs.find((job: any) => job.version === source.version && job.pass === pass && job.status === 'succeeded');
      if (completed) {
        verifyFormats(completed.parsing, source);
        if (pass === 1) { completed.snapshot ??= snapshot(); first = completed.snapshot; }
        else check(completed.idempotencyVerified && JSON.stringify(completed.snapshot) === JSON.stringify(first), 'resume_repeat_proof_missing');
        await save(); continue;
      }
      const job = enqueueProductImport(store, { root: bulk + '/inputs/' + source.name, product: 'SampleManager', sampleManagerVersion: source.version, authority: 'official', language: 'en', idempotencyKey: `raw-format-original-v1:${source.version}:${pass}` });
      const record: any = { version: source.version, pass, id: job.id, status: 'running', startedAt: new Date().toISOString() }; report.jobs.push(record); await save();
      console.log(`[raw-formats-e2e] ${source.version} pass ${pass}: running`);
      const timer = setInterval(() => {
        const current = store.db.prepare('SELECT status,result_json FROM knowledge_ingest_jobs WHERE id=?').get(job.id);
        let progress: any = {}; try { progress = JSON.parse(current.result_json ?? '{}'); } catch {}
        console.log(JSON.stringify({ event: 'bulk_progress', version: source.version, pass, status: current.status, processed: progress.processed, total: progress.total, imported: progress.imported, unchanged: progress.unchanged }));
      }, 30000);
      try { await runPendingIngestJobs(store); } finally { clearInterval(timer); }
      const result = store.db.prepare('SELECT status,result_json,error FROM knowledge_ingest_jobs WHERE id=?').get(job.id);
      const summary = JSON.parse(result.result_json ?? '{}');
      Object.assign(record, { status: result.status, finishedAt: new Date().toISOString(), runId: summary.runId, imported: summary.imported, unchanged: summary.unchanged, failed: summary.failed, parsing: summary.parsing, warningCount: summary.warnings?.length, errorSha256: result.error ? sha(result.error) : undefined });
      await save(); check(result.status === 'succeeded', 'real_format_import_failed');
      verifyFormats(summary.parsing, source);
      record.snapshot = snapshot();
      if (pass === 1) first = record.snapshot;
      else { check(JSON.stringify(record.snapshot) === JSON.stringify(first) && summary.imported === 0 && summary.updated === 0, 'repeat_import_changed_corpus'); record.idempotencyVerified = true; }
      await save(); console.log(`[raw-formats-e2e] ${source.version} pass ${pass}: passed`);
    }
    report.structure[source.version] = structure(source.version); await save();
  }
  check(Number(store.db.prepare('SELECT COUNT(*) AS n FROM knowledge_provider_configs').get().n) === 0, 'unexpected_provider_configuration');
  report.final = snapshot(); report.integrity = store.db.pragma('integrity_check', { simple: true }); check(report.integrity === 'ok', 'bulk_database_integrity');
  report.status = 'passed_original_formats_and_idempotency'; report.finishedAt = new Date().toISOString(); await save(); console.log('[raw-formats-e2e] passed_original_formats_and_idempotency');
}
try { await main(); }
catch (error) { report.status = 'failed'; report.failureCode = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'driver_error'; report.finishedAt = new Date().toISOString(); await save(); console.error(`[raw-formats-e2e] failed: ${report.failureCode}; isolated state preserved`); process.exitCode = 1; }
finally { store?.close(); }