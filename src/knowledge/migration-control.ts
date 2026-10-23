import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import type { WeKnoraDocumentInput, WeKnoraIngestor } from "./weknora-ingest.js";
import { INTEGRATION_ROUTING_MIGRATION } from "./migrations/038-integration-routing.js";
export type MigrationStatus = "created" | "staged" | "published" | "rolled_back" | "failed";
export interface KnowledgeMigration { id: string; kind: string; status: MigrationStatus; idempotencyKey: string; sourceManifest: Record<string, unknown>; report: Record<string, unknown>; rollbackManifest: Record<string, unknown>; rollbackReason?: string; actorId?: number; createdAt: string; updatedAt: string; publishedAt?: string; rolledBackAt?: string; }

/** Product Knowledge retrieval routing: local Relay index or the WeKnora side. */
export type ProductProvider = "relay_local" | "weknora";
export const PRODUCT_PROVIDER_SETTING_KEY = "product_provider";
const PRODUCT_PROVIDERS: readonly ProductProvider[] = ["relay_local", "weknora"];

/** Per-document manifest metadata only: never the body, never secrets. */
export interface SourceManifestDocument { localDocumentId: string; title: string; sourcePath: string; sourceSha256?: string; bodySha256: string; productVersion?: string; solution?: string; module?: string; language?: string; topicId?: string; projectId?: string; }

export interface CreateFromLocalInput { actorId: number; idempotencyKey: string; kind?: string; productVersion?: string; solution?: string; module?: string; projectId?: string; limit?: number; parserVersion: string; /** Re-attempt documents currently recorded as failed. */ retry?: boolean; }

export interface MigrationCleanupReport {
  dryRun: true;
  generatedAt: string;
  migrationId?: string;
  candidates: {
    failedDocuments: Array<{ id: string; externalDocumentId: string; failureCode?: string }>;
    deprecatedDocuments: Array<{ id: string; externalDocumentId: string }>;
    pendingExternalDocuments: Array<{ id: string; externalDocumentId: string }>;
  };
  totals: { failed: number; deprecated: number; pendingExternal: number; wouldDelete: number; truncated: boolean };
  note: string;
}

function parse(value: unknown): Record<string, unknown> { try { const v = JSON.parse(String(value ?? "{}")); return v && typeof v === "object" ? v as Record<string, unknown> : {}; } catch { return {}; } }
function fromRow(row: Record<string, unknown>): KnowledgeMigration { return { id: String(row.id), kind: String(row.kind), status: String(row.status) as MigrationStatus, idempotencyKey: String(row.idempotency_key), sourceManifest: parse(row.source_manifest_json), report: parse(row.report_json), rollbackManifest: parse(row.rollback_manifest_json), rollbackReason: row.rollback_reason ? String(row.rollback_reason) : undefined, actorId: row.actor_id == null ? undefined : Number(row.actor_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at), publishedAt: row.published_at ? String(row.published_at) : undefined, rolledBackAt: row.rolled_back_at ? String(row.rolled_back_at) : undefined }; }
export class MigrationController {
  constructor(private readonly store: KnowledgeStore, private readonly clock: () => Date = () => new Date()) {
    // The 038 schema may not be registered in the store yet; every statement is
    // idempotent so applying it here converges fresh and recovered databases.
    this.store.db.exec(INTEGRATION_ROUTING_MIGRATION.sql);
  }
  create(input: { actorId: number; kind?: string; idempotencyKey: string; sourceManifest: Record<string, unknown> }): KnowledgeMigration { const existing = this.store.db.prepare("SELECT * FROM knowledge_migrations WHERE idempotency_key=?").get(input.idempotencyKey) as Record<string, unknown> | undefined; if (existing) return fromRow(existing); const now = this.clock().toISOString(); const id = `migration-${randomUUID()}`; this.store.db.prepare("INSERT INTO knowledge_migrations(id,kind,status,idempotency_key,source_manifest_json,report_json,rollback_manifest_json,actor_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, input.kind ?? "product_knowledge", "created", input.idempotencyKey, JSON.stringify(input.sourceManifest), "{}", "{}", input.actorId, now, now); this.store.audit({ actorId: input.actorId, action: "knowledge.migration.create", entityType: "migration", entityId: id, details: { kind: input.kind ?? "product_knowledge" } }); return this.get(id)!; }
  get(id: string): KnowledgeMigration | undefined { const row = this.store.db.prepare("SELECT * FROM knowledge_migrations WHERE id=?").get(id) as Record<string, unknown> | undefined; return row ? fromRow(row) : undefined; }
  markStaged(id: string, report: Record<string, unknown>, actorId: number): KnowledgeMigration { return this.transition(id, "staged", report, actorId); }
  publish(id: string, actorId: number): KnowledgeMigration { const now = this.clock().toISOString(); const result = this.store.db.prepare("UPDATE knowledge_migrations SET status='published',published_at=?,updated_at=? WHERE id=? AND status='staged'").run(now, now, id); if (!result.changes) throw new Error("Migration must be staged before publish"); this.store.audit({ actorId, action: "knowledge.migration.publish", entityType: "migration", entityId: id, details: { status: "published" } }); return this.get(id)!; }

  /** Retrieval routing defaults to the local Relay index until an explicit publish switches it. */
  activeProductProvider(): ProductProvider {
    const row = this.store.db.prepare("SELECT value FROM knowledge_integration_settings WHERE key=?").get(PRODUCT_PROVIDER_SETTING_KEY) as { value?: string } | undefined;
    return PRODUCT_PROVIDERS.includes(row?.value as ProductProvider) ? row!.value as ProductProvider : "relay_local";
  }

  /**
   * Manual routing override. Switching to WeKnora is only allowed with a
   * published migration; switching back to relay_local is always permitted.
   * The setting update and its audit row commit atomically.
   */
  setProductProvider(provider: ProductProvider, actorId: number, options: { migrationId?: string } = {}): { provider: ProductProvider; previousProvider: ProductProvider } {
    if (!PRODUCT_PROVIDERS.includes(provider)) throw new Error(`Unknown product provider: ${String(provider)}`);
    if (provider === "weknora") {
      const migration = options.migrationId ? this.get(options.migrationId) : undefined;
      if (!migration || migration.status !== "published") throw new Error("Switching to WeKnora requires a published migration");
    }
    const now = this.clock().toISOString();
    let previousProvider: ProductProvider = "relay_local";
    this.store.db.transaction(() => {
      previousProvider = this.activeProductProvider();
      this.writeProviderSetting(provider, actorId, options.migrationId, previousProvider, now);
      this.store.audit({ actorId, action: "knowledge.integration.set_product_provider", entityType: "integration_setting", entityId: PRODUCT_PROVIDER_SETTING_KEY, details: { provider, previousProvider, migrationId: options.migrationId ?? null } });
    })();
    return { provider, previousProvider };
  }

  /**
   * Build a metadata-only source manifest from local Product documents and
   * stage each document through the ingestor. Re-running with the same
   * idempotency key never re-calls the ingestor for already-mapped documents;
   * failed documents are only re-attempted with `retry: true`.
   */
  async createFromLocal(input: CreateFromLocalInput, ingestor: WeKnoraIngestor): Promise<KnowledgeMigration> {
    const key = input.idempotencyKey.trim();
    if (!key) throw new Error("idempotencyKey is required");
    const parserVersion = input.parserVersion.trim();
    if (!parserVersion) throw new Error("parserVersion is required");
    const existing = this.store.db.prepare("SELECT * FROM knowledge_migrations WHERE idempotency_key=?").get(key) as Record<string, unknown> | undefined;
    if (existing && ["published", "rolled_back"].includes(String(existing.status))) return fromRow(existing);

    const rows = this.queryLocalProductDocuments(input);
    const manifest = {
      source: "relay_local",
      generatedAt: this.clock().toISOString(),
      parserVersion,
      filters: { productVersion: input.productVersion ?? null, solution: input.solution ?? null, module: input.module ?? null, projectId: input.projectId ?? null },
      documents: rows.map(({ body: _body, ...metadata }) => metadata),
    };

    let migrationId: string;
    if (existing) {
      migrationId = String(existing.id);
      this.store.db.prepare("UPDATE knowledge_migrations SET source_manifest_json=?,updated_at=? WHERE id=? AND status IN ('created','staged')").run(JSON.stringify(manifest), this.clock().toISOString(), migrationId);
    } else {
      migrationId = this.create({ actorId: input.actorId, kind: input.kind ?? "product_knowledge", idempotencyKey: key, sourceManifest: manifest }).id;
    }

    const mapped = new Map<string, Record<string, unknown>>();
    for (const row of this.store.db.prepare("SELECT * FROM knowledge_migration_documents WHERE migration_id=?").all(migrationId) as Array<Record<string, unknown>>) mapped.set(String(row.local_document_id), row);
    const upsertMapping = this.store.db.prepare(`INSERT INTO knowledge_migration_documents(migration_id,local_document_id,document_id,idempotency_key,external_document_id,status,failure_code,failure_message,content_sha256,parser_version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(migration_id,local_document_id) DO UPDATE SET document_id=excluded.document_id,external_document_id=excluded.external_document_id,status=excluded.status,failure_code=excluded.failure_code,failure_message=excluded.failure_message,content_sha256=excluded.content_sha256,parser_version=excluded.parser_version,updated_at=excluded.updated_at`);
    const findStagedByKey = this.store.db.prepare("SELECT id,external_document_id,status FROM knowledge_weknora_documents WHERE idempotency_key=?");
    const now = () => this.clock().toISOString();

    for (const document of rows) {
      const prior = mapped.get(document.localDocumentId);
      // Already mapped documents are never re-staged; failed ones wait for an
      // explicit retry so a re-run cannot hammer a failing upstream.
      if (prior && ["staged", "published"].includes(String(prior.status))) continue;
      if (prior && String(prior.status) === "failed" && !input.retry) continue;
      const documentKey = `${key}:${document.localDocumentId}`;
      const weknoraInput: WeKnoraDocumentInput = {
        idempotencyKey: documentKey,
        title: document.title,
        content: document.body,
        productVersion: document.productVersion,
        solution: document.solution,
        module: document.module,
        topicId: document.topicId,
        sourcePath: document.sourcePath,
        language: document.language,
        projectId: input.projectId ?? document.projectId,
        parserVersion,
        rawSha256: document.sourceSha256,
      };
      const batch = await ingestor.stageBatch([weknoraInput], { retry: Boolean(prior) });
      const item = batch.items[0];
      const stagedRow = findStagedByKey.get(documentKey) as Record<string, unknown> | undefined;
      const status = item?.status === "failed" || String(stagedRow?.status ?? "") === "failed" ? "failed" : "staged";
      upsertMapping.run(migrationId, document.localDocumentId, item?.documentId ?? (stagedRow ? String(stagedRow.id) : null), documentKey, stagedRow ? String(stagedRow.external_document_id) : null, status, item?.failureCode ?? null, item?.error ?? null, document.bodySha256, parserVersion, now(), now());
      this.store.audit({ actorId: input.actorId, action: "knowledge.migration.stage_document", entityType: "migration", entityId: migrationId, details: { localDocumentId: document.localDocumentId, status, externalDocumentId: stagedRow?.external_document_id ?? null } });
    }

    const linkage = this.store.db.prepare("SELECT * FROM knowledge_migration_documents WHERE migration_id=? ORDER BY local_document_id").all(migrationId) as Array<Record<string, unknown>>;
    const documents = linkage.map((row) => ({
      localDocumentId: String(row.local_document_id),
      idempotencyKey: String(row.idempotency_key),
      status: String(row.status),
      documentId: row.document_id ? String(row.document_id) : null,
      externalDocumentId: row.external_document_id ? String(row.external_document_id) : null,
      failureCode: row.failure_code ? String(row.failure_code) : null,
      failureMessage: row.failure_message ? String(row.failure_message) : null,
      contentSha256: row.content_sha256 ? String(row.content_sha256) : null,
      parserVersion: row.parser_version ? String(row.parser_version) : null,
    }));
    const failedDocuments = documents.filter((document) => document.status === "failed").map((document) => ({ localDocumentId: document.localDocumentId, idempotencyKey: document.idempotencyKey, failureCode: document.failureCode, error: document.failureMessage }));
    const mappedCount = documents.filter((document) => document.status !== "failed").length;
    const report = {
      total: rows.length,
      mapped: mappedCount,
      failed: failedDocuments.length,
      skipped: rows.length - mappedCount - failedDocuments.length,
      manifestCount: manifest.documents.length,
      parserVersion,
      failedDocuments,
      documents,
      lastRunAt: this.clock().toISOString(),
    };
    return this.markStaged(migrationId, report, input.actorId);
  }

  /**
   * Validate the staged migration, publish its documents, and switch retrieval
   * routing to WeKnora in one atomic transaction; the rollback manifest records
   * the previous provider and the published document ids.
   */
  validateAndPublish(id: string, actorId: number, options: { sampleSize?: number } = {}): KnowledgeMigration {
    const migration = this.get(id);
    if (!migration) throw new Error("Migration not found");
    if (migration.status !== "staged") throw new Error("Migration must be staged before publish");
    const manifestDocuments = Array.isArray(migration.sourceManifest.documents) ? migration.sourceManifest.documents as Array<Record<string, unknown>> : [];
    if (manifestDocuments.length === 0) throw new Error("Migration source manifest has no documents");
    const failedDocuments = Array.isArray(migration.report.failedDocuments) ? migration.report.failedDocuments : [];
    if (Number(migration.report.failed ?? 0) > 0 || failedDocuments.length > 0) throw new Error("Migration has failed documents; retry them before publish");
    const linkage = this.store.db.prepare("SELECT * FROM knowledge_migration_documents WHERE migration_id=?").all(id) as Array<Record<string, unknown>>;
    const mapped = linkage.filter((row) => ["staged", "published"].includes(String(row.status)));
    if (mapped.length !== manifestDocuments.length || Number(migration.report.mapped ?? -1) !== manifestDocuments.length) throw new Error("Mapped document count does not match the source manifest");
    const missingExternal = mapped.filter((row) => { const external = String(row.external_document_id ?? ""); return !external || external.startsWith("pending:"); });
    if (missingExternal.length > 0) throw new Error("Mapped documents are missing external document ids");
    // Spot-check a bounded sample against the live control-plane rows.
    const sample = mapped.slice(0, Math.max(1, Math.min(options.sampleSize ?? 5, mapped.length)));
    for (const row of sample) {
      const document = this.store.db.prepare("SELECT status FROM knowledge_weknora_documents WHERE id=?").get(String(row.document_id)) as { status?: string } | undefined;
      if (!document || !["staged", "published"].includes(String(document.status))) throw new Error("Linked WeKnora document is not staged");
    }

    const now = this.clock().toISOString();
    const documentIds = mapped.map((row) => String(row.document_id));
    this.store.db.transaction(() => {
      const publishDocument = this.store.db.prepare("UPDATE knowledge_weknora_documents SET status='published',published_at=?,updated_at=?,deprecated_at=NULL WHERE id=? AND status IN ('staged','published')");
      for (const documentId of documentIds) publishDocument.run(now, now, documentId);
      this.store.db.prepare("UPDATE knowledge_migration_documents SET status='published',updated_at=? WHERE migration_id=? AND status='staged'").run(now, id);
      const previousProvider = this.activeProductProvider();
      const rollbackManifest = { migrationId: id, previousProvider, restoreProvider: "relay_local", documentIds, publishedDocumentCount: documentIds.length, generatedAt: now };
      const result = this.store.db.prepare("UPDATE knowledge_migrations SET status='published',published_at=?,updated_at=?,rollback_manifest_json=? WHERE id=? AND status='staged'").run(now, now, JSON.stringify(rollbackManifest), id);
      if (!result.changes) throw new Error("Migration must be staged before publish");
      this.writeProviderSetting("weknora", actorId, id, previousProvider, now);
      this.store.audit({ actorId, action: "knowledge.migration.publish", entityType: "migration", entityId: id, details: { status: "published", documentCount: documentIds.length, validatedSample: sample.length } });
      this.store.audit({ actorId, action: "knowledge.integration.set_product_provider", entityType: "integration_setting", entityId: PRODUCT_PROVIDER_SETTING_KEY, details: { provider: "weknora", previousProvider, migrationId: id } });
    })();
    return this.get(id)!;
  }

  /**
   * Restore relay_local routing and move the migration's published documents
   * back to staged. Nothing is deleted: WeKnora documents, Relay local
   * documents, Evidence and Memory all survive. Repeating a rollback is a
   * no-op that returns the already rolled-back record.
   */
  rollback(id: string, actorId: number, reason: string): KnowledgeMigration {
    const now = this.clock().toISOString();
    const current = this.get(id);
    if (!current) throw new Error("Migration not found");
    if (current.status === "rolled_back") return current;
    if (!["published", "staged"].includes(current.status)) throw new Error("Migration cannot be rolled back");
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE knowledge_weknora_documents SET status='staged',published_at=NULL,updated_at=? WHERE status='published' AND id IN (SELECT document_id FROM knowledge_migration_documents WHERE migration_id=? AND document_id IS NOT NULL)").run(now, id);
      this.store.db.prepare("UPDATE knowledge_migration_documents SET status='staged',updated_at=? WHERE migration_id=? AND status='published'").run(now, id);
      // Only the migration that switched routing to WeKnora switches it back.
      const setting = this.store.db.prepare("SELECT value,migration_id FROM knowledge_integration_settings WHERE key=?").get(PRODUCT_PROVIDER_SETTING_KEY) as Record<string, unknown> | undefined;
      if (setting && String(setting.value) === "weknora" && String(setting.migration_id ?? "") === id) {
        this.writeProviderSetting("relay_local", actorId, id, "weknora", now);
        this.store.audit({ actorId, action: "knowledge.integration.set_product_provider", entityType: "integration_setting", entityId: PRODUCT_PROVIDER_SETTING_KEY, details: { provider: "relay_local", previousProvider: "weknora", migrationId: id, reason: reason.slice(0, 500) } });
      }
      const rollbackManifest = { ...current.rollbackManifest, migrationId: id, restore: "relay-local-index", reason: reason.slice(0, 2_000), rolledBackAt: now };
      this.store.db.prepare("UPDATE knowledge_migrations SET status='rolled_back',rollback_reason=?,rollback_manifest_json=?,rolled_back_at=?,updated_at=? WHERE id=?").run(reason.slice(0, 2_000), JSON.stringify(rollbackManifest), now, now, id);
      this.store.audit({ actorId, action: "knowledge.migration.rollback", entityType: "migration", entityId: id, details: { reason: reason.slice(0, 500), status: "rolled_back" } });
    })();
    return this.get(id)!;
  }

  /**
   * Dry-run cleanup only: lists the control-plane rows a future cleanup phase
   * would remove (failed, deprecated, pending-external WeKnora records). This
   * phase never deletes; administrator authorization is enforced by the route
   * layer before calling this.
   */
  cleanupDryRun(options: { actorId?: number; migrationId?: string } = {}): MigrationCleanupReport {
    const scope = options.migrationId ? "AND id IN (SELECT document_id FROM knowledge_migration_documents WHERE migration_id=?)" : "";
    const params: unknown[] = options.migrationId ? [options.migrationId] : [];
    const query = (where: string) => this.store.db.prepare(`SELECT id,external_document_id,failure_code,status FROM knowledge_weknora_documents WHERE ${where} ${scope} ORDER BY id LIMIT 500`).all(...params) as Array<Record<string, unknown>>;
    const toRef = (row: Record<string, unknown>) => ({ id: String(row.id), externalDocumentId: String(row.external_document_id), failureCode: row.failure_code ? String(row.failure_code) : undefined });
    const failed = query("status = 'failed'");
    const deprecated = query("status = 'deprecated'");
    const pending = query("external_document_id LIKE 'pending:%'");
    const distinctIds = new Set([...failed, ...deprecated, ...pending].map((row) => String(row.id)));
    const totals = { failed: failed.length, deprecated: deprecated.length, pendingExternal: pending.length, wouldDelete: distinctIds.size, truncated: failed.length >= 500 || deprecated.length >= 500 || pending.length >= 500 };
    this.store.audit({ actorId: options.actorId, action: "knowledge.migration.cleanup_dry_run", entityType: "migration", entityId: options.migrationId ?? "product-knowledge", details: { dryRun: true, ...totals } });
    return {
      dryRun: true,
      generatedAt: this.clock().toISOString(),
      migrationId: options.migrationId,
      candidates: {
        failedDocuments: failed.map(toRef),
        deprecatedDocuments: deprecated.map((row) => ({ id: String(row.id), externalDocumentId: String(row.external_document_id) })),
        pendingExternalDocuments: pending.map((row) => ({ id: String(row.id), externalDocumentId: String(row.external_document_id) })),
      },
      totals,
      note: "Dry run only: no WeKnora, Relay local, Evidence or Memory data is deleted in this phase.",
    };
  }

  private writeProviderSetting(provider: ProductProvider, actorId: number | undefined, migrationId: string | undefined, previousProvider: ProductProvider, now: string): void {
    this.store.db.prepare(`INSERT INTO knowledge_integration_settings(key,value,previous_value,migration_id,updated_by,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,previous_value=excluded.previous_value,migration_id=excluded.migration_id,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(PRODUCT_PROVIDER_SETTING_KEY, provider, previousProvider, migrationId ?? null, actorId ?? null, now);
  }

  /** Local Product documents with their bodies for staging; the manifest keeps only metadata. */
  private queryLocalProductDocuments(input: CreateFromLocalInput): Array<SourceManifestDocument & { body: string }> {
    const conditions = ["d.kind = 'product_document'", "d.lifecycle != 'deprecated'"];
    const params: unknown[] = [];
    if (input.productVersion) { conditions.push("d.samplemanager_version = ?"); params.push(input.productVersion); }
    if (input.solution) { conditions.push("d.solution = ?"); params.push(input.solution); }
    if (input.module) { conditions.push("d.module = ?"); params.push(input.module); }
    if (input.projectId) { conditions.push("d.project_id = ?"); params.push(input.projectId); }
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 1000), 10000));
    const rows = this.store.db.prepare(`SELECT d.id, d.title, d.body, d.project_id, d.samplemanager_version, d.solution, d.module, d.source_locator, d.source_sha256, p.source_path, p.language, b.topic_id
      FROM knowledge_documents d
      LEFT JOIN knowledge_product_documents p ON p.id = d.id
      LEFT JOIN knowledge_product_document_bindings b ON b.document_id = d.id
      WHERE ${conditions.join(" AND ")} ORDER BY d.id LIMIT ?`).all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const body = String(row.body ?? "");
      return {
        localDocumentId: String(row.id),
        title: String(row.title ?? row.id),
        body,
        projectId: row.project_id ? String(row.project_id) : undefined,
        productVersion: row.samplemanager_version ? String(row.samplemanager_version) : undefined,
        solution: row.solution ? String(row.solution) : undefined,
        module: row.module ? String(row.module) : undefined,
        sourcePath: String(row.source_path ?? row.source_locator ?? ""),
        sourceSha256: row.source_sha256 ? String(row.source_sha256) : undefined,
        bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
        language: row.language ? String(row.language) : undefined,
        topicId: row.topic_id ? String(row.topic_id) : undefined,
      };
    });
  }

  private transition(id: string, status: "staged", report: Record<string, unknown>, actorId: number): KnowledgeMigration { const now = this.clock().toISOString(); const result = this.store.db.prepare("UPDATE knowledge_migrations SET status='staged',report_json=?,updated_at=? WHERE id=? AND status IN ('created','staged')").run(JSON.stringify(report), now, id); if (!result.changes) throw new Error("Migration not found or already published"); this.store.audit({ actorId, action: "knowledge.migration.stage", entityType: "migration", entityId: id, details: { status, reportKeys: Object.keys(report) } }); return this.get(id)!; }
}
