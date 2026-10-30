import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../frontend/src/api/client.ts";

test("Product and Wiki detail, revision and mutation requests retain their source scope", async () => {
  const calls: { url: string; method: string; body: any }[] = [];
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), method: options?.method ?? "GET", body: options?.body ? JSON.parse(String(options.body)) : undefined }); return new Response("{}", { status: 200 }); };
  try {
    const scope = { projectId: "project-a", environment: "test" };
    await api.productDocumentGlobal("doc/1", scope);
    await api.knowledgeWikiPage("wiki/1", scope);
    await api.knowledgeWikiRevisions("wiki/1", scope);
    await api.knowledgeWikiDiff("wiki/1", 1, 2, scope);
    await api.knowledgeWikiEdit("wiki/1", { body: "updated", reason: "review" }, scope);
    await api.knowledgeWikiPublish("wiki/1", "review", scope);
    await api.knowledgeWikiDeprecate("wiki/1", "review", scope);
    await api.knowledgeWikiRollback("wiki/1", 1, "review", scope);
    for (const call of calls.slice(0, 4)) {
      const url = new URL(call.url, "http://relay.test");
      assert.equal(url.searchParams.get("projectId"), "project-a", call.url);
      assert.equal(url.searchParams.get("environment"), "test", call.url);
      assert.match(url.pathname, /(?:doc|wiki)%2F1/);
    }
    const diff = new URL(calls[3].url, "http://relay.test");
    assert.equal(diff.searchParams.get("fromRevision"), "1");
    assert.equal(diff.searchParams.get("toRevision"), "2");
    for (const call of calls.slice(4, 8)) {
      assert.equal(call.body.projectId, "project-a");
      assert.equal(call.body.environment, "test");
      assert.equal(call.body.reason, "review");
    }
    await api.productDocumentsList(scope);
    await api.productDocumentSearch({ ...scope, q: "probe" });
    await api.knowledgeWikiDirectory(scope);
    await api.knowledgeWikiGeneration(scope);
    for (const call of calls.slice(8, 13)) {
      const url = new URL(call.url, "http://relay.test");
      assert.equal(url.searchParams.get("projectId"), "project-a");
      assert.equal(url.searchParams.get("environment"), "test");
    }
    await api.knowledgeWikiGenerationStart({ ...scope, retryFailed: true });
    assert.equal(calls[12].body.projectId, "project-a");
    assert.equal(calls[12].body.environment, "test");
    assert.equal(calls[12].body.retryFailed, true);
    await api.knowledgeWikiCreate({ ...scope, title: "Wiki", sourceRefs: ["source-1"] });
    await api.knowledgeSearch({ ...scope, query: "probe" });
    for (const call of calls.slice(13)) {
      assert.equal(call.body.projectId, "project-a");
      assert.equal(call.body.environment, "test");
    }
    assert.deepEqual(calls.find((call) => Array.isArray(call.body?.sourceRefs))?.body.sourceRefs, ["source-1"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as any).localStorage;
  }
});


test("Candidate scope review sends the observed Session revision and explicit reason", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const calls: { url: string; body: any }[] = [];
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), body: JSON.parse(String(options?.body)) }); return new Response("{}", { status: 200 }); };
  try {
    await api.knowledgeCandidateInsightReviewScope("insight/legacy", "Review the current Session scope", "2026-10-25T10:00:00.000Z");
    assert.equal(calls[0].url, "/api/knowledge/candidate-insights/insight%2Flegacy/review-scope");
    assert.deepEqual(calls[0].body, { reason: "Review the current Session scope", expectedSessionUpdatedAt: "2026-10-25T10:00:00.000Z" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as any).localStorage;
  }
});
