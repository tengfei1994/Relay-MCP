import assert from "node:assert/strict";
import test from "node:test";
import { buildKnowledgeScope, buildWeknoraSearchBody, knowledgeItemScope, knowledgeItemMatchesScope, productEngineDocumentState, withKnowledgeScope } from "../frontend/src/knowledge/integrated-search.ts";

test("WeKnora retrieval request carries the selected project scope", () => {
  assert.deepEqual(buildWeknoraSearchBody({ q: "provider probe", productVersion: "21.1", solution: "SampleManager", module: "Instruments", limit: "10" }, "e2e-browser"), {
    query: "provider probe",
    limit: 10,
    projectId: "e2e-browser",
    productVersion: "21.1",
    solution: "SampleManager",
    module: "Instruments",
  });
});


test("Product engine retrieval includes the selected environment without changing legacy callers", () => {
  const query = { q: " probe ", productVersion: "", solution: "", module: "", limit: "10" };
  assert.deepEqual(buildWeknoraSearchBody(query, "project-a", " test "), { query: "probe", limit: 10, projectId: "project-a", environment: "test" });
});


test("Document links preserve the source project and environment across navigation", () => {
  const selected = { projectId: "project-a", environment: "test" };
  const source = knowledgeItemScope({ project_id: "project-b", environment: "production" }, selected);
  assert.equal(withKnowledgeScope("/knowledge/product-docs?document=doc%2F1#section", source), "/knowledge/product-docs?document=doc%2F1&projectId=project-b&environment=production#section");
  assert.deepEqual(knowledgeItemScope({}, selected), selected);
  assert.deepEqual(buildKnowledgeScope({ projectId: 1, environment: "  " }), { projectId: "1" });
  assert.equal(withKnowledgeScope("/knowledge/integrated?tab=wiki", { projectId: " p1 ", environment: " test " }), "/knowledge/integrated?tab=wiki&projectId=p1&environment=test");
});

test("Publication readiness rejects legacy staged and incomplete upstream documents", () => {
  const ready = { status: "staged", upstream_parse_status: "completed", upstream_verified_at: "2026-10-25T00:00:00.000Z", external_chunk_ids_json: '["chunk-1"]', model_provenance_json: '{"providerId":"provider-a","modelId":"embed-model","dimensions":1024,"indexVersion":2}' };
  assert.equal(productEngineDocumentState({ status: "staged" }).canPublish, false);
  assert.equal(productEngineDocumentState({ ...ready, upstream_parse_status: "processing" }).canPublish, false);
  assert.equal(productEngineDocumentState({ ...ready, upstream_verified_at: null }).canPublish, false);
  assert.equal(productEngineDocumentState({ ...ready, upstream_verified_at: "invalid" }).canPublish, false);
  assert.equal(productEngineDocumentState({ ...ready, external_chunk_ids_json: "[]" }).canPublish, false);
  assert.equal(productEngineDocumentState({ ...ready, external_chunk_ids_json: "bad json" }).canPublish, false);
  assert.equal(productEngineDocumentState({ ...ready, status: "failed" }).canPublish, false);
  const state = productEngineDocumentState(ready);
  assert.equal(state.canPublish, true);
  assert.equal(state.chunkCount, 1);
  assert.equal(state.modelProvenance.indexVersion, 2);
  assert.equal(state.modelProvenance.modelId, "embed-model");
  assert.equal(productEngineDocumentState({ status: "staged", upstreamParseStatus: "completed", upstreamVerifiedAt: ready.upstream_verified_at, externalChunkIds: ["chunk-1"] }).canPublish, true);
});


test("Wiki source choices match the exact default or named environment", () => {
  assert.equal(knowledgeItemMatchesScope({ project_id: "p1", environment: null }, { projectId: "p1" }), true);
  assert.equal(knowledgeItemMatchesScope({ project_id: "p1", environment: "test" }, { projectId: "p1" }), false);
  assert.equal(knowledgeItemMatchesScope({ projectId: "p1", environment: "test" }, { projectId: "p1", environment: "test" }), true);
  assert.equal(knowledgeItemMatchesScope({ project_id: "p2", environment: "test" }, { projectId: "p1", environment: "test" }), false);
});
