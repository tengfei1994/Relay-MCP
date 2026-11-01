import assert from "node:assert/strict";
import test from "node:test";
import { buildWikiDirectoryTree, wikiDirectoryPath } from "../frontend/src/knowledge/wiki-directory.ts";

test("Wiki directory uses the persisted display path and keeps pages under expandable folders", () => {
  const pages = [
    { id: "a", title: "Alpha", directoryPath: "SampleManager/Topic families/Reports/Alpha", solution: "Unassigned", module: "samplemanager" },
    { id: "b", title: "Beta", directoryPath: "SampleManager/Topic families/Reports/Beta", solution: "Unassigned", module: "samplemanager" },
    { id: "c", title: "Gamma", solution: "Operations", module: "Runtime" },
    { id: "d", title: "Root topic" },
  ];

  assert.deepEqual(wikiDirectoryPath(pages[0]), ["SampleManager", "Topic families", "Reports"]);
  const tree = buildWikiDirectoryTree(pages);
  assert.deepEqual(tree.nodes.map((node) => node.label), ["Operations", "SampleManager"]);
  assert.deepEqual(tree.nodes[1].children.map((node) => node.label), ["Topic families"]);
  assert.deepEqual(tree.nodes[1].children[0].children.map((node) => node.label), ["Reports"]);
  assert.deepEqual(tree.nodes[1].children[0].children[0].pages.map((page) => page.title), ["Alpha", "Beta"]);
  assert.equal(tree.nodes[1].count, 2);
  assert.deepEqual(tree.pages.map((page) => page.title), ["Root topic"]);
});

test("Wiki directory does not render an artificial Unassigned folder", () => {
  const tree = buildWikiDirectoryTree([{ id: "a", title: "Topic", solution: "Unassigned", module: "General" }]);
  assert.deepEqual(tree.nodes.map((node) => node.label), ["General"]);
});

test("Wiki directory keeps the server taxonomy stable when more pages are appended", () => {
  const initial = buildWikiDirectoryTree([
    { id: "a", title: "Alpha", directoryPath: "Product/Other topics/Alpha" },
  ]);
  const expanded = buildWikiDirectoryTree([
    { id: "a", title: "Alpha", directoryPath: "Product/Topic families/Operations/Alpha" },
    { id: "b", title: "Beta", directoryPath: "Product/Topic families/Operations/Beta" },
  ]);

  assert.deepEqual(initial.nodes[0].children.map((node) => node.label), ["Other topics"]);
  assert.deepEqual(expanded.nodes[0].children.map((node) => node.label), ["Topic families"]);
  assert.deepEqual(expanded.nodes[0].children[0].children.map((node) => node.label), ["Operations"]);
  assert.deepEqual(expanded.nodes[0].children[0].children[0].pages.map((page) => page.title), ["Alpha", "Beta"]);
});

test("Wiki directory does not merge unrelated server-assigned topic names", () => {
  const pages = [
    { id: "cert", title: "Cert Overview", directoryPath: "API/Topic families/Cert/Cert Overview" },
    { id: "cert-job", title: "CertJob", directoryPath: "API/Topic families/CertJob/CertJob" },
    { id: "cert-sample", title: "CertSample", directoryPath: "API/Topic families/CertSample/CertSample" },
  ];
  const tree = buildWikiDirectoryTree(pages);
  assert.deepEqual(tree.nodes[0].children.map((node) => node.label), ["Topic families"]);
  assert.deepEqual(tree.nodes[0].children[0].children.map((node) => node.label), ["Cert", "CertJob", "CertSample"]);
});

test("Wiki directory keeps high-cardinality pages in their persisted business dimensions", () => {
  const pages = Array.from({ length: 48 }, (_, index) => ({
    id: `property-${index}`,
    title: `Class ${String(index).padStart(2, "0")} Property`,
    directoryPath: `SampleManager/Topic families/API/Properties/Class ${String(index).padStart(2, "0")} Property`,
  }));

  const tree = buildWikiDirectoryTree(pages);
  assert.deepEqual(tree.nodes[0].children.map((node) => node.label), ["Topic families"]);
  assert.deepEqual(tree.nodes[0].children[0].children.map((node) => node.label), ["API"]);
  assert.equal(tree.nodes[0].children[0].children[0].count, pages.length);
});

test("Wiki directory never creates an A-Z bucket", () => {
  const pages = [
    { id: "a", title: "Alpha", directoryPath: "SampleManager/Other topics" },
    { id: "b", title: "Beta", directoryPath: "SampleManager/Other topics" },
    { id: "c", title: "Config", directoryPath: "SampleManager/Topic families/Configuration" },
    { id: "d", title: "Connection", directoryPath: "SampleManager/Topic families/Configuration" },
  ];
  const tree = buildWikiDirectoryTree(pages);
  const labels: string[] = [];
  const visit = (nodes: typeof tree.nodes) => nodes.forEach((node) => { labels.push(node.label); visit(node.children); });
  visit(tree.nodes);
  assert.ok(!labels.some((label) => /^[A-Z]$|^0–9$|^#$/.test(label)));
});
