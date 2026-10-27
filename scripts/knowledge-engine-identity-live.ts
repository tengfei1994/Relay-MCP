/**
 * Live identity protocol acceptance against the isolated, deployed v0.8.3 engine.
 * Run on the nonproduction host with RELAY_IDENTITY_E2E_ISOLATED=1.
 * The one approved source body is reused in SYNTHETIC identity variants; this is
 * not evidence that real SampleManager versions contain equivalent documents.
 * Uses deployed dist modules, never starts services or changes managed control.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import type { WeKnoraDocumentInput } from '../src/knowledge/weknora-ingest.js';

type Row = Record<string, any>;
class Failure extends Error { constructor(readonly code: string) { super(code); } }
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new Failure(code); }
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const root = '/home/ftd/relay-knowledge-engine-nonprod';
const relay = join(root, 'relay');
const home = join(root, 'runtime', 'knowledge-engine');
const runId = randomUUID();
const report: Row = { schemaVersion: 1, runId, status: 'running', testKind: 'synthetic_source_identity_only',
  sourceVersionEquivalenceStatus: 'not_tested', relayPublicationAclStatus: 'not_tested',
  milestones: [], variants: [], uploads: [] };
let reportPath = '', currentStage = 'preflight', started = Date.now();
let kbId = '';
async function guardedExisting(path: string, directory = false): Promise<string> {
  check(isAbsolute(path), 'absolute_path_required');
  const resolved = await realpath(path);
  const rel = relative(root, resolved);
  check(resolved !== root && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'isolated_path_required');
  const info = await stat(resolved);
  check(directory ? info.isDirectory() : info.isFile(), 'path_type_invalid');
  return resolved;
}
async function save(): Promise<void> {
  if (!reportPath) return;
  const temp = reportPath + '.' + process.pid + '.tmp';
  await writeFile(temp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, reportPath);
}
function progress(): void {
  console.log(JSON.stringify({ stage: currentStage, status: report.status, completedCount: report.variants.length,
    elapsedMs: Date.now() - started }));
}
async function stage(name: string, work: () => Promise<void>): Promise<void> {
  currentStage = name;
  const evidence: Row = { stage: name, status: 'running' };
  report.milestones.push(evidence); await save(); progress();
  const begin = Date.now();
  try { await work(); evidence.status = 'passed'; }
  catch (error) { evidence.status = 'failed'; throw error; }
  finally { evidence.elapsedMs = Date.now() - begin; await save(); progress(); }
}
function failureCode(error: unknown): string {
  if (error instanceof Failure) return error.code;
  const allowed = new Set(['timeout', 'rate_limited', 'unauthorized', 'invalid_response', 'unavailable', 'not_found', 'conflict', 'parse_failed', 'upstream_not_ready', 'model_provenance_mismatch']);
  return allowed.has(row(error).code) ? row(error).code : 'unexpected_driver_error';
}
async function main(): Promise<void> {
  check(process.env.RELAY_IDENTITY_E2E_ISOLATED === '1', 'explicit_isolated_flag_required');
  check(process.platform === 'linux' && await realpath(root) === root, 'isolated_linux_root_required');
  const script = await guardedExisting(fileURLToPath(import.meta.url));
  check(script === join(relay, 'scripts', 'knowledge-engine-identity-live.ts'), 'isolated_script_path_required');
  await guardedExisting(relay, true);
  await guardedExisting(home, true);
  const envPath = await guardedExisting(join(relay, '.env'));
  // Extract this single nonsecret key without loading or reporting other settings.
  const dbLines = (await readFile(envPath, 'utf8')).split(/\r?\n/).filter(line => /^\s*KNOWLEDGE_DB_PATH\s*=/.test(line));
  check(dbLines.length === 1, 'knowledge_db_key_required');
  let dbValue = dbLines[0].slice(dbLines[0].indexOf('=') + 1).trim();
  if ((dbValue.startsWith('"') && dbValue.endsWith('"')) || (dbValue.startsWith("'") && dbValue.endsWith("'"))) dbValue = dbValue.slice(1, -1);
  const dbPath = await guardedExisting(resolve(relay, dbValue));
  const manifestPath = await guardedExisting(join(relay, 'data', 'nonprod-seed-manifest.json'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  check(manifest.isolationRoot === root && manifest.environment === 'nonprod' &&
    Array.isArray(manifest.documents) && manifest.documents.length === 5, 'approved_manifest_required');
  const sample = manifest.documents[0];
  check(typeof sample.id === 'string' && /^[a-f0-9]{64}$/.test(sample.normalizedBodySha256) &&
    /^[a-f0-9]{64}$/.test(sample.sourceSha256), 'approved_source_hash_required');
  for (const name of ['engine.json', 'control.json']) {
    const path = await guardedExisting(join(home, name));
    check(((await stat(path)).mode & 0o077) === 0, 'private_engine_config_required');
  }
  const configPath = await guardedExisting(join(relay, 'dist', 'knowledge', 'engine-config.js'));
  const clientPath = await guardedExisting(join(relay, 'dist', 'knowledge', 'weknora.js'));
  const writerPath = await guardedExisting(join(relay, 'dist', 'knowledge', 'weknora-ingest.js'));
  const config = await import(pathToFileURL(configPath).href) as typeof import('../src/knowledge/engine-config.js');
  const { WeKnoraClient } = await import(pathToFileURL(clientPath).href) as typeof import('../src/knowledge/weknora.js');
  const { WeKnoraClientDocumentWriter, normalizeProductContent } = await import(pathToFileURL(writerPath).href) as typeof import('../src/knowledge/weknora-ingest.js');
  const runtime = config.readEngineRuntime(home), control = config.readEngineControl(home);
  check(runtime?.version === 'v0.8.3' && runtime.baseUrl === 'http://127.0.0.1:18190' &&
    runtime.relayGatewayUrl === 'http://127.0.0.1:18300/internal/knowledge-engine/v1', 'isolated_runtime_endpoint_required');
  check(control.phase === 'ready' && control.apiKey && control.knowledgeBaseId, 'ready_managed_control_required');
  const binding = control.bindings.find(b => b.kind === 'embedding');
  check(binding?.engineModelId && binding.dimensions && binding.providerId && binding.modelId, 'embedding_binding_required');
  const controlFile = join(home, 'control.json'), initialControlHash = sha(await readFile(controlFile));
  const initialRuntimeHash = sha(await readFile(join(home, 'engine.json')));
  let body: string;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const document = db.prepare('SELECT d.body,d.source_sha256,d.kind,p.source_sha256 AS product_sha FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE d.id=?').get(sample.id) as Row | undefined;
    check(document?.kind === 'product_document' && typeof document.body === 'string' &&
      (document.product_sha === sample.sourceSha256 || document.source_sha256 === sample.sourceSha256), 'approved_source_missing_or_changed');
    check(sha(document.body) === sample.normalizedBodySha256, 'approved_body_hash_mismatch');
    body = normalizeProductContent(document.body);
  } finally { db.close(); }
  const evidenceDir = join(root, 'identity-acceptance');
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await guardedExisting(evidenceDir, true);
  reportPath = join(evidenceDir, runId + '.json');
  report.source = { documentId: sample.id, approvedBodySha256: sample.normalizedBodySha256, normalizedBodySha256: sha(body), sourceSha256: sample.sourceSha256, bodyBytes: Buffer.byteLength(body) };
  report.deployedModuleSha256 = { client: sha(await readFile(clientPath)), writer: sha(await readFile(writerPath)) };
  report.embedding = { providerId: binding.providerId, modelId: binding.modelId, engineModelId: binding.engineModelId, dimensions: binding.dimensions, indexVersion: binding.indexVersion };
  const api = async (method: 'GET' | 'POST', path: string, payload?: Row): Promise<Row> => {
    check(path.startsWith('/api/v1/') && !path.includes('..'), 'api_path_invalid');
    check(method === 'GET' || path === '/api/v1/knowledge-bases' && !kbId, 'unexpected_api_mutation');
    const response = await fetch(runtime.baseUrl + path, { method, redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { 'X-API-Key': control.apiKey!, 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload) });
    check(response.ok, 'upstream_http_' + response.status);
    const value = row(await response.json()); check(value.success !== false, 'upstream_request_failed');
    return value;
  };
  await stage('verify-managed-model', async () => {
    const model = row((await api('GET', '/api/v1/models/' + encodeURIComponent(binding.engineModelId!))).data);
    check(model.id === binding.engineModelId && model.name === binding.alias && model.type === 'Embedding' &&
      model.source === 'remote' && model.parameters?.base_url === runtime.relayGatewayUrl &&
      model.parameters?.embedding_parameters?.dimension === binding.dimensions, 'managed_gateway_model_mismatch');
  });
  const kbPath = () => '/api/v1/knowledge-bases/' + encodeURIComponent(kbId);
  async function verifyPrivateKb(): Promise<void> {
    const kb = row((await api('GET', kbPath())).data);
    check(kb.id === kbId && kbId !== control.knowledgeBaseId && String(kb.tenant_id) === String(control.tenantId) &&
      kb.embedding_model_id === binding!.engineModelId && !kb.summary_model_id &&
      kb.indexing_strategy?.vector_enabled === true && kb.indexing_strategy?.wiki_enabled === false &&
      kb.indexing_strategy?.graph_enabled === false && kb.question_generation_config?.enabled !== true &&
      kb.auto_tag_config?.enabled !== true, 'isolated_kb_configuration_mismatch');
    const shareResponse = row((await api('GET', kbPath() + '/shares')).data), shares = shareResponse.shares;
    check(shareResponse.total === 0 && Array.isArray(shares) && shares.length === 0, 'private_unshared_kb_required');
    report.shareCount = shares.length; report.wikiGenerationStatus = 'disabled'; report.summaryStatus = 'disabled';
  }
  await stage('create-private-test-kb', async () => {
    const created = row((await api('POST', '/api/v1/knowledge-bases', {
      name: 'Relay synthetic identity acceptance ' + runId, type: 'document', is_temporary: true,
      description: 'Synthetic identity variants of one approved body. Not real cross-version content equivalence evidence.',
      embedding_model_id: binding.engineModelId, summary_model_id: '',
      chunking_config: { chunk_size: 512, chunk_overlap: 100, separators: ['\n\n', '\n'] },
      indexing_strategy: { vector_enabled: true, keyword_enabled: true, wiki_enabled: false, graph_enabled: false },
      question_generation_config: { enabled: false }, auto_tag_config: { enabled: false }, profile_config: { enabled: false },
    })).data);
    check(typeof created.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(created.id), 'new_kb_id_invalid');
    kbId = created.id; report.knowledgeBaseId = kbId; await save();
    await verifyPrivateKb();
    const empty = await api('GET', kbPath() + '/knowledge?page=1&page_size=100');
    check(empty.total === 0 && Array.isArray(empty.data) && empty.data.length === 0, 'new_kb_not_empty');
  });
  // This is a real network transport. Only processing options are added to the
  // deployed client's multipart form, using v0.8.3's official process_config.
  // Identity metadata and Markdown bytes are never synthesized by this wrapper.
  const allowedDocuments = new Set<string>();
  const network: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    check(target.origin === runtime.baseUrl, 'client_origin_escape');
    const upload = init?.method === 'POST';
    if (upload) {
      check(target.pathname === kbPath() + '/knowledge/file' && init.body instanceof FormData, 'client_upload_scope_escape');
      init.body.set('process_config', JSON.stringify({ summary_enabled: false, graph_enabled: false,
        enable_multimodel: false, question_generation_config: { enabled: false } }));
    } else {
      const found = target.pathname.match(/^\/api\/v1\/(?:knowledge|chunks)\/([^/]+)$/);
      check(init?.method === 'GET' && found && allowedDocuments.has(decodeURIComponent(found[1])), 'client_read_scope_escape');
    }
    const response = await fetch(input, init);
    if (upload) {
      const payload = row(await response.clone().json()), id = row(payload.data).id;
      if (typeof id === 'string') allowedDocuments.add(id);
      report.uploads.push({ httpStatus: response.status, ...(typeof id === 'string' ? { documentId: id } : {}) });
      await save();
    }
    return response;
  };
  const client = new WeKnoraClient({ baseUrl: runtime.baseUrl, authMode: 'api_key', secretResolver: async () => control.apiKey,
    fetchImpl: network, timeoutMs: 120_000 });
  const writer = new WeKnoraClientDocumentWriter(client, kbId, {
    modelProvenance: { knowledgeBaseId: kbId, providerId: binding.providerId, modelId: binding.modelId, dimensions: binding.dimensions, indexVersion: binding.indexVersion },
    readiness: { timeoutMs: 900_000, pollIntervalMs: 2_000 },
  });
  const baseline: WeKnoraDocumentInput = { idempotencyKey: runId + ':baseline', title: 'SYNTHETIC identity acceptance baseline',
    content: body, parserVersion: 'synthetic-source-identity-acceptance-v1', productVersion: 'identity-test-version-a',
    sourcePath: 'relay-identity-test/' + runId + '/source-a.md', projectId: 'identity-test-project-a', environment: 'identity-test-env-a' };
  const variants: Array<{ id: string; changes: Partial<WeKnoraDocumentInput> }> = [
    { id: 'baseline', changes: {} },
    { id: 'version', changes: { productVersion: 'identity-test-version-b' } },
    { id: 'path', changes: { sourcePath: 'relay-identity-test/' + runId + '/source-b.md' } },
    { id: 'project', changes: { projectId: 'identity-test-project-b' } },
    { id: 'environment', changes: { environment: 'identity-test-env-b' } },
  ];
  const allChunkIds = new Set<string>(), allDocumentIds = new Set<string>();
  const upload = async (input: WeKnoraDocumentInput) => writer.upsertDocument({ ...input, normalizedContent: body, normalizedContentSha256: sha(body) });
  for (const variant of variants) await stage('upload-' + variant.id, async () => {
    const input = { ...baseline, ...variant.changes, title: 'SYNTHETIC identity acceptance ' + variant.id, idempotencyKey: runId + ':' + variant.id };
    const result = await upload(input);
    const documentId = result.externalDocumentId, chunks = await client.listDocumentChunks(documentId);
    check(result.parseStatus === 'completed' && chunks.length > 0 && !allDocumentIds.has(documentId), 'identity_document_collision');
    check(chunks.every(c => c.documentId === documentId && !allChunkIds.has(c.chunkId)), 'identity_chunk_collision');
    const detail = row((await api('GET', '/api/v1/knowledge/' + encodeURIComponent(documentId))).data), metadata = row(detail.metadata);
    check(detail.knowledge_base_id === kbId && detail.channel === 'gitlab' &&
      metadata.relay_ingestion_source === 'relay_product_knowledge' && metadata.relay_source_identity_contract === 'weknora-v0.8.3-file-v1' &&
      metadata.normalized_content_sha256 === sha(body) && metadata.productVersion === input.productVersion &&
      metadata.sourcePath === input.sourcePath && metadata.projectId === input.projectId && metadata.environment === input.environment &&
      /^[a-f0-9]{64}$/.test(metadata.external_id), 'upstream_identity_metadata_mismatch');
    check(!report.variants.some((v: Row) => v.sourceIdentitySha256 === metadata.external_id), 'identity_hash_collision');
    allDocumentIds.add(documentId); chunks.forEach(c => allChunkIds.add(c.chunkId));
    report.variants.push({ variantId: variant.id, status: 'passed', documentId, sourceIdentitySha256: metadata.external_id,
      normalizedBodySha256: sha(body), chunkIds: chunks.map(c => c.chunkId).sort(), chunkCount: chunks.length,
      indexedChunkCount: result.externalChunkIds?.length ?? 0, parseStatus: result.parseStatus });
  });
  const snapshot = async () => {
    const listing = await api('GET', kbPath() + '/knowledge?page=1&page_size=100');
    check(Array.isArray(listing.data) && listing.total === 5 && listing.data.length === 5, 'unexpected_kb_document_count');
    const ids = listing.data.map((d: Row) => d.id).sort();
    check(JSON.stringify(ids) === JSON.stringify([...allDocumentIds].sort()), 'unexpected_kb_document_ids');
    const chunks: Record<string, string[]> = {};
    for (const id of ids) chunks[id] = (await client.listDocumentChunks(id)).map(c => c.chunkId).sort();
    return { documentIds: ids, chunks, documentCount: ids.length, chunkCount: Object.values(chunks).reduce((n, c) => n + c.length, 0) };
  };
  await stage('retry-new-operation-key', async () => {
    const before = await snapshot();
    // Direct writer invocation intentionally bypasses Relay's local dedupe cache.
    const result = await upload({ ...baseline, idempotencyKey: runId + ':retry-new-operation', title: 'SYNTHETIC identity acceptance retry' });
    const after = await snapshot();
    check(result.externalDocumentId === report.variants[0].documentId, 'retry_changed_document_id');
    check(JSON.stringify(before) === JSON.stringify(after), 'retry_changed_document_or_chunks');
    check(report.uploads.length === 6 && report.uploads.slice(0, 5).every((u: Row) => u.httpStatus === 200 || u.httpStatus === 201) &&
      report.uploads[5].httpStatus === 409, 'upstream_duplicate_response_required');
    report.retry = { status: 'passed', documentId: result.externalDocumentId, beforeDocumentCount: before.documentCount,
      afterDocumentCount: after.documentCount, beforeChunkCount: before.chunkCount, afterChunkCount: after.chunkCount,
      chunkIdentitySha256: sha(JSON.stringify(after.chunks)), httpStatus: report.uploads[5].httpStatus };
  });
  await stage('verify-isolation-retained', async () => {
    await verifyPrivateKb();
    check(sha(await readFile(controlFile)) === initialControlHash && sha(await readFile(join(home, 'engine.json'))) === initialRuntimeHash, 'managed_configuration_changed');
    const final = await snapshot();
    report.documentCount = final.documentCount; report.chunkCount = final.chunkCount;
    report.managedConfigurationStatus = 'unchanged'; report.testKbStatus = 'retained_private_for_review';
  });
  report.status = 'passed'; await save(); progress();
}
const timer = setInterval(progress, 20_000);
try { await main(); }
catch (error) {
  report.status = 'failed'; report.failureCode = failureCode(error);
  await save(); console.log(JSON.stringify({ stage: currentStage, status: 'failed', code: report.failureCode, completedCount: report.variants.length }));
  process.exitCode = 1;
} finally { clearInterval(timer); }
