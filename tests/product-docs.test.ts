import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { importProductDocuments, productDocumentDiff } from "../src/knowledge/product-docs.ts";

test("product document import is idempotent and records ingest status", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-product-docs-"));
  const source = join(root, "docs"); mkdirSync(source); writeFileSync(join(source, "guide-21.1.md"), "# Guide\n\n## Install\nRun command A.\n", "utf8");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    const options = { root: source, sampleManagerVersion: "21.1", product: "SampleManager" };
    const first = importProductDocuments(store, options); const second = importProductDocuments(store, options);
    assert.equal(first.imported, 1); assert.equal(second.unchanged, 1);
    const run = store.db.prepare("SELECT status,imported,skipped,failed FROM knowledge_ingest_runs WHERE id = ?").get(first.runId) as Record<string, unknown>;
    assert.deepEqual(run, { status: "succeeded", imported: 1, skipped: 0, failed: 0 });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents WHERE kind='product_document'").get().count, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("product document diff detects section changes and moves", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-product-diff-")); const source = join(root, "docs"); mkdirSync(source);
  writeFileSync(join(source, "a.md"), "# Guide\n\n## Install\nRun command A.\n", "utf8");
  writeFileSync(join(source, "b.md"), "# Guide\n\n## Setup\nRun command A.\n\n## Extra\nNew text.\n", "utf8");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    const a = importProductDocuments(store, { root: source, sampleManagerVersion: "21.1", documentFamilyId: "guide" });
    assert.equal(a.imported, 2);
    const [left, right] = a.documents;
    const diff = productDocumentDiff(store, left, right);
    assert.ok(diff.changes.some((item) => item.status === "renamed" || item.status === "moved"));
    assert.ok(diff.changes.some((item) => item.status === "added"));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
