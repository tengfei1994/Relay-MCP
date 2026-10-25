import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

test("administrator deprecate API withdraws migration routing and blocks local and engine read aliases", async () => {
  const root=mkdtempSync(join(tmpdir(),"relay-deprecate-http-"));
  const keys=["DB_PATH","KNOWLEDGE_DB_PATH","WEKNORA_BASE_URL","WEKNORA_KNOWLEDGE_BASE_ID","WEKNORA_API_TOKEN"];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]])); const fetchBefore=globalThis.fetch;
  process.env.DB_PATH=join(root,"app.db");process.env.KNOWLEDGE_DB_PATH=join(root,"knowledge.db");
  process.env.WEKNORA_BASE_URL="https://weknora.test";process.env.WEKNORA_KNOWLEDGE_BASE_ID="kb-test";process.env.WEKNORA_API_TOKEN="test-token";
  let upstreamCalls=0; globalThis.fetch=(async()=>{upstreamCalls++;throw new Error("Withdrawn reads must not reach upstream");}) as typeof fetch;
  const {default:Fastify}=await import("fastify");
  const {db,runMigrations}=await import("../src/server/db/index.js");
  const {knowledgeRoutes}=await import("../src/server/routes/knowledge.js");
  const {getKnowledgeStore}=await import("../src/server/knowledge-context.js");
  const {WeKnoraIngestor}=await import("../src/knowledge/weknora-ingest.js");
  const {MigrationController}=await import("../src/knowledge/migration-control.js");
  const {runReleaseGates}=await import("../src/knowledge/release-gates.js");
  runMigrations();const store=getKnowledgeStore();const app=Fastify();let isAdmin=false;
  app.decorate("authenticate",async(req:any)=>{req.user={id:7,isAdmin};});await app.register(knowledgeRoutes);
  try {
    const now=new Date().toISOString(); store.grantAcl("p1",7);
    store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,source_locator,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("local-deprecate","product_document","Document","real imported source","approved","p1","source.html",now,now);
    store.db.prepare("INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,source_path,source_sha256,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("local-deprecate","family","html","en","source.html","raw-source","21.3",now,now);
    const ingestor=new WeKnoraIngestor(store,{upsertDocument:async()=>({externalDocumentId:"external-doc",knowledgeBaseId:"kb-test",parseStatus:"completed",externalChunkIds:["chunk"]})});
    const controller=new MigrationController(store);
    const migration=await controller.createFromLocal({actorId:7,idempotencyKey:"deprecate-api",parserVersion:"v1"},ingestor);
    controller.publish(migration.id,7); const doc=ingestor.listRetrievalVisible()[0];
    const before=await app.inject({url:"/api/knowledge/product-docs?projectId=p1"});assert.equal(before.statusCode,200,before.body);assert.equal(before.json().documents.length,1);
    const denied=await app.inject({method:"POST",url:`/api/knowledge/weknora/documents/${doc.id}/deprecate`});assert.equal(denied.statusCode,403);
    assert.equal(controller.get(migration.id)?.mappingCounts.published,1);
    isAdmin=true;
    for(let i=0;i<2;i++){const response=await app.inject({method:"POST",url:`/api/knowledge/weknora/documents/${doc.id}/deprecate`});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().document.status,"deprecated");}
    assert.equal(controller.get(migration.id)?.mappingCounts.withdrawn,1);
    assert.equal(runReleaseGates(store).checks.publishedVisibility.ok,true);
    for(const id of [doc.id,"local-deprecate","external-doc"]){const read=await app.inject({url:`/api/knowledge/product-docs/${id}?projectId=p1`});assert.equal(read.statusCode,404,read.body);}
    const after=await app.inject({url:"/api/knowledge/product-docs?projectId=p1"});assert.equal(after.statusCode,200,after.body);assert.equal(after.json().documents.length,0);
    assert.equal(upstreamCalls,0);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_audit WHERE action='knowledge.weknora.deprecate'").get() as {n:number}).n,1);
  } finally {
    await app.close();store.close();(db as any).session.client.close();globalThis.fetch=fetchBefore;
    for(const [key,value] of Object.entries(previous)) if(value===undefined)delete process.env[key];else process.env[key]=value;
    rmSync(root,{recursive:true,force:true});
  }
});
