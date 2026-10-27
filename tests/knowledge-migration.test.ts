import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore, type KnowledgeStore } from "../src/knowledge/store.ts";
import { MigrationController, PRODUCT_PROVIDER_SETTING_KEY } from "../src/knowledge/migration-control.ts";
import { INTEGRATION_ROUTING_MIGRATION } from "../src/knowledge/migrations/038-integration-routing.ts";
import { WeKnoraIngestor, type WeKnoraDocumentWriter } from "../src/knowledge/weknora-ingest.ts";
import { runReleaseGates } from "../src/knowledge/release-gates.ts";
import { invalidateEngineProductMappings } from "../src/knowledge/knowledge-products.ts";

test("043 upgrades a real 042 database and preserves mapping identity and migration history", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-withdraw-upgrade-")); const path = join(root,"knowledge.db");
  let store = createKnowledgeStore({dbPath:path});
  try {
    seedProductDocument(store,"legacy-withdraw"); const controller=makeController(store); const {writer}=countingWriter();
    const migration=await controller.createFromLocal({actorId:7,idempotencyKey:"legacy-withdraw",parserVersion:"v1"},new WeKnoraIngestor(store,writer));
    controller.publish(migration.id,7);
    const history=store.db.prepare("SELECT * FROM knowledge_migrations WHERE id=?").get(migration.id);
    const before=store.db.prepare("SELECT * FROM knowledge_migration_documents").get() as Record<string,unknown>;
    for (const trigger of store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'knowledge_migration_%'").all() as {name:string}[]) store.db.exec(`DROP TRIGGER ${trigger.name}`);
    store.db.exec("CREATE TEMP TABLE old_mappings AS SELECT migration_id,local_document_id,document_id,idempotency_key,external_document_id,status,failure_code,failure_message,content_sha256,parser_version,created_at,updated_at FROM knowledge_migration_documents; DROP TABLE knowledge_migration_documents;");
    store.db.exec(INTEGRATION_ROUTING_MIGRATION.sql);
    store.db.exec("INSERT INTO knowledge_migration_documents SELECT * FROM old_mappings; DROP TABLE old_mappings; DELETE FROM schema_migrations WHERE version='043-migration-withdrawal'; UPDATE knowledge_weknora_documents SET status='deprecated';");
    assert.throws(()=>store.db.prepare("UPDATE knowledge_migration_documents SET status='withdrawn'").run(),/CHECK/);
    store.close(); store=createKnowledgeStore({dbPath:path});
    const after=store.db.prepare("SELECT * FROM knowledge_migration_documents").get() as Record<string,unknown>;
    assert.equal(after.status,"withdrawn"); assert.equal(after.withdrawal_reason,"schema043_source_deprecated"); assert.ok(after.withdrawn_at);
    for (const key of ["migration_id","local_document_id","document_id","idempotency_key","external_document_id","content_sha256","parser_version","created_at"]) assert.equal(after[key],before[key]);
    assert.deepEqual(store.db.prepare("SELECT * FROM knowledge_migrations WHERE id=?").get(migration.id),history);
    assert.deepEqual(store.db.pragma("foreign_key_check"),[]);
    assert.equal(runReleaseGates(store).checks.publishedVisibility.deprecatedVisible,0);
    assert.throws(()=>makeController(store).setProductProvider("weknora",7,{migrationId:migration.id}),/withdrawn/);
    store.close(); store=createKnowledgeStore({dbPath:path});
    const audits=store.db.prepare("SELECT details_json FROM knowledge_audit WHERE action='knowledge.migration.withdraw_document'").all() as {details_json:string}[];
    assert.equal(audits.length,1); assert.equal(JSON.parse(audits[0].details_json).previousStatus,"published");
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test("metadata invalidation and late mapping writes cannot restore a deprecated source", async () => withStore(async store => {
  seedProductDocument(store,"metadata-withdraw"); const controller=makeController(store); const {writer}=countingWriter();
  const migration=await controller.createFromLocal({actorId:7,idempotencyKey:"metadata-withdraw",parserVersion:"v1"},new WeKnoraIngestor(store,writer));
  controller.publish(migration.id,7); assert.equal(invalidateEngineProductMappings(store,["metadata-withdraw"]),1);
  assert.equal(controller.get(migration.id)?.mappingCounts.withdrawn,1);
  assert.throws(()=>store.db.prepare("UPDATE knowledge_migration_documents SET status='published'").run(),/Withdrawn/);
  const late=controller.create({actorId:7,idempotencyKey:"late-mapping",sourceManifest:{}});
  store.db.prepare("INSERT INTO knowledge_migration_documents(migration_id,local_document_id,document_id,idempotency_key,external_document_id,status,created_at,updated_at) SELECT ?,local_document_id,document_id,'late',external_document_id,'staged',created_at,updated_at FROM knowledge_migration_documents WHERE migration_id=?").run(late.id,migration.id);
  assert.equal(controller.get(late.id)?.mappingCounts.withdrawn,1);
  assert.equal(runReleaseGates(store).checks.publishedVisibility.deprecatedVisible,0);
}));

test("deprecation withdraws every migration mapping without rewriting historical reports", async () => withStore(async store => {
  seedProductDocument(store, "withdraw-doc");
  const {writer, state} = countingWriter(); const ingestor = new WeKnoraIngestor(store, writer); const controller = makeController(store);
  const first = await controller.createFromLocal({actorId: 7, idempotencyKey: "withdraw-published", parserVersion: "v1"}, ingestor);
  const published = controller.publish(first.id, 7);
  const second = await controller.createFromLocal({actorId: 7, idempotencyKey: "withdraw-staged", parserVersion: "v1"}, ingestor);
  const source = store.db.prepare("SELECT document_id FROM knowledge_migration_documents WHERE migration_id=?").get(first.id) as {document_id:string};
  const calls = state.calls;
  ingestor.deprecate(source.document_id, 7); ingestor.deprecate(source.document_id, 7);
  const rows = store.db.prepare("SELECT * FROM knowledge_migration_documents ORDER BY migration_id").all() as Array<Record<string,unknown>>;
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.status === "withdrawn" && row.withdrawn_at && row.external_document_id));
  assert.deepEqual(controller.get(first.id)?.report, published.report);
  assert.deepEqual(controller.get(first.id)?.sourceManifest, published.sourceManifest);
  assert.deepEqual(controller.get(first.id)?.rollbackManifest, published.rollbackManifest);
  assert.equal((controller.get(first.id) as any).mappingCounts.withdrawn, 1);
  assert.equal(runReleaseGates(store).checks.publishedVisibility.deprecatedVisible, 0);
  assert.equal(ingestor.listRetrievalVisible().length, 0);
  assert.throws(() => controller.publish(second.id, 7), /withdrawn/);
  assert.throws(() => controller.setProductProvider("weknora", 7, {migrationId:first.id}), /withdrawn/);
  const retry = await controller.createFromLocal({actorId:7,idempotencyKey:"withdraw-staged",parserVersion:"v1",retry:true},ingestor);
  assert.equal(state.calls, calls); assert.equal(retry.report.mapped, 0); assert.equal(retry.report.withdrawn, 1);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_audit WHERE action='knowledge.migration.withdraw_document'").get() as {n:number}).n, 2);
}));

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
      return { externalDocumentId: `ext-${input.idempotencyKey}`, knowledgeBaseId: "kb-1", parseStatus: "completed", externalChunkIds: [`chunk-${input.idempotencyKey}`] };
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

test("routing defaults to relay_local and switching to weknora requires a verified published migration", async () => withStore(async (store) => {
  const controller = makeController(store);
  assert.equal(controller.activeProductProvider(), "relay_local");
  assert.throws(() => controller.setProductProvider("weknora", 7), /published migration/);
  const empty = controller.create({ actorId: 7, idempotencyKey: "empty", sourceManifest: { documents: [] } });
  controller.markStaged(empty.id, { mapped: 0 }, 7);
  assert.throws(() => controller.publish(empty.id, 7), /no documents/);
  seedProductDocument(store, "route-doc");
  const { writer } = countingWriter();
  const migration = await controller.createFromLocal({ actorId: 7, idempotencyKey: "route-1", parserVersion: "v1" }, new WeKnoraIngestor(store, writer));
  assert.throws(() => controller.setProductProvider("weknora", 7, { migrationId: migration.id }), /published migration/);
  controller.publish(migration.id, 7);
  assert.equal(controller.activeProductProvider(), "weknora");
  assert.deepEqual(controller.setProductProvider("relay_local", 7), { provider: "relay_local", previousProvider: "weknora" });
  const switched = controller.setProductProvider("weknora", 7, { migrationId: migration.id });
  assert.deepEqual(switched, { provider: "weknora", previousProvider: "relay_local" });
  const setting = store.db.prepare("SELECT value,previous_value,migration_id,updated_by FROM knowledge_integration_settings WHERE key=?").get(PRODUCT_PROVIDER_SETTING_KEY) as Record<string, unknown>;
  assert.deepEqual(setting, { value: "weknora", previous_value: "relay_local", migration_id: migration.id, updated_by: 7 });
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

test("a different migration key reuses the deduplicated external document id", async () => withStore(async (store) => {
  seedProductDocument(store, "doc-1");
  const { writer } = countingWriter();
  const ingestor = new WeKnoraIngestor(store, writer, () => new Date("2026-10-23T00:00:00.000Z"));
  const controller = makeController(store);

  const first = await controller.createFromLocal({ actorId: 7, idempotencyKey: "mig-dedupe-a", parserVersion: "parser-1" }, ingestor);
  const second = await controller.createFromLocal({ actorId: 7, idempotencyKey: "mig-dedupe-b", parserVersion: "parser-1" }, ingestor);
  const firstDocument = (first.report.documents as Array<Record<string, unknown>>)[0];
  const secondDocument = (second.report.documents as Array<Record<string, unknown>>)[0];

  assert.equal(secondDocument.externalDocumentId, firstDocument.externalDocumentId);
  assert.doesNotThrow(() => controller.validateAndPublish(second.id, 7));
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


test("migration propagates document environment through manifest and staged mapping", async () => withStore(async (store) => {
  seedProductDocument(store, "env-doc");
  store.db.prepare("UPDATE knowledge_documents SET environment='test' WHERE id='env-doc'").run();
  const { writer } = countingWriter(); const ingestor = new WeKnoraIngestor(store, writer);
  const migration = await makeController(store).createFromLocal({ actorId: 7, idempotencyKey: "env", parserVersion: "v1", environment: "test" }, ingestor);
  assert.equal((migration.sourceManifest.documents as Array<Record<string, unknown>>)[0].environment, "test");
  const id = (migration.report.documents as Array<{ documentId: string }>)[0].documentId;
  assert.equal(ingestor.get(id)?.environment, "test");
}));

test("migration validates the sixth document and routing cannot bypass readiness", async () => withStore(async (store) => {
  for (let i = 1; i <= 6; i++) seedProductDocument(store, `doc-${i}`);
  const { writer } = countingWriter(); const ingestor = new WeKnoraIngestor(store, writer); const controller = makeController(store);
  const migration = await controller.createFromLocal({ actorId: 7, idempotencyKey: "six", parserVersion: "v1" }, ingestor);
  const sixth = store.db.prepare("SELECT document_id FROM knowledge_migration_documents WHERE migration_id=? AND local_document_id='doc-6'").get(migration.id) as { document_id: string };
  store.db.prepare("UPDATE knowledge_weknora_documents SET upstream_verified_at=NULL WHERE id=?").run(sixth.document_id);
  assert.throws(() => controller.validateAndPublish(migration.id, 7, { sampleSize: 1 }), /verified|readiness|completed/i);
  assert.equal(controller.activeProductProvider(), "relay_local");
  assert.equal(ingestor.listRetrievalVisible().length, 0);
  assert.throws(() => controller.publish(migration.id, 7), /verified|readiness|completed/i);
  store.db.prepare("UPDATE knowledge_migrations SET status='published' WHERE id=?").run(migration.id);
  assert.throws(() => controller.setProductProvider("weknora", 7, { migrationId: migration.id }), /verified|readiness|completed/i);
}));

test("migration rejects linkage identity, source hash and model generation mismatches", async () => withStore(async (store) => {
  seedProductDocument(store, "doc-1"); seedProductDocument(store, "doc-2");
  const { writer } = countingWriter(); const ingestor = new WeKnoraIngestor(store, writer); const controller = makeController(store);
  const migration = await controller.createFromLocal({ actorId: 7, idempotencyKey: "integrity", parserVersion: "v1" }, ingestor);
  const first = (migration.report.documents as Array<{ documentId: string; externalDocumentId: string }>)[0];
  store.db.prepare("UPDATE knowledge_migration_documents SET external_document_id='wrong' WHERE document_id=?").run(first.documentId);
  assert.throws(() => controller.validateAndPublish(migration.id, 7), /identity|external/i);
  store.db.prepare("UPDATE knowledge_migration_documents SET external_document_id=? WHERE document_id=?").run(first.externalDocumentId, first.documentId);
  store.db.prepare("UPDATE knowledge_weknora_documents SET raw_sha256='wrong' WHERE id=?").run(first.documentId);
  assert.throws(() => controller.validateAndPublish(migration.id, 7), /hash|source|manifest/i);
  store.db.prepare("UPDATE knowledge_weknora_documents SET raw_sha256='sha-doc-1' WHERE id=?").run(first.documentId);
  const binding = { knowledgeBaseId: "kb-1", providerId: "p", modelId: "e", dimensions: 32, indexVersion: 1 };
  store.db.prepare("UPDATE knowledge_weknora_documents SET model_provenance_json=?").run(JSON.stringify(binding));
  store.db.prepare("UPDATE knowledge_weknora_documents SET model_provenance_json=? WHERE id=?").run(JSON.stringify({ ...binding, indexVersion: 2 }), first.documentId);
  assert.throws(() => controller.validateAndPublish(migration.id, 7), /model|index|generation/i);
}));

test("migration stages only explicitly selected local document IDs", async () => withStore(async (store) => {
  for (const id of ["doc-1", "doc-2", "doc-3"]) seedProductDocument(store, id);
  const { writer, state } = countingWriter(); const ingestor = new WeKnoraIngestor(store, writer); const controller = makeController(store);
  const migration = await controller.createFromLocal({ actorId: 7, idempotencyKey: "selected-batch", parserVersion: "v1", localDocumentIds: ["doc-1", "doc-3"] }, ingestor);
  assert.equal(migration.report.total, 2);
  assert.equal(state.calls, 2);
  assert.deepEqual(state.keys.sort(), ["selected-batch:doc-1", "selected-batch:doc-3"]);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_weknora_documents WHERE id='doc-2'").get().n, 0);
  const repeated = await controller.createFromLocal({ actorId: 7, idempotencyKey: "selected-batch", parserVersion: "v1", localDocumentIds: ["doc-1", "doc-3"] }, ingestor);
  assert.equal(repeated.report.mapped, 2);
  assert.equal(state.calls, 2);
}));

test("explicit local document batches are not truncated by the generic limit", async () => withStore(async (store) => {
  for (const id of ["doc-1", "doc-2", "doc-3"]) seedProductDocument(store, id);
  const { writer, state } = countingWriter(); const ingestor = new WeKnoraIngestor(store, writer); const controller = makeController(store);
  const migration = await controller.createFromLocal({ actorId: 7, idempotencyKey: "selected-limit", parserVersion: "v1", limit: 1, localDocumentIds: ["doc-1", "doc-2", "doc-3"] }, ingestor);
  assert.equal(migration.report.total, 3);
  assert.equal(migration.report.mapped, 3);
  assert.equal(state.calls, 3);
}));

test("migration rerun stages only newly added source documents", async () => withStore(async (store) => {
  seedProductDocument(store, "doc-1"); seedProductDocument(store, "doc-2");
  const { writer, state } = countingWriter(); const ingestor = new WeKnoraIngestor(store, writer); const controller = makeController(store);
  const migration = await controller.createFromLocal({ actorId: 7, idempotencyKey: "incremental", parserVersion: "v1" }, ingestor);
  const originalMappings = store.db.prepare("SELECT local_document_id,document_id,external_document_id FROM knowledge_migration_documents WHERE migration_id=? ORDER BY local_document_id").all(migration.id);
  seedProductDocument(store, "doc-3");
  const updated = await controller.createFromLocal({ actorId: 7, idempotencyKey: "incremental", parserVersion: "v1" }, ingestor);
  assert.equal(updated.report.total, 3);
  assert.deepEqual(state.keys, ["incremental:doc-1", "incremental:doc-2", "incremental:doc-3"]);
  assert.deepEqual(store.db.prepare("SELECT local_document_id,document_id,external_document_id FROM knowledge_migration_documents WHERE migration_id=? AND local_document_id IN ('doc-1','doc-2') ORDER BY local_document_id").all(migration.id), originalMappings);
}));
