import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createKnowledgeStore} from "../src/knowledge/store.ts";
import {WorkSessionService} from "../src/knowledge/work-session.ts";
import {captureKnowledgeCandidates} from "../src/knowledge/capture-worker.ts";
import {drainRelayEventSpool} from "../src/knowledge/event-sink.ts";
import {summarizeExec} from "../src/shared/output.ts";

async function fixture(run:(f:any)=>Promise<void>){
 const root=mkdtempSync(join(tmpdir(),"job-environment-")),previous=process.env.RELAY_STATE_ROOT;
 process.env.RELAY_STATE_ROOT=root;
 const knowledge=createKnowledgeStore({dbPath:join(root,"knowledge.db")});
 knowledge.grantAcl("42",7,true);const sessions=new WorkSessionService(knowledge);
 const session=sessions.open({actorId:7,idempotencyKey:"job-scope",intent:{actorId:7,projectId:"42",environment:"nonprod",objective:"Verify fixture",actions:["verify"],phase:"validation",constraints:[],acceptanceCriteria:[],risk:"read_only",knowledgeMode:"capture"}});
 const jobs=await import(`../src/shared/job-store.ts?environment=${root}`);
 jobs.configureJobStore({eventSink:knowledge,resolveProjectId:()=>42,validateWorkSession:(actor:number,_project:string,id:string,environment?:string)=>{try{sessions.assertSessionUsable({actorId:actor,sessionId:id,projectId:"42",environment});return true;}catch{return false;}}});
 const events=()=>knowledge.db.prepare("SELECT id,type,payload_json FROM relay_domain_events ORDER BY occurred_at,id").all().map((r:any)=>({...r,payload:JSON.parse(r.payload_json)}));
 try{await run({root,knowledge,sessions,session,jobs,events});}
 finally{jobs.configureJobStore({});drainRelayEventSpool(knowledge);knowledge.close();if(previous===undefined)delete process.env.RELAY_STATE_ROOT;else process.env.RELAY_STATE_ROOT=previous;rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:20});}
}

test("real Job emission to Capture retains environment in success/failure Evidence and strict Session summary",()=>fixture(async({knowledge,sessions,session,jobs,events})=>{
 const input={environment:"nonprod",workSessionId:session.id,intentStep:"verify"};
 const success=jobs.startJob({id:7,username:"tester"},"fixture","exec_remote",input,async()=>summarizeExec("fixture verify",{stdout:"fixture observation",stderr:"",code:0}));
 const failed=jobs.startJob({id:7,username:"tester"},"fixture","exec_remote",input,async()=>{throw Error("fixture exit 17");});
 assert.equal((await jobs.waitForJobRecord(success.id,7,{waitMs:2000,pollMs:10})).job.status,"succeeded");
 assert.equal((await jobs.waitForJobRecord(failed.id,7,{waitMs:2000,pollMs:10})).job.status,"failed");
 drainRelayEventSpool(knowledge);
 assert.equal(events().length,4);
 for(const event of events())assert.equal(event.payload.environment,"nonprod",event.type+" must carry authoritative top-level scope");
 await captureKnowledgeCandidates(knowledge,"capture",100);
 const summary=sessions.summarize({actorId:7,sessionId:session.id,limit:200});
 assert.equal(summary.events.length,4);assert.equal(summary.observations.length,1);assert.ok(summary.evidence.length>0);
 const evidence=knowledge.db.prepare("SELECT environment FROM knowledge_evidence").all();assert.ok(evidence.length>0);assert.ok(evidence.every((x:any)=>x.environment==="nonprod"));
 const candidates=knowledge.db.prepare("SELECT environment FROM knowledge_candidates").all();assert.equal(candidates.length,1);assert.equal(candidates[0].environment,"nonprod");
 const before=JSON.stringify(summary);await captureKnowledgeCandidates(knowledge,"capture",100);assert.equal(JSON.stringify(sessions.summarize({actorId:7,sessionId:session.id,limit:200})),before);
}));

test("Job scope is snapshotted before execution and remains on retry and terminal events",()=>fixture(async({jobs,session,knowledge,events})=>{
 const input={environment:"nonprod",workSessionId:session.id};
 const job=jobs.startJob({id:7,username:"tester"},"fixture","exec_remote",input,async()=>{input.environment="wrong-after-start";return "done";},{retryOf:"prior-fixture-job"});
 await jobs.waitForJobRecord(job.id,7,{waitMs:2000,pollMs:10});drainRelayEventSpool(knowledge);
 assert.equal(jobs.getJob(job.id)?.environment,"nonprod");assert.equal(events().length,3);
 for(const event of events())assert.equal(event.payload.environment,"nonprod",event.type);
}));

test("recovery retains new scope snapshots and leaves legacy nested environments unpromoted",()=>fixture(async({jobs,session,knowledge,events,sessions})=>{
 const base={userId:7,username:"tester",project:"fixture",projectIdSnapshot:"42",kind:"exec_remote",status:"succeeded",input:{environment:"nonprod"},logs:[],startedAt:"2026-10-26T00:00:00Z",finishedAt:"2026-10-26T00:01:00Z",workSessionId:session.id};
 jobs.saveJob({...base,id:"new-scoped",environment:"nonprod"});jobs.saveJob({...base,id:"legacy-unscoped"});
 jobs.recoverUnemittedTerminalJobEvents();drainRelayEventSpool(knowledge);
 const scoped=events().find((x:any)=>x.payload.environment==="nonprod");assert.ok(scoped,"new persisted environment is restored");
 assert.equal(events().filter((x:any)=>x.payload.environment===undefined).length,1,"legacy records are not retroactively re-scoped");
 await captureKnowledgeCandidates(knowledge,"capture",100);
 assert.deepEqual(sessions.summarize({actorId:7,sessionId:session.id}).events.map((x:any)=>x.event_id),[scoped.id]);
 const before=JSON.stringify(events());jobs.recoverUnemittedTerminalJobEvents();drainRelayEventSpool(knowledge);assert.equal(JSON.stringify(events()),before);
}));
