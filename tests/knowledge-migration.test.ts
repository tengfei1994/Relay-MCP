import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore, type KnowledgeStore } from "../src/knowledge/store.ts";
import { MigrationController, PRODUCT_PROVIDER_SETTING_KEY } from "../src/knowledge/migration-control.ts";
import { INTEGRATION_ROUTING_MIGRATION } from "../src/knowledge/migrations/038-integration-routing.ts";
import { WeKnoraIngestor, type WeKnoraDocumentWriter } from "../src/knowledge/weknora-ingest.ts";

function withStore(fn: (store: KnowledgeStore) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "relay-migration-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  return Promise.resolve(fn(store)).finally(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
}

function seedProductDocument(store: KnowledgeStore, id: string, overrides: { version?: string; solution?: string; module?: string; body?: string; projectId?: string } = {}): void {
  store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,samplemanager_version,solution,module,source_locator,source_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "product_document", `Title ${id}`, overrides.body ?? `Body of ${id}`, "approved", overrides.projectId ?? "p1", overrides.version ?? "21.3", overrides.solution ?? "Core", overrides.module ?? "Forms", `docs/${id}.html`, `sha-${id}`, "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
  store.db.prepare("INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,source_path,source_sha256,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, `family-${id}`, "html", "en", `docs/${id}.html`, `sha-${id}`, overrides.version ?? "21.3", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
}

function countingWriter(failOn?: (key: string) => boolean) {
  const state = { calls: 0, keys: [] as string[] };
  const writer: WeKnoraDocumentWriter = {
    async upsertDocument(input) {
      state.calls += 1;
      state.keys.push(input.idempotencyKey);
      if (failOn?.(input.idempotencyKey)) throw new Error("upstream 500 with token sk-migration-secret-1");
      return { externalDocumentId: `ext-${input.idempotencyKey}`, knowledgeBaseId: "kb-1" };
    },
  };
  return { writer, state };
}

function makeController(store: KnowledgeStore) {
  return new MigrationController(store, () => new Date("2026-10-23T00:00:00.000Z"));
}

test("migration 038 applies idempotently and creates routing and linkage tables", async () => withStore((store) => {
  store.db.exec(INTEGRATION_ROUTING_MIGRATION.sql);
  store.db.exec(INTEGRATION_ROUTING_MIGRATION.sql);
  const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('knowledge_integration_settings','knowledge_migration_documents')").all() as Array<{ name: string }>).map((row) => row.name);
  assert.deepEqual(tables.sort(), ["knowledge_integration_settings", "knowledge_migration_documents"]);
}));

test("routing defaults to relay_local and switching to weknora requires a published migration", async () => withStore((store) => {
  const controller = makeController(store);
  assert.equal(controller.activeProductProvider(), "relay_local");
  assert.throws(() => controller.setProductProvider("weknora", 7), /published migration/);

  const migration = controller.create({ actorId: 7, idempotencyKey: "route-1", sourceManifest: { documents: [1] } });
  assert.throws(() => controller.setProductProvider("weknora", 7, { migrationId: migration.id }), /published migration/);
  controller.markStaged(migration.id, { mapped: 1 }, 7);
  assert.throws(() => controller.setProductProvider("weknora", 7, { migrationId: migration.id }), /published migration/);
  controller.publish(migration.id, 7);
  const switched = controller.setProductProvider("weknora", 7, { migrationId: migration.id });
  assert.deepEqual(switched, { provider: "weknora", previousProvider: "relay_local" });
  assert.equal(controller.activeProductProvider(), "weknora");
  const setting = store.db.prepare("SELECT value,previous_value,migration_id,updated_by FROM knowledge_integration_settings WHERE key=?").get(PRODUCT_PROVIDER_SETTING_KEY) as Record<string, unknown>;
  assert.deepEqual(setting, { value: "weknora", previous_value: "relay_local", migration_id: migration.id, updated_by: 7 });
  const audit = store.db.prepare("SELECT action FROM knowledge_audit WHERE entity_type='integration_setting' AND entity_id=?").all(PRODUCT_PROVIDER_SETTING_KEY) as Array<{ action: string }>;
  assert.deepEqual(audit.map((row) => row.action), ["knowledge.integration.set_product_provider"]);

  const reverted = controller.setProductProvider("relay_local", 7);
  assert.deepEqual(reverted, { provider: "relay_local", previousProvider: "weknora" });
  assert.equal(controller.activeProductProvider(), "relay_local");
}));

test("createFromLocal stages each local product document and re-running the idempotency key does not restage", async () => withStore(async (store) => {
  seedProductDocument(store, "doc-1");
  seedProductDocument(store, "doc-2");
  const { writer, state } = countingWriter();
  const ingestor = new WeKnoraIngestor(store, writer, () => new Date("2026-10-23T00:00:00.000Z"));
  const controller = makeController(store);

  const migration = await controller.createFromLocal({ actorId: 7, idempotencyKey: "mig-1", parserVersion: "parser-1" }, ingestor);
  assert.equal(migration.status, "staged");
  assert.equal(state.calls, 2);
  assert.deepEqual(state.keys.sort(), ["mig-1:doc-1", "mig-1:doc-2"]);
  assert.equal(migration.report.total, 2);
  assert.equal(migration.report.mapped, 2);
  assert.equal(migration.report.failed, 0);
  assert.equal(migration.report.parserVersion, "parser-1");

  // The manifest carries metadata and hashes only, never document bodies.
  const manifestDocuments = migration.sourceManifest.documents as Array<Record<string, unknown>>;
  assert.equal(manifestDocuments.length, 2);
  assert.ok(!JSON.stringify(migration.sourceManifest).includes("Body of"));
  assert.ok(manifestDocuments.every((document) => typeof document.bodySha256 === "string" && document.bodySha256.length === 64));
  assert.deepEqual(
    manifestDocuments.map((document) => ({ localDocumentId: document.localDocumentId, sourcePath: document.sourcePath, productVersion: document.productVersion, language: document.language })),
    [
      { localDocumentId: "doc-1", sourcePath: "docs/doc-1.html", productVersion: "21.3", language: "en" },
      { localDocumentId: "doc-2", sourcePath: "docs/doc-2.html", productVersion: "21.3", language: "en" },
    ],
  );

  const linkage = store.db.prepare("SELECT local_document_id,external_document_id,status,parser_version,content_sha256 FROM knowledge_migration_documents WHERE migration_id=? ORDER BY local_document_id").all(migration.id) as Array<Record<string, unknown>>;
  assert.deepEqual(linkage, [
    { local_document_id: "doc-1", external_document_id: "ext-mig-1:doc-1", status: "staged", parser_version: "parser-1", content_sha256: (manifestDocuments[0] as { bodySha256: string }).bodySha256 },
    { local_document_id: "doc-2", external_document_id: "ext-mig-1:doc-2", status: "staged", parser_version: "parser-1", content_sha256: (manifestDocuments[1] as { bodySha256: string }).bodySha256 },
  ]);

  const repeated = await controller.createFromLocal({ actorId: 7, idempotencyKey: "mig-1", parserVersion: "parser-1" }, ingestor);
  assert.equal(repeated.id, migration.id);
  assert.equal(state.calls, 2, "re-run must not call the ingestor for mapped documents");
  assert.equal(repeated.report.mapped, 2);
  const weknoraCount = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_weknora_documents").get() as { count: number };
  assert.equal(weknoraCount.count, 2);
}));

test("failed staging is reported, blocks publish, and explicit retry recovers without duplicating documents", async () => withStore(async (store) => {
  seedProductDocument(store, "doc-1");
  seedProductDocument(store, "doc-2");
  let failing = true;
  const { writer, state } = countingWriter((key) => failing && key === "mig-2:doc-2");
  const ingestor = new WeKnoraIngestor(store, writer, () => new Date("2026-10-23T00:00:00.000Z"));
  const controller = makeController(store);

  const migration = await controller.createFromLocal({ actorId: 7, idempotencyKey: "mig-2", parserVersion: "parser-1" }, ingestor);
  assert.equal(migration.status, "staged");
  assert.equal(migration.report.failed, 1);
  assert.equal(migration.report.mapped, 1);
  const failedDocuments = migration.report.failedDocuments as Array<Record<string, unknown>>;
  assert.equal(failedDocuments.length, 1);
  assert.equal(failedDocuments[0].localDocumentId, "doc-2");
  assert.doesNotMatch(String(failedDocuments[0].error), /sk-migration-secret-1/);
  assert.throws(() => controller.validateAndPublish(migration.id, 7), /failed documents/);

  // A plain re-run leaves the failed document untouched.
  await controller.createFromLocal({ actorId: 7, idempotencyKey: "mig-2", parserVersion: "parser-1" }, ingestor);
  assert.equal(state.calls, 2);
  assert.equal((controller.get(migration.id)!.report.failed), 1);

  failing = false;
  const retried = await controller.createFromLocal({ actorId: 7, idempotencyKey: "mig-2", parserVersion: "parser-1", retry: true }, ingestor);
  assert.equal(state.calls, 3, "only the failed document is retried");
  assert.equal(retried.report.failed, 0);
  assert.equal(retried.report.mapped, 2);
  const dedupe = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_weknora_documents WHERE idempotency_key='mig-2:doc-2'").get() as { count: number };
  assert.equal(dedupe.count, 1);

  const published = controller.validateAndPublish(migration.id, 7);
  assert.equal(published.status, "published");
  assert.equal(controller.activeProductProvider(), "weknora");
  assert.equal(ingestor.retrievalKnowledgeIds().length, 2);
  const rollbackManifest = published.rollbackManifest as { previousProvider?: string; restoreProvider?: string; documentIds?: string[] };
  assert.equal(rollbackManifest.previousProvider, "relay_local");
  assert.equal(rollbackManifest.restoreProvider, "relay_local");
  assert.equal(rollbackManifest.documentIds?.length, 2);
}));

test("validateAndPublish rejects unstaged migrations, count mismatches and missing external ids", async () => withStore(async (store) => {
  seedProductDocument(store, "doc-1");
  const { writer } = countingWriter();
  const ingestor = new WeKnoraIngestor(store, writer, () => new Date("2026-10-23T00:00:00.000Z"));
  const controller = makeController(store);

  const unstaged = controller.create({ actorId: 7, idempotencyKey: "mig-raw", sourceManifest: { documents: [{ localDocumentId: "doc-1" }] } });
  assert.throws(() => controller.validateAndPublish(unstaged.id, 7), /staged/);

  const migration = await controller.createFromLocal({ actorId: 7, idempotencyKey: "mig-3", parserVersion: "parser-1" }, ingestor);
  store.db.prepare("DELETE FROM knowledge_migration_documents WHERE migration_id=?").run(migration.id);
  assert.throws(() => controller.validateAndPublish(migration.id, 7), /does not match/);

  const second = await controller.createFromLocal({ actorId: 7, idempotencyKey: "mig-4", parserVersion: "parser-1" }, ingestor);
  store.db.prepare("UPDATE knowledge_migration_documents SET external_document_id='pending:x' WHERE migration_id=?").run(second.id);
  assert.throws(() => controller.validateAndPublish(second.id, 7), /external document ids/);
}));

test("publish switches routing and rollback restores relay_local, restages documents and stays idempotent", async () => withStore(async (store) => {
  seedProductDocument(store, "doc-1");
  seedProductDocument(store, "doc-2");
  const { writer } = countingWriter();
  const ingestor = new WeKnoraIngestor(store, writer, () => new Date("2026-10-23T00:00:00.000Z"));
  const controller = makeController(store);

  const migration = await controller.createFromLocal({ actorId: 7, idempotencyKey: "mig-5", parserVersion: "parser-1" }, ingestor);
  controller.validateAndPublish(migration.id, 7);
  assert.equal(controller.activeProductProvider(), "weknora");
  assert.equal(ingestor.listRetrievalVisible().length, 2);

  const rolledBack = controller.rollback(migration.id, 7, "post-publish verification failed");
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(rolledBack.rollbackReason, "post-publish verification failed");
  assert.equal(controller.activeProductProvider(), "relay_local");
  assert.equal(ingestor.listRetrievalVisible().length, 0, "restaged documents leave retrieval scope");

  // Nothing is deleted: WeKnora control-plane rows, mapping rows and the local
  // Relay documents all remain.
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_weknora_documents").get() as { count: number }).count, 2);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_migration_documents WHERE migration_id=?").get(migration.id) as { count: number }).count, 2);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents WHERE kind='product_document'").get() as { count: number }).count, 2);
  const statuses = store.db.prepare("SELECT status FROM knowledge_weknora_documents ORDER BY id").all() as Array<{ status: string }>;
  assert.ok(statuses.every((row) => row.status === "staged"));
  const setting = store.db.prepare("SELECT value,previous_value,migration_id FROM knowledge_integration_settings WHERE key=?").get(PRODUCT_PROVIDER_SETTING_KEY) as Record<string, unknown>;
  assert.deepEqual(setting, { value: "relay_local", previous_value: "weknora", migration_id: migration.id });
  assert.ok(rolledBack.rollbackManifest.rolledBackAt);

  // Repeating the rollback is a no-op.
  const repeated = controller.rollback(migration.id, 7, "again");
  assert.equal(repeated.status, "rolled_back");
  assert.equal(repeated.rollbackReason, "post-publish verification failed");
  const rollbackAudits = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_audit WHERE entity_id=? AND action='knowledge.migration.rollback'").get(migration.id) as { count: number };
  assert.equal(rollbackAudits.count, 1);
  const providerAudits = store.db.prepare("SELECT action FROM knowledge_audit WHERE entity_type='integration_setting' ORDER BY rowid").all() as Array<{ action: string }>;
  assert.equal(providerAudits.length, 2);
}));

test("cleanupDryRun lists failed, deprecated and pending candidates without deleting anything", async () => withStore(async (store) => {
  seedProductDocument(store, "doc-1");
  seedProductDocument(store, "doc-2");
  const { writer } = countingWriter((key) => key === "mig-6:doc-2");
  const ingestor = new WeKnoraIngestor(store, writer, () => new Date("2026-10-23T00:00:00.000Z"));
  const controller = makeController(store);
  const migration = await controller.createFromLocal({ actorId: 7, idempotencyKey: "mig-6", parserVersion: "parser-1" }, ingestor);

  const staged = store.db.prepare("SELECT id FROM knowledge_weknora_documents WHERE status='staged'").get() as { id: string };
  ingestor.deprecate(staged.id, 7);
  const before = (store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_weknora_documents").get() as { count: number }).count;

  const report = controller.cleanupDryRun({ actorId: 7, migrationId: migration.id });
  assert.equal(report.dryRun, true);
  assert.equal(report.migrationId, migration.id);
  assert.equal(report.totals.failed, 1);
  assert.equal(report.totals.deprecated, 1);
  assert.equal(report.totals.pendingExternal, 1, "failed rows keep their pending external placeholder");
  assert.equal(report.totals.wouldDelete, 2);
  assert.equal(report.candidates.failedDocuments.length, 1);
  assert.equal(report.candidates.deprecatedDocuments.length, 1);
  assert.match(report.note, /no .* deleted/i);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_weknora_documents").get() as { count: number }).count, before, "dry run must not delete");
  const audit = store.db.prepare("SELECT details_json FROM knowledge_audit WHERE action='knowledge.migration.cleanup_dry_run'").get() as { details_json: string };
  assert.match(audit.details_json, /"dryRun":true/);

  const global = controller.cleanupDryRun({ actorId: 7 });
  assert.equal(global.migrationId, undefined);
  assert.equal(global.totals.wouldDelete, 2);
}));
