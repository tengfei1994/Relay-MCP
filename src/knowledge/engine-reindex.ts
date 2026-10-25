import { createHash } from 'node:crypto';
import type { KnowledgeStore } from './store.js';
import { EngineError, type EngineControlState } from './engine-config.js';
import { getEngineManager } from './engine-service.js';
import type { ProviderRegistry, ProviderReindexJob } from './provider-registry.js';
import { createManagedProviderRegistry } from './provider-setup.js';
import { MigrationController, PRODUCT_PROVIDER_SETTING_KEY, type KnowledgeMigration } from './migration-control.js';
import { isVerifiedWeKnoraDocument, normalizeProductContent, weKnoraDocumentFromRow, type StagedWeKnoraDocument, type WeKnoraModelProvenance } from './weknora-ingest.js';

export interface EngineReindexDependencies {
  manager?: { status(): { phase: string }; control(): Pick<EngineControlState, 'knowledgeBaseId' | 'bindings'> };
  registry?: Pick<ProviderRegistry, 'get' | 'completeReindex'>;
}
type Row = Record<string, unknown>;
function fail(code: string): never { throw new EngineError('reindex_' + code, 409); }
function required(condition: unknown, code: string): asserts condition { if (!condition) fail(code); }
function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function object(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function sameGeneration(document: StagedWeKnoraDocument, expected: WeKnoraModelProvenance): boolean {
  const actual = document.modelProvenance;
  return Boolean(actual && document.knowledgeBaseId === expected.knowledgeBaseId &&
    actual.knowledgeBaseId === expected.knowledgeBaseId && actual.providerId === expected.providerId &&
    actual.modelId === expected.modelId && actual.dimensions === expected.dimensions && actual.indexVersion === expected.indexVersion);
}
function documentFromRow(row: Row): StagedWeKnoraDocument {
  try { return weKnoraDocumentFromRow(row); } catch { return fail('document_unverified'); }
}

/** Completion records existing proof; it never creates vectors, changes routing, or deletes an index. */
export function completeVerifiedEngineReindex(store: KnowledgeStore, jobId: string, actorId: number, dependencies: EngineReindexDependencies = {}): ProviderReindexJob {
  const registry = dependencies.registry ?? createManagedProviderRegistry(store);
  const manager = dependencies.manager ?? getEngineManager(store);
  return store.db.transaction(() => {
    const job = store.db.prepare('SELECT * FROM knowledge_provider_reindex_jobs WHERE id=?').get(jobId) as Row | undefined;
    required(job, 'job_not_found');
    const provider = registry.get(String(job.provider_id));
    required(provider?.kind === 'embedding' && provider.status !== 'disabled' &&
      provider.indexVersion === Number(job.index_version) && provider.modelId === job.to_model_id && provider.dimensions === job.to_dimensions, 'job_not_current');
    required(manager.status().phase === 'ready', 'engine_not_ready');
    const control = manager.control();
    const embeddings = control.bindings.filter(binding => binding.kind === 'embedding');
    const binding = embeddings[0];
    required(control.knowledgeBaseId && embeddings.length === 1 && binding.providerId === provider.id &&
      binding.modelId === provider.modelId && binding.dimensions === provider.dimensions &&
      Number.isInteger(binding.dimensions) && Number(binding.dimensions) > 0 && binding.indexVersion === provider.indexVersion, 'binding_mismatch');
    const expected: WeKnoraModelProvenance = { knowledgeBaseId: control.knowledgeBaseId, providerId: provider.id, modelId: binding.modelId, dimensions: binding.dimensions!, indexVersion: binding.indexVersion };

    const controller = new MigrationController(store);
    const routing = store.db.prepare('SELECT migration_id FROM knowledge_integration_settings WHERE key=?').get(PRODUCT_PROVIDER_SETTING_KEY) as Row | undefined;
    const migration = routing?.migration_id ? controller.get(String(routing.migration_id)) : undefined;
    required(controller.activeProductProvider() === 'weknora' && migration?.kind === 'product_knowledge' && migration.status === 'published', 'published_migration_required');
    const verified = new Map<string, StagedWeKnoraDocument>();
    const validatedMigrations = new Set<string>();
    const validateMigration = (migration: KnowledgeMigration) => {
      required(migration.kind === 'product_knowledge' && migration.status === 'published', 'published_migration_required');
      if (validatedMigrations.has(migration.id)) return;
      const sourceDocuments = Array.isArray(migration.sourceManifest.documents) ? migration.sourceManifest.documents.map(object) : [];
      const manifests = new Map(sourceDocuments.map(source => [String(source.localDocumentId ?? ''), source]));
      const mapped = store.db.prepare('SELECT * FROM knowledge_migration_documents WHERE migration_id=?').all(migration.id) as Row[];
      required(sourceDocuments.length > 0 && !manifests.has('') && manifests.size === sourceDocuments.length &&
        mapped.length === sourceDocuments.length && Number(migration.report.mapped) === mapped.length &&
        Number(migration.report.failed ?? 0) === 0 && (!Array.isArray(migration.report.failedDocuments) || migration.report.failedDocuments.length === 0), 'migration_incomplete');

      const documentIds = new Set<string>();
      for (const mapping of mapped) {
        const manifest = manifests.get(String(mapping.local_document_id));
        const row = store.db.prepare('SELECT * FROM knowledge_weknora_documents WHERE id=?').get(mapping.document_id) as Row | undefined;
        required(manifest && row && mapping.status === 'published' && row.status === 'published', 'document_unverified');
        const document = documentFromRow(row);
        required(isVerifiedWeKnoraDocument(document), 'document_unverified');
        required(sameGeneration(document, expected), 'document_binding_mismatch');
        required(mapping.external_document_id === document.externalDocumentId && !documentIds.has(document.id), 'document_identity_mismatch');
        documentIds.add(document.id);
        const local = store.db.prepare("SELECT body FROM knowledge_documents WHERE id=? AND kind='product_document'").get(mapping.local_document_id) as { body: string } | undefined;
        required(local && mapping.content_sha256 === manifest.bodySha256 && hash(local.body) === manifest.bodySha256 &&
          hash(normalizeProductContent(local.body)) === document.normalizedContentSha256 &&
          document.rawSha256 === (manifest.sourceSha256 ?? undefined) && mapping.parser_version === migration.sourceManifest.parserVersion &&
          document.parserVersion === mapping.parser_version, 'source_manifest_mismatch');
        for (const key of ['projectId', 'environment', 'productVersion', 'solution', 'module', 'topicId', 'sourcePath', 'language'] as const) {
          required(document[key] === (manifest[key] ?? undefined), 'source_manifest_mismatch');
        }
        verified.set(String(mapping.local_document_id), document);
      }
      validatedMigrations.add(migration.id);
    };
    validateMigration(migration);

    // Rollback clears the document's published_at and stages its mappings,
    // while the migration retains publication history. Include that history so
    // rollback cannot erase coverage requirements; never-published migrations
    // do not count, and explicit document deprecation still retires a source.
    const retained = store.db.prepare(`SELECT w.* FROM knowledge_weknora_documents w
      WHERE w.status!='deprecated' AND (w.status='published' OR w.published_at IS NOT NULL OR w.id IN (
        SELECT d.document_id FROM knowledge_migration_documents d
        JOIN knowledge_migrations m ON m.id=d.migration_id
        WHERE d.document_id IS NOT NULL AND (m.status='published' OR m.published_at IS NOT NULL)
      ))`).all() as Row[];
    const previousMappings = store.db.prepare(`SELECT DISTINCT d.local_document_id FROM knowledge_migration_documents d
      JOIN knowledge_migrations m ON m.id=d.migration_id
      WHERE d.document_id=? AND (m.status='published' OR m.published_at IS NOT NULL)`);
    const supplementalMigrations = store.db.prepare(`SELECT DISTINCT m.id FROM knowledge_migrations m
      JOIN knowledge_migration_documents d ON d.migration_id=m.id
      JOIN knowledge_weknora_documents w ON w.id=d.document_id
      WHERE m.kind='product_knowledge' AND m.status='published' AND d.status='published' AND w.status='published'
        AND d.local_document_id=? AND w.external_knowledge_base_id=? ORDER BY m.id`);
    let coveredPreviousDocuments = 0;
    for (const row of retained) {
      const document = documentFromRow(row), provenance = document.modelProvenance;
      // Unknown provenance cannot prove that an older retained source belongs
      // to another provider. An explicit deprecation or a verified rebuild is required.
      required(provenance, 'document_provenance_missing');
      if (provenance.providerId !== provider.id) continue;
      if (sameGeneration(document, expected)) {
        required(isVerifiedWeKnoraDocument(document), 'document_unverified');
        continue;
      }
      required(provenance.indexVersion < expected.indexVersion, 'document_binding_mismatch');
      const aliases = previousMappings.all(document.id) as Array<{ local_document_id: string }>;
      required(aliases.length > 0, 'legacy_mapping_required');
      for (const alias of aliases) {
        // A provider can serve several project/environment migrations. Require
        // the same complete published proof for each supplemental replacement;
        // a staged row or a matching model label alone is insufficient.
        if (!verified.has(alias.local_document_id)) {
          for (const candidate of supplementalMigrations.all(alias.local_document_id, expected.knowledgeBaseId) as Array<{ id: string }>) {
            const supplemental = controller.get(candidate.id);
            required(supplemental, 'published_migration_required');
            validateMigration(supplemental);
          }
        }
        const replacement = verified.get(alias.local_document_id);
        required(replacement && replacement.projectId === document.projectId && replacement.environment === document.environment, 'corpus_incomplete');
      }
      coveredPreviousDocuments++;
    }

    store.audit({ actorId, action: 'knowledge.engine.reindex_verified', entityType: 'provider', entityId: provider.id,
      details: { jobId, migrationId: migration.id, migrationIds: [...validatedMigrations].sort(), indexVersion: expected.indexVersion, verifiedDocuments: verified.size, coveredPreviousDocuments } });
    return registry.completeReindex(jobId, actorId);
  // Reserve the write transaction before the corpus proof. A background writer
  // must not invalidate the read snapshot before completion/audit can commit.
  }).immediate();
}
