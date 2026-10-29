import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Product catalogs honor ACL, environment and current published engine bindings, including global documents", async () => {
  const root = mkdtempSync(join(tmpdir(), "product-catalog-http-"));
  const previous = { ...process.env }; const fetchBefore = globalThis.fetch;
  Object.assign(process.env, { DB_PATH: join(root, "app.db"), KNOWLEDGE_DB_PATH: join(root, "knowledge.db"), KNOWLEDGE_ENGINE_HOME: join(root, "absent"), WEKNORA_BASE_URL: "http://fixture", WEKNORA_KNOWLEDGE_BASE_ID: "kb" });
  globalThis.fetch = (async (url, init) => {
    const path = String(url); const global = path.includes("ext-global"); const externalId = global ? "ext-global" : "ext-good"; const chunkId = global ? "chunk-global" : "chunk-good";
    if (path.endsWith("/download")) return new Response("Actual source", { headers: { "content-type": "application/octet-stream" } });
    const chunk = { id: chunkId, knowledge_id: externalId, content: "Actual source", seq: 0, chunk_type: "text", is_enabled: true, index_status: "ready", source_locators: [{ type: "pdf", page: 42 }] };
    const data = init?.method === "POST" ? [{ id: "summary", knowledge_id: externalId, content: "Generated summary", chunk_type: "summary", parent_chunk_id: chunkId, score: 0.9 }]
      : path.includes("/chunks/by-id/") ? chunk : path.includes("/chunks/") ? [chunk] : { id: externalId, parse_status: "completed" };
    return new Response(JSON.stringify({ data, total: 1 }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const { default: Fastify } = await import("fastify");
  const { db, runMigrations } = await import("../src/server/db/index.js");
  const { knowledgeRoutes } = await import("../src/server/routes/knowledge.js");
  const { getKnowledgeStore } = await import("../src/server/knowledge-context.js");
  const { MigrationController } = await import("../src/knowledge/migration-control.js");
  runMigrations(); const store = getKnowledgeStore(); store.grantAcl("p1", 7); const now = "2026-10-25T00:00:00Z";
  const migration = new MigrationController(store).create({ actorId: 7, idempotencyKey: "published", sourceManifest: {} });
  store.db.prepare("UPDATE knowledge_migrations SET status='published',published_at=? WHERE id=?").run(now, migration.id);
  store.db.prepare("INSERT INTO knowledge_integration_settings(key,value,migration_id,updated_by,updated_at) VALUES ('product_provider','relay_local',?,7,?)").run(migration.id, now);
  store.db.prepare("INSERT INTO knowledge_topics(id,canonical_key,canonical_title,created_at,updated_at) VALUES ('mixed','mixed','Mixed manual',?,?)").run(now, now);
  for (const [id, project, environment, kb, status] of [
    ["good", "p1", "dev", "kb", "published"], ["secret", "p2", "dev", "kb", "published"],
    ["prod", "p1", "prod", "kb", "published"], ["global", null, null, "kb", "published"],
    ["unpublished", "p1", "dev", "kb", "staged"], ["old", "p1", "dev", "old-kb", "published"],
  ]) {
    store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,environment,source_locator,created_at,updated_at) VALUES (?,'product_document',?,'obsolete local body','approved',?,?,?,?,?)").run(id, id, project, environment, `${id}.pdf`, now, now);
    store.db.prepare("INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,source_path,source_sha256,version,created_at,updated_at) VALUES (?,?,'guide','en',?,'sha',?,?,?)").run(id, `family-${id}`, `${id}.pdf`, id, now, now);
    store.db.prepare("INSERT INTO knowledge_product_document_bindings(id,topic_id,document_id,product_version,source_path,created_at,updated_at) VALUES (?,'mixed',?,?,?,?,?)").run(`binding-${id}`, id, id, `${id}.pdf`, now, now);
    store.db.prepare("INSERT INTO knowledge_weknora_documents(id,external_document_id,external_knowledge_base_id,external_chunk_ids_json,title,normalized_content_sha256,parser_version,product_version,source_path,project_id,environment,status,idempotency_key,created_at,updated_at,upstream_verified_at,upstream_parse_status) VALUES (?,?,?,?,?,?,'v1',?,?,?,?,?,?,?,?,?,'completed')").run(`engine-${id}`, `ext-${id}`, kb, JSON.stringify([`chunk-${id}`]), id, createHash("sha256").update("Actual source").digest("hex"), id, `${id}.pdf`, project, environment, status, id, now, now, now);
    store.db.prepare("INSERT INTO knowledge_migration_documents(migration_id,local_document_id,document_id,idempotency_key,external_document_id,status,created_at,updated_at) VALUES (?,?,?,?,?,'published',?,?)").run(migration.id, id, `engine-${id}`, id, `ext-${id}`, now, now);
  }
  const app = Fastify(); let httpUser = { id: 7, isAdmin: false }; app.decorate("authenticate", async (req: any) => { req.user = httpUser; }); await app.register(knowledgeRoutes);
  const scope = "projectId=p1&environment=dev";
  try {
    const local = await app.inject({ url: `/api/knowledge/product-documents/versions?${scope}` });
    assert.equal(local.statusCode, 200);
    assert.deepEqual(local.json().versions.map((v: any) => v.document_family_id).sort(), ["family-global", "family-good", "family-old", "family-unpublished"]);
    store.db.prepare("UPDATE knowledge_product_document_bindings SET status='rejected' WHERE id='binding-old'").run();
    store.db.prepare("UPDATE knowledge_product_document_bindings SET status='pending' WHERE id='binding-unpublished'").run();
    const localTopics = await app.inject({ url: `/api/knowledge/product-topics?${scope}` });
    assert.equal(localTopics.statusCode, 200);
    assert.equal(localTopics.json().page.total, 1);
    assert.equal(localTopics.json().topics[0].revisionCount, 2);
    httpUser = { id: 7, isAdmin: true };
    const reviewTopics = await app.inject({ url: `/api/knowledge/product-topics?${scope}&includeReview=true` });
    assert.equal(reviewTopics.statusCode, 200);
    assert.equal(reviewTopics.json().topics[0].revisionCount, 4);
    assert.deepEqual(reviewTopics.json().topics[0].versions.sort(), ["good", "old", "unpublished", "global"].sort());
    httpUser = { id: 7, isAdmin: false };
    const localDetail = await app.inject({ url: `/api/knowledge/product-topics/mixed?${scope}` });
    assert.equal(localDetail.statusCode, 200);
    assert.deepEqual(localDetail.json().versions.map((version: any) => version.product_version).sort(), ["good", "global"].sort());
    httpUser = { id: 7, isAdmin: true };
    const reviewDetail = await app.inject({ url: `/api/knowledge/product-topics/mixed?${scope}&includeReview=true` });
    assert.equal(reviewDetail.statusCode, 200);
    assert.equal(reviewDetail.json().versions.length, 4);
    httpUser = { id: 7, isAdmin: false };
    store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,source_locator,created_at,updated_at) VALUES ('wrong-kind','candidate','Wrong kind','body','draft','wrong.txt',?,?)").run(now, now);
    store.db.prepare("INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,source_path,source_sha256,version,created_at,updated_at) VALUES ('wrong-kind','family-wrong','guide','en','wrong.txt','sha','wrong',?,?)").run(now, now);
    store.db.prepare("INSERT INTO knowledge_product_document_bindings(id,topic_id,document_id,product_version,source_path,created_at,updated_at) VALUES ('binding-wrong','mixed','wrong-kind','wrong','wrong.txt',?,?)").run(now, now);
    const filteredLocalTopics = await app.inject({ url: `/api/knowledge/product-topics?${scope}` });
    assert.equal(filteredLocalTopics.statusCode, 200);
    assert.equal(filteredLocalTopics.json().page.total, 1);
    assert.ok(!filteredLocalTopics.json().topics[0].versions.includes("wrong"));
    httpUser = { id: 999, isAdmin: false };
    assert.equal((await app.inject({ url: "/api/knowledge/product-topics" })).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/knowledge/product-topics/mixed" })).statusCode, 403);
    httpUser = { id: 7, isAdmin: false };
    store.db.prepare("UPDATE knowledge_integration_settings SET value='weknora' WHERE key='product_provider'").run();
    const versions = await app.inject({ url: `/api/knowledge/product-documents/versions?${scope}` });
    assert.deepEqual(versions.json().versions.map((v: any) => v.document_family_id).sort(), ["family-global", "family-good"]);
    assert.equal(versions.json().page.total, 2);
    const topics = await app.inject({ url: `/api/knowledge/product-topics?${scope}` });
    assert.equal(topics.statusCode, 200); assert.equal(topics.json().topics[0].revisionCount, 2);
    const globalDetail = await app.inject({ url: `/api/knowledge/product-topics/mixed?${scope}` });
    assert.equal(globalDetail.statusCode, 200, globalDetail.body); assert.ok(globalDetail.json().versions.some((version: any) => version.document_id === "global" && version.body === "Actual source"));
    store.db.prepare("DELETE FROM knowledge_product_document_bindings WHERE document_id='global'").run();
    const detail = await app.inject({ url: `/api/knowledge/product-topics/mixed?${scope}` });
    assert.equal(detail.statusCode, 200, detail.body); assert.equal(detail.json().versions.length, 1);
    assert.equal(detail.json().versions[0].body, "Actual source"); assert.ok(!detail.body.includes("obsolete local"));
    assert.equal((await app.inject({ url: "/api/knowledge/product-topics?projectId=p2&environment=dev" })).statusCode, 403);
    const search = await app.inject({ method: "POST", url: "/api/knowledge/search", payload: { projectId: "p1", environment: "dev", query: "source" } });
    assert.equal(search.statusCode, 200, search.body);
    assert.equal(search.json().references[0].sourceLocator, "good.pdf#page=42");
    assert.deepEqual(search.json().contextPack.authoritativeDocs[0].sourceLocators, [{ type: "pdf", page: 42 }]);
    const { registerKnowledgeTools } = await import("../src/mcp/tools/knowledge.js");
    const callbacks = new Map<string, Function>();
    registerKnowledgeTools({ server: { tool: (name: string, ...args: any[]) => callbacks.set(name, args.at(-1)), resource: () => undefined } as any,
      user: { id: 7, username: "scoped-reader", defaultProject: "p1", defaultEnvironment: "dev" }, knowledge: store });
    const mcp = JSON.parse((await callbacks.get("knowledge_topic_get")!({ topicId: "mixed", projectId: "p1", environment: "dev" })).content[0].text);
    assert.equal(mcp.bindings.length, 1); assert.equal(mcp.bindings[0].body, "Actual source");
    assert.equal(mcp.bindings[0].source_locator, undefined, "engine DTO must not retain legacy snake-case provenance");
    assert.equal(mcp.bindings[0].source_sha256, undefined);
    assert.ok(!JSON.stringify(mcp).includes("obsolete local"));
    await assert.rejects(callbacks.get("knowledge_topic_diff")!({ topicId: "mixed", fromVersion: "good", toVersion: "prod", projectId: "p1", environment: "dev" }), /versions not found/i);
    await assert.rejects(callbacks.get("knowledge_topic_diff")!({ topicId: "mixed", fromVersion: "good", toVersion: "unpublished", projectId: "p1", environment: "dev" }), /versions not found/i);
    const mcpDiff = JSON.parse((await callbacks.get("knowledge_topic_diff")!({ topicId: "mixed", fromVersion: "good", toVersion: "good", projectId: "p1", environment: "dev" })).content[0].text);
    assert.equal(mcpDiff.from.body, "Actual source"); assert.equal(mcpDiff.to.provider, "weknora");
    store.db.prepare("UPDATE knowledge_integration_settings SET value='relay_local' WHERE key='product_provider'").run();
    const localTopic = JSON.parse((await callbacks.get("knowledge_topic_get")!({ topicId: "mixed", projectId: "p1", environment: "dev" })).content[0].text);
    assert.deepEqual(localTopic.bindings.map((binding: any) => binding.document_id).sort(), ["good"]);
    store.db.prepare("UPDATE knowledge_integration_settings SET value='weknora' WHERE key='product_provider'").run();
    store.db.transaction(() => {
      for (let i = 0; i < 501; i++) {
        const id = `bulk-${String(i).padStart(3, "0")}`;
        store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,environment,source_locator,created_at,updated_at) VALUES (?,'product_document',?,'body','approved','p1','dev',?,?,?)").run(id, id, `${id}.pdf`, now, now);
        store.db.prepare("INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,source_path,source_sha256,version,created_at,updated_at) VALUES (?,?,'guide','en',?,'sha',?,?,?)").run(id, `family-${id}`, `${id}.pdf`, id, now, now);
        store.db.prepare("INSERT INTO knowledge_product_document_bindings(id,topic_id,document_id,product_version,source_path,created_at,updated_at) VALUES (?,'mixed',?,?,?,?,?)").run(`binding-${id}`, id, id, `${id}.pdf`, now, now);
        store.db.prepare("INSERT INTO knowledge_weknora_documents(id,external_document_id,external_knowledge_base_id,external_chunk_ids_json,title,normalized_content_sha256,parser_version,product_version,source_path,project_id,environment,status,idempotency_key,created_at,updated_at,upstream_verified_at,upstream_parse_status) VALUES (?,?,'kb',?,?,?,'v1',?,?,'p1','dev','published',?,?,?,?,'completed')").run(`engine-${id}`, `ext-${id}`, JSON.stringify([`chunk-${id}`]), id, createHash("sha256").update("Actual source").digest("hex"), id, `${id}.pdf`, id, now, now, now);
        store.db.prepare("INSERT INTO knowledge_migration_documents(migration_id,local_document_id,document_id,idempotency_key,external_document_id,status,created_at,updated_at) VALUES (?,?,?,?,?,'published',?,?)").run(migration.id, id, `engine-${id}`, id, `ext-${id}`, now, now);
      }
    })();
    const later = await app.inject({ url: `/api/knowledge/product-documents/versions?${scope}&offset=500&limit=10` });
    assert.equal(later.statusCode, 200); assert.equal(later.json().page.total, 503); assert.equal(later.json().versions.length, 3);
    const largeTopic = await app.inject({ url: `/api/knowledge/product-topics?${scope}` });
    assert.equal(largeTopic.json().topics[0].revisionCount, 502);
    assert.equal(largeTopic.json().topics[0].versions.length, 100);
    assert.equal(largeTopic.json().topics[0].versionsTruncated, true);
    assert.equal(largeTopic.json().page.total, 1);
    const paged = await app.inject({ url: `/api/knowledge/product-topics?${scope}&limit=1&offset=1` });
    assert.equal(paged.statusCode, 200);
    assert.equal(paged.json().topics.length, 0);
    assert.equal(paged.json().page.total, 1);
  } finally {
    await app.close(); store.close(); (db as any).session.client.close(); globalThis.fetch = fetchBefore;
    for (const key of ["DB_PATH", "KNOWLEDGE_DB_PATH", "KNOWLEDGE_ENGINE_HOME", "WEKNORA_BASE_URL", "WEKNORA_KNOWLEDGE_BASE_ID"]) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true });
  }
});
