import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeStore, type KnowledgeStore } from "../src/knowledge/store.ts";
import { WikiService } from "../src/knowledge/wiki.ts";
import { wikiTopicIdentity } from "../src/knowledge/wiki-identity.ts";

function fixture(run: (store: KnowledgeStore, wiki: WikiService) => void): void {
  const root = mkdtempSync(join(tmpdir(), "relay-local-wiki-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  store.grantAcl("p1", 7, true);
  try { run(store, new WikiService(store, () => new Date("2026-10-25T00:00:00.000Z"))); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}
test("local Wiki persists environment and isolates exact project/environment scope", () => fixture((store, wiki) => {
  const page = wiki.create({ actorId: 7, isAdmin: false, projectId: "p1", environment: "nonprod", pageKey: "scoped/nonprod", title: "Nonprod", body: "Nonprod body", topicId: "TOPIC_A", reason: "Capture" });
  assert.equal(page.environment, "nonprod");
  const persisted = store.db.prepare("SELECT environment FROM knowledge_wiki_pages WHERE id=?").get(page.id) as Record<string, unknown>;
  assert.equal(persisted.environment, "nonprod");
  assert.throws(() => wiki.get({ actorId: 7, isAdmin: false, id: page.id, projectId: "p1", environment: "prod" }), /denied/i);
  assert.throws(() => wiki.edit({ actorId: 7, isAdmin: false, id: page.id, projectId: "p1", environment: "prod", body: "wrong scope", reason: "Must reject" }), /denied/i);
  assert.throws(() => wiki.listRevisions({ actorId: 7, isAdmin: false, id: page.id, projectId: "p1", environment: "prod" }), /denied/i);
}));

test("local Wiki keeps opaque topic IDs distinct", () => {
  assert.notEqual(wikiTopicIdentity({ topic_id: "TOPIC_A" }), wikiTopicIdentity({ topic_id: "topic-a" }));
  assert.notEqual(wikiTopicIdentity({ source_refs_json: JSON.stringify(["doc_1"]) }), wikiTopicIdentity({ source_refs_json: JSON.stringify(["doc-1"]) }));
  assert.equal(wikiTopicIdentity({ source_refs_json: JSON.stringify([" doc-1 ", "doc-1"]) }), wikiTopicIdentity({ source_refs_json: JSON.stringify(["doc-1"]) }));
  assert.notEqual(wikiTopicIdentity({ external_slug: "generated/one", source_refs_json: JSON.stringify(["doc-1"]) }), wikiTopicIdentity({ external_slug: "generated/two", source_refs_json: JSON.stringify(["doc-1"]) }));
  assert.equal(wikiTopicIdentity({ external_slug: "generated/one", source_refs_json: JSON.stringify(["doc-1"]) }), wikiTopicIdentity({ external_slug: "generated/one", source_refs_json: JSON.stringify(["doc-2"]) }));
});

test("generated Wiki keeps one topic page with version sections and section citations", () => fixture((store, wiki) => {
  const page = wiki.upsertGenerated({
    topicGroupId: "topic-localization",
    pageKey: "topic/localization",
    title: "Localization Deployment Kit",
    body: "# Localization Deployment Kit\n\n## Common\n\nShared procedure.",
    supportedVersions: ["21.1", "21.3"],
    sourceRefs: ["doc-21-1", "doc-21-3"],
    fingerprint: "fingerprint-1",
    sections: [
      { key: "common", kind: "common", title: "Common", body: "Shared procedure.", sortOrder: 0, citations: [
        { documentId: "doc-21-1", productVersion: "21.1", chunkIds: ["doc-21-1:chunk:0"] },
        { documentId: "doc-21-3", productVersion: "21.3", chunkIds: ["doc-21-3:chunk:0"] },
      ] },
      { key: "version-21-3", kind: "version", productVersion: "21.3", title: "21.3", body: "21.3-specific change.", sortOrder: 1, citations: [
        { documentId: "doc-21-3", productVersion: "21.3", chunkIds: ["doc-21-3:chunk:1"] },
      ] },
    ],
  });
  assert.deepEqual(page.supportedVersions, ["21.1", "21.3"]);
  assert.equal(page.sections?.length, 2);
  assert.equal(page.citations?.length, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_wiki_section_citations").get()?.n, 3);
  const replay = wiki.upsertGenerated({
    topicGroupId: "topic-localization", pageKey: "topic/localization", title: page.title, body: page.body,
    supportedVersions: page.supportedVersions!, sourceRefs: page.sourceRefs, fingerprint: "fingerprint-1", sections: [
      { key: "common", kind: "common", title: "Common", body: "Shared procedure.", sortOrder: 0, citations: [
        { documentId: "doc-21-1", productVersion: "21.1", chunkIds: ["doc-21-1:chunk:0"] },
        { documentId: "doc-21-3", productVersion: "21.3", chunkIds: ["doc-21-3:chunk:0"] },
      ] },
      { key: "version-21-3", kind: "version", productVersion: "21.3", title: "21.3", body: "21.3-specific change.", sortOrder: 1, citations: [
        { documentId: "doc-21-3", productVersion: "21.3", chunkIds: ["doc-21-3:chunk:1"] },
      ] },
    ],
  });
  assert.equal(replay.id, page.id);
  assert.equal(replay.currentRevision, 1);
  assert.equal(wiki.list({ actorId: 7, isAdmin: true, productVersion: "21.1" }).total, 1);
  assert.equal(wiki.list({ actorId: 7, isAdmin: true, topicGroupId: "topic-localization" }).items[0].topicGroupId, "topic-localization");
}));
