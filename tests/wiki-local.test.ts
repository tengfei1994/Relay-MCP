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
