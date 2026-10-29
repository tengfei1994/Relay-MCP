import assert from "node:assert/strict";
import test from "node:test";
import { classifyProductSearchIntent, PRODUCT_SEARCH_INTENT_PRECEDENCE, routeProductSearchIntent, type ProductSearchIntentInput } from "../src/knowledge/search-intent.ts";

const baseIntent: ProductSearchIntentInput["intent"] = {
  objective: "Understand product behavior",
  actions: ["understand"],
  phase: "explore",
};

test("search intent precedence routes version comparisons before document cues", () => {
  const result = routeProductSearchIntent({
    query: "Compare the 21.1 and 21.2 user guides",
    intent: baseIntent,
  });
  assert.equal(result.intent, "version_comparison");
  assert.equal(result.graphExpansion.enabled, true);
  assert.equal(result.graphExpansion.maxHops, 1);
  assert.deepEqual(PRODUCT_SEARCH_INTENT_PRECEDENCE.slice(0, 3), ["version_comparison", "direct_document", "relation_context"]);
});

test("direct document queries disable graph expansion", () => {
  const result = routeProductSearchIntent({ query: "Open the SampleManager installation guide PDF", filters: { productVersion: "21.2" } });
  assert.equal(result.intent, "direct_document");
  assert.deepEqual(result.graphExpansion, { enabled: false, maxHops: 0, maxEntities: 0, relationTypes: [] });
});

test("relation context outranks procedural and entity language", () => {
  const result = routeProductSearchIntent({ query: "How does the instrument depend on the result service and what does it impact?" });
  assert.equal(result.intent, "relation_context");
  assert.equal(result.graphExpansion.maxHops, 2);
  assert.ok(result.graphExpansion.relationTypes.includes("depends_on"));
});

test("procedure and entity routes use deterministic query signals", () => {
  assert.equal(routeProductSearchIntent({ query: "How do I configure the instrument endpoint?" }).intent, "procedure");
  assert.equal(routeProductSearchIntent({ query: "What is the result service?" }).intent, "entity");
  assert.equal(routeProductSearchIntent({ query: "Overview of result management" }).intent, "topic");
});

test("intent envelope and filters contribute context without changing bounded query terms", () => {
  const result = routeProductSearchIntent({
    query: "Compare release behavior",
    intent: { objective: "Compare supported versions", actions: ["verify"], phase: "validation" },
    filters: { sampleManagerVersion: "21.1", toVersion: "21.2", projectId: "project-a" },
  });
  assert.equal(result.intent, "version_comparison");
  assert.deepEqual(result.terms, ["compare", "release", "behavior"]);
  assert.ok(result.terms.length <= 24);
  assert.ok(result.terms.every((term) => term.length <= 80));
});

test("unknown and empty queries safely default to topic", () => {
  assert.deepEqual(routeProductSearchIntent({ query: "" }), {
    intent: "topic",
    terms: [],
    graphExpansion: { enabled: true, maxHops: 1, maxEntities: 6, relationTypes: ["related_to"] },
  });
  assert.equal(classifyProductSearchIntent({ query: "nonsense qzx" }).intent, "topic");
});

test("document and comparison signals may come from filters", () => {
  assert.equal(routeProductSearchIntent({ query: "find the source", filters: { documentId: "doc-1" } }).intent, "direct_document");
  assert.equal(routeProductSearchIntent({ query: "show changes", filters: { fromVersion: "v21.1", toVersion: "v21.2" } }).intent, "version_comparison");
});
