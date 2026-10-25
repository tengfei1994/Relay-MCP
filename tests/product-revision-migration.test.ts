import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeStore, type KnowledgeStore } from "../src/knowledge/store.ts";
import { PRODUCT_REVISIONS_MIGRATION } from "../src/knowledge/migrations/028-product-revisions.ts";

const version = "046-product-revision-parser-identity";
const timestamp = "2026-10-25T00:00:00.000Z";
const revisionInsert = `INSERT INTO knowledge_product_revisions
  (id,normalized_content_sha256,raw_sha256,title,body,sections_json,parser_version,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`;

function legacyFixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-revision-migration-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  // Recreate the actual 028 schema, including its single-column UNIQUE, so
  // this exercises an upgrade with live references rather than a fresh DB.
  store.db.exec("DROP TABLE knowledge_product_revisions");
  store.db.exec(PRODUCT_REVISIONS_MIGRATION.sql.split("ALTER TABLE")[0]);
  store.db.prepare("DELETE FROM schema_migrations WHERE version=?").run(version);
  store.db.prepare(revisionInsert).run("old-html", "shared-hash", "raw-1", "Original", "CaseSensitive  CODE\nnext", '[{"anchor":"code"}]', "html-2", timestamp, timestamp);
  store.db.prepare(revisionInsert).run("old-md", "other-hash", null, "Markdown", "Keep\tSpacing", "[]", "markdown-1", timestamp, timestamp);
  for (const [id, revisionId] of [["doc-211", "old-html"], ["doc-213", "old-html"], ["doc-md", "old-md"], ["doc-unbound", null]]) {
    store.db.prepare(`INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,source_locator,created_at,updated_at)
      VALUES (?,'product_document','Original','Document body','approved','fixture',?,?)`).run(id, timestamp, timestamp);
    store.db.prepare(`INSERT INTO knowledge_product_documents
      (id,document_family_id,document_type,source_path,version,revision_id,created_at,updated_at)
      VALUES (?,'family','html',?,'21.3',?,?,?)`).run(id, `${id}.htm`, revisionId, timestamp, timestamp);
  }
  return { store, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } };
}
function snapshot(store: KnowledgeStore) {
  return {
    revisions: store.db.prepare("SELECT * FROM knowledge_product_revisions ORDER BY id").all(),
    documents: store.db.prepare("SELECT * FROM knowledge_product_documents ORDER BY id").all(),
  };
}
function assertLegacyUnchanged(store: KnowledgeStore, before: ReturnType<typeof snapshot>) {
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version), undefined);
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_product_revisions_046'").get(), undefined);
  assert.throws(() => store.db.prepare(revisionInsert).run("not-yet", "shared-hash", null, "New", "New body", "[]", "html-3", timestamp, timestamp), /UNIQUE constraint failed/);
}

test("046 preserves populated revision IDs, exact bodies and FK bindings while separating parser generations", () => {
  const fixture = legacyFixture(); const { store } = fixture;
  try {
    const before = snapshot(store);
    store.migrate();
    assert.deepEqual(snapshot(store), before);
    assert.ok(store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version));
    assert.equal(store.db.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(store.db.pragma("foreign_key_check"), []);
    const foreignKeys = store.db.pragma("foreign_key_list(knowledge_product_documents)") as Array<{ table: string; from: string; to: string }>;
    assert.ok(foreignKeys.some((fk) => fk.table === "knowledge_product_revisions" && fk.from === "revision_id" && fk.to === "id"));
    assert.throws(() => store.db.prepare("DELETE FROM knowledge_product_revisions WHERE id='old-html'").run(), /FOREIGN KEY constraint failed/);
    assert.throws(() => store.db.prepare("UPDATE knowledge_product_documents SET revision_id='missing' WHERE id='doc-211'").run(), /FOREIGN KEY constraint failed/);
    store.db.prepare(revisionInsert).run("new-html", "shared-hash", "raw-1", "Parsed again", "CaseSensitive  CODE\nnext", "[]", "html-3", timestamp, timestamp);
    store.db.prepare(`${revisionInsert} ON CONFLICT(normalized_content_sha256,parser_version) DO UPDATE SET title=excluded.title`)
      .run("ignored-id", "shared-hash", "raw-1", "Updated new parser", "ignored body", "[]", "html-3", timestamp, timestamp);
    assert.equal(store.db.prepare("SELECT title FROM knowledge_product_revisions WHERE id='new-html'").get().title, "Updated new parser");
    assert.deepEqual(store.db.prepare("SELECT * FROM knowledge_product_revisions WHERE id='old-html'").get(), before.revisions.find((row: any) => row.id === "old-html"));
    assert.throws(() => store.db.prepare(revisionInsert).run("duplicate", "shared-hash", null, "Duplicate", "Body", "[]", "html-3", timestamp, timestamp), /UNIQUE constraint failed/);
    store.migrate();
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_product_revisions").get().count, 3);
    assert.deepEqual(store.db.pragma("foreign_key_check"), []);
  } finally { fixture.cleanup(); }
});

test("046 marker failure rolls back the rebuilt parent and restores FK enforcement before retry", () => {
  const fixture = legacyFixture(); const { store } = fixture;
  try {
    const before = snapshot(store);
    store.db.exec(`CREATE TRIGGER reject_046 BEFORE INSERT ON schema_migrations WHEN NEW.version='${version}'
      BEGIN SELECT RAISE(ABORT,'injected marker failure'); END`);
    assert.throws(() => store.migrate(), /injected marker failure/);
    assertLegacyUnchanged(store, before);
    assert.deepEqual(store.db.pragma("foreign_key_check"), []);
    store.db.exec("DROP TRIGGER reject_046");
    store.migrate();
    assert.deepEqual(snapshot(store), before);
    assert.ok(store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version));
  } finally { fixture.cleanup(); }
});

test("046 rejects pre-existing invalid revision refs atomically without silently dropping or repairing data", () => {
  const fixture = legacyFixture(); const { store } = fixture;
  try {
    store.db.pragma("foreign_keys = OFF");
    store.db.prepare("UPDATE knowledge_product_documents SET revision_id='missing' WHERE id='doc-md'").run();
    store.db.pragma("foreign_keys = ON");
    const before = snapshot(store);
    assert.throws(() => store.migrate(), /foreign key.*validation/i);
    assertLegacyUnchanged(store, before);
    assert.equal((store.db.pragma("foreign_key_check") as unknown[]).length, 1);
    store.db.prepare("UPDATE knowledge_product_documents SET revision_id='old-md' WHERE id='doc-md'").run();
    store.migrate();
    assert.deepEqual(store.db.pragma("foreign_key_check"), []);
  } finally { fixture.cleanup(); }
});


test("046 refuses a nested transaction before changing FK mode or schema", () => {
  const fixture = legacyFixture(); const { store } = fixture;
  try {
    const before = snapshot(store);
    assert.throws(() => store.db.transaction(() => store.migrate())(), /top-level transaction/);
    assertLegacyUnchanged(store, before);
    store.migrate();
    assert.deepEqual(snapshot(store), before);
  } finally { fixture.cleanup(); }
});
