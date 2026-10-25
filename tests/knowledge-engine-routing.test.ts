import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createKnowledgeStore} from "../src/knowledge/store.ts";
import {searchKnowledge} from "../src/knowledge/retriever.ts";
test("standard knowledge search preserves Memory but never falls back to legacy Product after cutover",async()=>{
  const home=mkdtempSync(join(tmpdir(),"engine-routing-")),store=createKnowledgeStore({dbPath:join(home,"k.db")});
  try{
    store.grantAcl("p1",7,true);
    for(const [id,kind] of [["old-product","product_document"],["memory","case"]]){
      store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,source_locator,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id,kind,"pump","pump operating guidance","approved","p1","test/source","now","now");
      store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) VALUES (?,?,?)").run(id,"pump","pump operating guidance");
    }
    store.db.prepare("INSERT INTO knowledge_integration_settings(key,value,updated_at) VALUES ('product_provider','weknora','now')").run();
    const result=await searchKnowledge(store,{userId:7,projectId:"p1",query:"pump",providers:{embedding:undefined}});
    assert.deepEqual(result.results.map(x=>x.id),["memory"]);
    assert.equal(result.degraded,true);
    assert.equal(result.degradedReasons?.productKnowledge,"unavailable");
  }finally{store.close();rmSync(home,{recursive:true,force:true});}
});


test("managed document readiness permits long synthesis but rejects invalid unbounded budgets",async()=>{
  const {engineReadinessTimeout}=await import("../src/knowledge/engine-service.ts");
  assert.equal(engineReadinessTimeout(""),600_000);assert.equal(engineReadinessTimeout("900000"),900_000);
  for(const bad of ["0","NaN","Infinity","999","7200001"])assert.throws(()=>engineReadinessTimeout(bad),/timeout_invalid/);
});
