import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore, type KnowledgeStore } from "../src/knowledge/store.ts";
import { extractProductGraph, persistProductGraph, queryProductGraph, rebuildProductGraph } from "../src/knowledge/product-graph.ts";

function withStore(fn: (store: KnowledgeStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), "product-graph-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try { fn(store); } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seedDocument(store: KnowledgeStore, id: string, projectId?: string): void {
  store.db.prepare(`INSERT INTO knowledge_documents
    (id,kind,title,body,lifecycle,project_id,samplemanager_version,solution,module,environment,source_locator,source_sha256,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, "product_document", "Product Guide", "body", "approved", projectId ?? null, "21.3", "Core", "Forms", null, `docs/${id}.md`, `sha-${id}`, "2026-10-01", "2026-10-01");
  store.db.prepare(`INSERT INTO knowledge_product_documents
    (id,document_family_id,document_type,source_path,source_sha256,version,review_status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, `family-${id}`, "guide", `docs/${id}.md`, `sha-${id}`, "21.3", "approved", "2026-10-01", "2026-10-01");
}

test("Product graph extraction is deterministic and binds headings, links, metadata, and explicit relations", () => {
  const input = {
    documentId: "doc-a", title: "Forms Guide", text: "# Setup\n\nDepends on: Authentication\n\nRead [Deployment](deploy.md).",
    metadata: { stableIdentifiers: { helpId: "help-42" }, productVersion: "21.3", solution: "Core", module: "Forms" },
    sourceLocator: "docs/forms.md", sourceSha256: "abc123", projectId: "project-a", extractionVersion: "test-v1",
  };
  const first = extractProductGraph(input); const second = extractProductGraph(input);
  assert.deepEqual(first, second);
  assert.ok(first.entities.some((item) => item.kind === "heading" && item.name === "Setup"));
  assert.ok(first.entities.some((item) => item.kind === "reference" && item.name === "Deployment"));
  assert.ok(first.entities.some((item) => item.kind === "identifier" && item.name === "help-42"));
  assert.ok(first.relations.some((item) => item.relationType === "depends_on"));
  for (const item of [...first.entities, ...first.relations]) {
    assert.equal(item.documentId, "doc-a"); assert.equal(item.sourceLocator.startsWith("docs/forms.md"), true);
    assert.equal(item.sourceSha256, "abc123"); assert.equal(item.productVersion, "21.3"); assert.equal(item.projectId, "project-a"); assert.equal(item.extractionVersion, "test-v1");
  }
});

test("Product graph persistence is idempotent and does not write SampleManager relations", () => withStore((store) => {
  seedDocument(store, "doc-a", "project-a");
  const graph = extractProductGraph({ documentId: "doc-a", title: "Guide", body: "# Setup\n\nRequires: Authentication", sourceLocator: "docs/a.md", sourceSha256: "sha-a", productVersion: "21.3", projectId: "project-a" });
  const first = persistProductGraph(store, graph); const second = persistProductGraph(store, graph);
  assert.deepEqual(first, second);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_product_graph_entities").get() as { n: number }).n, graph.entities.length);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_product_graph_relations").get() as { n: number }).n, graph.relations.length);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_relations").get() as { n: number }).n, 0);
}));

test("Product graph query applies project ACL and never returns another project", () => withStore((store) => {
  seedDocument(store, "doc-a", "project-a"); seedDocument(store, "doc-b", "project-b");
  const graphA = extractProductGraph({ documentId: "doc-a", title: "A", text: "# A", sourceSha256: "sha-a", projectId: "project-a" });
  const graphB = extractProductGraph({ documentId: "doc-b", title: "B", text: "# B", sourceSha256: "sha-b", projectId: "project-b" });
  persistProductGraph(store, graphA); persistProductGraph(store, graphB);
  store.db.prepare("INSERT INTO knowledge_acl(project_id,user_id,can_read) VALUES ('project-a',7,1)").run();
  assert.throws(() => queryProductGraph(store, { actorId: 7, projectId: "project-b" }), /access denied/);
  const visible = queryProductGraph(store, { actorId: 7, projectId: "project-a" });
  assert.ok(visible.entities.length > 0); assert.ok(visible.entities.every((item) => item.projectId === "project-a"));
  const typed = queryProductGraph(store, { actorId: 7, projectId: "project-a", relationTypes: ["contains"] });
  assert.ok(typed.relations.length > 0); assert.ok(typed.relations.every((item) => item.relationType === "contains"));
  persistProductGraph(store, extractProductGraph({ documentId: "doc-a", title: "Stale scope", text: "# Stale", sourceSha256: "stale", projectId: undefined }));
  assert.equal(queryProductGraph(store, { actorId: 7, projectId: "project-a" }).entities.length, 0);
}));
test("Product graph rebuild is resumable and idempotent for existing source documents", () => withStore((store) => {
  seedDocument(store, "doc-a"); seedDocument(store, "doc-b");
  const first = rebuildProductGraph(store, { limit: 1, includeDeprecated: true });
  assert.equal(first.scanned, 1); assert.equal(first.rebuilt, 1); assert.equal(first.failed, 0); assert.equal(first.complete, false);
  const second = rebuildProductGraph(store, { limit: 1, afterDocumentId: first.lastDocumentId, includeDeprecated: true });
  assert.equal(second.scanned, 1); assert.equal(second.rebuilt, 1); assert.equal(second.failed, 0); assert.equal(second.complete, false);
  const third = rebuildProductGraph(store, { limit: 1, afterDocumentId: second.lastDocumentId, includeDeprecated: true });
  assert.equal(third.scanned, 0); assert.equal(third.rebuilt, 0); assert.equal(third.failed, 0); assert.equal(third.complete, true);
  const before = store.db.prepare("SELECT COUNT(*) AS entities FROM knowledge_product_graph_entities").get() as { entities: number };
  const replay = rebuildProductGraph(store, { includeDeprecated: true });
  assert.equal(replay.failed, 0); assert.equal((store.db.prepare("SELECT COUNT(*) AS entities FROM knowledge_product_graph_entities").get() as { entities: number }).entities, before.entities);
}));
