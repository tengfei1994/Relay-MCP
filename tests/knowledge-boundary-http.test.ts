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
      ].filter(ref=>seenKnowledgeIds.includes(ref.knowledge_id)),
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const { default: Fastify } = await import("fastify");
  const { db, runMigrations } = await import("../src/server/db/index.js");
  const { knowledgeRoutes } = await import("../src/server/routes/knowledge.js");
  const { getKnowledgeStore } = await import("../src/server/knowledge-context.js");
  const { KnowledgeRepository } = await import("../src/knowledge/repository.js");
  const { EvidenceStore } = await import("../src/knowledge/evidence-store.js");
  const { ConfirmedMemoryService } = await import("../src/knowledge/confirmed-memory.js");
  const { WeKnoraIngestor } = await import("../src/knowledge/weknora-ingest.js");

  runMigrations();
  const store = getKnowledgeStore();
  store.grantAcl("p1", 7, true);
  const now = "2026-10-23T00:00:00.000Z";
  const repository = new KnowledgeRepository(store);
  const evidence = new EvidenceStore(store, join(root, "evidence")).put({ content: Buffer.from("cache failure confirmed"), mimeType: "text/plain", sourceKind: "log", projectId: "p1", environment: "nonprod", locator: "case:p1" });
  const memories = new ConfirmedMemoryService(store);
  memories.save({ id: "case-p1", type: "Case", title: "Cache case", statement: "cache failure confirmed", details: { symptoms: "cache failure", rootCause: "fixture", resolution: "reviewed", verification: "confirmed" }, scope: { projectId: "p1", environment: "nonprod", scopeType: "environment", scopeKey: "nonprod", visibility: "project" }, evidenceRefs: [evidence.id], source: { kind: "manual", locator: "case:p1" }, confirmedBy: 7, confirmedAt: now, audit: { action: "manual", reason: "fixture" } });
  const p1 = new WeKnoraIngestor(store, { upsertDocument: async () => ({ knowledgeBaseId:"kb-test", externalDocumentId: "ext-p1", parseStatus: "completed", externalChunkIds: ["chunk-p1"] }) });
  const p2 = new WeKnoraIngestor(store, { upsertDocument: async () => ({ knowledgeBaseId:"kb-test", externalDocumentId: "ext-p2", parseStatus: "completed", externalChunkIds: ["chunk-p2"] }) });
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
    const missingScope = await app.inject({ method: "POST", url: "/api/knowledge/search", payload: { query: "cache" } });
    assert.equal(missingScope.statusCode, 200, missingScope.body);
    assert.deepEqual(missingScope.json().references, []);
    assert.deepEqual(missingScope.json().contextPack.confirmedKnowledge, []);

    const scopedSearch = await app.inject({ method: "POST", url: "/api/knowledge/search", payload: { query: "cache", projectId: "p1" } });
    assert.equal(scopedSearch.statusCode, 200, scopedSearch.body);
    assert.deepEqual(seenKnowledgeIds, ["ext-p1"]);
    const scopedBody = scopedSearch.json();
    assert.deepEqual(scopedBody.references.map((reference: { documentId: string }) => reference.documentId), ["ext-p1"]);
    assert.deepEqual(scopedBody.contextPack.confirmedKnowledge.map((item: { id: string }) => item.id), ["case-p1"]);

    const prodEvidence = new EvidenceStore(store, join(root, "evidence")).put({ content: Buffer.from("cache failure confirmed in prod"), mimeType: "text/plain", sourceKind: "log", projectId: "p1", environment: "prod", locator: "case:prod" });
    memories.save({ id: "case-prod", type: "Case", title: "Cache production case", statement: "cache failure confirmed in prod", details: { symptoms: "cache failure", rootCause: "fixture", resolution: "reviewed", verification: "confirmed" }, scope: { projectId: "p1", environment: "prod", scopeType: "environment", scopeKey: "prod", visibility: "project" }, evidenceRefs: [prodEvidence.id], source: { kind: "manual", locator: "case:prod" }, confirmedBy: 7, confirmedAt: now, audit: { action: "manual", reason: "fixture" } });
    const scopedPack=await app.inject({method:"POST",url:"/api/knowledge/search",payload:{query:"cache",projectId:"p1",environment:"nonprod"}});
    assert.equal(scopedPack.statusCode,200,scopedPack.body);
    assert.ok(!scopedPack.json().contextPack.confirmedKnowledge.some((item:any)=>item.id==="case-prod"),"no-session ContextPack must respect explicit environment");
    const healthyFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("Simulated private upstream failure"); };
    try {
      const outage = await app.inject({ method: "POST", url: "/api/knowledge/search", payload: { query: "cache", projectId: "p1" } });
      assert.equal(outage.statusCode, 200, outage.body);
      assert.deepEqual(outage.json().references, []);
      assert.equal(outage.json().contextPack.degraded.productKnowledge, "unavailable");
      assert.ok(outage.json().contextPack.confirmedKnowledge.some((item: any) => item.id === "case-p1"));
      assert.ok(!outage.body.includes("private upstream"));
    } finally { globalThis.fetch = healthyFetch; }
    const topicList = await app.inject({ url: "/api/knowledge/product-topics" });
    assert.equal(topicList.statusCode, 200);
    assert.equal(topicList.json().page.total, 0);
    const foreignTopic = await app.inject({ url: "/api/knowledge/product-topics/topic-p2" });
    assert.equal(foreignTopic.statusCode, 403);
    for(const path of ["product-docs","product-documents"]) {
      const list=await app.inject({url:`/api/knowledge/${path}?projectId=p1`});
      assert.equal(list.statusCode,200,list.body);
      assert.equal(list.json().documents.length,0,"foreign Product must not leak via "+path);
    }
    store.db.prepare("INSERT INTO knowledge_integration_settings(key,value,updated_at) VALUES ('product_provider','weknora',?)").run(now);
    for(const path of ["product-docs","product-documents"]) {
      const list=await app.inject({url:`/api/knowledge/${path}?projectId=p1`});
      assert.equal(list.statusCode,200,list.body);
      assert.ok(!list.body.includes("P2 doc"),"legacy Product must not leak after cutover via "+path);
      for(const status of ["approved","published","draft","deprecated","staged"]){
        const filtered=await app.inject({url:`/api/knowledge/${path}?projectId=p1&status=${status}`});
        assert.equal(filtered.statusCode,200,filtered.body);
        const expected=["approved","published"].includes(status)?1:0;
        assert.equal(filtered.json().documents.length,expected,path+":"+status);
        assert.equal(filtered.json().page.total,expected,path+":"+status+":total");
        assert.ok(filtered.json().documents.every((doc:any)=>doc.lifecycle==="approved"));
      }
    }

    const template=store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE id=?").get(p1Document.id) as Record<string,unknown>;
    const insert=store.db.prepare(`INSERT INTO knowledge_weknora_documents(${Object.keys(template).join(",")}) VALUES (${Object.keys(template).map(()=>"?").join(",")})`);
    store.db.transaction(()=>{for(let i=0;i<500;i++){const copy={...template,id:`page-${i}`,external_document_id:`page-external-${i}`,idempotency_key:`page-${i}`,identity_hash:`page-${i}`};insert.run(...Object.values(copy));}})();
    for(const path of ["product-docs","product-documents"]) {
      const page=await app.inject({url:`/api/knowledge/${path}?projectId=p1&offset=500&limit=100`});
      assert.equal(page.statusCode,200,page.body);assert.equal(page.json().page.total,501);assert.equal(page.json().page.offset,500);assert.equal(page.json().documents.length,1);
    }
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
