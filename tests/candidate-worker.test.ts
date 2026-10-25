import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { WorkSessionService } from "../src/knowledge/work-session.ts";
import { CandidateInsightWorker, enqueueCandidateInsight, getCandidateInsightJob } from "../src/knowledge/candidate-worker.ts";
import { CandidateInsightCompiler } from "../src/knowledge/candidate-insight.ts";
import { EvidenceStore } from "../src/knowledge/evidence-store.ts";

async function fixture(run: (store: ReturnType<typeof createKnowledgeStore>, other: ReturnType<typeof createKnowledgeStore>, input: any) => Promise<void>) {
  const root=mkdtempSync(join(tmpdir(),"candidate-worker-")), path=join(root,"knowledge.db");
  const store=createKnowledgeStore({dbPath:path}),other=createKnowledgeStore({dbPath:path});
  try {
    store.grantAcl("p1",7,true);
    const session=new WorkSessionService(store).open({actorId:7,idempotencyKey:"worker",intent:{actorId:7,projectId:"p1",actions:["capture"],phase:"diagnosis",objective:"Inspect",constraints:[],acceptanceCriteria:[],risk:"read_only",knowledgeMode:"capture"}});
    await run(store,other,{actorId:7,sessionId:session.id,evidenceRefs:[],context:{statement:"Worker fixture"}});
  } finally {other.close();store.close();rmSync(root,{recursive:true,force:true});}
}

test("two real SQLite stores cannot call the model twice for the same queued Candidate",()=>fixture(async(store,other,input)=>{
  const job=enqueueCandidateInsight(store,input).job;
  let calls=0, release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const compiler={compile:async()=>{calls++;await gate;return {id:"ephemeral",persisted:false} as any;}};
  const first=new CandidateInsightWorker(store,compiler).runOnce();
  // Another writer can commit while the first consumer is in the model await.
  other.grantAcl("p2",8,false);
  const second=new CandidateInsightWorker(other,compiler).runOnce();
  release();
  const results=await Promise.all([first,second]);
  assert.equal(calls,1);
  assert.equal(results.reduce((sum,row)=>sum+row.claimed,0),1);
  assert.equal((store.db.prepare("SELECT status FROM knowledge_candidate_insight_jobs WHERE id=?").get(job.id) as {status:string}).status,"done");
  assert.equal(enqueueCandidateInsight(other,input).enqueued,false);
  await new CandidateInsightWorker(other,compiler).runOnce();assert.equal(calls,1);
}));

test("heartbeat keeps a slow model owned and stop drains only the active compile",()=>fixture(async(store,other,input)=>{
  enqueueCandidateInsight(store,input);enqueueCandidateInsight(store,{...input,context:{statement:"Second job"}});
  let calls=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const compiler={compile:async()=>{calls++;await gate;return {persisted:false} as any;}};
  const worker=new CandidateInsightWorker(store,compiler,{leaseMs:100});const active=worker.runOnce();
  await new Promise(resolve=>setTimeout(resolve,170));
  assert.equal((await new CandidateInsightWorker(other,compiler,{leaseMs:100}).runOnce()).claimed,0);
  let stopped=false;const stopping=worker.stop().then(()=>{stopped=true;});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(stopped,false);
  release();await active;await stopping;assert.equal(calls,1);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM knowledge_candidate_insight_jobs WHERE status='queued'").get() as {n:number}).n,1);
  assert.equal((await worker.runOnce()).claimed,0);
}));

test("abandoned ambiguous calls require explicit retry and stale completions cannot replace the terminal result",()=>fixture(async(store,other,input)=>{
  const job=enqueueCandidateInsight(store,input).job;
  let release!:()=>void,calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});
  const active=new CandidateInsightWorker(store,{compile:async()=>{calls++;await gate;return {persisted:false} as any;}}).runOnce();
  other.db.prepare("UPDATE knowledge_candidate_insight_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(job.id);
  const recovery=new CandidateInsightWorker(other,{compile:async()=>{calls++;return {persisted:false} as any;}});
  assert.equal((await recovery.runOnce()).claimed,0);
  release();assert.equal((await active).completed,0);
  assert.equal(getCandidateInsightJob(store,{actorId:7,id:job.id}).error,"interrupted_uncertain_retry_required");
  assert.equal(enqueueCandidateInsight(store,input).job.status,"failed");assert.equal(calls,1);
  assert.equal(enqueueCandidateInsight(store,{...input,retry:true}).job.status,"queued");
  assert.equal((await recovery.runOnce()).completed,1);assert.equal(calls,2);
}));

test("restart recovers an already persisted result without any further provider call",()=>fixture(async(store,other,input)=>{
  const evidence=new EvidenceStore(store,join(dirname(store.db.name),"evidence")).put({content:Buffer.from("Observed fixture"),mimeType:"text/plain",sourceKind:"log",projectId:"p1",locator:"test://worker"});
  input.evidenceRefs=[evidence.id];
    const saved=await new CandidateInsightCompiler(store,{providerId:"fixture",modelId:"fixture",complete:async()=>{throw new Error("Unavailable");}}).compile(input);
    const job=enqueueCandidateInsight(store,input).job;
    store.db.prepare("UPDATE knowledge_candidate_insight_jobs SET claim_token='dead-owner',lease_until='2000-01-01T00:00:00.000Z',attempts=1 WHERE id=?").run(job.id);
    const recovered=await new CandidateInsightWorker(other,{compile:async()=>{throw new Error("Must not invoke provider");}}).runOnce();
    assert.equal(recovered.claimed,0);assert.equal(getCandidateInsightJob(store,{actorId:7,id:job.id}).insightId,saved.id);
    assert.equal(getCandidateInsightJob(store,{actorId:7,id:job.id}).status,"done");
}));

test("queued jobs recheck ACL, status reads enforce ACL, and failure retries use bounded backoff",()=>fixture(async(store,other,input)=>{
  let now=new Date("2026-01-01T00:00:00Z"),calls=0;
  const job=enqueueCandidateInsight(store,input,()=>now).job;
  assert.throws(()=>getCandidateInsightJob(store,{actorId:8,id:job.id}),/denied|access|not found/i);
  other.db.prepare("UPDATE knowledge_acl SET can_read=0 WHERE project_id='p1' AND user_id=7").run();
  const worker=new CandidateInsightWorker(store,{compile:async()=>{calls++;throw new Error("Sensitive body must not appear");}},{clock:()=>now,maxAttempts:2,retryBaseMs:1000});
  assert.equal((await worker.runOnce()).retried,1);assert.equal(calls,0);
  store.grantAcl("p1",7,true);
  assert.equal((await worker.runOnce()).claimed,0);
  now=new Date(now.getTime()+1000);assert.equal((await worker.runOnce()).failed,1);assert.equal(calls,1);
  assert.equal(getCandidateInsightJob(store,{actorId:7,id:job.id}).error,"Error");
}));

test("migration 042 resumes an existing unclaimed queue without rewriting its request",()=>fixture(async(store,other,input)=>{
  const job=enqueueCandidateInsight(store,input).job;
  store.db.exec("DROP INDEX idx_candidate_insight_jobs_claim");
  for(const column of ["claim_token","lease_until","available_at","provider_id"])store.db.exec(`ALTER TABLE knowledge_candidate_insight_jobs DROP COLUMN ${column}`);
  store.db.prepare("DELETE FROM schema_migrations WHERE version='042-candidate-worker-lease'").run();
  const upgraded=createKnowledgeStore({dbPath:store.db.name});
  try {
    assert.deepEqual(getCandidateInsightJob(upgraded,{actorId:7,id:job.id}).context,input.context);
    let calls=0;
    const result=await new CandidateInsightWorker(other,{compile:async()=>{calls++;return {persisted:false} as any;}}).runOnce();
    assert.equal(result.completed,1);assert.equal(calls,1);
  }finally{upgraded.close();}
}));
