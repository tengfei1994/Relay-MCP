import assert from "node:assert/strict";
import test from "node:test";
import { buildWikiDirectoryTree, wikiDirectoryPath } from "../frontend/src/knowledge/wiki-directory.ts";

test("Wiki directory prefers generated paths and keeps pages under expandable folders", () => {
  const pages = [
    { id: "a", title: "Alpha", directoryPath: "SampleManager/Reports/Alpha", solution: "Unassigned", module: "samplemanager" },
    { id: "b", title: "Beta", directoryPath: "SampleManager/Reports/Beta", solution: "Unassigned", module: "samplemanager" },
    { id: "c", title: "Gamma", solution: "Operations", module: "Runtime" },
    { id: "d", title: "Root topic" },
  ];

  assert.deepEqual(wikiDirectoryPath(pages[0]), ["SampleManager", "Reports"]);
  const tree = buildWikiDirectoryTree(pages);
  assert.deepEqual(tree.nodes.map((node) => node.label), ["Operations", "SampleManager"]);
  assert.deepEqual(tree.nodes[1].children.map((node) => node.label), ["Reports"]);
  assert.deepEqual(tree.nodes[1].children[0].pages.map((page) => page.title), ["Alpha", "Beta"]);
  assert.equal(tree.nodes[1].count, 2);
  assert.deepEqual(tree.pages.map((page) => page.title), ["Root topic"]);
});

test("Wiki directory does not render an artificial Unassigned folder", () => {
  const tree = buildWikiDirectoryTree([{ id: "a", title: "Topic", solution: "Unassigned", module: "General" }]);
  assert.deepEqual(tree.nodes.map((node) => node.label), ["General"]);
});

test("Wiki directory summarizes singleton graph branches with visible path context", () => {
  const tree = buildWikiDirectoryTree([
    { id: "a", title: "Alpha", directoryPath: "Product/Operations/Installation/Alpha" },
    { id: "b", title: "Beta", directoryPath: "Product/Operations/Installation/Beta" },
    { id: "c", title: "Gamma", directoryPath: "Product/Operations/Deployment/Agent/Gamma" },
  ]);

  const product = tree.nodes[0];
  assert.equal(product.label, "Product");
  assert.deepEqual(product.children.map((node) => node.label), ["Operations"]);
  assert.deepEqual(product.children[0].children.map((node) => node.label), ["Installation"]);
  assert.deepEqual(product.children[0].children[0].pages.map((page) => page.title), ["Alpha", "Beta"]);
  assert.deepEqual(product.children[0].pages.map((page) => page.title), ["Gamma"]);
  assert.equal(product.children[0].pages[0].directoryContext, "Deployment / Agent");
});

test("Wiki directory merges shared PascalCase API families under their base topic", () => {
  const pages = [
    { id: "cert", title: "Cert Overview", directoryPath: "Cert/Cert Overview" },
    { id: "cert-job", title: "CertJob", directoryPath: "CertJob/CertJob" },
    { id: "cert-sample", title: "CertSample", directoryPath: "CertSample/CertSample" },
    { id: "cert-section-data", title: "CertSectionData Class", directoryPath: "CertSectionData Class/CertSectionData Class" },
    { id: "cert-section-result", title: "CertSectionResult", directoryPath: "CertSectionResult/CertSectionResult" },
    { id: "cert-template", title: "CertTemplate", directoryPath: "CertTemplate/CertTemplate" },
  ];
  const tree = buildWikiDirectoryTree(pages);
  assert.deepEqual(tree.nodes.map((node) => node.label), ["Cert"]);
  assert.deepEqual(tree.nodes[0].pages.map((page) => page.title), [
    "Cert Overview",
    "CertJob",
    "CertSample",
    "CertSectionData Class",
    "CertSectionResult",
    "CertTemplate",
  ]);
  assert.equal(tree.nodes[0].count, pages.length);
  assert.equal(tree.nodes[0].pages.find((page) => page.title === "CertJob")?.directoryContext, "CertJob");
});
