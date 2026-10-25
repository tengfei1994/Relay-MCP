import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createKnowledgeStore,type KnowledgeStore} from "../src/knowledge/store.ts";
import {ProviderRegistry} from "../src/knowledge/provider-registry.ts";
import {admitProviderInvocation,inspectProviderAdmission} from "../src/knowledge/provider-admission.ts";

const run=promisify(execFile);
async function fixture(fn:(store:KnowledgeStore,path:string)=>Promise<void>) {
  const root=mkdtempSync(join(tmpdir(),"relay-provider-admission-"));const path=join(root,"knowledge.db");
  const store=createKnowledgeStore({dbPath:path});
  try {await fn(store,path);}finally{store.close();rmSync(root,{recursive:true,force:true});}
}
function configure(store:KnowledgeStore,maxCalls=2,windowMs=60_000) {
  new ProviderRegistry(store).upsert({id:"provider",kind:"candidate_llm",provider:"openai-compatible",baseUrl:"https://unit.invalid/v1",modelId:"unit-model",concurrency:1,maxRetries:0,quota:{maxCalls,windowMs},actorId:7});
}
async function childInvocation(path:string,operation="complete") {
  const source=`import {createKnowledgeStore} from ${JSON.stringify(new URL("../src/knowledge/store.ts",import.meta.url).href)};
    import {ProviderRegistry} from ${JSON.stringify(new URL("../src/knowledge/provider-registry.ts",import.meta.url).href)};
    const store=createKnowledgeStore({dbPath:process.argv[1]});let httpCalls=0;
    const registry=new ProviderRegistry(store,undefined,{fetchImpl:async()=>{httpCalls++;return new Response(JSON.stringify({choices:[{message:{content:'ok'}}]}),{status:200});}});
    try {const handle=registry.resolveCandidateProvider('provider');await (process.argv[2]==='probe'?handle.probe():handle.complete('unit input'));console.log(JSON.stringify({allowed:true,httpCalls}));}
    catch(error){console.log(JSON.stringify({allowed:false,httpCalls,code:error.code,retryAt:error.retryAt}));}finally{store.close();}`;
  const {stdout}=await run(process.execPath,["--import","tsx","--input-type=module","-e",source,path,operation],{timeout:15_000});
  return JSON.parse(stdout.trim()) as {allowed:boolean;httpCalls:number;code?:string;retryAt?:string};
}

test("provider admission budget is atomic across four independent processes",()=>fixture(async(store,path)=>{
  configure(store);
  const results=await Promise.all(Array.from({length:4},()=>childInvocation(path)));
  assert.equal(results.filter(row=>row.allowed).length,2);
  assert.equal(results.reduce((n,row)=>n+row.httpCalls,0),2);
  for(const result of results.filter(row=>!row.allowed)){assert.equal(result.code,"provider_quota_exceeded");assert.ok(Number.isFinite(Date.parse(result.retryAt!)));}
}));

test("provider budget survives process exit and probe shares the same admission limit",()=>fixture(async(store,path)=>{
  configure(store,1);
  assert.equal((await childInvocation(path,"probe")).allowed,true);
  const denied=await childInvocation(path);
  assert.equal(denied.allowed,false);assert.equal(denied.httpCalls,0);assert.equal(denied.code,"provider_quota_exceeded");
}));

test("rolling admission rejects without recording and expires at the exact safe boundary",()=>fixture(async(store)=>{
  configure(store);const at=Date.now();
  assert.equal(admitProviderInvocation(store,"provider",new Date(at)).remaining,1);
  assert.equal(admitProviderInvocation(store,"provider",new Date(at+1000)).remaining,0);
  const exhausted=inspectProviderAdmission(store,"provider",new Date(at+2000));
  assert.deepEqual(exhausted,{used:2,remaining:0,maxCalls:2,windowMs:60000,reason:"rolling_quota",nextAvailableAt:new Date(at+60000).toISOString()});
  for(let i=0;i<3;i++)assert.throws(()=>admitProviderInvocation(store,"provider",new Date(at+2000)),(error:any)=>error.code==="provider_quota_exceeded"&&error.retryAt===exhausted.nextAvailableAt);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_provider_admissions").get() as {n:number}).n,2);
  assert.equal(admitProviderInvocation(store,"provider",new Date(at+60000)).used,2);
  assert.equal(inspectProviderAdmission(store,"provider",new Date(at-1000)).remaining,0,"clock rollback cannot create a fresh allowance");
}));

test("current config changes and disablement apply across stores without resetting usage",()=>fixture(async(store,path)=>{
  configure(store,3);const at=Date.now();const other=createKnowledgeStore({dbPath:path});
  try {
    for(let i=0;i<3;i++)admitProviderInvocation(store,"provider",new Date(at+i*1000));
    configure(other,1);
    const reduced=inspectProviderAdmission(store,"provider",new Date(at+3000));
    assert.equal(reduced.used,3);assert.equal(reduced.remaining,0);assert.equal(reduced.nextAvailableAt,new Date(at+62000).toISOString());
    assert.throws(()=>admitProviderInvocation(store,"provider",new Date(at+61000)),(error:any)=>error.code==="provider_quota_exceeded");
    new ProviderRegistry(other).disable("provider",7);
    assert.throws(()=>admitProviderInvocation(store,"provider",new Date(at+63000)),(error:any)=>error.code==="provider_disabled");
    configure(other,1);assert.equal(admitProviderInvocation(store,"provider",new Date(at+63000)).used,1);
  } finally {other.close();}
}));

test("unlimited invocations are retained when a quota is subsequently configured",()=>fixture(async(store)=>{
  configure(store);store.db.prepare("UPDATE knowledge_provider_configs SET quota_max_calls=NULL,quota_window_ms=NULL WHERE id='provider'").run();
  const at=Date.now();const first=admitProviderInvocation(store,"provider",new Date(at));
  assert.equal(first.remaining,null);assert.equal(first.used,1);
  configure(store,1);assert.equal(inspectProviderAdmission(store,"provider",new Date(at+1)).remaining,0);
}));

test("044 upgrade preserves an explicit barrier for uncounted legacy usage across reopen",()=>fixture(async(store,path)=>{
  configure(store,2);
  store.db.exec("DROP TABLE knowledge_provider_admissions; DROP TABLE knowledge_provider_admission_barriers; DELETE FROM schema_migrations WHERE version='044-provider-admission';");
  const started=Date.now();store.migrate();const finished=Date.now();
  const initial=inspectProviderAdmission(store,"provider");
  assert.equal(initial.used,0);assert.equal(initial.remaining,0);assert.equal(initial.reason,"upgrade_barrier");
  assert.ok(Date.parse(initial.nextAvailableAt!)>=started+60000);
  assert.ok(Date.parse(initial.nextAvailableAt!)<=finished+61000);
  const other=createKnowledgeStore({dbPath:path});
  try {
    const again=inspectProviderAdmission(other,"provider");assert.equal(again.nextAvailableAt,initial.nextAvailableAt);
    assert.throws(()=>admitProviderInvocation(other,"provider"),(error:any)=>error.reason==="upgrade_barrier"&&error.retryAt===initial.nextAvailableAt);
    assert.equal(admitProviderInvocation(other,"provider",new Date(initial.nextAvailableAt!)).remaining,1);
    assert.equal((other.db.prepare("SELECT COUNT(*) AS n FROM knowledge_provider_admission_barriers").get() as {n:number}).n,1);
  } finally {other.close();}
}));

test("admission counts one logical invocation with retries and stores no input or token data",()=>fixture(async(store)=>{
  configure(store);let requests=0;
  store.db.prepare("UPDATE knowledge_provider_configs SET max_retries=1 WHERE id='provider'").run();
  const registry=new ProviderRegistry(store,undefined,{policy:{retryBaseMs:10},fetchImpl:async()=>{
    requests++;return requests===1?new Response("unit provider transient error",{status:503}):new Response(JSON.stringify({choices:[{message:{content:"unit answer"}}]}),{status:200});
  }});
  await registry.resolveCandidateProvider("provider").complete("private request canary");
  assert.equal(requests,2);assert.equal(inspectProviderAdmission(store,"provider").used,1);
  const rows=store.db.prepare("SELECT * FROM knowledge_provider_admissions").all() as Record<string,unknown>[];
  assert.deepEqual(Object.keys(rows[0]).sort(),["admitted_at","id","provider_id"]);assert.doesNotMatch(JSON.stringify(rows),/private request|unit answer/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(registry.resolveCandidateProvider("provider").chat([{role:"user",content:"never send"}],1,undefined,{signal:controller.signal}));
  assert.equal(inspectProviderAdmission(store,"provider").used,1);assert.equal(requests,2);
}));

test("circuit rejection has no HTTP or durable admission and recovery does not refund history",()=>fixture(async(store)=>{
 configure(store,100);let requests=0,now=Date.now();
 const registry=new ProviderRegistry(store,()=>new Date(now),{policy:{now:()=>now,circuitFailureThreshold:1,circuitCooldownMs:100},fetchImpl:async()=>{requests++;return requests===1?new Response('{}',{status:503,headers:{'content-type':'application/json'}}):new Response(JSON.stringify({choices:[{message:{content:'ok'}}]}),{status:200});}});
 const handle=registry.resolveCandidateProvider('provider');
 await assert.rejects(handle.complete('private initial request'),(error:any)=>error.code==='unavailable');
 const initial=store.db.prepare('SELECT * FROM knowledge_provider_admissions').all();assert.equal(initial.length,1);
 for(let n=0;n<3;n++)await assert.rejects(handle.complete('private blocked request'),(error:any)=>error.code==='provider_circuit_open');
 assert.equal(requests,1);assert.deepEqual(store.db.prepare('SELECT * FROM knowledge_provider_admissions').all(),initial);
 now+=101;await handle.complete('private recovery request');assert.equal(requests,2);assert.equal(inspectProviderAdmission(store,'provider',new Date(now)).used,2);
 assert.deepEqual(store.db.prepare('SELECT * FROM knowledge_provider_admissions ORDER BY admitted_at LIMIT 1').get(),initial[0]);
}));

test("cancelled concurrency waiter is not admitted before actual policy execution",()=>fixture(async(store)=>{
 configure(store,100);let requests=0,release:()=>void=()=>{};
 const registry=new ProviderRegistry(store,undefined,{fetchImpl:async()=>{requests++;await new Promise<void>(resolve=>{release=resolve;});return new Response(JSON.stringify({choices:[{message:{content:'ok'}}]}),{status:200});}});
 const handle=registry.resolveCandidateProvider('provider'),first=handle.complete('first private input');
 await new Promise(resolve=>setImmediate(resolve));const controller=new AbortController();
 const waiting=handle.chat([{role:'user',content:'queued private input'}],1,undefined,{signal:controller.signal});
 await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(waiting);
 try{assert.equal(requests,1);assert.equal(inspectProviderAdmission(store,'provider').used,1);}finally{release();await first;}
}));

test("provider error audit retains exact HTTP status and allowlisted code without raw diagnostics",()=>fixture(async(store)=>{
 configure(store,100);let requests=0;const privateToken='private_credential_canary',privateInput='private_request_canary';
 store.db.prepare("UPDATE knowledge_provider_configs SET secret_ref='env://test' WHERE id='provider'").run();
 const registry=new ProviderRegistry(store,undefined,{secrets:{resolve:async()=>privateToken},policy:{circuitFailureThreshold:20},fetchImpl:async()=>{
  requests++;return new Response(JSON.stringify({error:{code:requests===3?privateInput:'invalid_api_key',message:privateToken+' '+privateInput,request_id:privateToken}}),{status:requests===1?401:403,headers:{'content-type':'application/json'}});
 }});
 for(let n=0;n<3;n++)await assert.rejects(registry.resolveCandidateProvider('provider').complete(privateInput),(error:any)=>error.code==='unauthorized');
 const rows=store.db.prepare("SELECT details_json FROM knowledge_audit WHERE action='knowledge.provider.invoke_error' ORDER BY rowid").all() as Array<{details_json:string}>;
 const details=rows.map(row=>JSON.parse(row.details_json));
 assert.deepEqual(details.map(row=>row.httpStatus),[401,403,403]);
 assert.equal(details[0].upstreamErrorCode,'invalid_api_key');assert.equal(details[0].reason,'authentication_failed');assert.equal(details[2].upstreamErrorCode,undefined);
 assert.doesNotMatch(JSON.stringify(details),/private_|requestId|message|responseBody|prompt/);
 assert.deepEqual(Object.keys(details[0]).sort(),['request','errorCode','httpStatus','upstreamErrorCode','reason'].sort());
}));

test("repeated durable quota rejection stays retryable at expiry without opening an upstream circuit",()=>fixture(async(store)=>{
 configure(store,1,1000);let requests=0,now=Date.now();
 const registry=new ProviderRegistry(store,()=>new Date(now),{policy:{now:()=>now,circuitFailureThreshold:3,circuitCooldownMs:30000},fetchImpl:async()=>{requests++;return new Response(JSON.stringify({choices:[{message:{content:'ok'}}]}),{status:200});}});
 const handle=registry.resolveCandidateProvider('provider');await handle.complete('private first input');
 for(let n=0;n<5;n++)await assert.rejects(handle.complete('private over-quota input'),(error:any)=>error.code==='provider_quota_exceeded'&&Number.isFinite(Date.parse(error.retryAt)));
 assert.equal(requests,1);assert.equal(handle.health().state,'closed');assert.equal(handle.health().consecutiveFailures,0);
 now+=1000;await handle.complete('private after-expiry input');assert.equal(requests,2);assert.equal(inspectProviderAdmission(store,'provider',new Date(now)).used,1);
}));

test("queued invocations recheck a newly opened circuit before HTTP or durable admission",()=>fixture(async(store)=>{
 configure(store,100);let requests=0,now=Date.now(),release:()=>void=()=>{};
 const registry=new ProviderRegistry(store,()=>new Date(now),{policy:{now:()=>now,circuitFailureThreshold:1,circuitCooldownMs:100},fetchImpl:async()=>{
  requests++;if(requests===1){await new Promise<void>(resolve=>{release=resolve;});return Response.json({error:{code:'invalid_api_key'}},{status:403});}
  return Response.json({choices:[{message:{content:'ok'}}]});
 }});
 const handle=registry.resolveCandidateProvider('provider');const first=handle.complete('private first');
 await new Promise(resolve=>setImmediate(resolve));
 const queued=Array.from({length:3},()=>handle.complete('private queued'));
 const all=Promise.allSettled([first,...queued]);await new Promise(resolve=>setImmediate(resolve));assert.equal(requests,1);release();
 const results=await all;assert.equal(results[0].status,'rejected');
 for(const result of results.slice(1)){assert.equal(result.status,'rejected');if(result.status==='rejected')assert.equal(result.reason.code,'provider_circuit_open');}
 assert.equal(requests,1);assert.equal(inspectProviderAdmission(store,'provider',new Date(now)).used,1);assert.equal(handle.health().totalFailures,1);
 now+=100;await handle.complete('private recovery');assert.equal(requests,2);assert.equal(inspectProviderAdmission(store,'provider',new Date(now)).used,2);
}));
