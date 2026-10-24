import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("HTTP Product Knowledge boundaries enforce project scope and topic ACLs", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-boundary-http-"));
  const previousEnv = {
    DB_PATH: process.env.DB_PATH,
    KNOWLEDGE_DB_PATH: process.env.KNOWLEDGE_DB_PATH,
    WEKNORA_BASE_URL: process.env.WEKNORA_BASE_URL,
    WEKNORA_KNOWLEDGE_BASE_ID: process.env.WEKNORA_KNOWLEDGE_BASE_ID,
    WEKNORA_API_TOKEN: process.env.WEKNORA_API_TOKEN,
  };
  const previousFetch = globalThis.fetch;
  process.env.DB_PATH = join(root, "app.db");
  process.env.KNOWLEDGE_DB_PATH = join(root, "knowledge.db");
  process.env.WEKNORA_BASE_URL = "https://weknora.example.test";
  process.env.WEKNORA_KNOWLEDGE_BASE_ID = "kb-test";
  process.env.WEKNORA_API_TOKEN = "test-token";

  let seenKnowledgeIds: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { knowledge_ids?: string[] };
    seenKnowledgeIds = body.knowledge_ids ?? [];
    return new Response(JSON.stringify({
      success: true,
      data: [
        { id: "chunk-p1", knowledge_id: "ext-p1", content: "p1 result", score: 0.9, metadata: { sourcePath: "p1.md" } },
        { id: "chunk-p2", knowledge_id: "ext-p2", content: "p2 result", score: 0.8, metadata: { sourcePath: "p2.md" } },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const { default: Fastify } = await import("fastify");
  const { db, runMigrations } = await import("../src/server/db/index.js");
  const { knowledgeRoutes } = await import("../src/server/routes/knowledge.js");
  const { getKnowledgeStore } = await import("../src/server/knowledge-context.js");
  const { KnowledgeRepository } = await import("../src/knowledge/repository.js");
  const { WeKnoraIngestor } = await import("../src/knowledge/weknora-ingest.js");

  runMigrations();
  const store = getKnowledgeStore();
  store.grantAcl("p1", 7);
  const now = "2026-10-23T00:00:00.000Z";
  const repository = new KnowledgeRepository(store);
  repository.saveCase({ id: "case-p1", kind: "case", title: "Cache case", body: "cache failure confirmed", lifecycle: "approved", projectId: "p1", locator: "case:p1", createdAt: now, updatedAt: now } as any);
  const p1 = new WeKnoraIngestor(store, { upsertDocument: async () => ({ externalDocumentId: "ext-p1" }) });
  const p2 = new WeKnoraIngestor(store, { upsertDocument: async () => ({ externalDocumentId: "ext-p2" }) });
  const p1Document = await p1.stage({ idempotencyKey: "p1", title: "P1", content: "P1", projectId: "p1", parserVersion: "test" });
  const p2Document = await p2.stage({ idempotencyKey: "p2", title: "P2", content: "P2", projectId: "p2", parserVersion: "test" });
  p1.publish(p1Document.id, 7);
  p2.publish(p2Document.id, 7);

  store.db.prepare("INSERT INTO knowledge_topics(id,canonical_key,canonical_title,created_at,updated_at) VALUES (?,?,?,?,?)").run("topic-p2", "topic-p2", "P2 topic", now, now);
  store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,source_locator,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("product-p2", "product_document", "P2 doc", "P2", "approved", "p2", "p2.md", now, now);
  store.db.prepare("INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,source_path,source_sha256,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("product-p2", "family-p2", "guide", "en", "p2.md", "sha-p2", "21.3", now, now);
  store.db.prepare("INSERT INTO knowledge_product_document_bindings(id,topic_id,document_id,product_version,source_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("binding-p2", "topic-p2", "product-p2", "21.3", "p2.md", now, now);

  const app = Fastify();
  app.decorate("authenticate", async (req: any) => { req.user = { id: 7, isAdmin: false }; });
  await app.register(knowledgeRoutes);
  try {
    const missingScope = await app.inject({ method: "POST", url: "/api/knowledge/weknora/search", payload: { query: "cache" } });
    assert.equal(missingScope.statusCode, 403);

    const scopedSearch = await app.inject({ method: "POST", url: "/api/knowledge/weknora/search", payload: { query: "cache", projectId: "p1" } });
    assert.equal(scopedSearch.statusCode, 200, scopedSearch.body);
    assert.deepEqual(seenKnowledgeIds, ["ext-p1"]);
    const scopedBody = scopedSearch.json();
    assert.deepEqual(scopedBody.references.map((reference: { documentId: string }) => reference.documentId), ["ext-p1"]);
    assert.deepEqual(scopedBody.contextPack.confirmedKnowledge.map((item: { id: string }) => item.id), ["case-p1"]);

    const topicList = await app.inject({ url: "/api/knowledge/product-topics" });
    assert.equal(topicList.statusCode, 200);
    assert.equal(topicList.json().page.total, 0);
    const foreignTopic = await app.inject({ url: "/api/knowledge/product-topics/topic-p2" });
    assert.equal(foreignTopic.statusCode, 403);
  } finally {
    await app.close();
    store.close();
    (db as any).session.client.close();
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
