import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(process.cwd(), "frontend", "src");

test("Knowledge information architecture exposes every #37 route", () => {
  const app = readFileSync(join(root, "App.tsx"), "utf8");
  const navigation = readFileSync(join(root, "components", "shell", "navigation.ts"), "utf8");
  const requiredRoutes = [
    "knowledge", "knowledge/product-docs", "knowledge/product-docs/imports", "knowledge/product-docs/versions", "knowledge/product-docs/search",
    "knowledge/evidence", "knowledge/candidates", "knowledge/cases", "knowledge/patterns", "knowledge/playbooks",
    "knowledge/operations/capture", "knowledge/operations/ingest", "knowledge/operations/index",
  ];
  for (const route of requiredRoutes) assert.match(app, new RegExp(`path=\\"${route.replaceAll("/", "\\/")}\\"`));
  assert.match(navigation, /Product docs/);
  assert.match(navigation, /Capture/);
  assert.match(navigation, /adminOnly/);
});

test("Knowledge planes keep global Product and project runtime scope distinct", () => {
  const product = readFileSync(join(root, "pages", "KnowledgeProduct.tsx"), "utf8");
  const project = readFileSync(join(root, "pages", "KnowledgeProject.tsx"), "utf8");
  const operations = readFileSync(join(root, "pages", "KnowledgeOperations.tsx"), "utf8");
  assert.match(product, /Versioned documentation/);
  assert.match(product, /sampleManagerVersion/);
  assert.match(product, /Rebuild index/);
  assert.match(product, /Copy citation/);
  assert.match(product, /Batch-correct low-confidence/);
  assert.match(product, /useSearchParams/);
  assert.match(project, /ScopeBanner/);
  assert.match(project, /Accept & create Case/);
  assert.match(project, /Supporting Cases/);
  assert.match(project, /Proposed Skill diff|Skill diff proposal/);
  assert.match(project, /Runtime Observation/);
  assert.match(project, /Technical details/);
  assert.match(project, /Manage Evidence links/);
  assert.match(project, /Environment/);
  assert.match(operations, /dead-letter/i);
  assert.match(operations, /Invalidate embeddings/);
  assert.match(operations, /extraction/);
  assert.match(operations, /eventLossRisk/);
  assert.match(operations, /Last call/);
  assert.match(operations, /Error rate/);
});

test("Memory workspace is non-linear and separates Candidate Insights from Confirmed Memory", () => {
  const app = readFileSync(join(root, "App.tsx"), "utf8");
  const navigation = readFileSync(join(root, "components", "shell", "navigation.ts"), "utf8");
  const primitives = readFileSync(join(root, "components", "KnowledgePrimitives.tsx"), "utf8");
  const memory = readFileSync(join(root, "pages", "KnowledgeMemory.tsx"), "utf8");
  const overview = readFileSync(join(root, "pages", "KnowledgeOverview.tsx"), "utf8");
  for (const route of ["knowledge/memory", "knowledge/sessions", "knowledge/candidate-insights", "knowledge/confirmed-memory"]) assert.ok(app.includes(route), `missing ${route}`);
  assert.match(navigation, /Memory/);
  assert.match(navigation, /Candidate insights/);
  assert.match(navigation, /Confirmed memory/);
  assert.match(memory, /knowledgeCandidateInsights|knowledgeConfirmedMemories/);
  assert.match(memory, /reviewReason|reviewStatus|audit/i);
  assert.match(memory, /History|Reviewed/);
  assert.match(overview, /to="\/knowledge\/memory"/);
  assert.doesNotMatch(overview, /to="\/knowledge\/candidates"/);
  assert.doesNotMatch(primitives, /Evidence.*→.*Observation.*→.*Candidate.*→.*Case.*→.*Pattern.*→.*Playbook/);
});
