import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { ProviderRegistry } from "../src/knowledge/provider-registry.ts";
import { registerEngineModelGateway } from "../src/knowledge/engine-model-gateway.ts";
import { callOpenAiChat } from "../src/knowledge/provider-probe.ts";

async function fixture(run: (f: { app: ReturnType<typeof Fastify>; calls: any[]; registry: ProviderRegistry; baseUrl: string }) => Promise<void>) {
 const calls: any[]=[];
 const server=createServer(async(req,res)=>{
  let raw="";for await(const chunk of req)raw+=chunk;
  calls.push(JSON.parse(raw));res.setHeader("content-type","application/json");
  res.end(JSON.stringify({choices:[{message:{content:"Synthetic fixture response"},finish_reason:"stop"}]}));
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
 const dir=mkdtempSync(join(tmpdir(),"wiki-sampling-"));const store=createKnowledgeStore({dbPath:join(dir,"knowledge.db")});
 const registry=new ProviderRegistry(store,undefined,{secrets:{resolve:async()=>"fixture-token"}});
 registry.upsert({id:"wiki",kind:"wiki_llm",provider:"bailian",baseUrl,modelId:"fixture-qwen",secretRef:"fixture:token",actorId:1,maxRetries:0});
 const app=Fastify();await registerEngineModelGateway(app,{registry,token:()=>"fixture-gateway",bindings:()=>[{providerId:"wiki",kind:"wiki_llm",modelId:"fixture-qwen",indexVersion:1,alias:"relay-wiki"}]});
 try {await run({app,calls,registry,baseUrl});}finally{await app.close();store.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));rmSync(dir,{recursive:true,force:true});}
}
const request={method:"POST",url:"/internal/knowledge-engine/v1/chat/completions",headers:{authorization:"Bearer fixture-gateway"}} as const;
const messages=[{role:"system",content:"Synthetic source grounding policy"},{role:"user",content:"Synthetic source fact"}];

test("Wiki gateway transports requested sampling and native thinking dialects to actual provider HTTP",()=>fixture(async({app,calls})=>{
 for(const [temperature,thinking,expectedThinking] of [[0.3,{enable_thinking:false},false],[0,{thinking:{type:"disabled"}},false],[2,{chat_template_kwargs:{enable_thinking:true}},true]] as const){
  const result=await app.inject({...request,payload:{model:"relay-wiki",messages,max_tokens:128,temperature,...thinking,arbitrary_private_field:"never-forward"}});
  assert.equal(result.statusCode,200);
  const actual=calls.at(-1);assert.equal(actual.temperature,temperature);assert.equal(actual.enable_thinking,expectedThinking);
  assert.deepEqual(actual.messages,messages);assert.equal(actual.max_tokens,128);
  assert.equal(actual.thinking,undefined);assert.equal(actual.chat_template_kwargs,undefined);assert.equal(actual.arbitrary_private_field,undefined);
 }
}));

test("omitted controls remain omitted for existing gateway and candidate handle callers",()=>fixture(async({app,calls,registry})=>{
 assert.equal((await app.inject({...request,payload:{model:"relay-wiki",messages}})).statusCode,200);
 await registry.resolveCandidateProvider("wiki").chat(messages,32,undefined,{timeoutMs:1000});
 for(const actual of calls){assert.equal(Object.hasOwn(actual,"temperature"),false);assert.equal(Object.hasOwn(actual,"enable_thinking"),false);}
}));

test("invalid or conflicting gateway controls fail safely before provider HTTP",()=>fixture(async({app,calls})=>{
 for(const invalid of [{temperature:-0.1},{temperature:2.1},{temperature:null},{temperature:"0.3"},{enable_thinking:"false"},{enable_thinking:null},{thinking:{type:"maybe"}},{thinking:{type:["enabled"]}},{thinking:{type:["disabled"]}},{thinking:false},{thinking:{type:"disabled",extra:"private-canary"}},{chat_template_kwargs:{enable_thinking:0}},{enable_thinking:false,thinking:{type:"enabled"}}]){
  const result=await app.inject({...request,payload:{model:"relay-wiki",messages,...invalid}});
  assert.equal(result.statusCode,400,JSON.stringify(invalid));assert.doesNotMatch(result.body,/private-canary|Synthetic source|fixture-token/);
 }
 assert.equal(calls.length,0);
}));

test("serializer rejects nonfinite and out-of-range sampling before any HTTP",()=>fixture(async({baseUrl,calls})=>{
 for(const temperature of [NaN,Infinity,-Infinity,-1,2.01,"0.3",null]){
  await assert.rejects(callOpenAiChat({baseUrl,modelId:"fixture-qwen",messages,temperature} as any),/invalid_chat_generation_options/);
 }
 await assert.rejects(callOpenAiChat({baseUrl,modelId:"fixture-qwen",messages,enableThinking:"false"} as any),/invalid_chat_generation_options/);
 assert.equal(calls.length,0);
}));
