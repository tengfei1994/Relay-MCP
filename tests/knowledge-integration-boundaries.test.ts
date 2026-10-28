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
import { ConfirmedMemoryService } from "../src/knowledge/confirmed-memory.ts";

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
    store.db.prepare("INSERT INTO knowledge_evidence(id,sha256,storage_path,mime_type,size_bytes,source_kind,project_id,source_locator,retention,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("evidence-1", "sha-1", "memory://evidence-1", "text/plain", 5, "log", "p1", "test:evidence-1", "standard", now);
    store.db.prepare("INSERT INTO knowledge_evidence_acl(evidence_id,project_id,created_at) VALUES (?,?,?)").run("evidence-1", "p1", now);
    new ConfirmedMemoryService(store).save({ id: "case-1", type: "Case", title: "Cache case", statement: "cache failure confirmed", details: { symptoms: "cache failure", rootCause: "stale cache", resolution: "refresh cache", verification: "reloaded" }, scope: { projectId: "p1", scopeType: "project", scopeKey: "p1", visibility: "project" }, evidenceRefs: ["evidence-1"], source: { kind: "manual", locator: "case:1" }, confirmedBy: 7, confirmedAt: now, audit: { action: "manual", reason: "reviewed" }, createdAt: now, updatedAt: now });
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
