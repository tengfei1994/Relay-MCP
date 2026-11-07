import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { importKnowledgeProducts } from "../src/knowledge/knowledge-products.js";
import { searchPublicProductChunks } from "../src/knowledge/product-search-v2.js";
import { CONFIRMED_MEMORY_MIGRATION } from "../src/knowledge/migrations/047-confirmed-memory.js";

test("isolated legacy backup, migration, classification and restore rehearsal", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-migration-rehearsal-"));
  const live = join(root, "live"), backup = join(root, "backup"), restored = join(root, "restored");
  const previousDb = process.env.DB_PATH;
  let store: KnowledgeStore | undefined;
  let appClient: Database.Database | undefined;
  try {
    for (const directory of [live, backup, restored]) mkdirSync(directory);
    const appPath = join(live, "app.db"), knowledgePath = join(live, "knowledge.db");
    const legacyApp = new Database(appPath);
    legacyApp.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, is_admin INTEGER DEFAULT 0, knowledge_enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT)");
    legacyApp.prepare("INSERT INTO users(id,username,password_hash,is_admin,knowledge_enabled) VALUES(1,'legacy','test',1,1)").run();
    legacyApp.close();

    store = new KnowledgeStore({ dbPath: knowledgePath, appDbPath: appPath });
    const docs = join(live, "docs"); mkdirSync(docs);
    writeFileSync(join(docs, "old.md"), "# Old manual\n\nLegacy calibration instructions.");
    const documentId = importKnowledgeProducts(store, { root: docs, sampleManagerVersion: "21" }).documents[0];
    store.db.prepare("UPDATE knowledge_documents SET project_id='1' WHERE id=?").run(documentId);
    store.upsertDocument({ id: "old-candidate", kind: "candidate", title: "Old candidate", body: "Historical material", lifecycle: "draft", projectId: "1", locator: "event:old", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    store.db.pragma("foreign_keys=OFF");
    store.db.exec(`DROP TRIGGER IF EXISTS knowledge_wiki_revision_sources_insert; DROP TABLE knowledge_wiki_revision_sources; DROP TRIGGER IF EXISTS knowledge_product_chunk_fts_delete; DROP TABLE knowledge_product_chunk_fts; DROP TABLE knowledge_memory_scope_reviews; DROP TABLE knowledge_legacy_candidate_reviews; DROP TABLE knowledge_memory_submissions; DROP TABLE knowledge_product_classifications; DROP TABLE knowledge_confirmed_memories; ${CONFIRMED_MEMORY_MIGRATION.sql} DELETE FROM schema_migrations WHERE version='055-knowledge-access';`);
    const insert = store.db.prepare(`INSERT INTO knowledge_confirmed_memories(id,memory_type,title,statement,details_json,project_id,scope_json,evidence_refs_json,source_json,confirmed_by,confirmed_at,audit_json,status,created_at,updated_at) VALUES(?,'Fact',?,'Legacy statement','{}','1',?,'[]','{}',1,'now','{}','confirmed','now','now')`);
    insert.run("project-old", "Project", JSON.stringify({ visibility: "project" }));
    insert.run("global-old", "Global", JSON.stringify({ visibility: "global" }));
    store.close(); store = undefined;

    // The engine, evidence and configuration here are synthetic fixture files;
    // the engine's own backup implementation is covered by its runtime tests.
    for (const [name, content] of [["evidence.dat", "fixture evidence"], ["engine.dat", "fixture engine state"], ["config.json", '{"fixture":true}']] as const) writeFileSync(join(live, name), content);
    for (const name of ["app.db", "knowledge.db"]) {
      const source = new Database(join(live, name), { readonly: true });
      try { await source.backup(join(backup, name)); } finally { source.close(); }
    }
    for (const name of ["evidence.dat", "engine.dat", "config.json"]) copyFileSync(join(live, name), join(backup, name));

    process.env.DB_PATH = appPath;
    const { db, runMigrations } = await import("../src/server/db/index.js");
    appClient = (db as any).session.client;
    runMigrations(); runMigrations();
    const user = appClient!.prepare("SELECT knowledge_enabled,account_status FROM users WHERE id=1").get() as any;
    assert.deepEqual(user, { knowledge_enabled: 1, account_status: "active" });
    store = new KnowledgeStore({ dbPath: knowledgePath, appDbPath: appPath });
    store.migrate();
    assert.deepEqual(store.db.prepare("SELECT id,memory_scope FROM knowledge_confirmed_memories ORDER BY id").all(), [
      { id: "global-old", memory_scope: "review" }, { id: "project-old", memory_scope: "project" },
    ]);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_documents WHERE id='old-candidate'").get().n, 1);
    assert.equal((await searchPublicProductChunks(store, { query: "calibration" })).references.length, 0);
    store.db.prepare("INSERT INTO knowledge_product_classifications(document_id,classification,reviewed_by,reason,updated_at) VALUES (?,'product',1,'Fixture review','now')").run(documentId);
    assert.equal((await searchPublicProductChunks(store, { query: "calibration" })).references.length, 1);
    store.close(); store = undefined;
    appClient!.close(); appClient = undefined;

    // Restore to an empty, separate directory, then prove the old state is intact.
    for (const name of ["app.db", "knowledge.db", "evidence.dat", "engine.dat", "config.json"]) copyFileSync(join(backup, name), join(restored, name));
    const restoredApp = new Database(join(restored, "app.db"), { readonly: true });
    const restoredKnowledge = new Database(join(restored, "knowledge.db"), { readonly: true });
    try {
      assert.equal(restoredApp.prepare("SELECT knowledge_enabled FROM users WHERE id=1").get().knowledge_enabled, 1);
      assert.equal(restoredKnowledge.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version='055-knowledge-access'").get().n, 0);
      assert.equal(restoredKnowledge.prepare("SELECT COUNT(*) AS n FROM knowledge_confirmed_memories").get().n, 2);
      assert.equal(restoredKnowledge.prepare("SELECT COUNT(*) AS n FROM knowledge_documents WHERE id='old-candidate'").get().n, 1);
      assert.equal(readFileSync(join(restored, "evidence.dat"), "utf8"), "fixture evidence");
      assert.equal(readFileSync(join(restored, "engine.dat"), "utf8"), "fixture engine state");
      assert.equal(readFileSync(join(restored, "config.json"), "utf8"), '{"fixture":true}');
    } finally { restoredApp.close(); restoredKnowledge.close(); }
    store = new KnowledgeStore({ dbPath: join(restored, "knowledge.db"), appDbPath: join(restored, "app.db") });
    assert.equal((await searchPublicProductChunks(store, { query: "calibration" })).references.length, 0, "restored legacy project data must return to the unclassified queue");
  } finally {
    store?.close(); appClient?.close();
    if (previousDb === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = previousDb;
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + requirePathSeparator()));
    rmSync(root, { recursive: true, force: true });
  }
});

function requirePathSeparator(): string { return process.platform === "win32" ? "\\" : "/"; }
