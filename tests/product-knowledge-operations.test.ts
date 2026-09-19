import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { diffKnowledgeProducts, importKnowledgeProducts, searchKnowledgeProducts, updateProductDocumentLifecycle } from "../src/knowledge/knowledge-products.ts";

test("knowledge product operations preserve old revisions and search globally", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-product-operations-"));
  const source = join(root, "docs"); mkdirSync(source);
  const file = join(source, "stability-guide.md");
  writeFileSync(file, "# Stability Guide\n\n## Setup\nRun command A.\n", "utf8");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    const first = importKnowledgeProducts(store, { root: source, sampleManagerVersion: "21.1", product: "SampleManager", documentFamilyId: "stability-guide" });
    assert.equal(first.imported, 1);
    const oldId = first.documents[0];
    writeFileSync(file, "# Stability Guide\n\n## Setup\nRun command B.\n", "utf8");
    const second = importKnowledgeProducts(store, { root: source, sampleManagerVersion: "21.1", product: "SampleManager", documentFamilyId: "stability-guide" });
    assert.equal(second.updated, 1);
    assert.notEqual(second.documents[0], oldId);
    assert.equal(store.db.prepare("SELECT lifecycle FROM knowledge_documents WHERE id=?").get(oldId).lifecycle, "deprecated");
    const found = searchKnowledgeProducts(store, { query: "command B", sampleManagerVersion: "21.1" });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, second.documents[0]);
    const diff = diffKnowledgeProducts(store, oldId, second.documents[0]);
    assert.ok(diff.changes.some((item) => item.status === "modified" && item.textDiff?.some((part) => part.added)));
    const published = updateProductDocumentLifecycle(store, second.documents[0], "approved");
    assert.equal(published.changed, false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("manifest rules provide per-document metadata and confidence reasons", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-product-manifest-"));
  const source = join(root, "docs"); mkdirSync(source);
  writeFileSync(join(source, "api.md"), "# API Reference\n\n## Commands\nrun vgl\n", "utf8");
  writeFileSync(join(source, "manifest.yaml"), "sampleManagerVersion: 21.2\ndocuments:\n  - path: api.md\n    module: Quality\n    documentType: reference\n    documentFamilyId: api-family\n", "utf8");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    const report = importKnowledgeProducts(store, { root: source, sampleManagerVersion: "" });
    assert.equal(report.imported, 1);
    const row = store.db.prepare("SELECT d.module,p.document_type,p.document_family_id,p.metadata_json FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE d.id=?").get(report.documents[0]) as Record<string, unknown>;
    assert.equal(row.module, "Quality"); assert.equal(row.document_type, "reference"); assert.equal(row.document_family_id, "api-family");
    assert.match(String(row.metadata_json), /document family supplied/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("HTML help templates preserve semantic headings and structured sections", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-product-html-"));
  const source = join(root, "docs"); mkdirSync(source);
  writeFileSync(join(source, "madcap.htm"), `<!doctype html><html><head><title>Entity Template</title><meta name="AIT_Topic_ID" content="1234"></head><body><nav>Navigation</nav><main><h1>Entity Template</h1><h2>Default Values</h2><p>The default value is active.</p><table><tr><th>Property</th><th>Value</th></tr><tr><td>Status</td><td>Active</td></tr></table></main><footer>Copyright</footer></body></html>`, "utf8");
  writeFileSync(join(source, "innovasys.html"), `<!doctype html><html><head><meta name="Title" content="Form Designer"><meta name="Microsoft.Help.Id" content="form-123"></head><body><div class="i-page-title-text">Form Designer</div><div class="i-section-heading"><span class="i-section-heading-text">Creating a Form</span></div><div id="main"><p>Create a form.</p><pre>public void CreateForm()</pre></div></body></html>`, "utf8");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    const report = importKnowledgeProducts(store, { root: source, sampleManagerVersion: "21.3", product: "SampleManager" });
    assert.equal(report.imported, 2);
    const rows = store.db.prepare("SELECT d.title,d.body,p.sections_json,p.metadata_json FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id ORDER BY d.title").all() as Array<Record<string, string>>;
    assert.equal(rows.length, 2);
    assert.match(rows[0].body, /^# Entity Template/m);
    assert.match(rows[0].body, /## Default Values/);
    assert.ok(JSON.parse(rows[0].sections_json).length >= 2);
    assert.match(rows[0].metadata_json, /normalizedContentSha256/);
    assert.match(rows[0].metadata_json, /AIT_Topic_ID/i);
    assert.match(rows[1].body, /^# Form Designer/m);
    assert.match(rows[1].body, /## Creating a Form/);
    assert.ok(JSON.parse(rows[1].sections_json).length >= 2);
    assert.match(rows[1].body, /Create a form/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_topics").get().count, 2);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_product_document_bindings").get().count, 2);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("equivalent content across versions reuses one revision and topic", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-product-revision-")); const firstRoot = join(root, "21.1"); const nextRoot = join(root, "21.3"); mkdirSync(firstRoot); mkdirSync(nextRoot);
  const html = `<html><head><meta name="AIT_Topic_ID" content="entity-template" /></head><body><h1>Entity Template</h1><p>Configure the entity template.</p></body></html>`;
  // Create the moved path after the first write so the test mirrors a TOC/path move.
  mkdirSync(join(firstRoot, "old"), { recursive: true }); writeFileSync(join(firstRoot, "old", "entity-template.html"), html, "utf8"); mkdirSync(join(nextRoot, "config"), { recursive: true }); writeFileSync(join(nextRoot, "config", "entity-template.html"), html, "utf8");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    const a = importKnowledgeProducts(store, { root: firstRoot, sampleManagerVersion: "21.1", product: "SampleManager" }); const b = importKnowledgeProducts(store, { root: nextRoot, sampleManagerVersion: "21.3", product: "SampleManager" });
    assert.equal(a.imported, 1); assert.equal(b.imported, 1); assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_product_revisions").get().n, 1); assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_topics WHERE canonical_title='Entity Template'").get().n, 1); assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_product_document_bindings WHERE topic_id=(SELECT id FROM knowledge_topics WHERE canonical_title='Entity Template')").get().n, 2);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
