import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importKnowledgeProducts } from "../src/knowledge/knowledge-products.ts";
import { createKnowledgeStore } from "../src/knowledge/store.ts";

test("MadCap and Innovasys template changes with a directory move reuse the topic and revision", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-product-template-review-"));
  const firstRoot = join(root, "21.1");
  const nextRoot = join(root, "21.3");
  mkdirSync(join(firstRoot, "legacy"), { recursive: true });
  mkdirSync(join(nextRoot, "configuration"), { recursive: true });
  writeFileSync(join(firstRoot, "legacy", "entity-template.htm"), `<!doctype html><html><head><title>Entity Template</title><meta name="AIT_Topic_ID" content="shared-topic"></head><body><main><h1>Entity Template</h1><h2>Default Values</h2><a id="main"></a><p>The default value is active.</p></main></body></html>`, "utf8");
  writeFileSync(join(nextRoot, "configuration", "entity-template.html"), `<!doctype html><html><head><meta name="Title" content="Entity Template"><meta name="Microsoft.Help.Id" content="shared-topic"></head><body><div class="i-page-title-text">Entity Template</div><div class="i-section-heading"><span class="i-section-heading-text">Default Values</span></div><div id="main"><p>The default value is active.</p></div></body></html>`, "utf8");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    const first = importKnowledgeProducts(store, { root: firstRoot, sampleManagerVersion: "21.1", product: "SampleManager" });
    const second = importKnowledgeProducts(store, { root: nextRoot, sampleManagerVersion: "21.3", product: "SampleManager" });
    assert.equal(first.imported, 1);
    assert.equal(second.imported, 1);
    assert.equal(store.db.prepare("SELECT COUNT(DISTINCT normalized_content_sha256) AS count FROM knowledge_product_revisions").get().count, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_product_revisions").get().count, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_topics WHERE canonical_title='Entity Template'").get().count, 1);
    const bindings = store.db.prepare(`SELECT b.product_version,b.source_path,b.match_confidence,b.status,p.revision_id
      FROM knowledge_product_document_bindings b JOIN knowledge_product_documents p ON p.id=b.document_id
      ORDER BY b.product_version`).all() as Array<Record<string, unknown>>;
    assert.equal(bindings.length, 2);
    assert.equal(bindings[0].source_path, "legacy/entity-template.htm");
    assert.equal(bindings[1].source_path, "configuration/entity-template.html");
    assert.equal(bindings[0].revision_id, bindings[1].revision_id);
    assert.ok(bindings.every((binding) => Number(binding.match_confidence) < 0.8));
    assert.ok(bindings.every((binding) => binding.status === "pending_review"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("new bindings below the confidence threshold require review while confident bindings stay active", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-product-binding-review-"));
  const source = join(root, "docs");
  mkdirSync(source);
  writeFileSync(join(source, "unmapped.md"), "# Unmapped Guide\n\nConfigure the unmapped guide.\n", "utf8");
  writeFileSync(join(source, "mapped.md"), "# Mapped Guide\n\nConfigure the mapped guide.\n", "utf8");
  writeFileSync(join(source, "manifest.yaml"), "documents:\n  - path: mapped.md\n    documentFamilyId: mapped-guide\n", "utf8");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    const report = importKnowledgeProducts(store, { root: source, sampleManagerVersion: "21.3", product: "SampleManager" });
    assert.equal(report.imported, 2);
    const rows = store.db.prepare(`SELECT d.title,b.match_confidence,b.status FROM knowledge_product_document_bindings b
      JOIN knowledge_documents d ON d.id=b.document_id ORDER BY d.title`).all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      { title: "Mapped Guide", match_confidence: 0.95, status: "active" },
      { title: "Unmapped Guide", match_confidence: 0.7, status: "pending_review" },
    ]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
