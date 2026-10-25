import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgeStore } from '../src/knowledge/store.ts';
import { WeKnoraClient, type WeKnoraRequestTrace } from '../src/knowledge/weknora.ts';
import { WeKnoraClientDocumentWriter, WeKnoraIngestor, normalizeProductContent, type WeKnoraDocumentInput, type WeKnoraModelProvenance } from '../src/knowledge/weknora-ingest.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const fileHash = (text: string) => createHash('md5').update(text).digest('hex'); // v0.8.3 calculateFileHash
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const provenance: WeKnoraModelProvenance = { knowledgeBaseId: 'kb', providerId: 'embedding', modelId: 'embedding-model', dimensions: 1024, indexVersion: 1 };
const input: WeKnoraDocumentInput = { idempotencyKey: 'run-1', title: 'Source guide', content: '<h1>Shared guide</h1><p>Unmodified source text.</p>', sourcePath: 'manual/guide.html', productVersion: '21.3', projectId: 'p1', environment: 'nonprod', parserVersion: 'v1' };
interface StoredFile { id: string; knowledge_base_id: string; channel: string; metadata: Record<string, string>; file_hash: string; content: string; parse_status: string; }

/** Contract model pinned to v0.8.3 knowledge_create.go and repository/knowledge.go; not live E2E evidence. */
function upstream(mode: 'scoped' | 'ignore-identity' | 'lie-about-identity' = 'scoped') {
  const files: StoredFile[] = [], uploads: Array<{ content: string; metadata: Record<string, string>; channel: string }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/knowledge/file')) {
      const form = init?.body as FormData;
      const content = await (form.get('file') as File).text();
      const metadata = JSON.parse(String(form.get('metadata') ?? '{}')) as Record<string, string>;
      const channel = String(form.get('channel') ?? 'web');
      uploads.push({ content, metadata, channel });
      const scopeIdentity = mode === 'scoped' && ['gitlab', 'confluence', 'seafile'].includes(channel) && metadata.datasource_id && metadata.external_id;
      const existing = files.find(file => file.file_hash === fileHash(content) && (!scopeIdentity ||
        (file.metadata.datasource_id === metadata.datasource_id && file.metadata.external_id === metadata.external_id)));
      if (existing) return json({ success: false, code: 'duplicate_file', data: mode === 'lie-about-identity' ? { ...existing, channel, metadata } : existing }, 409);
      const file: StoredFile = { id: `document-${files.length + 1}`, knowledge_base_id: 'kb', channel, metadata, file_hash: fileHash(content), content, parse_status: 'completed' };
      files.push(file); return json({ success: true, data: file });
    }
    const id = path.split('/').pop()!; const file = files.find(file => file.id === id);
    assert.ok(file, 'document must have been uploaded');
    if (path.includes('/chunks/')) return json({ success: true, data: [{ id: `chunk-${id}`, knowledge_id: id, content: file.content, seq: 0, chunk_type: 'text', is_enabled: true, index_status: 'ready' }], total: 1 });
    return json({ success: true, data: file });
  };
  return { files, uploads, fetchImpl };
}
async function fixture(fn: (f: { ingestor: WeKnoraIngestor; writer: WeKnoraClientDocumentWriter; remote: ReturnType<typeof upstream>; traces: WeKnoraRequestTrace[]; store: ReturnType<typeof createKnowledgeStore> }) => Promise<void>, mode: Parameters<typeof upstream>[0] = 'scoped') {
  const directory = mkdtempSync(join(tmpdir(), 'relay-source-identity-'));
  const store = createKnowledgeStore({ dbPath: join(directory, 'knowledge.db') });
  const remote = upstream(mode), traces: WeKnoraRequestTrace[] = [];
  const client = new WeKnoraClient({ baseUrl: 'http://engine.invalid', fetchImpl: remote.fetchImpl, secretResolver: async () => 'private-auth-token', onTrace: trace => traces.push(trace) });
  const writer = new WeKnoraClientDocumentWriter(client, 'kb', { modelProvenance: provenance });
  try { await fn({ ingestor: new WeKnoraIngestor(store, writer), writer, remote, traces, store }); }
  finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}
const normalizedInput = (value: WeKnoraDocumentInput) => { const normalizedContent = normalizeProductContent(value.content); return { ...value, normalizedContent, normalizedContentSha256: hash(normalizedContent) }; };

test('same Markdown bytes retain distinct upstream identities across parser versions, raw sources, versions and scopes', () => fixture(async ({ ingestor, remote }) => {
  const variants = [input,
    { ...input, idempotencyKey: 'other-version', productVersion: '21.1' },
    { ...input, idempotencyKey: 'other-parser', parserVersion: 'v2' },
    { ...input, idempotencyKey: 'other-raw-source', rawSha256: 'different-raw-source-proof' },
    { ...input, idempotencyKey: 'other-path', sourcePath: 'other/guide.html' },
    { ...input, idempotencyKey: 'other-project', projectId: 'p2' },
    { ...input, idempotencyKey: 'other-environment', environment: 'prod' },
    { ...input, idempotencyKey: 'global', projectId: undefined, environment: undefined },
  ];
  const results = [];
  for (const value of variants) results.push(await ingestor.stage(value));
  assert.equal(new Set(results.map(result => result.externalDocumentId)).size, variants.length);
  assert.equal(new Set(results.map(result => result.normalizedContentSha256)).size, 1);
  assert.equal(remote.files.length, variants.length);
  assert.equal(new Set(remote.uploads.map(upload => upload.metadata.external_id)).size, variants.length);
  for (let i = 0; i < variants.length; i++) {
    assert.equal(results[i].productVersion, variants[i].productVersion);
    assert.equal(results[i].projectId, variants[i].projectId);
    assert.equal(results[i].environment, variants[i].environment);
    assert.equal(results[i].sourcePath, variants[i].sourcePath);
    assert.deepEqual(results[i].externalChunkIds, [`chunk-${results[i].externalDocumentId}`]);
  }
}));

test('source identity survives retries and changed import keys without modifying Markdown or leaking credentials', () => fixture(async ({ writer, remote, traces }) => {
  const first = await writer.upsertDocument(normalizedInput(input));
  const again = await writer.upsertDocument(normalizedInput({ ...input, idempotencyKey: 'another-migration-key', title: 'Renamed display title' }));
  assert.equal(first.externalDocumentId, again.externalDocumentId);
  assert.equal(remote.files.length, 1); assert.equal(remote.uploads.length, 2);
  assert.equal(remote.uploads[0].metadata.external_id, remote.uploads[1].metadata.external_id);
  assert.match(remote.uploads[0].metadata.external_id, /^[a-f0-9]{64}$/);
  assert.equal(remote.uploads[0].metadata.datasource_id, 'relay-mcp-product-v1');
  assert.equal(remote.uploads[0].metadata.relay_ingestion_source, 'relay_product_knowledge');
  assert.equal(remote.uploads[0].channel, 'gitlab', 'pinned v0.8.3 source-identity compatibility field, not source provenance');
  for (const upload of remote.uploads) {
    assert.equal(upload.content, normalizeProductContent(input.content));
    assert.ok(!JSON.stringify(upload).includes('private-auth-token'));
  }
  assert.ok(!JSON.stringify(traces).includes('Unmodified source text'));
  assert.ok(!JSON.stringify(traces).includes('private-auth-token'));
}));

test('changed embedding index identity cannot reuse same-byte upstream vectors', () => fixture(async ({ writer, remote }) => {
  const first = await writer.upsertDocument(normalizedInput(input));
  const changed = new WeKnoraClientDocumentWriter(new WeKnoraClient({ baseUrl: 'http://engine.invalid', fetchImpl: remote.fetchImpl }), 'kb', { modelProvenance: { ...provenance, modelId: 'next-model', dimensions: 2048, indexVersion: 2 } });
  const second = await changed.upsertDocument(normalizedInput(input));
  assert.notEqual(first.externalDocumentId, second.externalDocumentId);
  assert.notEqual(remote.uploads[0].metadata.external_id, remote.uploads[1].metadata.external_id);
}));

test('upstream ignoring source identity fails closed and cannot overwrite another Relay source mapping', () => fixture(async ({ ingestor, store }) => {
  const first = await ingestor.stage(input);
  await assert.rejects(ingestor.stage({ ...input, idempotencyKey: 'foreign-scope', projectId: 'p2' }), /identity|scope|conflict/i);
  assert.equal(ingestor.get(first.id)?.projectId, 'p1');
  const rejected = store.db.prepare("SELECT status,failure_code FROM knowledge_weknora_documents WHERE idempotency_key='foreign-scope'").get() as { status: string; failure_code: string };
  assert.equal(rejected.status, 'failed'); assert.match(rejected.failure_code, /conflict/);
}, 'ignore-identity'));

test('local external identity collision guard remains effective even if upstream echoes forged identity', () => fixture(async ({ ingestor, store }) => {
  const first = await ingestor.stage(input);
  await assert.rejects(ingestor.stage({ ...input, idempotencyKey: 'forged', productVersion: '21.1' }), /external_identity_conflict/);
  assert.equal(ingestor.get(first.id)?.productVersion, '21.3');
  assert.equal((store.db.prepare("SELECT status FROM knowledge_weknora_documents WHERE idempotency_key='forged'").get() as { status: string }).status, 'failed');
}, 'lie-about-identity'));

test('source identity response verification rejects wrong KB, metadata, channel and non-duplicate conflicts', async () => {
  const identity = { dataSourceId: 'relay-mcp-product-v1', externalId: 'a'.repeat(64) };
  const good = { id: 'doc', knowledge_base_id: 'kb', channel: 'gitlab', metadata: { datasource_id: identity.dataSourceId, external_id: identity.externalId } };
  for (const response of [
    json({ success: true, data: { ...good, knowledge_base_id: 'foreign' } }),
    json({ success: true, data: { ...good, metadata: {} } }),
    json({ success: true, data: { ...good, channel: 'web' } }),
    json({ success: false, code: 'another_conflict', data: good }, 409),
  ]) {
    const client = new WeKnoraClient({ baseUrl: 'http://engine.invalid', fetchImpl: async () => response });
    await assert.rejects(client.upsertDocument({ knowledgeBaseId: 'kb', title: 'Guide', content: 'Body', sourceIdentity: identity }), /identity|conflict/i);
  }
});
