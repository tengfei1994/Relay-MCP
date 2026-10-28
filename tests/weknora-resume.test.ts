import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawn} from "node:child_process";
import {createKnowledgeStore} from "../src/knowledge/store.ts";
import {WeKnoraClient} from "../src/knowledge/weknora.ts";
import {WeKnoraClientDocumentWriter,WeKnoraIngestor} from "../src/knowledge/weknora-ingest.ts";

const input={idempotencyKey:"resume",title:"Guide",content:"# Source\nUseful content",sourcePath:"guide.md",parserVersion:"v1",projectId:"p1"};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});
async function fixture(fn:(f:any)=>Promise<void>){
  const root=mkdtempSync(join(tmpdir(),"weknora-resume-")),path=join(root,"knowledge.db");
  const f:any={store:createKnowledgeStore({dbPath:path}),posts:0,creates:0,phase:"pending",acceptedSeen:false,unknownOnce:false,configChanged:false,processConfig:undefined};let stored:any;
  const fetchImpl:typeof fetch=async(url,init)=>{
    if(init?.method==="POST"){
      f.posts++;const form=init.body as FormData;f.processConfig=form.get("process_config");
      const duplicate=Boolean(stored);if(!stored){f.creates++;stored={id:"external",knowledge_base_id:"kb",channel:form.get("channel"),metadata:JSON.parse(String(form.get("metadata"))),parse_status:"pending"};}
      if(f.unknownOnce){f.unknownOnce=false;throw new Error("Response lost after acceptance");}
      return json({success:!duplicate,...(duplicate?{code:"duplicate_file"}:{}),data:stored},duplicate?409:200);
    }
    const mapping=f.store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE idempotency_key='resume'").get() as any;
    f.acceptedSeen ||= mapping?.external_document_id==="external"&&mapping.upstream_verified_at===null;
    if(String(url).includes("/chunks/")){if(f.changeAtChunks)f.configChanged=true;return json({data:[{id:"chunk",knowledge_id:"external",content:"Useful content",seq:0,chunk_type:"text",index_status:"ready",is_enabled:true}],total:1});}
    return json({success:true,data:{...stored,parse_status:f.phase}});
  };
  f.make=(options:any={})=>new WeKnoraIngestor(f.store,new WeKnoraClientDocumentWriter(new WeKnoraClient({baseUrl:"http://unit.invalid",fetchImpl}),"kb",{readiness:{timeoutMs:8,pollIntervalMs:1},...options}));
  f.reopen=()=>{f.store.close();f.store=createKnowledgeStore({dbPath:path});};
  try{await fn(f);}finally{f.store.close();rmSync(root,{recursive:true,force:true});}
}

test("accepted upload ID is durable before readiness and timeout resumes after reopen without POST",()=>fixture(async f=>{
  await assert.rejects(f.make().stage(input),/timed out/);
  let row=f.store.db.prepare("SELECT * FROM knowledge_weknora_documents").get() as any;
  assert.equal(row.external_document_id,"external");assert.equal(row.upstream_verified_at,null);assert.equal(row.status,"failed");assert.equal(f.acceptedSeen,true);
  assert.throws(()=>f.make().publish(row.id,7),/staged/);
  f.reopen();f.phase="completed";const recovered=await f.make().stage(input,{retry:true});
  assert.equal(recovered.id,row.id);assert.equal(recovered.upstreamParseStatus,"completed");assert.ok(recovered.upstreamVerifiedAt);assert.equal(f.posts,1);assert.equal(f.creates,1);
}));

test("terminal upstream failure is retained and explicit retries never upload or pretend to reparse",()=>fixture(async f=>{
  f.phase="failed";await assert.rejects(f.make().stage(input),/failed/);
  const row=f.store.db.prepare("SELECT * FROM knowledge_weknora_documents").get() as any;
  assert.equal(row.external_document_id,"external");
  await assert.rejects(f.make().stage(input,{retry:true}),/failed/);
  assert.equal(f.posts,1);assert.equal(f.creates,1);
  assert.equal(f.store.db.prepare("SELECT upstream_verified_at FROM knowledge_weknora_documents").get().upstream_verified_at,null);
}));

test("a terminal cancellation reached during polling is persisted and cannot trigger reparse",()=>fixture(async f=>{
  let reads=0;
  Object.defineProperty(f,"phase",{get:()=>++reads===1?"pending":"cancelled"});
  await assert.rejects(f.make().stage(input),/cancelled/);
  const row=f.store.db.prepare("SELECT * FROM knowledge_weknora_documents").get() as any;
  assert.equal(row.upstream_parse_status,"cancelled");assert.equal(row.upstream_verified_at,null);
  await assert.rejects(f.make().stage(input,{retry:true}),/cancelled/);
  assert.equal(f.posts,1);assert.equal(f.creates,1);
}));

test("unknown acceptance response reconciles the same canonical identity without a new source",()=>fixture(async f=>{
  f.unknownOnce=true;await assert.rejects(f.make().stage(input));
  const before=f.store.db.prepare("SELECT * FROM knowledge_weknora_documents").get() as any;
  assert.ok(before.external_document_id.startsWith("pending:"));
  f.phase="completed";const recovered=await f.make().stage(input,{retry:true});
  assert.equal(recovered.id,before.id);assert.equal(f.posts,2);assert.equal(f.creates,1);assert.equal(recovered.externalDocumentId,"external");
}));

test("deferred synthesis is explicit and changed runtime profile cannot become verified",()=>fixture(async f=>{
  f.phase="completed";f.changeAtChunks=true;
  const options={deferSynthesis:true,assertCurrentConfiguration:()=>{if(f.configChanged)throw new Error("profile changed");}};
  await assert.rejects(f.make(options).stage(input),/configuration|profile/i);
  assert.deepEqual(JSON.parse(f.processConfig),{summary_enabled:false,question_generation_config:{enabled:false}});
  const row=f.store.db.prepare("SELECT * FROM knowledge_weknora_documents").get() as any;
  assert.equal(row.external_document_id,"external");assert.equal(row.upstream_verified_at,null);assert.equal(row.failure_code,"ingestion_configuration_changed");
  const posts=f.posts;await assert.rejects(f.make(options).stage(input,{retry:true}),/configuration|profile/i);assert.equal(f.posts,posts);
}));

test("a killed upload process recovers its durable accepted ID without another POST",async()=>{
  const root=mkdtempSync(join(tmpdir(),"weknora-crash-")),dbPath=join(root,"knowledge.db");
  const script=`
    import {createKnowledgeStore} from ${JSON.stringify(new URL("../src/knowledge/store.ts",import.meta.url).href)};
    import {WeKnoraClient} from ${JSON.stringify(new URL("../src/knowledge/weknora.ts",import.meta.url).href)};
    import {WeKnoraClientDocumentWriter,WeKnoraIngestor} from ${JSON.stringify(new URL("../src/knowledge/weknora-ingest.ts",import.meta.url).href)};
    const store=createKnowledgeStore({dbPath:${JSON.stringify(dbPath)}});
    const fetchImpl=async(url,init)=>{
      if(init?.method==='POST'){
        const form=init.body;
        return new Response(JSON.stringify({data:{id:'accepted-before-kill',knowledge_base_id:'kb',channel:form.get('channel'),metadata:JSON.parse(form.get('metadata')),parse_status:'pending'}}),{headers:{'content-type':'application/json'}});
      }
      process.stdout.write('ACCEPTED\\n');
      return new Promise(()=>setInterval(()=>{},1000));
    };
    await new WeKnoraIngestor(store,new WeKnoraClientDocumentWriter(new WeKnoraClient({baseUrl:'http://unit.invalid',fetchImpl}),'kb')).stage(${JSON.stringify(input)});
  `;
  const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script],{stdio:["ignore","pipe","pipe"]});
  const closed=new Promise<void>(resolve=>child.once("close",()=>resolve()));
  let store:ReturnType<typeof createKnowledgeStore>|undefined;
  try {
    await new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error("Child did not reach accepted phase")),10000);
      let output="";
      child.stdout.on("data",chunk=>{output+=String(chunk);if(output.includes("ACCEPTED")){clearTimeout(timeout);resolve();}});
      child.once("error",error=>{clearTimeout(timeout);reject(error);});
      child.once("exit",()=>{clearTimeout(timeout);reject(new Error("Child exited before acceptance"));});
    });
    store=createKnowledgeStore({dbPath});
    const before=store.db.prepare("SELECT * FROM knowledge_weknora_documents").get() as any;
    assert.equal(before.external_document_id,"accepted-before-kill");assert.equal(before.status,"staged");assert.equal(before.upstream_verified_at,null);
    store.close();store=undefined;
    child.kill("SIGKILL");await closed;
    store=createKnowledgeStore({dbPath});let posts=0;
    const fetchImpl:typeof fetch=async(url,init)=>{
      if(init?.method==="POST"){posts++;throw new Error("Recovery must not upload");}
      return String(url).includes("/chunks/") ? json({data:[{id:"chunk",knowledge_id:"accepted-before-kill",content:"content",chunk_type:"text",index_status:"ready"}],total:1}) : json({data:{id:"accepted-before-kill",knowledge_base_id:"kb",parse_status:"completed"}});
    };
    const result=await new WeKnoraIngestor(store,new WeKnoraClientDocumentWriter(new WeKnoraClient({baseUrl:"http://unit.invalid",fetchImpl}),"kb")).stage(input);
    assert.equal(result.id,before.id);assert.ok(result.upstreamVerifiedAt);assert.equal(posts,0);
  }finally{child.kill("SIGKILL");await closed;store?.close();rmSync(root,{recursive:true,force:true});}
});

test("deprecation while remote parsing completes cannot resurrect an accepted mapping",()=>fixture(async f=>{
  f.phase="completed";
  let checks=0;
  const ingestor=f.make({assertCurrentConfiguration:()=>{
    if(++checks===2){const row=f.store.db.prepare("SELECT id FROM knowledge_weknora_documents").get() as any;ingestor.deprecate(row.id,7);}
  }});
  await assert.rejects(ingestor.stage(input),/state changed/);
  const row=f.store.db.prepare("SELECT * FROM knowledge_weknora_documents").get() as any;
  assert.equal(row.status,"deprecated");assert.equal(row.external_document_id,"external");assert.equal(row.upstream_verified_at,null);
}));

test("a stale runtime profile is rejected before the first upload",()=>fixture(async f=>{
  await assert.rejects(f.make({assertCurrentConfiguration:()=>{throw new Error("changed");}}).stage(input),/configuration/);
  assert.equal(f.posts,0);assert.equal(f.creates,0);
}));
