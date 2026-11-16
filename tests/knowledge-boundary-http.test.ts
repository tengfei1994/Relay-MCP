import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("HTTP keeps public product search separate from project Memory and private documents", async () => {
  const root=mkdtempSync(join(tmpdir(),"knowledge-boundary-http-"));
  const keys=["DB_PATH","KNOWLEDGE_DB_PATH","KNOWLEDGE_ENGINE_HOME"] as const;
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.DB_PATH=join(root,"app.db");process.env.KNOWLEDGE_DB_PATH=join(root,"knowledge.db");process.env.KNOWLEDGE_ENGINE_HOME=join(root,"unavailable-engine");
  const {default:Fastify}=await import("fastify");
  const {db,runMigrations}=await import("../src/server/db/index.js");
  const {users,projects}=await import("../src/server/db/schema.js");
  const {knowledgeRoutes}=await import("../src/server/routes/knowledge.js");
  const {getKnowledgeStore}=await import("../src/server/knowledge-context.js");
  const {submitMemory,reviewMemorySubmission}=await import("../src/knowledge/memory-v2.js");
  runMigrations();
  db.insert(users).values([{id:7,username:"owner",passwordHash:"unused",knowledgeEnabled:true},{id:8,username:"reader",passwordHash:"unused",knowledgeEnabled:true}]).run();
  db.insert(projects).values({id:1,userId:7,name:"owner-project",workspacePath:root}).run();
  const store=getKnowledgeStore(),now=new Date().toISOString();
  store.upsertDocument({id:"public-guide",kind:"product_document",title:"Public cache guide",body:"# Setup\n\nCache configuration.\n\n# Recovery\n\nCache reset procedure.",lifecycle:"approved",locator:"guide.md",createdAt:now,updatedAt:now});
  store.db.prepare("INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,source_path,source_sha256,version,created_at,updated_at) VALUES ('public-guide','family','guide','en','guide.md','sha','21',?,?)").run(now,now);
  store.db.prepare("INSERT INTO knowledge_product_classifications(document_id,classification,updated_at) VALUES ('public-guide','product',?)").run(now);
  store.upsertDocument({id:"private-guide",kind:"product_document",title:"Private cache guide",body:"Private cache detail.",lifecycle:"approved",projectId:"1",locator:"private.md",createdAt:now,updatedAt:now});
  store.db.prepare("INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,source_path,source_sha256,version,created_at,updated_at) VALUES ('private-guide','private','guide','en','private.md','sha','21',?,?)").run(now,now);
  store.db.prepare("INSERT INTO knowledge_product_classifications(document_id,classification,updated_at) VALUES ('private-guide','project',?)").run(now);
  const author={actorId:7,isAdmin:false,canReadGeneral:()=>true,assertProject(id:string){if(id!=="1")throw new Error("denied");}},admin={...author,actorId:8,isAdmin:true};
  const submitted=submitMemory(store,author,{idempotencyKey:"project-memory",requestedScope:"project",projectId:"1",title:"Cache experience",memoryType:"Fact",statement:"Cache project experience."});
  reviewMemorySubmission(store,admin,{id:submitted.id,action:"approve",reason:"Reviewed"});
  const app=Fastify();app.decorate("authenticate",async(req:any)=>{req.user={id:Number(req.headers["x-user"] ?? 7),isAdmin:false};});await app.register(knowledgeRoutes);
  try {
    const search=await app.inject({method:"POST",url:"/api/knowledge/search",headers:{"x-user":"8"},payload:{query:"cache"}});
    assert.equal(search.statusCode,200,search.body);assert.equal(search.json().references.length,2);assert.ok(search.json().references.every((item:any)=>item.documentId==="public-guide"));assert.equal(search.json().contextPack,undefined);
    assert.equal((await app.inject({method:"POST",url:"/api/knowledge/search",payload:{query:"cache",projectId:"1"}})).statusCode,400);
    assert.equal((await app.inject({url:"/api/knowledge/product-documents/private-guide",headers:{"x-user":"8"}})).statusCode,404);
    const memory=await app.inject({url:"/api/memory/search?scope=project&projectId=1",headers:{"x-user":"7"}});assert.equal(memory.statusCode,200);assert.equal(memory.json().results.length,1);
    assert.equal((await app.inject({url:"/api/memory/search?scope=project&projectId=1",headers:{"x-user":"8"}})).statusCode,403);
    store.db.prepare("INSERT INTO knowledge_integration_settings(key,value,updated_at) VALUES ('product_provider','weknora',?)").run(now);
    const outage=await app.inject({method:"POST",url:"/api/knowledge/search",payload:{query:"cache"}});assert.equal(outage.statusCode,503);assert.match(outage.body,/engine/i);
  } finally {
    await app.close();store.close();(db as any).session.client.close();
    for(const key of keys) previous[key]===undefined ? delete process.env[key] : process.env[key]=previous[key];
    rmSync(root,{recursive:true,force:true});
  }
});
