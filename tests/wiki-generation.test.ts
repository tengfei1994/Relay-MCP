import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { WikiService } from "../src/knowledge/wiki.ts";
import { WikiGenerationService } from "../src/knowledge/wiki-generation.ts";
import { buildWikiDirectoryPath, buildWikiDirectoryPaths } from "../src/knowledge/wiki-directory.ts";
import { buildWikiDirectoryTree } from "../frontend/src/knowledge/wiki-directory.ts";
import { extractProductGraph, persistProductGraph } from "../src/knowledge/product-graph.ts";
import type { ManagedProviderHandle } from "../src/knowledge/provider-registry.ts";

function fakeProvider(response: unknown): ManagedProviderHandle {
  return { chat: async () => ({ text: JSON.stringify(response) }) } as ManagedProviderHandle;
}

test("Wiki generation groups versions, validates citations and persists one page", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-wiki-generation-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  const now = new Date().toISOString();
  try {
    for (const [id, version, body] of [["doc-211", "21.1", "Shared deployment procedure."], ["doc-213", "21.3", "Shared deployment procedure with a new flag."]] as const) {
      store.upsertDocument({ id, kind: "product_document", title: "Localization Deployment Kit", body, lifecycle: "approved", sampleManagerVersion: version, solution: "Localization", module: "Deployment", locator: `fixture://${id}`, sha256: `${id}-sha`, createdAt: now, updatedAt: now });
      store.db.prepare(`INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,authority,source_path,source_sha256,version,topic_group_id,normalized_content_sha256,parser_version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, "localization", "guide", "en", "official", `${id}.md`, `${id}-sha`, version, "topic-localization", `${id}-normalized`, "fixture-v1", now, now);
    }
    for (const [id, version] of [["doc-211", "21.1"], ["doc-213", "21.3"]] as const) {
      persistProductGraph(store, extractProductGraph({
        documentId: id,
        body: "# Installation\n## Configure\n### Agent\n\nDepends on: Deployment Agent",
        productVersion: version,
        solution: "Localization",
        module: "Deployment",
        sourceLocator: `fixture://${id}`,
        sourceSha256: `${id}-sha`,
      }));
    }
    const response = { title: "Localization Deployment Kit", sections: [
      { key: "common", kind: "common", title: "Common", body: "Both versions use the same deployment sequence.", sourceRefs: ["doc-211", "doc-213"], chunkRefs: ["doc-211:chunk:0", "doc-213:chunk:0"] },
      { key: "version-21-3", kind: "version", productVersion: "21.3", title: "21.3", body: "The new flag is available.", sourceRefs: ["doc-213"], chunkRefs: ["doc-213:chunk:0"] },
      { key: "difference", kind: "difference", title: "Differences", body: "21.3 adds a flag.", sourceRefs: ["doc-211", "doc-213"], chunkRefs: ["doc-211:chunk:0", "doc-213:chunk:0"] },
    ] };
    const generated = await new WikiGenerationService(store, () => new Date(now), fakeProvider(response)).generate({ topicGroupId: "topic-localization" });
    const page = new WikiService(store).get({ actorId: 7, isAdmin: true, id: generated.pageId });
    assert.equal(page.title, "Localization Deployment Kit");
    assert.deepEqual(page.supportedVersions, ["21.1", "21.3"]);
    assert.deepEqual(page.sections?.map(section => section.kind), ["common", "version", "difference"]);
    assert.equal(page.directoryPath, "Localization/Deployment/Installation/Configure/Agent/Deployment Agent/Localization Deployment Kit");
    const directoryInput = { title: page.title, sourceRefs: page.sourceRefs, solution: page.solution, module: page.module };
    assert.equal(buildWikiDirectoryPath(store, directoryInput), page.directoryPath);
    assert.deepEqual(buildWikiDirectoryPaths(store, [directoryInput, directoryInput]), [page.directoryPath, page.directoryPath]);
    assert.equal(new WikiService(store).list({ actorId: 7, isAdmin: true }).items[0]?.directoryPath, page.directoryPath);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Wiki directory shares qualified API namespaces across distinct property pages", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-wiki-api-directory-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  const now = new Date().toISOString();
  const documents = [
    ["api-instrument", "ChromeleonInstrument Property", "help:Thermo.SampleManager.ObjectModel~Thermo.SampleManager.ObjectModel.ChromeleonLinkObjectModel~ChromeleonMappingEntity~ChromeleonInstrument", "Thermo.SampleManager.ObjectModel.ChromeleonLinkObjectModel.ChromeleonMappingEntity.ChromeleonInstrument"],
    ["api-mapping", "ChromeleonMapping Property", "help:Thermo.SampleManager.ObjectModel~Thermo.SampleManager.ObjectModel.ChromeleonLinkObjectModel~ChromeleonMappingProperty~ChromeleonMapping", "Thermo.SampleManager.ObjectModel.ChromeleonLinkObjectModel.ChromeleonMappingProperty.ChromeleonMapping"],
    ["api-sequence", "ChromeleonSequence Property", "help:Thermo.SampleManager.ObjectModel~Thermo.SampleManager.ObjectModel.ChromeleonLinkObjectModel~ChromeleonSequenceLog~ChromeleonSequence", "Thermo.SampleManager.ObjectModel.ChromeleonLinkObjectModel.ChromeleonSequenceLog.ChromeleonSequence"],
  ] as const;
  try {
    for (const [id, title, family, identifier] of documents) {
      store.upsertDocument({ id, kind: "product_document", title, body: `# ${title}`, lifecycle: "approved", module: "samplemanager", locator: `fixture://${id}`, sha256: `${id}-sha`, createdAt: now, updatedAt: now });
      store.db.prepare(`INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,authority,source_path,source_sha256,version,topic_group_id,normalized_content_sha256,parser_version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, family, "reference", "en", "official", `${id}.html`, `${id}-sha`, "21.3", `topic-${id}`, `${id}-normalized`, "fixture-v1", now, now);
      persistProductGraph(store, extractProductGraph({
        documentId: id,
        title,
        body: `# ${title}`,
        metadata: { stableIdentifiers: { MicrosoftHelpF1: identifier } },
        module: "samplemanager",
        sourceLocator: `fixture://${id}`,
        sourceSha256: `${id}-sha`,
      }));
    }
    const pages = documents.map(([id, title]) => ({ id, title, sourceRefs: [id], module: "samplemanager" }));
    const paths = buildWikiDirectoryPaths(store, pages);
    assert.deepEqual(paths, [
      "samplemanager/ChromeleonLinkObjectModel/ChromeleonMappingEntity/ChromeleonInstrument/ChromeleonInstrument Property",
      "samplemanager/ChromeleonLinkObjectModel/ChromeleonMappingProperty/ChromeleonMapping/ChromeleonMapping Property",
      "samplemanager/ChromeleonLinkObjectModel/ChromeleonSequenceLog/ChromeleonSequence/ChromeleonSequence Property",
    ]);
    const tree = buildWikiDirectoryTree(pages.map((page, index) => ({ ...page, directoryPath: paths[index] })));
    const namespace = tree.nodes[0]?.children[0];
    assert.equal(tree.nodes[0]?.label, "samplemanager");
    assert.equal(namespace?.label, "ChromeleonLinkObjectModel");
    assert.deepEqual(namespace?.pages.map((page) => page.title), ["ChromeleonInstrument Property", "ChromeleonMapping Property", "ChromeleonSequence Property"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
