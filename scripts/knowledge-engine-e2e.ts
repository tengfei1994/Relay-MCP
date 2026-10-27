/** Live HTTP acceptance. No mocks, fixtures, server startup, or automatic cleanup. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

type Row = Record<string, unknown>;
type Check = { name: string; status: 'running' | 'passed' | 'failed' | 'unmet'; startedAt: string; durationMs?: number; evidence?: unknown; code?: string };
class Failure extends Error { constructor(readonly code: string, readonly unmet = false) { super(code); } }
const row = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const rows = (v: unknown): Row[] => Array.isArray(v) ? v.map(row) : [];
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const strs = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const field = (r: Row, ...keys: string[]): unknown => keys.map(k => r[k]).find(v => v !== undefined && v !== null);
const sha = (v: string | Uint8Array): string => createHash('sha256').update(v).digest('hex');
const requireThat = (yes: unknown, code: string, unmet = false): void => { if (!yes) throw new Failure(code, unmet); };
const encode = encodeURIComponent;
const parserVersion = 'real-sample-acceptance';
const environment = 'nonprod';
const runId = process.env.RELAY_E2E_RUN_ID ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const reportPath = resolve(process.env.RELAY_E2E_REPORT ?? `docs/verification/knowledge-engine-${runId}.json`);
const report: Row = {
  schemaVersion: 1, runId, startedAt: new Date().toISOString(), status: 'running',
  scope: 'bounded live Relay HTTP acceptance; at most five genuine operator-seeded SampleManager documents',
  parserVersion, environment, commit: process.env.RELAY_E2E_COMMIT ?? null,
  milestones: [] as Check[], http: [] as Row[], state: {},
  unproven: ['Source authenticity requires the operator fixture manifest.', 'Direct MCP transport is not exercised; /api/knowledge/search is the HTTP knowledge_search path.', 'Provider-call audit rows, upstream synthesis job provenance, full-corpus quality/recall, restart/recovery, and load testing require separate evidence.'],
};
let base: URL, token = '', foreignToken = '', projectId = '', foreignProjectId = '';
let requestTimeoutMs = 300_000;
const checks = report.milestones as Check[];
const events = report.http as Row[];
const state = report.state as Row;
async function save(): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true });
  const temp = `${reportPath}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, reportPath);
}
async function milestone(name: string, work: () => Promise<unknown>): Promise<void> {
  const check: Check = { name, status: 'running', startedAt: new Date().toISOString() };
  checks.push(check); await save(); console.log(`[knowledge-e2e] ${name}: running`);
  const started = performance.now();
  try { check.evidence = await work(); check.status = 'passed'; }
  catch (error) { check.status = error instanceof Failure && error.unmet ? 'unmet' : 'failed'; check.code = error instanceof Failure ? error.code : 'unexpected_driver_error'; throw error; }
  finally { check.durationMs = Math.round(performance.now() - started); await save(); console.log(`[knowledge-e2e] ${name}: ${check.status}`); }
}
function url(path: string, query: Row = {}): URL {
  const target = new URL(path, base);
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') target.searchParams.set(key, String(value));
  return target;
}
async function request(operation: string, method: string, path: string, options: { query?: Row; body?: Row; expected?: number[]; credential?: string; binary?: boolean } = {}): Promise<{ data: Row; status: number; bytes: Buffer }> {
  const started = performance.now();
  const event: Row = { operation, method, path };
  events.push(event);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url(path, options.query), {
      method, redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${options.credential ?? token}`, accept: options.binary ? 'application/octet-stream' : 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    event.status = response.status;
    const maxBytes = options.binary ? 1_048_576 : 16_777_216;
    requireThat(Number(response.headers.get('content-length') ?? 0) <= maxBytes, 'response_exceeds_bound');
    const parts: Uint8Array[] = []; let size = 0;
    const reader = response.body?.getReader();
    if (reader) for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Failure('response_exceeds_bound'); }
      parts.push(next.value);
    }
    const bytes = Buffer.concat(parts); event.responseBytes = bytes.length;
    requireThat((options.expected ?? [200]).includes(response.status), `http_${response.status}`);
    if (options.binary || !bytes.length || response.status >= 400) return { data: {}, status: response.status, bytes };
    let data: unknown; try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new Failure('invalid_json_response'); }
    requireThat(data && typeof data === 'object' && !Array.isArray(data), 'invalid_response_shape');
    return { data: row(data), status: response.status, bytes };
  } catch (error) { if (error instanceof Failure) throw error; throw new Failure(controller.signal.aborted ? 'http_timeout' : 'http_transport_failure'); }
  finally { clearTimeout(timer); event.latencyMs = Math.round(performance.now() - started); }
}
const scope = (): Row => ({ projectId, environment });
const get = async (operation: string, path: string, query?: Row): Promise<Row> => (await request(operation, 'GET', path, { query })).data;
const post = async (operation: string, path: string, body: Row = {}): Promise<Row> => (await request(operation, 'POST', path, { body })).data;
async function migrateSamples(operation: string, body: Row): Promise<Row> {
  const submitted = await request(operation, 'POST', '/api/knowledge/migrations/from-local', {body:{...body,asynchronous:true},expected:[202]});
  const jobId=str(row(submitted.data.job).id),migrationId=str(submitted.data.migrationId);
  requireThat(jobId && migrationId && row(submitted.data.migration).id===migrationId,'async_migration_identity_missing');
  state.migrationJob={id:jobId,migrationId,status:row(submitted.data.job).status};await save();
  const waitMs=Math.min(7_200_000,Math.max(1_000,Number(process.env.RELAY_E2E_MIGRATION_WAIT_MS??1_800_000)));
  requireThat(Number.isFinite(waitMs),'invalid_migration_wait');
  const started=Date.now();let lastProgress=0;
  for(;;){
    const job=row((await get('poll_migration_job',`/api/knowledge/ingest-jobs/${encode(jobId)}`)).job),progress=row(job.result);
    requireThat(!progress.migrationId||progress.migrationId===migrationId,'async_migration_job_mismatch');
    state.migrationJob={id:jobId,migrationId,status:job.status,processed:progress.processed,total:progress.total,mapped:progress.mapped,failed:progress.failed};await save();
    if(job.status==='succeeded')return row((await get('completed_migration_report',`/api/knowledge/migrations/${encode(migrationId)}`)).migration);
    requireThat(job.status!=='failed','async_migration_job_failed');
    requireThat(Date.now()-started<waitMs,'async_migration_job_timeout');
    if(Date.now()-lastProgress>=30_000){console.log(`[knowledge-e2e] migration progress: ${job.status}, processed=${Number(progress.processed??0)}, mapped=${Number(progress.mapped??0)}`);lastProgress=Date.now();}
    await pause(2000);
  }
}
async function provider(): Promise<string> { return str((await get('product_provider', '/api/knowledge/integrations/product-provider')).provider); }
function parseJson(value: unknown): unknown { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return undefined; } }
function safeMigration(value: Row): Row {
  const summary = row(value.report);
  return { id: value.id, status: value.status, total: summary.total, mapped: summary.mapped, failed: summary.failed, skipped: summary.skipped,
    documents: rows(summary.documents).map(d => ({ localDocumentId: d.localDocumentId, documentId: d.documentId, externalDocumentId: d.externalDocumentId, status: d.status, contentSha256: d.contentSha256, parserVersion: d.parserVersion, failureCode: d.failureCode })) };
}
function safeModel(value: Row): Row { return { providerId: value.providerId, modelId: value.modelId, dimensions: value.dimensions, indexVersion: value.indexVersion }; }
async function snapshots(memoryIds: string[], evidenceIds: string[]): Promise<Row> {
  const memory: Row[] = [], evidence: Row[] = [];
  for (const id of memoryIds) {
    const value = await get('memory_sentinel', `/api/knowledge/documents/${encode(id)}`, { projectId });
    const doc = row(value.document);
    requireThat(['candidate', 'case', 'pattern', 'playbook', 'fact'].includes(str(doc.kind)) && doc.projectId === projectId && str(doc.body).length > 0, 'invalid_memory_sentinel');
    memory.push({ id, kind: doc.kind, lifecycle: doc.lifecycle, bodySha256: sha(str(doc.body)), recordSha256: sha(JSON.stringify(value)) });
  }
  for (const id of evidenceIds) {
    const value = await get('evidence_sentinel', `/api/knowledge/evidence/${encode(id)}`), item = row(value.evidence);
    requireThat(item.projectId === projectId && Number(item.sizeBytes) > 0 && Number(item.sizeBytes) <= 1_048_576, 'invalid_evidence_sentinel');
    const content = await request('evidence_sentinel_content', 'GET', `/api/knowledge/evidence/${encode(id)}/content`, { binary: true });
    requireThat(sha(content.bytes) === item.sha256 && content.bytes.length === Number(item.sizeBytes), 'evidence_content_hash_mismatch');
    evidence.push({ id, sha256: item.sha256, sizeBytes: item.sizeBytes, recordSha256: sha(JSON.stringify(value)) });
  }
  const dashboard = await get('preservation_counts', '/api/knowledge/dashboard', { projectId });
  const counts = rows(dashboard.totals).filter(d => d.kind !== 'product_document').map(d => ({ kind: d.kind, count: d.count })).sort((a, b) => str(a.kind).localeCompare(str(b.kind)));
  return { memory, evidence, counts };
}
let migration: Row = {}, documents: Row[] = [], mappings: Row[] = [], generated: Row = {}, embeddingBinding: Row = {};
let memoryIds: string[] = [], evidenceIds: string[] = [], before: Row = {};
const originalBodies = new Map<string, string>();
function mappingFor(localId: string): Row { const linkage = documents.find(d => d.localDocumentId === localId); return mappings.find(d => d.id === linkage?.documentId) ?? {}; }
function validateProduct(value: Row, needsBody = false): Row {
  const id = str(value.id), mapping = mappingFor(id);
  requireThat(mapping.id && value.provider === 'weknora' && value.projectId === projectId && value.environment === environment, 'product_scope_or_provider_mismatch');
  requireThat(value.externalDocumentId === field(mapping, 'externalDocumentId', 'external_document_id') && value.sourceSha256 === field(mapping, 'rawSha256', 'raw_sha256', 'normalizedContentSha256', 'normalized_content_sha256'), 'product_provenance_mismatch');
  requireThat(str(value.sourcePath ?? value.sourceLocator) && str(value.sampleManagerVersion ?? value.version), 'product_source_metadata_missing');
  const allowed = new Set(strs(parseJson(field(mapping, 'externalChunkIds', 'external_chunk_ids_json'))));
  const citations = rows(value.citations);
  requireThat(citations.length > 0 && citations.every(c => c.documentId === id && allowed.has(str(c.chunkId)) && c.sourceSha256 === value.sourceSha256), 'product_citations_unverified');
  if (needsBody) requireThat(str(value.body).length > 0, 'remote_product_content_missing');
  return { id, externalDocumentId: value.externalDocumentId, provider: value.provider, sourceSha256: value.sourceSha256, productVersion: value.sampleManagerVersion ?? value.version,
    chunkIds: [...new Set(citations.map(c => c.chunkId))], citationCount: citations.length, ...(needsBody ? { bodySha256: sha(str(value.body)), bodyBytes: Buffer.byteLength(str(value.body)) } : {}) };
}
function validateWiki(page: Row): Row {
  requireThat(/^engine-wiki:[0-9a-f]{16}:[0-9a-f]{64}$/.test(str(page.id)), 'wiki_is_not_discovered_upstream_page');
  requireThat(page.projectId === projectId && page.environment === environment && str(page.body).length > 0, 'wiki_scope_or_content_missing');
  const citations = rows(page.citations);
  requireThat(citations.length > 0 && citations.every(c => {
    const source = mappings.find(d => d.id === c.documentId); if (!source) return false;
    const allowed = new Set(strs(parseJson(field(source, 'externalChunkIds', 'external_chunk_ids_json'))));
    return c.sourceSha256 === field(source, 'rawSha256', 'raw_sha256', 'normalizedContentSha256', 'normalized_content_sha256') && strs(c.chunkIds).length > 0 && strs(c.chunkIds).every(id => allowed.has(id));
  }), 'wiki_citations_unverified');
  return { id: page.id, status: page.status, revision: page.currentRevision, bodySha256: sha(str(page.body)), bodyBytes: Buffer.byteLength(str(page.body)), sourceDocumentIds: citations.map(c => c.documentId), chunkIds: [...new Set(citations.flatMap(c => strs(c.chunkIds)))] };
}
async function main(): Promise<void> {
  await milestone('preflight_and_preservation_baseline', async () => {
    requireThat(process.env.RELAY_E2E_ISOLATED === '1', 'isolated_environment_attestation_required', true);
    base = new URL(process.env.RELAY_E2E_BASE_URL ?? 'http://127.0.0.1:18300');
    requireThat(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'invalid_base_url');
    projectId = process.env.RELAY_E2E_PROJECT_ID ?? ''; foreignProjectId = process.env.RELAY_E2E_FOREIGN_PROJECT_ID ?? '';
    requireThat(projectId && foreignProjectId && projectId !== foreignProjectId, 'two_distinct_project_ids_required', true);
    const tokenFile = process.env.RELAY_E2E_TOKEN_FILE;
    requireThat(tokenFile, 'token_file_required', true);
    token = (await readFile(tokenFile!, 'utf8')).trim(); requireThat(token && !/\s/.test(token), 'invalid_bearer_token_file');
    if (process.env.RELAY_E2E_FOREIGN_TOKEN_FILE) foreignToken = (await readFile(process.env.RELAY_E2E_FOREIGN_TOKEN_FILE, 'utf8')).trim();
    else (report.unproven as string[]).push('Foreign actor ACL is not exercised without RELAY_E2E_FOREIGN_TOKEN_FILE; explicit project/environment isolation is exercised.');
    requestTimeoutMs = Math.min(3_600_000, Math.max(1_000, Number(process.env.RELAY_E2E_REQUEST_TIMEOUT_MS ?? 300_000)));
    requireThat(Number.isFinite(requestTimeoutMs), 'invalid_request_timeout');
    report.targetOrigin = base.origin; report.projectId = projectId; report.foreignProjectId = foreignProjectId;
    if (process.env.RELAY_E2E_FIXTURE_MANIFEST) report.fixtureManifestSha256 = sha(await readFile(process.env.RELAY_E2E_FIXTURE_MANIFEST));
    requireThat(await provider() === 'relay_local', 'fresh_local_provider_baseline_required', true);
    memoryIds = (process.env.RELAY_E2E_MEMORY_IDS ?? '').split(',').filter(Boolean);
    evidenceIds = (process.env.RELAY_E2E_EVIDENCE_IDS ?? '').split(',').filter(Boolean);
    if (!memoryIds.length) memoryIds = rows((await get('discover_memory_sentinels', '/api/knowledge/documents', { projectId, kinds: 'case,pattern,playbook,candidate,fact', limit: 5 })).documents).map(d => str(d.id));
    if (!evidenceIds.length) evidenceIds = rows((await get('discover_evidence_sentinels', '/api/knowledge/evidence', { ...scope(), limit: 5 })).evidence).filter(d => Number(d.sizeBytes) > 0 && Number(d.sizeBytes) <= 1_048_576).map(d => str(d.id));
    requireThat(memoryIds.length > 0 && evidenceIds.length > 0, 'nonempty_memory_and_evidence_sentinels_required', true);
    requireThat(memoryIds.length <= 20 && evidenceIds.length <= 20, 'sentinel_count_exceeds_bound');
    before = await snapshots(memoryIds, evidenceIds);
    return { isolated: true, baselineProvider: 'relay_local', ...before };
  });
  await milestone('managed_engine_initialize_and_status', async () => {
    const previous = await get('engine_status_before', '/api/knowledge/engine');
    const initialized = await post('engine_initialize', '/api/knowledge/engine/initialize', {
      embeddingProviderId: process.env.RELAY_E2E_EMBEDDING_PROVIDER_ID, wikiProviderId: process.env.RELAY_E2E_WIKI_PROVIDER_ID, rerankProviderId: process.env.RELAY_E2E_RERANK_PROVIDER_ID,
    });
    const status = await get('engine_status_after', '/api/knowledge/engine');
    requireThat(initialized.phase === 'ready' && status.phase === 'ready' && status.reachable === true, 'managed_engine_not_ready', true);
    requireThat(status.wikiReady === true, 'real_wiki_model_not_ready', true);
    const bindings = rows(status.bindings);
    embeddingBinding = bindings.find(d => d.kind === 'embedding') ?? {};
    requireThat(Number(embeddingBinding.dimensions) > 0 && str(embeddingBinding.modelId), 'embedding_binding_missing');
    return { previousPhase: previous.phase, phase: status.phase, version: status.version, wikiReady: status.wikiReady, bindings: bindings.map(d => ({ kind: d.kind, ...safeModel(d) })) };
  });
  await milestone('real_sample_stage_and_idempotency', async () => {
    const body = { idempotencyKey: `${parserVersion}:${runId}`, parserVersion, ...scope(), productVersion: process.env.RELAY_E2E_PRODUCT_VERSION, limit: 5 };
    migration = await migrateSamples('migrate_real_local_samples',body);
    state.migration = safeMigration(migration); await save();
    documents = rows(row(migration.report).documents);
    const manifest = rows(row(migration.sourceManifest).documents);
    requireThat(migration.status === 'staged' && documents.length > 0 && documents.length <= 5 && manifest.length === documents.length, 'bounded_staging_not_complete');
    requireThat(Number(row(migration.report).failed) === 0 && documents.every(d => d.status === 'staged' && d.documentId && d.externalDocumentId && d.parserVersion === parserVersion), 'staging_has_unready_documents');
    requireThat(manifest.every(d => d.projectId === projectId && d.environment === environment && /^[0-9a-f]{64}$/.test(str(d.bodySha256)) && /^[0-9a-f]{64}$/.test(str(d.sourceSha256)) && d.sourcePath && d.productVersion), 'manifest_scope_or_source_provenance_missing');
    requireThat(await provider() === 'relay_local', 'staging_switched_provider_early');
    const hidden = await post('staged_documents_are_not_searchable', '/api/knowledge/weknora/search', { ...scope(), query: process.env.RELAY_E2E_QUERY ?? 'SampleManager', limit: 20 });
    requireThat(!rows(hidden.references).some(d => documents.some(link => link.externalDocumentId === d.documentId)), 'staged_documents_visible_before_publication');
    for (const d of documents) {
      const local = row((await get('local_product_before_publish', `/api/knowledge/product-docs/${encode(str(d.localDocumentId))}`, scope())).document);
      requireThat(local.provider === 'relay_local' && str(local.body).length > 0, 'local_baseline_unreadable');
      originalBodies.set(str(d.localDocumentId), sha(str(local.body)));
    }
    const again = await migrateSamples('repeat_identical_migration',body);
    requireThat(again.id === migration.id && JSON.stringify(rows(row(again.report).documents)) === JSON.stringify(documents), 'migration_idempotency_changed_mapping');
    return { ...safeMigration(migration), idempotencyStable: true, sourceManifest: manifest.map(d => ({ localDocumentId: d.localDocumentId, sourceSha256: d.sourceSha256, bodySha256: d.bodySha256, productVersion: d.productVersion, projectId: d.projectId, environment: d.environment })) };
  });
  await milestone('publish_verified_mappings', async () => {
    migration = row((await post('publish_migration', `/api/knowledge/migrations/${encode(str(migration.id))}/publish`)).migration);
    state.migration = safeMigration(migration); await save();
    requireThat(migration.status === 'published' && await provider() === 'weknora', 'publication_did_not_select_engine');
    const result = await get('published_mapping_provenance', '/api/knowledge/weknora/documents', { ...scope(), status: 'published', limit: 200 });
    mappings = rows(result.documents).filter(d => documents.some(link => link.documentId === d.id));
    requireThat(mappings.length === documents.length, 'published_mapping_missing');
    const verified = mappings.map(d => {
      const model = row(parseJson(field(d, 'modelProvenance', 'model_provenance_json')));
      requireThat(field(d, 'projectId', 'project_id') === projectId && d.environment === environment && d.status === 'published', 'published_mapping_scope_mismatch');
      requireThat(field(d, 'upstreamParseStatus', 'upstream_parse_status') === 'completed' && str(field(d, 'upstreamVerifiedAt', 'upstream_verified_at')), 'upstream_parsing_not_verified');
      const chunkIds = strs(parseJson(field(d, 'externalChunkIds', 'external_chunk_ids_json')));
      requireThat(chunkIds.length > 0 && model.providerId && model.modelId && Number(model.dimensions) > 0 && Number(model.indexVersion) > 0, 'verified_chunks_or_model_identity_missing');
      requireThat(JSON.stringify(safeModel(model)) === JSON.stringify(safeModel(embeddingBinding)), 'document_model_differs_from_current_binding');
      return { id: d.id, externalDocumentId: field(d, 'externalDocumentId', 'external_document_id'), upstreamParseStatus: 'completed', upstreamVerifiedAt: field(d, 'upstreamVerifiedAt', 'upstream_verified_at'), chunkIds, model: safeModel(model) };
    });
    return { migrationId: migration.id, provider: 'weknora', documents: verified };
  });
  await milestone('product_search_read_and_knowledge_http', async () => {
    const query = { ...scope(), q: process.env.RELAY_E2E_QUERY ?? 'SampleManager', sampleManagerVersion: process.env.RELAY_E2E_PRODUCT_VERSION, limit: 20 };
    const endpoints: Row[] = [];
    for (const path of ['/api/knowledge/product-documents/search', '/api/knowledge/product-docs/search', '/api/knowledge/search']) {
      const result = await get('product_search', path, query);
      requireThat(!row(result.degradedReasons).productKnowledge, 'knowledge_search_product_provider_degraded');
      const products = rows(result.results).filter(d => d.kind === 'product_document');
      requireThat(products.length > 0, 'real_query_returned_no_product_hits', true);
      endpoints.push({ path, resultCount: products.length, retrievalRunId: result.retrievalRunId, documents: products.map(d => validateProduct(d)) });
    }
    const reads: Row[] = [];
    for (const document of documents) for (const prefix of ['/api/knowledge/product-documents/', '/api/knowledge/product-docs/', '/api/knowledge/documents/']) {
      const result = await get('product_read_legacy_id', prefix + encode(str(document.localDocumentId)), scope());
      reads.push({ path: prefix, ...validateProduct(row(result.document), true) });
    }
    return { endpoints, reads, transport: 'Relay HTTP; direct MCP transport not covered' };
  });
  await milestone('autogenerated_wiki_discovery', async () => {
    const waitMs = Math.min(900_000, Math.max(1_000, Number(process.env.RELAY_E2E_WIKI_WAIT_MS ?? 180_000)));
    requireThat(Number.isFinite(waitMs), 'invalid_wiki_wait');
    const started = Date.now(); let polls = 0;
    do {
      const result = await get('discover_generated_wiki', '/api/knowledge/wiki', { ...scope(), limit: 200 }); polls++;
      const candidates = rows(result.items).filter(d => /^engine-wiki:[0-9a-f]{16}:[0-9a-f]{64}$/.test(str(d.id)) && strs(d.sourceRefs).length > 0 && strs(d.sourceRefs).every(id => mappings.some(m => m.id === id)));
      if (candidates.length) {
        generated = row((await get('generated_wiki_content', `/api/knowledge/wiki/${encode(str(candidates[0].id))}`, { environment })).page);
        const proof = validateWiki(generated); state.wiki = proof; await save();
        return { ...proof, polls, candidateCount: candidates.length, elapsedMs: Date.now() - started, manualCreateRequests: 0, synthesisJobProvenance: 'requires supplementary engine/provider audit' };
      }
      state.wikiDiscovery = { polls, elapsedMs: Date.now() - started, observedScopedPages: rows(result.items).length }; await save();
      if (Date.now() - started < waitMs) await pause(Math.min(5_000, waitMs - (Date.now() - started)));
    } while (Date.now() - started < waitMs);
    throw new Failure('no_source_verified_autogenerated_wiki_pages', true);
  });
  await milestone('wiki_edit_publish_history_diff_revert', async () => {
    const id = str(generated.id), originalRevision = Number(generated.currentRevision), originalHash = sha(str(generated.body));
    const marker = `\n\nRelay live acceptance ${runId}.\n`;
    const edited = row((await request('edit_generated_wiki', 'PATCH', `/api/knowledge/wiki/${encode(id)}`, { body: { environment, body: str(generated.body) + marker, reason: `Live acceptance ${runId}` } })).data.page);
    requireThat(edited.status === 'draft' && Number(edited.currentRevision) > originalRevision && str(edited.body).endsWith(marker), 'wiki_edit_did_not_create_remote_draft_revision');
    const editProof = validateWiki(edited); state.wiki = editProof; await save();
    const published = row((await post('publish_generated_wiki', `/api/knowledge/wiki/${encode(id)}/publish`, { environment, reason: `Live acceptance ${runId}` })).page);
    requireThat(published.status === 'published' && published.currentRevision === edited.currentRevision, 'wiki_publication_failed');
    const history = rows((await get('wiki_remote_history', `/api/knowledge/wiki/${encode(id)}/revisions`, { environment })).revisions);
    requireThat(history.some(d => Number(d.revision) === originalRevision && sha(str(d.body)) === originalHash) && history.some(d => d.revision === edited.currentRevision && sha(str(d.body)) === sha(str(edited.body))), 'remote_history_does_not_contain_real_revisions');
    const diff = str((await get('wiki_remote_diff', `/api/knowledge/wiki/${encode(id)}/diff`, { environment, fromRevision: originalRevision, toRevision: edited.currentRevision })).diff);
    requireThat(diff.includes(`+Relay live acceptance ${runId}.`), 'wiki_diff_missing_actual_edit');
    const reverted = row((await post('revert_generated_wiki', `/api/knowledge/wiki/${encode(id)}/rollback`, { environment, revision: originalRevision, reason: `Live acceptance restore ${runId}` })).page);
    requireThat(reverted.status === 'draft' && Number(reverted.currentRevision) > Number(edited.currentRevision) && sha(str(reverted.body)) === originalHash, 'wiki_revert_did_not_restore_remote_content');
    const revertProof = validateWiki(reverted); state.wiki = revertProof;
    return { id, originalRevision, edited: editProof, publishedRevision: published.currentRevision, history: history.map(d => ({ revision: d.revision, bodySha256: sha(str(d.body)) })), diffSha256: sha(diff), reverted: revertProof };
  });
  await milestone('project_and_environment_isolation', async () => {
    const id = str(documents[0].localDocumentId), denied: Row[] = [];
    for (const [label, query] of [['foreign_project', { projectId: foreignProjectId, environment }], ['foreign_environment', { projectId, environment: 'e2e-foreign-environment' }]] as const) {
      const result = await request(label, 'GET', `/api/knowledge/product-docs/${encode(id)}`, { query, expected: [403, 404] });
      denied.push({ check: label, status: result.status });
      const search = await get(`${label}_search`, '/api/knowledge/product-docs/search', { ...query, q: process.env.RELAY_E2E_QUERY ?? 'SampleManager', limit: 10 });
      requireThat(!rows(search.results).some(d => documents.some(source => source.localDocumentId === d.id)), 'out_of_scope_product_search_leak');
    }
    const wiki = await request('wiki_foreign_environment', 'GET', `/api/knowledge/wiki/${encode(str(generated.id))}`, { query: { environment: 'e2e-foreign-environment' }, expected: [403, 404] });
    denied.push({ check: 'wiki_foreign_environment', status: wiki.status });
    for (const query of [{ projectId: foreignProjectId, environment }, { projectId, environment: 'e2e-foreign-environment' }]) {
      const listed = await request('wiki_out_of_scope_list', 'GET', '/api/knowledge/wiki', { query, expected: [200, 403, 404] });
      requireThat(!rows(listed.data.items).some(d => d.id === generated.id), 'out_of_scope_wiki_list_leak');
      denied.push({ check: 'wiki_out_of_scope_list', status: listed.status, visibleTargetPages: 0 });
    }
    if (foreignToken) for (const path of [`/api/knowledge/product-docs/${encode(id)}`, `/api/knowledge/wiki/${encode(str(generated.id))}`]) {
      const result = await request('foreign_actor_denial', 'GET', path, { query: scope(), credential: foreignToken, expected: [403, 404] });
      denied.push({ check: 'foreign_actor', path, status: result.status });
    }
    return { denied, foreignActorCovered: Boolean(foreignToken) };
  });
  await milestone('migration_rollback_preserves_local_memory_evidence', async () => {
    const result = row((await post('rollback_migration', `/api/knowledge/migrations/${encode(str(migration.id))}/rollback`, { reason: `Live acceptance rollback ${runId}` })).migration);
    state.migration = safeMigration(result); await save();
    requireThat(result.status === 'rolled_back' && await provider() === 'relay_local', 'migration_rollback_provider_not_restored');
    const localReads: Row[] = [];
    for (const d of documents) {
      const local = row((await get('local_product_after_rollback', `/api/knowledge/product-docs/${encode(str(d.localDocumentId))}`, scope())).document);
      requireThat(local.provider === 'relay_local' && sha(str(local.body)) === originalBodies.get(str(d.localDocumentId)), 'local_product_changed_or_unreadable_after_rollback');
      localReads.push({ id: local.id, provider: local.provider, bodySha256: sha(str(local.body)) });
    }
    const after = await snapshots(memoryIds, evidenceIds);
    requireThat(JSON.stringify(after) === JSON.stringify(before), 'memory_or_evidence_changed_during_migration');
    return { migrationId: result.id, status: result.status, provider: 'relay_local', localReads, preserved: after, destructiveCleanupRequests: 0 };
  });
  report.status = 'passed_bounded_http'; report.finishedAt = new Date().toISOString(); await save();
  console.log('[knowledge-e2e] Bounded HTTP milestones passed. Supplementary acceptance evidence remains required.');
}
try { await main(); }
catch (error) {
  report.status = error instanceof Failure && error.unmet ? 'unmet' : 'failed';
  report.failureCode = error instanceof Failure ? error.code : 'unexpected_driver_error';
  report.finishedAt = new Date().toISOString(); report.preservedForDiagnosis = true;
  try { await save(); } catch { console.error('[knowledge-e2e] report_write_failed'); }
  console.error(`[knowledge-e2e] ${report.status}: ${report.failureCode}. Stopped; state preserved; no automatic cleanup.`);
  process.exitCode = 1;
}
