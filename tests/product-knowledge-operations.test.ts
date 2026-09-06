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
