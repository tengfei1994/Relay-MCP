import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { knowledgeNavigation, primaryNavigation } from "../frontend/src/components/shell/navigation.js";

const root = join(process.cwd(), "frontend", "src");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

test("Knowledge pages use shared standard and workspace frames", () => {
  const frame = read("components", "knowledge", "KnowledgeFrame.tsx");
  assert.match(frame, /export function StandardPage/);
  assert.match(frame, /export function WorkspacePage/);
  for (const file of ["KnowledgeOverview.tsx", "KnowledgeIntegrated.tsx", "KnowledgeMemory.tsx", "KnowledgeOperations.tsx", "KnowledgeProject.tsx", "KnowledgeSource.tsx"]) {
    assert.match(read("pages", file), /StandardPage/);
  }
  assert.match(read("pages", "KnowledgeProduct.tsx"), /WorkspacePage/);
  assert.match(read("pages", "KnowledgeWiki.tsx"), /WorkspacePage/);
});

test("Knowledge navigation gives every capability one canonical visible owner", () => {
  const integrated = read("pages", "KnowledgeIntegrated.tsx");
  const operations = read("pages", "KnowledgeOperations.tsx");
  assert.match(integrated, /legacyTabRedirects/);
  assert.match(integrated, /\[\"providers\", \"Providers\"/);
  assert.match(integrated, /\[\"gates\", \"Release gates\"/);
  assert.doesNotMatch(integrated, /\[\"sessions\", \"Sessions\"/);
  assert.doesNotMatch(integrated, /\[\"candidates\", \"Candidates\"/);
  assert.doesNotMatch(integrated, /\[\"wiki\", \"Wiki\"/);
  assert.doesNotMatch(operations, /ProviderSetupForm/);
  assert.doesNotMatch(operations, /Modify<\/|Delete provider/);
  assert.match(operations, /Manage providers/);
});

test("Knowledge sub-navigation uses exact matching for Overview", () => {
  const overview = knowledgeNavigation.find((item) => item.path === "/knowledge");
  assert.ok(overview?.matches("/knowledge"));
  assert.equal(overview?.matches("/knowledge/wiki"), false);
  assert.deepEqual(knowledgeNavigation.filter((item) => item.matches("/knowledge/wiki")).map((item) => item.label), ["Wiki"]);
});

test("Knowledge frame keeps the shared content rail", () => {
  const frameCss = readFileSync(join(process.cwd(), "frontend", "src", "components", "knowledge", "knowledge-frame.css"), "utf8");
  const shellCss = readFileSync(join(process.cwd(), "frontend", "src", "components", "shell", "shell.css"), "utf8");
  assert.match(frameCss, /max-width:\s*1280px/);
  assert.match(frameCss, /max-width:\s*1600px/);
  assert.match(shellCss, /app-page-frame-standard\{max-width:1600px\}/);
  assert.match(shellCss, /clamp\(20px,3vw,40px\)/);
  assert.doesNotMatch(shellCss, /shell-footer/);
});

test("Workspace Activity and Jobs have distinct console entries", () => {
  const app = read("App.tsx");
  assert.match(app, /<Route path="activity" element=\{<ActivityPage \/>\} \/>/);
  assert.match(app, /<Route path="jobs" element=\{<JobsPage \/>\} \/>/);
  assert.deepEqual(primaryNavigation.filter((item) => item.label === "Activity").map((item) => item.path), ["/activity"]);
  assert.deepEqual(primaryNavigation.filter((item) => item.label === "Jobs").map((item) => item.path), ["/jobs"]);
});
