import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
test("initialization cannot change configuration while a migration is queued or running",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"engine-profile-http-"));
 process.env.KNOWLEDGE_DB_PATH=join(dir,"knowledge.db");process.env.DB_PATH=join(dir,"app.db");process.env.KNOWLEDGE_ENGINE_HOME=join(dir,"uninstalled");
 const {default:Fastify}=await import("fastify"),{knowledgeEngineRoutes}=await import("../src/server/routes/knowledge-engine.ts"),{getKnowledgeStore}=await import("../src/server/knowledge-context.ts");
 const store=getKnowledgeStore(),app=Fastify();
 app.decorate("authenticate",async(req:any)=>{req.user={id:1,isAdmin:!req.headers['x-not-admin']};});
 await app.register(knowledgeEngineRoutes);
 try{
  const request={method:"POST",url:"/api/knowledge/engine/initialize",payload:{ingestionProfile:"bulk"}} as const;
  assert.equal((await app.inject({...request,headers:{'x-not-admin':'1'}})).statusCode,403);
  for(const status of ['queued','running']){
   store.db.prepare("INSERT OR REPLACE INTO knowledge_ingest_jobs(id,kind,payload_json,status,available_at,created_at,updated_at) VALUES('job','product_migration','{}',?,'now','now','now')").run(status);
   const response=await app.inject(request);assert.equal(response.statusCode,409);assert.equal(response.json().error,"engine_migration_active");
  }
  store.db.prepare("UPDATE knowledge_ingest_jobs SET status='succeeded'").run();
  assert.equal((await app.inject(request)).statusCode,503);
 }finally{await app.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
