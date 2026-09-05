import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { searchKnowledge } from "../src/knowledge/retriever.ts";
import { DeterministicEmbeddingProvider } from "../src/knowledge/providers.ts";
import { EvidenceStore } from "../src/knowledge/evidence-store.ts";

test("hybrid retrieval caches vectors only for ACL/version-filtered documents and records run", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-hybrid-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    store.grantAcl("p1", 7, true);
    const now = new Date().toISOString();
    store.upsertDocument({ id: "d1", kind: "case", title: "Form cache", body: "FormsBin stale cache", lifecycle: "verified", projectId: "p1", sampleManagerVersion: "21.1", locator: "case:d1", createdAt: now, updatedAt: now });
    const evidence = new EvidenceStore(store, join(root, "evidence"));
    const linked = evidence.put({ content: Buffer.from("proof"), mimeType: "text/plain", sourceKind: "test", projectId: "p1", locator: "test:proof" });
    store.db.prepare("INSERT INTO knowledge_entity_evidence(entity_type,entity_id,evidence_id,created_at) VALUES (?,?,?,?)").run("case", "d1", linked.id, now);
    store.upsertDocument({ id: "d2", kind: "case", title: "Other", body: "FormsBin stale cache", lifecycle: "verified", projectId: "p2", locator: "case:d2", createdAt: now, updatedAt: now });
    const result = await searchKnowledge(store, { userId: 7, projectId: "p1", query: "FormsBin cache", sampleManagerVersion: "21.1", providers: { embedding: new DeterministicEmbeddingProvider() } });
    assert.equal(result.results.length, 1); assert.equal(result.results[0].id, "d1"); assert.equal(result.degraded, false);
    assert.deepEqual(result.results[0].evidenceRefs, [linked.id]);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_embeddings").get().n, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_retrieval_runs WHERE id = ?").get(result.retrievalRunId).n, 1);
  } finally { store.close(); }
});

test("retrieval degrades to FTS when no embedding provider is configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-hybrid-fts-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    store.grantAcl("p1", 7, true); const now = new Date().toISOString();
    store.upsertDocument({ id: "d1", kind: "case", title: "Form", body: "cache", lifecycle: "verified", projectId: "p1", locator: "case:d1", createdAt: now, updatedAt: now });
    const result = await searchKnowledge(store, { userId: 7, projectId: "p1", query: "cache", providers: { embedding: undefined } });
    assert.equal(result.degraded, true); assert.equal(result.results[0].id, "d1");
  } finally { store.close(); }
});
