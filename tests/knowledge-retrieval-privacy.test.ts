import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createKnowledgeStore} from "../src/knowledge/store.ts";
import {searchKnowledge} from "../src/knowledge/retriever.ts";
import {loadRelayContextSources} from "../src/knowledge/context-sources.ts";

function fixture(){
 const root=mkdtempSync(join(tmpdir(),"retrieval-privacy-")),store=createKnowledgeStore({dbPath:join(root,"knowledge.db")});store.grantAcl("p1",7,true);
 const now=new Date().toISOString();
 for(const id of ["case-1","case-2"])store.upsertDocument({id,kind:"case",title:`cache private_title_${id}`,body:`cache private_body_${id}`,lifecycle:"verified",projectId:"p1",environment:"nonprod",locator:`case:${id}`,createdAt:now,updatedAt:now});
 return {store,clean(){store.close();rmSync(root,{recursive:true,force:true});}};
}
function telemetry(store:ReturnType<typeof createKnowledgeStore>){return JSON.stringify({runs:store.db.prepare("SELECT * FROM knowledge_retrieval_runs").all(),audit:store.db.prepare("SELECT entity_id,details_json FROM knowledge_audit WHERE action='knowledge.search'").all()});}

test("retrieval telemetry excludes request and result content while preserving response and run identity",async()=>{
 const f=fixture(),query="cache private_query_sentinel 🔬";try{
  const result=await searchKnowledge(f.store,{userId:7,projectId:"p1",query,environment:"nonprod",providers:{embedding:undefined,rerank:{capabilities:{modelId:"fixture-rerank",dataPolicy:"local"},async rerank(_query,documents){return documents.map(d=>({id:d.id,score:0.75,reason:query+" private_reason_sentinel"}));}}}});
  assert.equal(result.query,query);assert.equal(result.results.length,2);assert.match(result.results[0].summary,/private_body/);assert.ok(result.results[0].matchReasons.some(x=>x.includes("private_reason_sentinel")));
  const saved=f.store.db.prepare("SELECT * FROM knowledge_retrieval_runs WHERE id=?").get(result.retrievalRunId) as any;
  assert.doesNotMatch(telemetry(f.store),/private_query|private_body|private_title|private_reason|queryTokens|matchReasons/);
  const hash=createHash("sha256").update(query).digest("hex"),metadata=JSON.parse(saved.results_json);
  assert.equal(saved.query,"sha256:"+hash);assert.equal(metadata.schemaVersion,1);assert.equal(metadata.queryHash,hash);assert.equal(metadata.queryLength,[...query].length);assert.equal(metadata.resultCount,2);assert.ok(metadata.latencyMs>=0);
  assert.deepEqual(metadata.results.map((x:any)=>x.id),result.results.map(x=>x.id));assert.equal(metadata.results[0].score,0.75);assert.equal(metadata.results[0].applicability.environment,"nonprod");assert.equal(metadata.rerankModelId,"fixture-rerank");
  const audit=f.store.db.prepare("SELECT entity_id,details_json FROM knowledge_audit WHERE action='knowledge.search'").get() as any;assert.equal(audit.entity_id,result.retrievalRunId);assert.equal(JSON.parse(audit.details_json).queryHash,hash);
 }finally{f.clean();}
});

test("ContextPack expanded objectives and actions never enter retrieval telemetry",async()=>{
 const f=fixture();try{
  const result=await loadRelayContextSources({store:f.store,userId:7,projectId:"p1",query:"cache private_question",intent:{objective:"private_objective",actions:["private_action"]},limit:10});
  assert.equal(result.confirmedKnowledge.length,2);assert.match(result.confirmedKnowledge[0].summary,/private_body/);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM knowledge_retrieval_runs").get().n,3);
  assert.doesNotMatch(telemetry(f.store),/private_question|private_objective|private_action|private_body|private_title|queryTokens/);
 }finally{f.clean();}
});

test("privacy-safe new telemetry does not delete historical run records",async()=>{
 const f=fixture();try{
  f.store.db.prepare("INSERT INTO knowledge_retrieval_runs(id,project_id,query,degraded,results_json,created_at) VALUES ('legacy','p1','legacy private request',0,'[{\"summary\":\"legacy body\"}]','old')").run();
  const before=f.store.db.prepare("SELECT * FROM knowledge_retrieval_runs WHERE id='legacy'").get();
  await searchKnowledge(f.store,{userId:7,projectId:"p1",query:"unmatched privacy_sentinel",providers:{embedding:undefined,rerank:undefined}});
  assert.deepEqual(f.store.db.prepare("SELECT * FROM knowledge_retrieval_runs WHERE id='legacy'").get(),before);
  const latest=f.store.db.prepare("SELECT query,results_json FROM knowledge_retrieval_runs WHERE id<>'legacy'").get() as any;assert.doesNotMatch(JSON.stringify(latest),/privacy_sentinel/);assert.equal(JSON.parse(latest.results_json).resultCount,0);
 }finally{f.clean();}
});
