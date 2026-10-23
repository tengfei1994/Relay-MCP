import assert from "node:assert/strict";
import test from "node:test";
import { ContextPackService, buildContextPack } from "../src/knowledge/context-pack.ts";
import type { KnowledgeReference } from "../src/knowledge/weknora.ts";

function ref(partial: Partial<KnowledgeReference>): KnowledgeReference {
  return { provider: "weknora", documentId: "d", retrievalRunId: "r", ...partial };
}

const intent = {
  objective: "Diagnose LIMS form failure",
  actions: ["diagnose"],
  phase: "diagnosis",
  projectId: "p1",
  sampleManagerVersion: "21.3",
  solution: "Core",
  module: "Forms",
  knowledgeMode: "retrieve_and_capture",
};

test("Context Pack filters authoritative docs by resolved ACL and intent version/module", () => {
  const service = new ContextPackService();
  const pack = service.build({
    intent,
    acl: { documentIds: ["d1", "d2", "d3", "d5"] },
    authoritativeDocs: [
      ref({ documentId: "d1", version: "21.3", module: "Forms", score: 0.5 }),
      ref({ documentId: "d2", version: "21.1", module: "Forms", score: 0.9 }),
      ref({ documentId: "d3", version: "21.3", module: "Inventory", score: 0.8 }),
      ref({ documentId: "d4", version: "21.3", module: "Forms", score: 0.99 }),
      ref({ documentId: "d5", score: 0.1 }),
    ],
  });
  assert.deepEqual(pack.authoritativeDocs.map((item) => item.documentId), ["d1", "d5"]);
  assert.equal(pack.conflicts.aclFiltered, 1, "d4 is outside the resolved ACL");
  assert.equal(pack.conflicts.versionFiltered, 1, "d2 targets version 21.1");
  assert.equal(pack.conflicts.scopeFiltered, 1, "d3 targets another module");
  assert.equal(pack.intent?.sampleManagerVersion, "21.3");
  assert.equal(pack.counts.authoritativeDocs, 2);
});

test("Context Pack counts cross-version conflicts on the same topic deterministically", () => {
  const pack = buildContextPack({
    authoritativeDocs: [
      ref({ documentId: "d1", topicId: "t1", version: "21.1" }),
      ref({ documentId: "d2", topicId: "t1", version: "21.3" }),
      ref({ documentId: "d3", topicId: "t1", version: "22.1" }),
      ref({ documentId: "d4", topicId: "t2", version: "21.3" }),
    ],
  });
  assert.equal(pack.conflicts.versionConflicts, 2);
});

test("Context Pack propagates degraded provider state and keeps Relay-owned sections intact", () => {
  const pack = buildContextPack({
    provider: "weknora",
    authoritativeDocs: [ref({ documentId: "d1" })],
    confirmedKnowledge: [{ id: "case-1", statement: "known" }],
    candidates: [{ id: "candidate-1", status: "draft" }],
    currentFacts: [{ id: "fact-1", text: "current" }],
    degraded: { productKnowledge: "timeout" },
  });
  assert.equal(pack.provider, "weknora");
  assert.equal(pack.degraded.productKnowledge, "timeout");
  assert.equal(pack.confirmedKnowledge.length, 1);
  assert.equal((pack.candidates[0] as { status: string }).status, "draft");
  assert.equal(pack.currentFacts.length, 1);
});

test("capture-only sessions omit retrieval sections and mark the omission", () => {
  const pack = buildContextPack({
    intent: { ...intent, knowledgeMode: "capture" },
    authoritativeDocs: [ref({ documentId: "d1" })],
    currentFacts: [{ id: "fact-1" }],
  });
  assert.equal(pack.authoritativeDocs.length, 0);
  assert.equal(pack.degraded.productKnowledge, "skipped_capture_only");
  assert.equal(pack.currentFacts.length, 1);
});

test("intent matching boosts version-aligned authoritative docs in ranking", () => {
  const pack = buildContextPack({
    intent: { ...intent, sampleManagerVersion: "21.3" },
    authoritativeDocs: [
      ref({ documentId: "no-version", score: 0.5 }),
      ref({ documentId: "aligned", version: "21.3", score: 0.5 }),
    ],
  });
  assert.equal(pack.authoritativeDocs[0].documentId, "aligned");
});

test("per-section limits are enforced", () => {
  const docs = Array.from({ length: 10 }, (_, index) => ref({ documentId: `d${index}`, score: index / 100 }));
  const pack = buildContextPack({ authoritativeDocs: docs, maxItemsPerSection: 3 });
  assert.equal(pack.authoritativeDocs.length, 3);
  assert.equal(pack.counts.authoritativeDocs, 3);
});
