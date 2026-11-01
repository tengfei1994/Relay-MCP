import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(process.cwd(), "frontend", "src");

test("Knowledge information architecture exposes every #37 route", () => {
  const app = readFileSync(join(root, "App.tsx"), "utf8");
  const navigation = readFileSync(join(root, "components", "shell", "navigation.ts"), "utf8");
  const requiredRoutes = [
    "knowledge", "knowledge/wiki", "knowledge/product-docs", "knowledge/product-docs/imports", "knowledge/product-docs/versions", "knowledge/product-docs/search",
    "knowledge/evidence", "knowledge/candidates", "knowledge/cases", "knowledge/patterns", "knowledge/playbooks",
    "knowledge/operations/capture", "knowledge/operations/ingest", "knowledge/operations/index",
    "knowledge/operations/wiki-generation",
  ];
  for (const route of requiredRoutes) assert.match(app, new RegExp(`path=\\"${route.replaceAll("/", "\\/")}\\"`));
  assert.match(navigation, /Product docs/);
  assert.match(navigation, /Capture/);
  assert.match(navigation, /Wiki/);
  assert.match(navigation, /adminOnly/);
});

test("top-level Server and Project pages use the shared adaptive page frame", () => {
  const frame = readFileSync(join(root, "components", "shell", "AppPageFrame.tsx"), "utf8");
  const shell = readFileSync(join(root, "components", "shell", "shell.css"), "utf8");
  const servers = readFileSync(join(root, "pages", "Servers.tsx"), "utf8");
  const projects = readFileSync(join(root, "pages", "Projects.tsx"), "utf8");
  assert.match(frame, /app-page-frame/);
  assert.match(shell, /app-page-frame-standard/);
  assert.match(shell, /app-page-frame-wide/);
  assert.match(shell, /app-project-sidebar/);
  assert.match(servers, /<AppPageFrame>/);
  assert.doesNotMatch(servers, /className="page max-w-3xl"/);
  assert.match(projects, /<AppPageFrame variant="wide"/);
  assert.match(projects, /app-workspace-panel/);
});

test("Project workspace exposes file preview, rename, and delete controls", () => {
  const client = readFileSync(join(root, "api", "client.ts"), "utf8");
  const projects = readFileSync(join(root, "pages", "Projects.tsx"), "utf8");
  assert.match(client, /previewFile/);
  assert.match(client, /renameFile/);
  assert.match(client, /deleteFile/);
  assert.match(projects, /Preview/);
  assert.match(projects, /Rename/);
  assert.match(projects, /Delete/);
  assert.match(projects, /\{ Button, ConfirmDialog, Dialog, Field, Input, Select \}/);
  assert.match(projects, /File preview/);
  assert.match(projects, /Delete \$\{deleteFileTarget/);
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

test("Wiki generation UI exposes normalized progress and job-scoped pause/resume controls", () => {
  const client = readFileSync(join(root, "api", "client.ts"), "utf8");
  const wiki = readFileSync(join(root, "pages", "KnowledgeIntegrated.tsx"), "utf8");
  const generation = readFileSync(join(root, "pages", "KnowledgeWikiGeneration.tsx"), "utf8");
  assert.match(client, /knowledgeWikiGenerationControl/);
  assert.match(generation, /setTimeout/);
  assert.match(generation, /processed/);
  assert.match(generation, /percent/);
  assert.match(generation, /triggerKind/);
  assert.match(generation, /Pause/);
  assert.match(generation, /Resume/);
  assert.match(generation, /controlState/);
  assert.match(generation, /jobsPage/);
  assert.match(generation, /topicsPage/);
  assert.match(generation, /Topic generation markers/);
  assert.match(generation, /generationStatus/);
  assert.match(generation, /Previous/);
  assert.match(generation, /Next/);
  assert.match(generation, /PageTabs section="operations"/);
  assert.doesNotMatch(wiki, /knowledgeWikiGeneration\(/);
  assert.doesNotMatch(wiki, /pausedGeneration/);
  assert.match(wiki, /Topic families/);
  assert.match(wiki, /Other topics/);
  assert.match(navigationText(), /label: "Wiki generation"[\s\S]*adminOnly: true/);
});

function navigationText(): string {
  return readFileSync(join(root, "components", "shell", "navigation.ts"), "utf8");
}
