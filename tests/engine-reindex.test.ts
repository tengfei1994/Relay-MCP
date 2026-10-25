import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKnowledgeStore, type KnowledgeStore } from '../src/knowledge/store.ts';
import { ProviderRegistry } from '../src/knowledge/provider-registry.ts';
import { MigrationController, type KnowledgeMigration } from '../src/knowledge/migration-control.ts';
import { WeKnoraIngestor, type WeKnoraDocumentWriter, type WeKnoraModelProvenance } from '../src/knowledge/weknora-ingest.ts';
import { completeVerifiedEngineReindex, type EngineReindexDependencies } from '../src/knowledge/engine-reindex.ts';

const NOW = '2026-10-25T00:00:00.000Z';
const ACTOR = 7;
const oldModel: WeKnoraModelProvenance = { knowledgeBaseId: 'kb-old', providerId: 'embed', modelId: 'model-old', dimensions: 3, indexVersion: 1 };
const newModel: WeKnoraModelProvenance = { knowledgeBaseId: 'kb-current', providerId: 'embed', modelId: 'model-new', dimensions: 4, indexVersion: 2 };
const digest = (body: string) => createHash('sha256').update(body).digest('hex');
function seed(store: KnowledgeStore, id: string) {
  const body = `Manual ${id}: retained local source content.`;
  store.db.prepare('INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,environment,samplemanager_version,source_locator,source_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'product_document', `Manual ${id}`, body, 'approved', 'p1', 'nonprod', '21.3', `manual/${id}.md`, digest(body), NOW, NOW);
}
function writer(model: WeKnoraModelProvenance): WeKnoraDocumentWriter {
  return {
    getModelProvenance: async () => model,
    upsertDocument: async input => ({ externalDocumentId: `upstream-${input.idempotencyKey}`, knowledgeBaseId: model.knowledgeBaseId, parseStatus: 'completed', externalChunkIds: [`chunk-${input.idempotencyKey}`], modelProvenance: model }),
  };
}
interface Fixture {
  store: KnowledgeStore; registry: ProviderRegistry; controller: MigrationController;
  jobId: string; dependencies: EngineReindexDependencies; oldMigration: KnowledgeMigration; oldDirectId?: string;
  publishCurrent: (limit?: number) => Promise<KnowledgeMigration>;
}
async function fixture(fn: (fixture: Fixture) => Promise<void> | void, directOld = false): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'relay-engine-reindex-'));
  const store = createKnowledgeStore({ dbPath: join(directory, 'knowledge.db') });
  const registry = new ProviderRegistry(store, () => new Date(NOW));
  const controller = new MigrationController(store, () => new Date(NOW));
  try {
    registry.upsert({ id: 'embed', kind: 'embedding', provider: 'openai', modelId: oldModel.modelId, dimensions: oldModel.dimensions, actorId: ACTOR });
    seed(store, 'local-a'); seed(store, 'local-b');
    const oldIngestor = new WeKnoraIngestor(store, writer(oldModel), () => new Date(NOW));
    const staged = await controller.createFromLocal({ actorId: ACTOR, idempotencyKey: 'old', parserVersion: 'parser-v1', projectId: 'p1', environment: 'nonprod' }, oldIngestor);
    const oldMigration = controller.validateAndPublish(staged.id, ACTOR);
    let oldDirectId: string | undefined;
    if (directOld) {
      const direct = await oldIngestor.stage({ idempotencyKey: 'direct-old', title: 'Direct older source', content: 'Previously published direct source', parserVersion: 'parser-v1', projectId: 'p1', environment: 'nonprod' });
      oldDirectId = oldIngestor.publish(direct.id, ACTOR).id;
    }
    registry.upsert({ id: 'embed', kind: 'embedding', provider: 'openai', modelId: newModel.modelId, dimensions: newModel.dimensions, actorId: ACTOR });
    const jobId = registry.pendingReindex()[0].job.id;
    const dependencies: EngineReindexDependencies = { registry, manager: {
      status: () => ({ phase: 'ready' }),
      control: () => ({ knowledgeBaseId: newModel.knowledgeBaseId, bindings: [{ ...newModel, kind: 'embedding', alias: 'managed-embedding' }] }),
    } };
    let sequence = 0;
    const publishCurrent = async (limit = 100) => {
      const staged = await controller.createFromLocal({ actorId: ACTOR, idempotencyKey: `current-${++sequence}`, parserVersion: 'parser-v1', projectId: 'p1', environment: 'nonprod', limit }, new WeKnoraIngestor(store, writer(newModel), () => new Date(NOW)));
      return controller.validateAndPublish(staged.id, ACTOR);
    };
    await fn({ store, registry, controller, jobId, dependencies, oldMigration, oldDirectId, publishCurrent });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}
function remainsPending(f: Fixture) {
  assert.equal(f.registry.get('embed')?.reindexRequired, true);
  assert.equal(f.registry.get('embed')?.status, 'pending_reindex');
  assert.equal((f.store.db.prepare('SELECT status FROM knowledge_provider_reindex_jobs WHERE id=?').get(f.jobId) as { status: string }).status, 'pending');
  assert.equal((f.store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_audit WHERE action='knowledge.provider.reindex_completed'").get() as { count: number }).count, 0);
}
const finish = (f: Fixture) => completeVerifiedEngineReindex(f.store, f.jobId, ACTOR, f.dependencies);

test('reindex completion requires a ready managed engine and keeps pending state on refusal', () => fixture(async f => {
  await f.publishCurrent();
  f.dependencies.manager = { status: () => ({ phase: 'not_installed' }), control: () => { throw new Error('control must not be read'); } };
  assert.throws(() => finish(f), /engine_not_ready/);
  remainsPending(f);
}));

test('reindex completion requires active WeKnora routing and its published migration', () => fixture(async f => {
  await f.publishCurrent(); f.controller.setProductProvider('relay_local', ACTOR);
  assert.throws(() => finish(f), /published_migration_required/);
  remainsPending(f);
}));

test('old-model published sources cannot satisfy the new current binding', () => fixture(f => {
  assert.throws(() => finish(f), /document_binding_mismatch/);
  remainsPending(f);
}));

test('published migration with a missing verified timestamp or chunks cannot clear reindex', () => fixture(async f => {
  const current = await f.publishCurrent();
  const mapped = (current.report.documents as Array<{ documentId: string }>)[0].documentId;
  f.store.db.prepare('UPDATE knowledge_weknora_documents SET upstream_verified_at=NULL WHERE id=?').run(mapped);
  assert.throws(() => finish(f), /document_unverified/);
  remainsPending(f);
  f.store.db.prepare("UPDATE knowledge_weknora_documents SET upstream_verified_at=?,external_chunk_ids_json='[]' WHERE id=?").run(NOW, mapped);
  assert.throws(() => finish(f), /document_unverified/);
  remainsPending(f);
}));

test('a verified one-document migration cannot silently drop the rest of the old published corpus', () => fixture(async f => {
  await f.publishCurrent(1);
  assert.throws(() => finish(f), /corpus_incomplete/);
  remainsPending(f);
}));

test('an older directly published document without local mapping blocks completion', () => fixture(async f => {
  await f.publishCurrent();
  assert.throws(() => finish(f), /legacy_mapping_required/);
  remainsPending(f);
}, true));

test('real migration rollback cannot hide missing old-corpus coverage by clearing document publication timestamps', () => fixture(async f => {
  const rolledBack = f.controller.rollback(f.oldMigration.id, ACTOR, 'Rebuild in the new embedding index');
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(rolledBack.publishedAt, NOW, 'migration publication history survives rollback');
  assert.deepEqual(f.store.db.prepare('SELECT status,published_at FROM knowledge_weknora_documents ORDER BY id').all(), [
    { status: 'staged', published_at: null }, { status: 'staged', published_at: null },
  ], 'exercise the actual controller behavior, not a hand-written status update');
  await f.publishCurrent(1);
  assert.throws(() => finish(f), /corpus_incomplete/);
  remainsPending(f);
}));

test('full verified replacement after real rollback completes while preserving the old index rows', () => fixture(async f => {
  f.controller.rollback(f.oldMigration.id, ACTOR, 'Rebuild all documents');
  const current = await f.publishCurrent();
  const before = f.store.db.prepare('SELECT * FROM knowledge_weknora_documents ORDER BY id').all();
  assert.equal(finish(f).status, 'completed');
  assert.equal(f.registry.get('embed')?.reindexRequired, false);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM knowledge_weknora_documents ORDER BY id').all(), before);
  const proof = f.store.db.prepare("SELECT details_json FROM knowledge_audit WHERE action='knowledge.engine.reindex_verified'").get() as { details_json: string };
  assert.deepEqual(JSON.parse(proof.details_json), { jobId: f.jobId, migrationId: current.id, indexVersion: 2, verifiedDocuments: 2, coveredPreviousDocuments: 2 });
}));

test('rolling back a never-published staged migration does not invent historical corpus coverage requirements', () => fixture(async f => {
  seed(f.store, 'unpublished-c');
  const neverPublished = await f.controller.createFromLocal({ actorId: ACTOR, idempotencyKey: 'never-published', parserVersion: 'parser-v1', projectId: 'p1', environment: 'nonprod' }, new WeKnoraIngestor(f.store, writer(oldModel), () => new Date(NOW)));
  assert.equal(neverPublished.status, 'staged');
  const rolledBack = f.controller.rollback(neverPublished.id, ACTOR, 'Cancel unpublished source import');
  assert.equal(rolledBack.status, 'rolled_back'); assert.equal(rolledBack.publishedAt, undefined);
  await f.publishCurrent(2);
  assert.equal(finish(f).status, 'completed');
  const proof = f.store.db.prepare("SELECT details_json FROM knowledge_audit WHERE action='knowledge.engine.reindex_verified'").get() as { details_json: string };
  assert.equal(JSON.parse(proof.details_json).coveredPreviousDocuments, 2);
}));

test('explicit deprecation permits retiring an old source while retaining its old row and content', () => fixture(async f => {
  f.controller.rollback(f.oldMigration.id, ACTOR, 'Rebuild retained sources only');
  await f.publishCurrent(1);
  f.store.db.prepare("UPDATE knowledge_weknora_documents SET status='deprecated',deprecated_at=? WHERE id IN (SELECT document_id FROM knowledge_migration_documents WHERE migration_id=? AND local_document_id='local-b')").run(NOW, f.oldMigration.id);
  const before = f.store.db.prepare('SELECT * FROM knowledge_weknora_documents ORDER BY id').all();
  const localBefore = f.store.db.prepare('SELECT id,body FROM knowledge_documents ORDER BY id').all();
  assert.equal(finish(f).status, 'completed');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM knowledge_weknora_documents ORDER BY id').all(), before);
  assert.deepEqual(f.store.db.prepare('SELECT id,body FROM knowledge_documents ORDER BY id').all(), localBefore);
}));

test('complete verified coverage clears pending state and records proof without deleting either index', () => fixture(async f => {
  const current = await f.publishCurrent();
  const before = f.store.db.prepare('SELECT * FROM knowledge_weknora_documents ORDER BY id').all();
  const done = finish(f);
  assert.equal(done.id, f.jobId); assert.equal(done.status, 'completed');
  assert.equal(f.registry.get('embed')?.reindexRequired, false);
  assert.equal(f.registry.get('embed')?.status, 'ready');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM knowledge_weknora_documents ORDER BY id').all(), before);
  const proof = f.store.db.prepare("SELECT details_json FROM knowledge_audit WHERE action='knowledge.engine.reindex_verified'").get() as { details_json: string };
  assert.deepEqual(JSON.parse(proof.details_json), { jobId: f.jobId, migrationId: current.id, indexVersion: 2, verifiedDocuments: 2, coveredPreviousDocuments: 2 });
}));

test('current engine binding must match the provider and current job after another model change', () => fixture(async f => {
  await f.publishCurrent();
  f.registry.upsert({ id: 'embed', kind: 'embedding', provider: 'openai', modelId: 'model-even-newer', dimensions: 5, actorId: ACTOR });
  assert.throws(() => finish(f), /job_not_current|binding_mismatch/);
  assert.equal(f.registry.get('embed')?.reindexRequired, true);
  assert.equal((f.store.db.prepare('SELECT status FROM knowledge_provider_reindex_jobs WHERE id=?').get(f.jobId) as { status: string }).status, 'pending');
}));

test('a source changed after publication cannot be asserted to have a current verified rebuild', () => fixture(async f => {
  await f.publishCurrent();
  f.store.db.prepare("UPDATE knowledge_documents SET body='Changed since publication' WHERE id='local-a'").run();
  assert.throws(() => finish(f), /source_manifest_mismatch/);
  remainsPending(f);
}));
