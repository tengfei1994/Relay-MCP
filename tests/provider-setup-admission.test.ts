import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createKnowledgeStore} from "../src/knowledge/store.ts";
import {ProviderRegistry} from "../src/knowledge/provider-registry.ts";
import {ProviderSetupService} from "../src/knowledge/provider-setup.ts";
import {admitProviderInvocation,inspectProviderAdmission} from "../src/knowledge/provider-admission.ts";

const input={id:"embedding",kind:"embedding" as const,provider:"test",baseUrl:"https://unit.invalid/v1",modelId:"model",actorId:1,token:"fake-new-token"};
async function fixture(run:(f:{store:ReturnType<typeof createKnowledgeStore>;service:ProviderSetupService;state:{modelCalls:number;discoveryCalls:number;fail:boolean};registry:ProviderRegistry})=>Promise<void>,existing=true){
  const dir=mkdtempSync(join(tmpdir(),"setup-admission-")),store=createKnowledgeStore({dbPath:join(dir,"knowledge.db")});
  const oldFetch=globalThis.fetch,oldKeyFile=process.env.PROVIDER_SECRET_KEY_FILE;
  process.env.PROVIDER_SECRET_KEY_FILE=join(dir,"private-key");
  const state={modelCalls:0,discoveryCalls:0,fail:false};
  globalThis.fetch=async url=>{
    if(String(url).endsWith("/models")){state.discoveryCalls++;return new Response(JSON.stringify({data:[{id:"model"}]}),{headers:{"content-type":"application/json"}});}
    state.modelCalls++;
    return new Response(JSON.stringify(state.fail?{error:{message:"fixture failure"}}:{data:[{index:0,embedding:[0.1,0.2]}]}),{status:state.fail?400:200,headers:{"content-type":"application/json"}});
  };
  try{
    const registry=new ProviderRegistry(store);
    if(existing)registry.upsert({...input,dimensions:2,quota:{maxCalls:1,windowMs:3600000}});
    await run({store,service:new ProviderSetupService(store),state,registry});
  }finally{
    globalThis.fetch=oldFetch;
    if(oldKeyFile===undefined)delete process.env.PROVIDER_SECRET_KEY_FILE;else process.env.PROVIDER_SECRET_KEY_FILE=oldKeyFile;
    store.close();rmSync(dir,{recursive:true,force:true});
  }
}

for(const action of ["configure","updateToken"] as const){
  const invoke=(service:ProviderSetupService)=>action==="configure"?service.configure(input):service.updateToken(input.id,input.token,input.actorId);
  test(`${action} cannot send a model probe after durable quota exhaustion`,()=>fixture(async({store,service,state})=>{
    admitProviderInvocation(store,input.id);
    await assert.rejects(invoke(service),(error:any)=>error.code==="provider_quota_exceeded"&&Boolean(error.retryAt));
    assert.equal(state.modelCalls,0);assert.equal(inspectProviderAdmission(store,input.id).used,1);
    assert.equal(state.discoveryCalls,action==="configure"?1:0);
  }));
  test(`${action} retains admission for failed probes and blocks their replay`,()=>fixture(async({store,service,state})=>{
    state.fail=true;
    await assert.rejects(invoke(service));
    assert.equal(state.modelCalls,1);assert.equal(inspectProviderAdmission(store,input.id).used,1);
    await assert.rejects(invoke(service),(error:any)=>error.code==="provider_quota_exceeded");
    assert.equal(state.modelCalls,1);
  }));
  test(`${action} successful probe preserves quota and the persisted admission`,()=>fixture(async({store,service,state,registry})=>{
    await invoke(service);
    assert.equal(state.modelCalls,1);assert.equal(inspectProviderAdmission(store,input.id).used,1);
    assert.deepEqual(registry.get(input.id)?.quota,{maxCalls:1,windowMs:3600000});
    await assert.rejects(invoke(service),(error:any)=>error.code==="provider_quota_exceeded");
    assert.equal(state.modelCalls,1);
  }));
}

test("model discovery is metadata only and never consumes model admission",()=>fixture(async({store,service,state})=>{
  await service.models(input);await service.models(input);
  assert.equal(state.discoveryCalls,2);assert.equal(state.modelCalls,0);assert.equal(inspectProviderAdmission(store,input.id).used,0);
}));
test("initial configuration has no existing provider quota before its first validated save",()=>fixture(async({store,service,state,registry})=>{
  await service.configure(input);
  assert.equal(state.modelCalls,1);assert.equal(state.discoveryCalls,1);assert.ok(registry.get(input.id));
  assert.equal(inspectProviderAdmission(store,input.id).maxCalls,null);
  assert.equal(inspectProviderAdmission(store,input.id).used,0);
},false));

for(const action of ['configure','updateToken'] as const){
 const invoke=(service:ProviderSetupService)=>action==='configure'?service.configure(input):service.updateToken(input.id,input.token,input.actorId);
 test(`${action} can validate a disabled provider without bypassing its durable allowance`,()=>fixture(async({store,service,state,registry})=>{
  registry.disable(input.id,1);
  assert.throws(()=>admitProviderInvocation(store,input.id),(error:any)=>error.code==='provider_disabled');
  await invoke(service);
  assert.equal(state.modelCalls,1);assert.equal(inspectProviderAdmission(store,input.id).used,1);assert.equal(registry.get(input.id)?.status,'ready');
  assert.deepEqual(registry.get(input.id)?.quota,{maxCalls:1,windowMs:3600000});
  await assert.rejects(invoke(service),(error:any)=>error.code==='provider_quota_exceeded');assert.equal(state.modelCalls,1);
 }));
 test(`${action} preserves disabled configuration and old encrypted secret after failed candidate probe`,()=>fixture(async({store,service,state,registry})=>{
  const {ProviderCredentialStore}=await import('../src/knowledge/provider-credential-store.ts');const credentials=new ProviderCredentialStore(store);
  const ref=credentials.save('existing-synthetic-private-token');registry.rotateSecret(input.id,ref,1);registry.disable(input.id,1);
  const before=store.db.prepare('SELECT * FROM knowledge_provider_configs WHERE id=?').get(input.id);const secretBefore=store.db.prepare('SELECT * FROM knowledge_provider_secrets WHERE ref=?').get(ref);
  state.fail=true;await assert.rejects(invoke(service));assert.equal(state.modelCalls,1);
  assert.deepEqual(store.db.prepare('SELECT * FROM knowledge_provider_configs WHERE id=?').get(input.id),before);assert.deepEqual(store.db.prepare('SELECT * FROM knowledge_provider_secrets WHERE ref=?').get(ref),secretBefore);assert.equal(await credentials.resolve(ref),'existing-synthetic-private-token');
  assert.equal(registry.get(input.id)?.status,'disabled');assert.equal(inspectProviderAdmission(store,input.id).used,1);
  assert.throws(()=>admitProviderInvocation(store,input.id),(error:any)=>error.code==='provider_disabled');
  await assert.rejects(invoke(service),(error:any)=>error.code==='provider_quota_exceeded');assert.equal(state.modelCalls,1);
 }));
 test(`${action} does not reset exhausted allowance when provider is disabled`,()=>fixture(async({store,service,state,registry})=>{
  admitProviderInvocation(store,input.id);registry.disable(input.id,1);
  await assert.rejects(invoke(service),(error:any)=>error.code==='provider_quota_exceeded');assert.equal(state.modelCalls,0);assert.equal(inspectProviderAdmission(store,input.id).used,1);assert.equal(registry.get(input.id)?.status,'disabled');
 }));
}
test('disabled configuration probes retain the upgrade barrier and do not reserve blocked attempts',()=>fixture(async({store,service,state,registry})=>{
 registry.disable(input.id,1);const until=Date.now()+60000;
 store.db.prepare('INSERT INTO knowledge_provider_admission_barriers(provider_id,not_before) VALUES(?,?)').run(input.id,until);
 await assert.rejects(service.configure(input),(error:any)=>error.code==='provider_quota_exceeded'&&error.reason==='upgrade_barrier');
 assert.equal(state.modelCalls,0);assert.equal(inspectProviderAdmission(store,input.id).used,0);assert.equal(registry.get(input.id)?.status,'disabled');
}));
