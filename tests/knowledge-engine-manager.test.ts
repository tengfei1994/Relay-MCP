import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,writeFileSync,rmSync,readFileSync,unlinkSync } from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createKnowledgeStore} from "../src/knowledge/store.ts";
import {ProviderRegistry} from "../src/knowledge/provider-registry.ts";
import {KnowledgeEngineManager} from "../src/knowledge/engine-manager.ts";

test("bootstrap owns upstream models and KB, survives restart, and exposes no credentials",async()=>{
  const home=mkdtempSync(join(tmpdir(),"engine-manager-"));
  writeFileSync(join(home,"engine.json"),JSON.stringify({schemaVersion:1,version:"v0.8.3",baseUrl:"http://127.0.0.1:18190",relayGatewayUrl:"http://127.0.0.1:3000/internal/knowledge-engine/v1",gatewayToken:"internal-private-token",ownerEmail:"engine@localhost.invalid",ownerPassword:"private-owner-password"}));
  const store=createKnowledgeStore({dbPath:join(home,"knowledge.db")});
  const registry=new ProviderRegistry(store);
  registry.upsert({id:"embed",kind:"embedding",provider:"test",baseUrl:"https://provider.test/v1",modelId:"real-secret-model",dimensions:3,actorId:1});
  registry.markTest("embed",{ok:true});
  let failModels=false;
  const calls:any[]=[];const models:any[]=[];const bases:any[]=[];
  const fetchImpl=(async(url,init)=>{
    const path=new URL(String(url)).pathname,method=init?.method??"GET";
    const body=init?.body?JSON.parse(String(init.body)):undefined;
    calls.push({path,method,body,headers:new Headers(init?.headers)});
    if(path.endsWith("/auth/login"))return Response.json({success:true,token:"jwt-private",active_tenant:{id:1}});
    if(path.endsWith("/api-keys"))return Response.json({success:true,data:{token:"api-private"}});
    assert.equal(new Headers(init?.headers).get("X-API-Key"),"api-private");
    if(path==="/api/v1/models"&&method==="POST"&&failModels)return Response.json({error:"failure"},{status:503});
    if(path==="/api/v1/models"){if(method==="POST"){const m={id:"m"+models.length,...body};models.push(m);return Response.json({success:true,data:m});}return Response.json({success:true,data:models});}
    if(path.startsWith("/api/v1/models/")){
      const id=path.split("/")[4],model=models.find(x=>x.id===id);
      if(path.endsWith("/credentials")){
        if(method==="PUT")model.parameters.api_key=body.api_key;
        return Response.json({success:true,data:{fields:{api_key:{configured:!!model.parameters.api_key}}}});
      }
      if(method==="PUT"){const key=model.parameters.api_key;Object.assign(model,body);model.parameters.api_key=key;}
      return Response.json({success:true,data:model});
    }    if(path==="/api/v1/knowledge-bases"){if(method==="POST"){const b={id:"kb"+bases.length,...body};bases.push(b);return Response.json({success:true,data:b});}return Response.json({success:true,data:bases});}
    if(path.startsWith("/api/v1/knowledge-bases/")){
      const base=bases.find(x=>path.endsWith(x.id));
      if(method==="PUT"&&body.config)Object.assign(base,body.config);
      return Response.json({success:true,data:base});
    }
    throw new Error("Unexpected request "+path);
  }) as typeof fetch;
  try{
    let manager=new KnowledgeEngineManager({home,registry,fetchImpl});
    const first=await manager.initialize({actorId:1});
    assert.equal(first.phase,"ready");assert.equal(first.wikiReady,false);assert.equal(first.embeddingProviderId,"embed");
    assert.equal(models.length,1);assert.equal(bases.length,1);
    assert.equal(models[0].parameters.api_key,"internal-private-token");
    assert.equal(models[0].name.includes("real-secret-model"),false);
    assert.equal(models[0].parameters.base_url,"http://127.0.0.1:3000/internal/knowledge-engine/v1");
    assert.doesNotMatch(JSON.stringify(first),/private|ownerPassword|apiKey|gatewayToken/);
    manager=new KnowledgeEngineManager({home,registry,fetchImpl});
    await manager.initialize({actorId:1});
    assert.equal(models.length,1);assert.equal(bases.length,1);
    registry.upsert({id:"chat",kind:"wiki_llm",provider:"test",modelId:"chat-model",actorId:1});
    const withWiki=await manager.initialize({actorId:1});
    assert.equal(withWiki.wikiReady,true);
    assert.equal(bases[0].indexing_strategy.wiki_enabled,true,"existing KB must actually enable Wiki");
    writeFileSync(join(home,"initialize.lock"),JSON.stringify({pid:999999999}));
    await manager.initialize({actorId:1});
    writeFileSync(join(home,"initialize.lock"),JSON.stringify({pid:process.pid}));
    await assert.rejects(manager.initialize({actorId:1}),/locked/);
    unlinkSync(join(home,"initialize.lock"));
    registry.upsert({id:"embed",kind:"embedding",provider:"test",modelId:"next",dimensions:4,actorId:1});
    assert.equal(manager.status().phase,"stale");
    failModels=true;
    await assert.rejects(manager.initialize({actorId:1}));
    assert.notEqual(manager.status().phase,"ready","failed reconciliation must not combine old KB with new bindings");
    await assert.rejects(manager.request("GET","/api/v1/knowledge-bases/kb0"));
    failModels=false;
    await manager.initialize({actorId:1});
    assert.equal(bases.length,2);
    assert.equal(registry.get("embed")?.reindexRequired,true,"bootstrap must not claim existing docs were reindexed");
    assert.ok(JSON.parse(readFileSync(join(home,"control.json"),"utf8")).apiKey);
  }finally{store.close();rmSync(home,{recursive:true,force:true});}
});

async function reconciliationFixture(fn:(f:any)=>Promise<void>){
  const home=mkdtempSync(join(tmpdir(),"engine-reconcile-"));
  const runtime={schemaVersion:1,version:"v0.8.3",baseUrl:"http://127.0.0.1:18190",relayGatewayUrl:"http://127.0.0.1:3000/internal/knowledge-engine/v1",gatewayToken:"original-internal-token",ownerEmail:"engine@localhost.invalid",ownerPassword:"private-password"};
  const saveRuntime=()=>writeFileSync(join(home,"engine.json"),JSON.stringify(runtime));saveRuntime();
  const store=createKnowledgeStore({dbPath:join(home,"knowledge.db")}),registry=new ProviderRegistry(store);
  registry.upsert({id:"embedding",kind:"embedding",provider:"test",baseUrl:"https://provider.test/v1",modelId:"real-embedding",dimensions:3,actorId:1});
  const calls:any[]=[],models:any[]=[],bases:any[]=[];let corruptReadback:Record<string,unknown>|undefined;let credentialConfigured=true;
  const view=(model:any)=>({...model,parameters:Object.fromEntries(Object.entries(model.parameters).filter(([key])=>key!=="api_key"))});
  const fetchImpl=(async(url,init)=>{
    const path=new URL(String(url)).pathname,method=init?.method??"GET",body=init?.body?JSON.parse(String(init.body)):undefined;
    calls.push({path,method,body});
    if(path.endsWith("/auth/login"))return Response.json({success:true,token:"jwt",active_tenant:{id:1}});
    if(path.endsWith("/api-keys"))return Response.json({success:true,data:{token:"api-key"}});
    if(path==="/api/v1/models"){
      if(method==="POST"){const model={id:`m${models.length}`,...body};models.push(model);return Response.json({success:true,data:view(model)});}
      return Response.json({success:true,data:models.map(view)});
    }
    if(path.startsWith("/api/v1/models/")){
      const model=models.find(x=>x.id===path.split("/")[4]);assert.ok(model);
      if(path.endsWith("/credentials")){
        assert.equal(method,"PUT");assert.deepEqual(Object.keys(body),["api_key"]);
        if(credentialConfigured)model.parameters.api_key=body.api_key;
        return Response.json({success:true,data:{fields:{api_key:{configured:credentialConfigured}}}});
      }
      if(method==="PUT"){
        // v0.8.3 ignores credentials in ordinary model PUT; rotation has its own subresource.
        assert.equal(body.parameters.api_key,undefined);
        const key=model.parameters.api_key;Object.assign(model,body);model.parameters.api_key=key;
      }
      return Response.json({success:true,data:{...view(model),...(method==="GET"?corruptReadback:{})}});
    }
    if(path==="/api/v1/knowledge-bases"){
      if(method==="POST"){const base={id:`kb${bases.length}`,...body};bases.push(base);return Response.json({success:true,data:base});}
      return Response.json({success:true,data:bases});
    }
    if(path.startsWith("/api/v1/knowledge-bases/")){
      const base=bases.find(x=>x.id===path.split("/")[4]);assert.ok(base);
      if(method==="PUT")Object.assign(base,body.config??{});
      return Response.json({success:true,data:base});
    }
    throw new Error("Unexpected contract fixture request");
  }) as typeof fetch;
  const manager=new KnowledgeEngineManager({home,registry,fetchImpl});
  try{await manager.initialize({actorId:1});await fn({manager,runtime,saveRuntime,models,bases,calls,setReadback:(value:Record<string,unknown>)=>{corruptReadback=value;},denyCredentials:()=>{credentialConfigured=false;}});}
  finally{store.close();rmSync(home,{recursive:true,force:true});}
}

test("existing model aliases reconcile gateway URL and token through the actual credential subresource",()=>reconciliationFixture(async({manager,runtime,saveRuntime,models,bases,calls})=>{
  const id=models[0].id,alias=models[0].name;
  runtime.relayGatewayUrl="http://127.0.0.1:18300/internal/knowledge-engine/v1";runtime.gatewayToken="rotated-internal-token";saveRuntime();
  const ready=await manager.initialize({actorId:1});
  assert.equal(ready.phase,"ready");assert.equal(models.length,1);assert.equal(bases.length,1);
  assert.equal(models[0].id,id);assert.equal(models[0].name,alias);assert.equal(models[0].type,"Embedding");
  assert.equal(models[0].parameters.embedding_parameters.dimension,3);
  assert.equal(models[0].parameters.base_url,runtime.relayGatewayUrl);
  assert.equal(models[0].parameters.api_key,runtime.gatewayToken);
  assert.ok(calls.some((c:any)=>c.method==="PUT"&&c.path===`/api/v1/models/${id}`));
  assert.ok(calls.some((c:any)=>c.method==="PUT"&&c.path===`/api/v1/models/${id}/credentials`));
  assert.ok(calls.some((c:any)=>c.method==="GET"&&c.path===`/api/v1/models/${id}`));
  assert.doesNotMatch(JSON.stringify(ready),/original-internal-token|rotated-internal-token|private-password|api-key/);
}));

test("existing alias with another type or vector dimension is rejected before mutation",async()=>{
  for(const mutate of [(model:any)=>{model.type="KnowledgeQA";},(model:any)=>{model.parameters.embedding_parameters.dimension=9;}]){
    await reconciliationFixture(async({manager,models,calls})=>{
      mutate(models[0]);calls.length=0;
      await assert.rejects(manager.initialize({actorId:1}),/engine_model.*(mismatch|invalid)/);
      assert.equal(manager.status().phase,"failed");
      assert.equal(calls.some((c:any)=>c.method==="PUT"),false);
    });
  }
});

test("model readback and credential confirmation must succeed before engine becomes ready",async()=>{
  for(const corrupt of [{name:"other-alias"},{type:"Rerank"},{parameters:{provider:"generic",base_url:"http://127.0.0.1:9999/v1",embedding_parameters:{dimension:3}}}]){
    await reconciliationFixture(async({manager,setReadback})=>{
      setReadback(corrupt);
      await assert.rejects(manager.initialize({actorId:1}),/engine_model.*verification/);
      assert.equal(manager.status().phase,"failed");
    });
  }
  await reconciliationFixture(async({manager,denyCredentials})=>{
    denyCredentials();
    await assert.rejects(manager.initialize({actorId:1}),/engine_model.*credential/);
    assert.equal(manager.status().phase,"failed");
  });
});
