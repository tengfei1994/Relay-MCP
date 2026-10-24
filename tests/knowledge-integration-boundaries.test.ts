import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { KnowledgeRepository } from "../src/knowledge/repository.ts";
import { loadRelayContextSources } from "../src/knowledge/context-sources.ts";
import { resolveRetrievalProjectId } from "../src/knowledge/weknora-scope.ts";
import { canReadTopicBinding } from "../src/knowledge/topic-access.ts";

test("WeKnora retrieval requires an explicit project or a Work Session scope", () => {
  assert.throws(() => resolveRetrievalProjectId({}), /projectId or workSessionId/i);
  assert.equal(resolveRetrievalProjectId({ projectId: "p1", sessionProjectId: "p2" }), "p1");
  assert.equal(resolveRetrievalProjectId({ sessionProjectId: "p2" }), "p2");
});

test("Context Pack sources include ACL-scoped Relay memory, candidates and facts", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-context-sources-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    store.grantAcl("p1", 7, true);
    const repository = new KnowledgeRepository(store);
    const now = "2026-10-23T00:00:00.000Z";
    repository.saveCase({ id: "case-1", kind: "case", title: "Cache case", body: "cache failure confirmed", lifecycle: "approved", projectId: "p1", locator: "case:1", createdAt: now, updatedAt: now } as any);
    repository.saveCandidate({ id: "candidate-1", kind: "candidate", title: "Cache candidate", body: "cache candidate", lifecycle: "draft", projectId: "p1", locator: "candidate:1", createdAt: now, updatedAt: now } as any);
    repository.saveFact({ id: "fact-1", userId: 7, projectId: "p1", text: "cache fact", tags: ["cache"], locator: "fact:1", status: "resolved", createdAt: now } as any);

    const sources = await loadRelayContextSources({ store, userId: 7, projectId: "p1", query: "cache", limit: 10 });
    assert.deepEqual(sources.confirmedKnowledge.map((item: any) => item.id), ["case-1"]);
    assert.deepEqual(sources.candidates.map((item: any) => item.id), ["candidate-1"]);
    assert.deepEqual(sources.currentFacts.map((item: any) => item.id), ["fact-1"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("topic bindings are readable only through the bound project ACL", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-topic-acl-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    store.grantAcl("p1", 7, true);
    assert.equal(canReadTopicBinding(store, 7, "p1"), true);
    assert.equal(canReadTopicBinding(store, 7, "p2"), false);
    assert.equal(canReadTopicBinding(store, 7, undefined), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
