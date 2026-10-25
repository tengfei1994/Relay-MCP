import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKnowledgeStore } from '../src/knowledge/store.ts';
import { normalizeProductContent, WeKnoraIngestor, type WeKnoraDocumentInput, type WeKnoraDocumentWriter } from '../src/knowledge/weknora-ingest.ts';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

test('already parsed Markdown keeps fenced and inline angle-bracket code and source anchors byte-for-byte', () => {
  const code = 'TABLE_NAME = <TABLE\n  COLUMN_A = "one"\n\n\n  COLUMN_B = "two"\n>\nRETURN TABLE_NAME';
  const fence = '```vgl\n' + code + '\n```';
  const source = '<a id="table_name"></a>\n# TABLE_NAME\n\n' + fence + '\n\nUse `List<Record> && &lt;literal&gt;` here.\n\n- Parent\n  - Child';
  const normalized = normalizeProductContent(source);
  assert.ok(normalized.includes(fence), 'every original code byte and blank line survives');
  assert.equal(sha(normalized.match(/```vgl\n([\s\S]*?)\n```/)![1]), sha(code));
  assert.ok(normalized.includes('`List<Record> && &lt;literal&gt;`'));
  assert.ok(normalized.includes('<a id="table_name"></a>'));
  assert.ok(normalized.includes('- Parent\n  - Child'));
  assert.equal(normalizeProductContent(normalized), normalized);
});

test('tilde and longer backtick fences shield literal HTML without turning Markdown into an HTML document', () => {
  const source = '# Literal examples\n\n~~~~xml\n<script>literal code only</script>\n<Record>A</Record>\n~~~~\n\n````markdown\n```html\n<h1>Example</h1>\n```\n````\n\nAn inline ``code `tick` <Node>``.';
  assert.equal(normalizeProductContent(source), source);
});

test('raw HTML code is protected after entity decoding and remains stable on a second normalization', () => {
  const source = '<html><body><h1 id="xml-sample">Sample</h1><pre class="language-xml"><code>&lt;Record id=&quot;A&quot;&gt;\n  &lt;Value&gt;1&lt;/Value&gt;\n&lt;/Record&gt;</code></pre><p>After code</p></body></html>';
  const normalized = normalizeProductContent(source);
  assert.ok(normalized.includes('```xml\n<Record id="A">\n  <Value>1</Value>\n</Record>\n```'));
  assert.ok(normalized.includes('<a id="xml-sample"></a>'));
  assert.equal(normalizeProductContent(normalized), normalized);
});

test('normalization still removes executable and navigation markup outside literal code', () => {
  const source = '<h1>Safe</h1><script>dangerOutside()</script><style>.privateRule{}</style><nav>navigationOnly</nav><p onclick="unsafe()">Allowed prose</p><pre>&lt;script&gt;literalInside()&lt;/script&gt;</pre>';
  const normalized = normalizeProductContent(source);
  assert.doesNotMatch(normalized, /dangerOutside|privateRule|navigationOnly|onclick|unsafe/);
  assert.match(normalized, /Allowed prose/);
  assert.ok(normalized.includes('```\n<script>literalInside()</script>\n```'));
});

const input: WeKnoraDocumentInput = { idempotencyKey: 'source-v1', title: 'Source', content: '# Source\n\nUnchanged body.', sourcePath: 'manual/source.html', productVersion: '21.3', projectId: 'project1', environment: 'nonprod', parserVersion: 'parser-v1', rawSha256: 'source-raw-hash', modelProvenance: { knowledgeBaseId: 'kb', providerId: 'embed', modelId: 'model', dimensions: 3, indexVersion: 1 } };
function legacyIdentity(value: WeKnoraDocumentInput, normalizedContentSha256: string) {
  return sha(JSON.stringify({ normalizedContentSha256, productVersion: value.productVersion ?? null, solution: value.solution ?? null, module: value.module ?? null, topicId: value.topicId ?? null, sourcePath: value.sourcePath ?? null, language: value.language ?? null, projectId: value.projectId ?? null, environment: value.environment ?? null, modelProvenance: value.modelProvenance ?? null }));
}
async function fixture(fn: (context: { store: ReturnType<typeof createKnowledgeStore>; ingestor: WeKnoraIngestor; writes: Array<WeKnoraDocumentInput & { normalizedContent: string; normalizedContentSha256: string }> }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-normalizer-'));
  const store = createKnowledgeStore({ dbPath: join(dir, 'knowledge.db') });
  const writes: Array<WeKnoraDocumentInput & { normalizedContent: string; normalizedContentSha256: string }> = [];
  const writer: WeKnoraDocumentWriter = { async upsertDocument(value) { writes.push(value); return { externalDocumentId: 'external-' + writes.length, externalChunkIds: ['chunk-' + writes.length], knowledgeBaseId: 'kb', parseStatus: 'completed', modelProvenance: value.modelProvenance }; } };
  try { await fn({ store, ingestor: new WeKnoraIngestor(store, writer), writes }); }
  finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('an explicit parser upgrade creates a new immutable mapping even when normalized body bytes are identical', async () => fixture(async ({ store, ingestor, writes }) => {
  const old = await ingestor.stage(input);
  const before = store.db.prepare('SELECT * FROM knowledge_weknora_documents WHERE id=?').get(old.id);
  const current = await ingestor.stage({ ...input, idempotencyKey: 'source-v2', parserVersion: 'parser-v2' });
  assert.notEqual(current.id, old.id);
  assert.notEqual(current.externalDocumentId, old.externalDocumentId);
  assert.equal(current.normalizedContentSha256, old.normalizedContentSha256);
  assert.equal(current.parserVersion, 'parser-v2');
  assert.equal(writes.length, 2);
  assert.deepEqual(store.db.prepare('SELECT * FROM knowledge_weknora_documents WHERE id=?').get(old.id), before);
  await assert.rejects(ingestor.stage({ ...input, parserVersion: 'parser-v2' }), /idempotency|identity/i);
}));

test('legacy same-parser identities replay and dedupe without rewriting their source proof or identity', async () => fixture(async ({ store, ingestor, writes }) => {
  const old = await ingestor.stage(input);
  store.db.prepare('UPDATE knowledge_weknora_documents SET identity_hash=? WHERE id=?').run(legacyIdentity(input, old.normalizedContentSha256), old.id);
  const before = store.db.prepare('SELECT * FROM knowledge_weknora_documents WHERE id=?').get(old.id);
  assert.equal((await ingestor.stage(input)).id, old.id);
  assert.equal((await ingestor.stage({ ...input, idempotencyKey: 'same-parser-new-operation' })).id, old.id);
  assert.equal(writes.length, 1);
  assert.deepEqual(store.db.prepare('SELECT * FROM knowledge_weknora_documents WHERE id=?').get(old.id), before);
  const upgraded = await ingestor.stage({ ...input, idempotencyKey: 'legacy-to-new-parser', parserVersion: 'parser-v2' });
  assert.notEqual(upgraded.id, old.id);
  assert.equal(upgraded.parserVersion, 'parser-v2');
  await assert.rejects(ingestor.stage({ ...input, rawSha256: 'changed-source-proof' }), /idempotency|identity/i);
  await assert.rejects(ingestor.stage({ ...input, environment: 'other-scope' }), /idempotency|identity/i);
}));

test('HTML preformatted code decodes entities even when the example contains Markdown backticks', () => {
  const source = '<html><pre>Use \x60&lt;Node&gt;\x60 exactly.</pre></html>';
  const result = normalizeProductContent(source);
  assert.equal(result, '\x60\x60\x60\nUse \x60<Node>\x60 exactly.\n\x60\x60\x60');
  assert.doesNotMatch(result, /RELAY_LITERAL/);
});

test('legacy affected code replays its original mapping only at the identical parser version', async () => fixture(async ({ store, ingestor, writes }) => {
  const original = { ...input, content: '# Source\n\n\x60\x60\x60vgl\nSELECT <TABLE>\nKEEP\n\x60\x60\x60' };
  const old = await ingestor.stage(original);
  const damagedHash = sha('# Source\n\n\x60\x60\x60vgl\nSELECT\nKEEP\n\x60\x60\x60');
  store.db.prepare('UPDATE knowledge_weknora_documents SET identity_hash=?,normalized_content_sha256=? WHERE id=?')
    .run(legacyIdentity(original, damagedHash), damagedHash, old.id);
  const before = store.db.prepare('SELECT * FROM knowledge_weknora_documents WHERE id=?').get(old.id);
  assert.equal((await ingestor.stage(original)).id, old.id);
  assert.equal((await ingestor.stage({ ...original, idempotencyKey: 'old-parser-new-run' })).id, old.id);
  assert.equal(writes.length, 1, 'same-parser replay does not silently repair/relabel historical content');
  const repaired = await ingestor.stage({ ...original, idempotencyKey: 'explicit-repair-v2', parserVersion: 'relay-chm-markdown-preserve-v2' });
  assert.notEqual(repaired.id, old.id);
  assert.equal(repaired.normalizedContentSha256, sha(original.content));
  assert.equal(writes.at(-1)?.normalizedContent, original.content);
  assert.deepEqual(store.db.prepare('SELECT * FROM knowledge_weknora_documents WHERE id=?').get(old.id), before);
  store.db.prepare("UPDATE knowledge_weknora_documents SET status='failed' WHERE id=?").run(old.id);
  await assert.rejects(ingestor.stage(original, { retry: true }), (error: any) => error.code === 'parser_upgrade_required');
  assert.equal(writes.length, 2, 'same-parser retry cannot overwrite the old damaged mapping');
  assert.equal(ingestor.get(old.id)?.normalizedContentSha256, damagedHash);
}));
