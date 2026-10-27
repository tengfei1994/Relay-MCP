import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { createKnowledgeStore } from '../src/knowledge/store.ts';
import { enqueueProductImport, runPendingIngestJobs } from '../src/knowledge/ingest-worker.ts';
import { importKnowledgeProducts, importKnowledgeProductsAsync } from '../src/knowledge/knowledge-products.ts';

function compressedPdf(text: string): Uint8Array {
  const stream = deflateSync(Buffer.from(`BT /F1 14 Tf 50 700 Td (${text}) Tj ET`));
  const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'), Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'), Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'), Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream')])];
  const parts = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = parts[0].length;
  objects.forEach((object, i) => { offsets.push(length); const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]); parts.push(part); length += part.length; });
  parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

test('async outer ZIP import parses compressed nested PDF text and repeats without new documents or chunks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-real-pdf-'));
  const archive = join(root, 'Docs.zip');
  writeFileSync(archive, zipSync({ 'Developer.zip': zipSync({ 'Guide.pdf': compressedPdf('Nested PDF acceptance text') }) }));
  const store = createKnowledgeStore({ dbPath: join(root, 'knowledge.db') });
  try {
    const first = enqueueProductImport(store, { root: archive, sampleManagerVersion: '21.3', idempotencyKey: 'real-pdf-first' });
    await runPendingIngestJobs(store);
    const job = store.db.prepare('SELECT status,result_json FROM knowledge_ingest_jobs WHERE id=?').get(first.id) as any;
    assert.equal(job.status, 'succeeded');
    assert.deepEqual(JSON.parse(job.result_json).parsing, { pdfFiles: 1, chmArchives: 0, chmHtmlFiles: 0, zipArchives: 2 });
    const document = store.db.prepare("SELECT d.id,d.body,p.source_path FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE p.document_type='pdf'").get() as any;
    assert.match(document.body, /Nested PDF acceptance text/);
    assert.match(document.source_path, /Developer\.zip.*Guide\.pdf/);
    const counts = () => ({ documents: (store.db.prepare('SELECT COUNT(*) AS n FROM knowledge_documents').get() as any).n, chunks: (store.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get() as any).n });
    const before = counts();
    const second = enqueueProductImport(store, { root: archive, sampleManagerVersion: '21.3', idempotencyKey: 'real-pdf-repeat' });
    await runPendingIngestJobs(store);
    const repeated = store.db.prepare('SELECT status,result_json FROM knowledge_ingest_jobs WHERE id=?').get(second.id) as any;
    assert.equal(repeated.status, 'succeeded'); assert.deepEqual(counts(), before);
    assert.equal(JSON.parse(repeated.result_json).imported, 0); assert.equal(JSON.parse(repeated.result_json).unchanged, 1);
  } finally { await runPendingIngestJobs(store); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('async PDF import rejects unreadable content instead of indexing a fallback placeholder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-invalid-pdf-'));
  const archive = join(root, 'Docs.zip'); writeFileSync(archive, zipSync({ 'Broken.pdf': Buffer.from('not a PDF') }));
  const store = createKnowledgeStore({ dbPath: join(root, 'knowledge.db') });
  try {
    const job = enqueueProductImport(store, { root: archive, sampleManagerVersion: '21.3' }); await runPendingIngestJobs(store);
    assert.equal((store.db.prepare('SELECT status FROM knowledge_ingest_jobs WHERE id=?').get(job.id) as any).status, 'failed');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM knowledge_documents').get() as any).n, 0);
  } finally { await runPendingIngestJobs(store); store.close(); rmSync(root, { recursive: true, force: true }); }
});
test('native PDF reimport repairs legacy extraction in place while preserving identity, scope and review state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-pdf-upgrade-'));
  const archive = join(root, 'Docs.zip');
  writeFileSync(archive, zipSync({ 'Developer.zip': zipSync({ 'Guide.pdf': compressedPdf('Native PDF upgrade acceptance text') }) }));
  const store = createKnowledgeStore({ dbPath: join(root, 'knowledge.db') });
  const options = { root: archive, sampleManagerVersion: '21.3' };
  try {
    const legacy = importKnowledgeProducts(store, { ...options, idempotencyKey: 'legacy' });
    assert.equal(legacy.imported, 1);
    const before = store.db.prepare('SELECT * FROM knowledge_documents').get() as any;
    assert.doesNotMatch(before.body, /Native PDF upgrade acceptance text/);
    store.db.prepare("UPDATE knowledge_documents SET lifecycle='deprecated',project_id='project-private',environment='restricted' WHERE id=?").run(before.id);
    store.db.prepare("UPDATE knowledge_scope_bindings SET scope_type='environment',scope_key='restricted',visibility='private',source_project_id='project-private' WHERE document_id=?").run(before.id);
    store.db.prepare("UPDATE knowledge_product_documents SET review_status='reviewed',metadata_json=json_set(metadata_json,'$.reviewNote','preserve') WHERE id=?").run(before.id);
    const scopeBefore = store.db.prepare('SELECT scope_type,scope_key,visibility,source_project_id FROM knowledge_scope_bindings WHERE document_id=?').all(before.id);
    const fixed = await importKnowledgeProductsAsync(store, { ...options, idempotencyKey: 'native-upgrade' });
    assert.equal(fixed.status, 'succeeded'); assert.equal(fixed.imported, 0); assert.equal(fixed.updated, 1); assert.equal(fixed.unchanged, 0);
    const after = store.db.prepare('SELECT * FROM knowledge_documents').get() as any;
    assert.equal(after.id, before.id); assert.equal(after.source_sha256, before.source_sha256); assert.equal(after.created_at, before.created_at);
    assert.equal(after.lifecycle, 'deprecated'); assert.equal(after.project_id, 'project-private'); assert.equal(after.environment, 'restricted');
    assert.match(after.body, /Native PDF upgrade acceptance text/);
    assert.deepEqual(store.db.prepare('SELECT scope_type,scope_key,visibility,source_project_id FROM knowledge_scope_bindings WHERE document_id=?').all(before.id), scopeBefore);
    const product = store.db.prepare('SELECT * FROM knowledge_product_documents WHERE id=?').get(before.id) as any;
    assert.equal(product.review_status, 'reviewed'); assert.equal(JSON.parse(product.metadata_json).reviewNote, 'preserve');
    assert.equal(JSON.parse(product.metadata_json).pdfExtraction, 'pdf-parse');
    assert.match((store.db.prepare('SELECT group_concat(content) body FROM knowledge_chunks WHERE document_id=?').get(before.id) as any).body, /Native PDF upgrade acceptance text/);
    assert.equal((store.db.prepare('SELECT body FROM knowledge_product_revisions WHERE id=?').get(product.revision_id) as any).body, after.body);
    const chunkRows = store.db.prepare('SELECT id,content_sha256 FROM knowledge_chunks WHERE document_id=? ORDER BY ordinal').all(before.id);
    const repeated = await importKnowledgeProductsAsync(store, { ...options, idempotencyKey: 'native-repeat' });
    assert.equal(repeated.imported, 0); assert.equal(repeated.updated, 0); assert.equal(repeated.unchanged, 1);
    assert.deepEqual(store.db.prepare('SELECT id,content_sha256 FROM knowledge_chunks WHERE document_id=? ORDER BY ordinal').all(before.id), chunkRows);    // A user's authored correction is not a legacy parser result.
    store.db.prepare('UPDATE knowledge_documents SET body=? WHERE id=?').run('Reviewed and corrected PDF text', before.id);
    store.db.prepare("UPDATE knowledge_product_documents SET metadata_json=json_remove(metadata_json,'$.pdfExtraction') WHERE id=?").run(before.id);
    const authored = await importKnowledgeProductsAsync(store, { ...options, idempotencyKey: 'native-authored' });
    assert.equal(authored.updated, 0); assert.equal(authored.unchanged, 1);
    assert.equal((store.db.prepare('SELECT body FROM knowledge_documents WHERE id=?').get(before.id) as any).body, 'Reviewed and corrected PDF text');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});