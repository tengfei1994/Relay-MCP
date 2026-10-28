import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createKnowledgeStore} from "../src/knowledge/store.ts";
import {ProviderRegistry} from "../src/knowledge/provider-registry.ts";
import {admitProviderInvocation} from "../src/knowledge/provider-admission.ts";
import {assessProviderCapacity,assertMigrationProviderHealthySince} from "../src/knowledge/migration-capacity.ts";
function fixture(fn:(store:ReturnType<typeof createKnowledgeStore>)=>void){
 const dir=mkdtempSync(join(tmpdir(),"migration-capacity-")),store=createKnowledgeStore({dbPath:join(dir,"db")});
 try{new ProviderRegistry(store).upsert({id:"embedding",kind:"embedding",provider:"test",baseUrl:"https://unit.invalid/v1",modelId:"embedding",dimensions:2,actorId:1,quota:{maxCalls:5,windowMs:60_000}});fn(store);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
test("document forecast waits until enough admissions expire, not just the next call",()=>fixture(store=>{
 const at=Date.now();[0,1000,2000,3000].forEach(ms=>admitProviderInvocation(store,"embedding",new Date(at+ms)));
 assert.equal(assessProviderCapacity(store,"embedding",1,new Date(at+4000)),undefined);
 assert.deepEqual(assessProviderCapacity(store,"embedding",3,new Date(at+4000)),{deferUntil:new Date(at+61000).toISOString(),reason:"provider_rolling_quota"});
 assert.equal(assessProviderCapacity(store,"embedding",3,new Date(at+61000)),undefined);
 assert.throws(()=>assessProviderCapacity(store,"embedding",6),/document_exceeds_provider_window/);
 assert.equal((store.db.prepare("SELECT COUNT(*) n FROM knowledge_provider_admissions").get() as any).n,4);
}));
test("upgrade barrier remains even for a fresh-looking ledger",()=>fixture(store=>{
 const at=Date.now();store.db.prepare("INSERT INTO knowledge_provider_admission_barriers(provider_id,not_before) VALUES(?,?)").run("embedding",at+60_000);
 assert.deepEqual(assessProviderCapacity(store,"embedding",5,new Date(at)),{deferUntil:new Date(at+60_000).toISOString(),reason:"provider_upgrade_barrier"});
}));

test("a new bound-provider failure stops migration, while old and unrelated failures do not",()=>fixture(store=>{
 store.audit({action:"knowledge.provider.invoke_error",entityType:"provider",entityId:"embedding",details:{errorCode:"unauthorized"}});
 const watermark=(store.db.prepare("SELECT MAX(rowid) n FROM knowledge_audit").get() as {n:number}).n;
 assert.doesNotThrow(()=>assertMigrationProviderHealthySince(store,"embedding",watermark));
 store.audit({action:"knowledge.provider.invoke_error",entityType:"provider",entityId:"wiki",details:{errorCode:"provider_circuit_open"}});
 assert.doesNotThrow(()=>assertMigrationProviderHealthySince(store,"embedding",watermark));
 store.audit({action:"knowledge.provider.invoke_error",entityType:"provider",entityId:"embedding",details:{errorCode:"unauthorized"}});
 assert.throws(()=>assertMigrationProviderHealthySince(store,"embedding",watermark),/provider failed.*progress is preserved/i);
}));
