import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActiveWikiService } from "../src/knowledge/active-wiki.ts";
import { EngineWikiError, type EngineWikiService } from "../src/knowledge/engine-wiki.ts";
import { WikiService, type WikiPageListQuery, type WikiPageListResult, type WikiPageSummary } from "../src/knowledge/wiki.ts";
import { createKnowledgeStore, type KnowledgeStore } from "../src/knowledge/store.ts";

function page(id: string, overrides: Record<string, unknown> = {}): WikiPageSummary {
  return {
    id,
    pageKey: "key-" + id,
    title: "Title " + id,
    status: "published",
    projectId: "project-1",
    sourceRefs: ["source-" + id],
    currentRevision: 1,
    createdBy: 7,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as WikiPageSummary;
}

function provider(items: WikiPageSummary[], failure?: Error) {
  return {
    list(input: WikiPageListQuery): WikiPageListResult {
      if (failure) throw failure;
      const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
      const offset = Math.max(0, Math.trunc(input.offset ?? 0));
      return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
    },
  };
}

function active(localItems: WikiPageSummary[], engineItems: WikiPageSummary[] = [], engineAuthoritative = false, failure?: Error): ActiveWikiService {
  const local = provider(localItems);
  const engine = provider(engineItems, failure);
  return new ActiveWikiService({} as KnowledgeStore, local as unknown as WikiService, engine as unknown as EngineWikiService, engineAuthoritative);
}

test("Active Wiki enumerates provider windows before calculating merged pagination", async () => {
  const items = Array.from({ length: 450 }, (_, index) => page("local-" + index, { topicId: "topic-" + index }));
  const result = await active(items).list({ actorId: 7, projectId: "project-1", limit: 50, offset: 400 });

  assert.equal(result.total, 450);
  assert.equal(result.offset, 400);
  assert.equal(result.items.length, 50);
  const expected = items.map(item => item.id).sort((left, right) => right.localeCompare(left)).slice(400, 450);
  assert.deepEqual(result.items.map(item => item.id), expected);
});

test("Active Wiki enumerates engine windows before calculating merged pagination", async () => {
  const items = Array.from({ length: 450 }, (_, index) => page("engine-wiki:" + index, { topicId: "engine-topic-" + index }));
  const result = await active([], items).list({ actorId: 7, projectId: "project-1", limit: 50, offset: 400 });

  assert.equal(result.total, 450);
  assert.equal(result.items.length, 50);
  const expected = items.map(item => item.id).sort((left, right) => right.localeCompare(left)).slice(400, 450);
  assert.deepEqual(result.items.map(item => item.id), expected);
});

test("engine-authoritative merge prefers the engine page for one identity", async () => {
  const local = page("local-1", { topicId: "same-topic", sourceRefs: ["same-source"], updatedAt: "2026-12-01T00:00:00.000Z" });
  const engine = page("engine-wiki:1", { topicId: "same-topic", sourceRefs: ["same-source"], status: "draft", updatedAt: "2026-01-01T00:00:00.000Z" });
  const result = await active([local], [engine], true).list({ actorId: 7, projectId: "project-1" });

  assert.equal(result.total, 1);
  assert.equal(result.items[0]?.id, "engine-wiki:1");
});
test("generated local Wiki shadows all engine pages citing its Product topic", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-active-wiki-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  store.grantAcl("project-1", 7, true);
  try {
    const now = "2026-10-25T00:00:00.000Z";
    store.db.prepare(`INSERT INTO knowledge_documents
      (id,kind,title,body,lifecycle,source_locator,source_sha256,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run("doc-1", "product_document", "Localization", "body", "approved", "fixture://doc-1", "sha-1", now, now);
    store.db.prepare(`INSERT INTO knowledge_product_documents
      (id,document_family_id,document_type,source_path,source_sha256,version,topic_group_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run("doc-1", "localization", "guide", "localization.md", "sha-1", "21.3", "topic-localization", now, now);
    const local = new WikiService(store, () => new Date(now));
    local.upsertGenerated({
      topicGroupId: "topic-localization", pageKey: "topic/localization", title: "Localization", body: "# Localization",
      supportedVersions: ["21.3"], sourceRefs: ["doc-1"], fingerprint: "fingerprint",
      sections: [{ key: "common", kind: "common", title: "Common", body: "body", sortOrder: 0, citations: [{ documentId: "doc-1", productVersion: "21.3", chunkIds: [] }] }],
    });
    const engine = provider([
      page("engine-wiki:one", { sourceRefs: ["doc-1"] }),
      page("engine-wiki:two", { sourceRefs: ["doc-1"] }),
      page("engine-wiki:three", { sourceRefs: ["doc-1"] }),
      page("engine-wiki:four", { sourceRefs: ["doc-1"] }),
      page("engine-wiki:five", { sourceRefs: ["doc-1"] }),
    ]);
    const result = await new ActiveWikiService(store, local, engine as unknown as EngineWikiService, true).list({ actorId: 7, isAdmin: true, projectId: "project-1" });
    assert.equal(result.total, 1);
    assert.equal(result.items[0]?.topicGroupId, "topic-localization");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("engine Wiki pages with shared sources remain distinct by upstream page key", async () => {
  const one = page("engine-wiki:one", { pageKey: "engine-wiki:one", sourceRefs: ["same-source"] });
  const two = page("engine-wiki:two", { pageKey: "engine-wiki:two", sourceRefs: ["same-source"] });
  const result = await active([], [one, two], true).list({ actorId: 7, projectId: "project-1" });

  assert.equal(result.total, 2);
  assert.deepEqual(new Set(result.items.map(item => item.id)), new Set(["engine-wiki:one", "engine-wiki:two"]));
});

test("canonical identity keeps same topic isolated by environment", async () => {
  const dev = page("local-dev", { topicId: "same-topic", sourceRefs: ["same-source"], environment: "dev" });
  const prod = page("local-prod", { topicId: "same-topic", sourceRefs: ["same-source"], environment: "prod" });
  const result = await active([dev, prod]).list({ actorId: 7, projectId: "project-1" });

  assert.equal(result.total, 2);
  const environments = result.items.map(item => {
    const raw = item as unknown as Record<string, unknown>;
    return raw.environment;
  });
  assert.deepEqual(new Set(environments), new Set(["dev", "prod"]));
});

test("unavailable engine falls back to the requested local window", async () => {
  const items = Array.from({ length: 300 }, (_, index) => page("local-" + index, { topicId: "topic-" + index }));
  const result = await active(items, [], false, new EngineWikiError("unavailable", "offline")).list({ actorId: 7, projectId: "project-1", limit: 20, offset: 250 });

  assert.equal(result.total, 300);
  assert.equal(result.offset, 250);
  assert.equal(result.items.length, 20);
  assert.equal(result.items[0]?.id, "local-250");
});
