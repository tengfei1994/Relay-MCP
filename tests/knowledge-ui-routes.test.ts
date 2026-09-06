import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(process.cwd(), "frontend", "src");

test("Knowledge information architecture exposes every #37 route", () => {
  const app = readFileSync(join(root, "App.tsx"), "utf8");
  const layout = readFileSync(join(root, "components", "Layout.tsx"), "utf8");
  const requiredRoutes = [
    "knowledge", "knowledge/product-docs", "knowledge/product-docs/imports", "knowledge/product-docs/versions", "knowledge/product-docs/search",
    "knowledge/evidence", "knowledge/candidates", "knowledge/cases", "knowledge/patterns", "knowledge/playbooks",
    "knowledge/operations/capture", "knowledge/operations/ingest", "knowledge/operations/index",
  ];
  for (const route of requiredRoutes) assert.match(app, new RegExp(`path=\\"${route.replaceAll("/", "\\/")}\\"`));
  assert.match(layout, /knowledge\.nav\.open/);
  assert.match(layout, /Product Documents/);
  assert.match(layout, /Capture operations/);
});

test("Knowledge planes keep global Product and project runtime scope distinct", () => {
  const product = readFileSync(join(root, "pages", "KnowledgeProduct.tsx"), "utf8");
  const project = readFileSync(join(root, "pages", "KnowledgeProject.tsx"), "utf8");
  const operations = readFileSync(join(root, "pages", "KnowledgeOperations.tsx"), "utf8");
  assert.match(product, /global Product Knowledge|Global, versioned, authoritative/);
  assert.match(product, /sampleManagerVersion/);
  assert.match(project, /ScopeBanner/);
  assert.match(project, /Accept & create Case/);
  assert.match(operations, /dead-letter/i);
  assert.match(operations, /Invalidate embeddings/);
});

