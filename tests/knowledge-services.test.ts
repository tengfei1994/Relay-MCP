import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { importCasebook, importContextFacts } from "../src/knowledge/importer.ts";
import { searchKnowledge } from "../src/knowledge/retriever.ts";
import { extractSampleManagerRelations, persistRelations, queryRelations } from "../src/knowledge/relations.ts";

test("casebook and legacy context imports are idempotent and preserve unresolved facts", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-services-"));
  const casebook = join(root, "casebook"); mkdirSync(casebook);
  writeFileSync(join(casebook, "sample.md"), "---\nid: CASE-1\ntitle: Form cache\nkind: case\nstatus: verified\nscope:\n  samplemanager: 21.1\n---\n事实：FormsBin cache is stale.\n");
  const facts = join(root, "facts.jsonl"); writeFileSync(facts, JSON.stringify({ text: "Keep FormsBin evidence", projectName: "Missing" }) + "\n");
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    const first = importCasebook(store, { root: casebook, projectId: "p1" });
    const second = importCasebook(store, { root: casebook, projectId: "p1" });
    const factReport = importContextFacts(store, { files: [facts], userId: 7 });
    assert.equal(first.imported, 1); assert.equal(second.skipped, 1); assert.equal(factReport.unresolved, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents").get().count, 1);
    assert.equal(store.db.prepare("SELECT status FROM knowledge_facts").get().status, "unresolved");
  } finally { store.close(); }
});

test("retrieval applies ACL, lifecycle and version filters before returning explainable results", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-search-")); const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    store.grantAcl("p1", 7, true);
    const now = new Date().toISOString();
    store.upsertDocument({ id: "d1", kind: "case", title: "Form cache", body: "FormsBin stale cache", lifecycle: "verified", projectId: "p1", sampleManagerVersion: "21.1", locator: "casebook:d1", createdAt: now, updatedAt: now });
    store.upsertDocument({ id: "d2", kind: "case", title: "Deprecated cache", body: "FormsBin stale cache", lifecycle: "deprecated", projectId: "p1", sampleManagerVersion: "21.1", locator: "casebook:d2", createdAt: now, updatedAt: now });
    const result = await searchKnowledge(store, { userId: 7, projectId: "p1", query: "FormsBin cache", sampleManagerVersion: "21.1" });
    assert.equal(result.results.length, 1); assert.equal(result.results[0].id, "d1"); assert.ok(result.results[0].matchReasons.length > 0);
  } finally { store.close(); }
});

test("SampleManager relation extraction is deterministic and source-backed", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-relations-")); const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    store.grantAcl("p1", 7, true);
    const edges = extractSampleManagerRelations({ content: '<Form name="Instrument"><Control name="Status" property="Mandatory"/></Form>', sourceLocator: "Forms/Instrument.xml", kind: "form-xml" });
    assert.ok(edges.length >= 2); assert.ok(persistRelations(store, edges, "p1") >= 2);
    const result = queryRelations(store, { userId: 7, projectId: "p1", relationType: "form_control" });
    assert.equal(result.length, 1); assert.equal(result[0].sourceLocator, "Forms/Instrument.xml"); assert.equal(result[0].verified, true);
  } finally { store.close(); }
});

