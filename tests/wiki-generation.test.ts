import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { WikiService } from "../src/knowledge/wiki.ts";
import { WikiGenerationService } from "../src/knowledge/wiki-generation.ts";
import { buildWikiDirectoryPath } from "../src/knowledge/wiki-directory.ts";
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
        title: "Localization Deployment Kit",
        body: "# Installation\n\nDepends on: Deployment Agent",
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
    assert.equal(page.directoryPath, "Localization/Deployment/Installation/Deployment Agent/Localization Deployment Kit");
    assert.equal(buildWikiDirectoryPath(store, { title: page.title, sourceRefs: page.sourceRefs, solution: page.solution, module: page.module }), page.directoryPath);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
