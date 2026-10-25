import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createKnowledgeStore,type KnowledgeStore} from "../src/knowledge/store.ts";
import {ProviderRegistry} from "../src/knowledge/provider-registry.ts";
import {managedControlPlane} from "../src/knowledge/engine-service.ts";
import {writeEngineControl} from "../src/knowledge/engine-config.ts";

const source={idempotencyKey:"frozen",title:"Guide",content:"Source text",parserVersion:"v1"};
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{"content-type":"application/json"}});
async function fixture(change:(store:KnowledgeStore)=>void,beforeUpload=false){
  const root=mkdtempSync(join(tmpdir(),"engine-binding-")),priorHome=process.env.KNOWLEDGE_ENGINE_HOME,priorFetch=globalThis.fetch;
  process.env.KNOWLEDGE_ENGINE_HOME=root;
  const store=createKnowledgeStore({dbPath:join(root,"knowledge.db")});
  try {
    new ProviderRegistry(store).upsert({id:"embedding",kind:"embedding",provider:"test",baseUrl:"https://unit.invalid/v1",modelId:"model",dimensions:2,actorId:1});
    writeFileSync(join(root,"engine.json"),JSON.stringify({schemaVersion:1,version:"0.8.3",baseUrl:"http://127.0.0.1:9999",relayGatewayUrl:"http://127.0.0.1:9998",gatewayToken:"fake",ownerEmail:"fake@invalid.test",ownerPassword:"fake"}));
    writeEngineControl(root,{schemaVersion:1,phase:"ready",knowledgeBaseId:"kb",ingestionProfile:"bulk",bindings:[{providerId:"embedding",kind:"embedding",modelId:"model",dimensions:2,indexVersion:1,alias:"relay-model",engineModelId:"engine-model"}]});
    let posts=0;
    globalThis.fetch=async(url,init)=>{
      if(init?.method==="POST"){
        posts++;const form=init.body as FormData;
        return json({data:{id:"accepted",knowledge_base_id:"kb",channel:form.get("channel"),metadata:JSON.parse(String(form.get("metadata"))),parse_status:"completed"}});
      }
      if(String(url).includes("/chunks/")){
        change(store);
        return json({data:[{id:"chunk",knowledge_id:"accepted",content:"Source text",chunk_type:"text",index_status:"ready"}],total:1});
      }
      return json({data:{id:"accepted",knowledge_base_id:"kb",parse_status:"completed"}});
    };
    const plane=managedControlPlane(store);
    if(beforeUpload)change(store);
    await assert.rejects(plane.ingestor.stage(source),/configuration changed/);
    assert.equal(plane.manager.status().phase,"stale");
    const row=store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE idempotency_key=?").get(source.idempotencyKey) as Record<string,unknown>;
    assert.equal(row.upstream_verified_at,null);assert.equal(row.status,"failed");
    assert.equal(row.failure_code,"ingestion_configuration_changed");
    assert.equal(posts,beforeUpload?0:1);
    if(!beforeUpload)assert.equal(row.external_document_id,"accepted");
    await assert.rejects(plane.ingestor.stage(source,{retry:true}),/configuration changed/);
    assert.equal(posts,beforeUpload?0:1,"stale retries cannot upload again");
  }finally{
    globalThis.fetch=priorFetch;
    if(priorHome===undefined)delete process.env.KNOWLEDGE_ENGINE_HOME;else process.env.KNOWLEDGE_ENGINE_HOME=priorHome;
    store.close();rmSync(root,{recursive:true,force:true});
  }
}

test("disabled embedding provider during chunk verification cannot certify the frozen upload",()=>fixture(store=>{
  store.db.prepare("UPDATE knowledge_provider_configs SET status='disabled' WHERE id='embedding'").run();
}));
test("changed embedding model generation during chunk verification cannot certify old vectors",()=>fixture(store=>{
  store.db.prepare("UPDATE knowledge_provider_configs SET model_id='new-model',index_version=2 WHERE id='embedding'").run();
}));
test("provider disabled after control-plane capture prevents the first upload",()=>fixture(store=>{
  store.db.prepare("UPDATE knowledge_provider_configs SET status='disabled' WHERE id='embedding'").run();
},true));


async function optionalFixture(profile:"standard"|"bulk",run:(f:any)=>Promise<void>){
 const root=mkdtempSync(join(tmpdir(),"engine-optional-")),priorHome=process.env.KNOWLEDGE_ENGINE_HOME,priorFetch=globalThis.fetch;
 process.env.KNOWLEDGE_ENGINE_HOME=root;const store=createKnowledgeStore({dbPath:join(root,"knowledge.db")});
 try{
  const registry=new ProviderRegistry(store),calls:any[]=[];
  for(const [id,kind] of [["embedding","embedding"],["wiki","wiki_llm"],["rank","rerank"]] as const)registry.upsert({id,kind,provider:"test",modelId:id+"-model",...(kind==="embedding"?{dimensions:2}:{}),actorId:1});
  writeFileSync(join(root,"engine.json"),JSON.stringify({schemaVersion:1,version:"0.8.3",baseUrl:"http://127.0.0.1:9999",relayGatewayUrl:"http://127.0.0.1:9998",gatewayToken:"fake",ownerEmail:"fake@invalid.test",ownerPassword:"fake"}));
  writeEngineControl(root,{schemaVersion:1,phase:"ready",apiKey:"fake",knowledgeBaseId:"kb",ingestionProfile:profile,bindings:registry.list().map(c=>({providerId:c.id,kind:c.kind,modelId:c.modelId,dimensions:c.dimensions,indexVersion:c.indexVersion,alias:"relay-"+c.id,engineModelId:"engine-"+c.id}))});
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),method:init?.method??"GET",processConfig:init?.body instanceof FormData?init.body.get("process_config"):undefined});
   if(String(url).endsWith("knowledge-search"))return json({data:[]});
   if(init?.method==="POST"){const form=init.body as FormData;return json({data:{id:"accepted",knowledge_base_id:"kb",channel:form.get("channel"),metadata:JSON.parse(String(form.get("metadata"))),parse_status:"completed"}});}
   if(String(url).includes("/chunks/"))return json({data:[{id:"chunk",knowledge_id:"accepted",content:"Source text",chunk_type:"text",index_status:"ready"}],total:1});
   return json({data:{id:"accepted",knowledge_base_id:"kb",parse_status:"completed"}});
  };
  await run({store,registry,calls,root});
 }finally{globalThis.fetch=priorFetch;if(priorHome===undefined)delete process.env.KNOWLEDGE_ENGINE_HOME;else process.env.KNOWLEDGE_ENGINE_HOME=priorHome;store.close();rmSync(root,{recursive:true,force:true});}
}
for(const optional of ["wiki","rank"])test(`bulk Product read and upload tolerate disabled optional ${optional}`,()=>optionalFixture("bulk",async({store,registry,calls})=>{
 registry.disable(optional,1);const plane=managedControlPlane(store);assert.equal(plane.manager.status().phase,"ready");
 await plane.client.search({query:"fixture",knowledgeIds:["accepted"]});
 const result=await plane.ingestor.stage(source);assert.equal(result.status,"staged");assert.ok(result.upstreamVerifiedAt);
 const upload=calls.find((c:any)=>c.processConfig);assert.ok(upload);assert.deepEqual(JSON.parse(upload.processConfig),{summary_enabled:false,question_generation_config:{enabled:false}});
}));
for(const mutation of ["disabled","model_changed","binding_changed"] as const)test(`standard synthesis independently gates ${mutation} Wiki after plane creation while Product reads remain available`,()=>optionalFixture("standard",async({store,registry,calls,root})=>{
 const plane=managedControlPlane(store);
 if(mutation==="disabled")registry.disable("wiki",1);
 else if(mutation==="model_changed")registry.upsert({id:"wiki",kind:"wiki_llm",provider:"test",modelId:"changed",actorId:1});
 else {const current=plane.manager.control();writeEngineControl(root,{...current,bindings:current.bindings.map((b:any)=>b.kind==="wiki_llm"?{...b,engineModelId:"another-upstream-model"}:b)});}
 assert.equal(plane.manager.status().phase,"ready");
 await plane.client.search({query:"fixture",knowledgeIds:["accepted"]});calls.length=0;
 await assert.rejects(plane.ingestor.stage(source),/configuration changed/);assert.equal(calls.length,0,"unavailable synthesis must be rejected before upload");
}));
test("disabled rerank does not block standard synthesis with compatible Wiki",()=>optionalFixture("standard",async({store,registry})=>{
 registry.disable("rank",1);const plane=managedControlPlane(store);assert.equal(plane.manager.status().wikiReady,true);assert.equal((await plane.ingestor.stage(source)).status,"staged");
}));
