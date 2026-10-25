import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { ProviderRegistry } from "../src/knowledge/provider-registry.ts";
import { registerEngineModelGateway } from "../src/knowledge/engine-model-gateway.ts";

async function fixture(fn: (f: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "engine-gateway-"));
  const store = createKnowledgeStore({ dbPath: join(dir,"knowledge.db") });
  const calls: any[] = [];
  let finishReason = "stop";
  const registry = new ProviderRegistry(store, undefined, { secrets: {resolve: async()=> "private-provider-token"}, fetchImpl: async (url, init) => {
    calls.push({url:String(url),body:JSON.parse(String(init?.body)),headers:init?.headers});
    return Response.json(String(url).endsWith("/embeddings") ? {data:[{index:0,embedding:[0.1,0.2]}],usage:{total_tokens:2}} : {choices:[{message:{content:"A useful long Wiki synthesis."},finish_reason:finishReason}],usage:{prompt_tokens:2,completion_tokens:8,total_tokens:10}});
  }});
  registry.upsert({id:"embedding",kind:"embedding",provider:"test",baseUrl:"https://provider.test/v1",modelId:"real-embedding",dimensions:2,secretRef:"test:token",actorId:1});
  registry.upsert({id:"chat",kind:"wiki_llm",provider:"test",baseUrl:"https://provider.test/v1",modelId:"real-chat",secretRef:"test:token",actorId:1});
  const bindings = [
    {providerId:"embedding",kind:"embedding",modelId:"real-embedding",dimensions:2,indexVersion:1,alias:"relay-embedding-v1"},
    {providerId:"chat",kind:"wiki_llm",modelId:"real-chat",indexVersion:1,alias:"relay-chat-v1"},
  ];
  const app = Fastify();
  await registerEngineModelGateway(app,{registry, token:()=> "internal-engine-token", bindings:()=>bindings});
  try {await fn({app,registry,calls,bindings,store,setFinishReason:(value:string)=>{finishReason=value;}});} finally {await app.close();store.close();rmSync(dir,{recursive:true,force:true});}
}
const headers = {authorization:"Bearer internal-engine-token"};
test("gateway rejects missing auth and unknown aliases without invoking a provider",()=>fixture(async({app,calls})=>{
  assert.equal((await app.inject({method:"POST",url:"/internal/knowledge-engine/v1/embeddings",payload:{model:"relay-embedding-v1",input:["text"]}})).statusCode,401);
  assert.equal((await app.inject({method:"POST",url:"/internal/knowledge-engine/v1/embeddings",headers,payload:{model:"unknown",input:["text"]}})).statusCode,403);
  assert.equal(calls.length,0);
}));
test("gateway uses live Relay credentials and blocks stale index or disabled provider",()=>fixture(async({app,registry,calls})=>{
  const request={method:"POST",url:"/internal/knowledge-engine/v1/embeddings",headers,payload:{model:"relay-embedding-v1",input:["text"]}} as const;
  const ok=await app.inject(request); assert.equal(ok.statusCode,200); assert.deepEqual(ok.json().data[0].embedding,[0.1,0.2]);
  assert.equal(calls[0].body.model,"real-embedding"); assert.doesNotMatch(ok.body,/private-provider-token/);
  registry.upsert({id:"embedding",kind:"embedding",provider:"test",baseUrl:"https://provider.test/v1",modelId:"different",dimensions:3,actorId:1});
  assert.equal((await app.inject(request)).statusCode,409); assert.equal(calls.length,1);
  registry.disable("chat",1);
  assert.equal((await app.inject({method:"POST",url:"/internal/knowledge-engine/v1/chat/completions",headers,payload:{model:"relay-chat-v1",messages:[{role:"user",content:"hi"}]}})).statusCode,503);
}));
test("Wiki completion preserves roles and token budget and supports the OpenAI stream envelope",()=>fixture(async({app,calls})=>{
  const messages=[{role:"system",content:"Return Wiki markdown"},{role:"user",content:"Write deployment guidance"}];
  const result=await app.inject({method:"POST",url:"/internal/knowledge-engine/v1/chat/completions",headers,payload:{model:"relay-chat-v1",messages,max_tokens:4096,stream:true,response_format:{type:"json_object"}}});
  assert.equal(result.statusCode,200);
  assert.match(result.headers["content-type"],/text\/event-stream/);
  assert.match(result.body,/data: \[DONE\]/);
  assert.deepEqual(calls[0].body.messages,messages);
  assert.equal(calls[0].body.max_tokens,4096);
  assert.deepEqual(calls[0].body.response_format,{type:"json_object"});
}));

test("gateway preserves provider truncation so Wiki can continue incomplete synthesis",()=>fixture(async({app,setFinishReason})=>{
  setFinishReason("length");
  const result=await app.inject({method:"POST",url:"/internal/knowledge-engine/v1/chat/completions",headers,payload:{model:"relay-chat-v1",messages:[{role:"user",content:"write"}]}});
  assert.equal(result.statusCode,200);assert.equal(result.json().choices[0].finish_reason,"length");
}));
