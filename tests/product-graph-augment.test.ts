import test from "node:test";
import assert from "node:assert/strict";
import { augmentProductCandidates } from "../src/knowledge/product-graph-augment.js";
import type { ProductGraph } from "../src/knowledge/product-graph.js";

test("Product graph augmentation preserves lexical candidates and adds bounded neighbors", async () => {
  const graph: ProductGraph = {
    entities: [
      { id: "seed", canonicalKey: "pump", name: "Pump", kind: "component", documentId: "doc-seed", sourceLocator: "guide#pump", sourceSha256: "a", confidence: 0.95, extractionVersion: "test" },
      { id: "neighbor", canonicalKey: "cache", name: "Cache", kind: "setting", documentId: "doc-neighbor", sourceLocator: "guide#cache", sourceSha256: "a", confidence: 0.9, extractionVersion: "test" },
    ],
    relations: [{ id: "rel", fromEntityId: "seed", toEntityId: "neighbor", relationType: "configures", documentId: "doc-seed", sourceLocator: "guide#pump", sourceSha256: "a", confidence: 0.9, verified: true, extractionVersion: "test" }],
  };
  const result = await augmentProductCandidates(
    [{ id: "doc-seed", score: 0.8, matchReasons: ["keyword"] }],
    graph,
    "pump",
    { maxAdded: 1, loadCandidates: (ids) => ids.map((id) => ({ id, score: 0.2, matchReasons: [] })) },
  );
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ["doc-seed", "doc-neighbor"]);
  assert.equal(result.added, 1);
  assert.ok(result.candidates.find((candidate) => candidate.id === "doc-neighbor")?.matchReasons?.includes("Product graph neighbor"));
  assert.ok(result.candidates.some((candidate) => candidate.matchReasons?.includes("keyword")));
});
test("empty Product graph leaves vector/keyword candidates unchanged", async () => {
  const candidates = [{ id: "doc", score: 0.7, matchReasons: ["vector"] }];
  const result = await augmentProductCandidates(candidates, { entities: [], relations: [] }, "pump");
  assert.deepEqual(result.candidates, candidates);
  assert.equal(result.added, 0);
});
test("Product graph augmentation honors bounded hop depth", async () => {
  const graph: ProductGraph = {
    entities: [
      { id: "seed", canonicalKey: "pump", name: "Pump", kind: "component", documentId: "doc-seed", sourceLocator: "guide#pump", sourceSha256: "a", confidence: 1, extractionVersion: "test" },
      { id: "middle", canonicalKey: "cache", name: "Cache", kind: "setting", documentId: "doc-middle", sourceLocator: "guide#cache", sourceSha256: "a", confidence: 1, extractionVersion: "test" },
      { id: "far", canonicalKey: "workflow", name: "Workflow", kind: "procedure", documentId: "doc-far", sourceLocator: "guide#workflow", sourceSha256: "a", confidence: 1, extractionVersion: "test" },
    ],
    relations: [
      { id: "rel-1", fromEntityId: "seed", toEntityId: "middle", relationType: "related_to", documentId: "doc-seed", sourceLocator: "guide#pump", sourceSha256: "a", confidence: 1, verified: true, extractionVersion: "test" },
      { id: "rel-2", fromEntityId: "middle", toEntityId: "far", relationType: "related_to", documentId: "doc-middle", sourceLocator: "guide#cache", sourceSha256: "a", confidence: 1, verified: true, extractionVersion: "test" },
    ],
  };
  const load = (ids: string[]) => ids.map((id) => ({ id, score: 0.2, matchReasons: [] }));
  const seedCandidate = [{ id: "doc-seed", score: 0.8, matchReasons: [] }];
  const oneHop = await augmentProductCandidates(seedCandidate, graph, "pump", { maxHops: 1, maxAdded: 10, loadCandidates: load });
  assert.deepEqual(oneHop.candidates.map((candidate) => candidate.id), ["doc-seed", "doc-middle"]);
  const twoHop = await augmentProductCandidates(seedCandidate, graph, "pump", { maxHops: 2, maxAdded: 10, loadCandidates: load });
  assert.deepEqual(twoHop.candidates.map((candidate) => candidate.id), ["doc-seed", "doc-middle", "doc-far"]);
});
