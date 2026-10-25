import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgeStore } from '../src/knowledge/store.ts';
import { WorkSessionService } from '../src/knowledge/work-session.ts';

function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'session-summary-'));const store=createKnowledgeStore({dbPath:join(dir,'k.db')});store.grantAcl('p1',7,true);
 const service=new WorkSessionService(store); const session=service.open({actorId:7,idempotencyKey:'summary',intent:{actorId:7,projectId:'p1',environment:'test',actions:['verify'],phase:'validation',objective:'PRIVATE_OBJECTIVE',constraints:[],acceptanceCriteria:[],risk:'read_only',knowledgeMode:'capture'}});
 const event=(id:string, project='p1',env='test',actor=7,sessionId=session.id)=>{
  store.db.prepare('INSERT INTO relay_domain_events(id,type,occurred_at,project_id,actor_id,payload_json) VALUES (?,?,?,?,?,?)').run(id,'job.completed','2026-10-26T00:00:00Z',project,actor,JSON.stringify({workSessionId:sessionId,environment:env,stdout:'PRIVATE_PAYLOAD'}));
  service.correlateEvent({actorId:7,sessionId:session.id,eventId:id,eventType:'job.completed',intentStep:'validation'});
  store.db.prepare('INSERT INTO knowledge_observations(id,event_id,project_id,event_class,capture_reason,problem_statement,source_locator,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('o-'+id,id,project,'success','PRIVATE_REASON','PRIVATE_OBSERVATION','PRIVATE_PATH','2026-10-26','2026-10-26');
 };
 const evidence=(id:string,eventId:string,project='p1',env='test',deleted:string|null=null)=>{
  store.db.prepare('INSERT INTO knowledge_evidence(id,sha256,storage_path,mime_type,size_bytes,source_kind,project_id,environment,source_locator,retention,created_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,id.padEnd(64,'a'),'/PRIVATE/'+id,'text/plain',12,'job',project,env,'PRIVATE_LOCATOR','standard','2026-10-26',deleted);
  store.db.prepare('INSERT INTO knowledge_evidence_acl(evidence_id,project_id,created_at) VALUES (?,?,?)').run(id,project,'2026-10-26');
  store.db.prepare('INSERT INTO knowledge_entity_evidence(entity_type,entity_id,evidence_id,created_at) VALUES (?,?,?,?)').run('observation','o-'+eventId,id,'2026-10-26');
 };
 return {store,service,session,event,evidence,done(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('closed Session summary joins only same actor/project/environment records and emits references, not content',()=>{
 const f=fixture();try {
  f.event('good'); f.event('wrong-project','p2');f.event('wrong-env','p1','prod');f.event('wrong-actor','p1','test',8);f.event('wrong-session','p1','test',7,'other');
  f.evidence('ev-good','good');f.evidence('ev-env','good','p1','prod');f.evidence('ev-project','good','p2');f.evidence('ev-deleted','good','p1','test','2026-10-26');
  const id=f.service.recordRetrieval({actorId:7,sessionId:f.session.id,projectId:'p1',environment:'test',query:'PRIVATE_QUERY',sourceRunId:'run-1',resultCount:3,degraded:false});
  assert.equal(f.service.recordRetrieval({actorId:7,sessionId:f.session.id,projectId:'p1',environment:'test',query:'PRIVATE_QUERY',sourceRunId:'run-1',resultCount:3,degraded:false}),id);
  f.service.close({actorId:7,sessionId:f.session.id,result:{summary:'PRIVATE_SUMMARY'}});
  const summary=f.service.summarize({actorId:7,sessionId:f.session.id});
  assert.deepEqual(summary.events.map(x=>x.event_id),['good',id]);assert.deepEqual(summary.observations.map(x=>x.id),['o-good']);assert.deepEqual(summary.evidence.map(x=>x.id),['ev-good']);assert.deepEqual(summary.retrievals.map(x=>x.id),[id]);
  assert.equal(summary.retrievals[0].resultCount,3);assert.equal(summary.pagination.evidence.total,1);assert.equal(summary.session.status,'completed');
  assert.equal(JSON.stringify({observations:summary.observations,evidence:summary.evidence,retrievals:summary.retrievals,events:summary.events}).includes('PRIVATE_'),false);assert.equal(JSON.stringify(summary).includes('wrong-'),false);
  assert.equal((f.store.db.prepare('SELECT query FROM knowledge_retrieval_runs WHERE id=?').get(id) as any).query.startsWith('sha256:'),true);
  f.store.db.prepare("UPDATE knowledge_acl SET can_read=0 WHERE project_id='p1' AND user_id=7").run();assert.throws(()=>f.service.summarize({actorId:7,sessionId:f.session.id}),/access denied/i);
 } finally {f.done();}
});

test('summary pagination is bounded and stable, including explicit truncation for each category',()=>{
 const f=fixture();try {for(let i=0;i<4;i++){f.event('e'+i);f.evidence('ev'+i,'e'+i);}
  const a=f.service.summarize({actorId:7,sessionId:f.session.id,limit:2});const b=f.service.summarize({actorId:7,sessionId:f.session.id,limit:2,offset:2});
  assert.equal(a.events.length,2);assert.equal(a.observations.length,2);assert.equal(a.evidence.length,2);assert.equal(a.pagination.events.total,4);assert.equal(a.pagination.events.hasMore,true);assert.equal(b.pagination.events.hasMore,false);assert.equal(new Set([...a.events,...b.events].map(x=>x.event_id)).size,4);
  assert.equal(f.service.summarize({actorId:7,sessionId:f.session.id,limit:10000}).pagination.events.limit,200);
 } finally {f.done();}
});

test('retrieval correlation rejects wrong scopes and excludes forged or malformed run metadata',()=>{
 const f=fixture();try {
  assert.throws(()=>f.service.recordRetrieval({actorId:7,sessionId:f.session.id,projectId:'p2',environment:'test',query:'q',sourceRunId:'r',resultCount:0,degraded:true}),/project/i);
  assert.throws(()=>f.service.recordRetrieval({actorId:7,sessionId:f.session.id,projectId:'p1',environment:'prod',query:'q',sourceRunId:'r',resultCount:0,degraded:true}),/environment/i);
  const id=f.service.recordRetrieval({actorId:7,sessionId:f.session.id,projectId:'p1',environment:'test',query:'q',sourceRunId:'r',resultCount:0,degraded:true});
  const run=f.store.db.prepare('SELECT results_json FROM knowledge_retrieval_runs WHERE id=?').get(id) as any;
  f.store.db.prepare('UPDATE knowledge_retrieval_runs SET results_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(run.results_json),environment:'prod'}),id);assert.equal(f.service.summarize({actorId:7,sessionId:f.session.id}).retrievals.length,0);
  for(const patch of [{actorId:8},{workSessionId:'other-session'}]) {f.store.db.prepare('UPDATE knowledge_retrieval_runs SET results_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(run.results_json),...patch}),id);assert.equal(f.service.summarize({actorId:7,sessionId:f.session.id}).retrievals.length,0);}
  f.store.db.prepare('UPDATE knowledge_retrieval_runs SET results_json=?,project_id=? WHERE id=?').run(run.results_json,'p2',id);assert.equal(f.service.summarize({actorId:7,sessionId:f.session.id}).retrievals.length,0);
  f.store.db.prepare('UPDATE knowledge_retrieval_runs SET results_json=?,project_id=? WHERE id=?').run('{broken','p1',id);assert.equal(f.service.summarize({actorId:7,sessionId:f.session.id}).retrievals.length,0);
 } finally {f.done();}
});


test('real Relay context retrievals attach durable safe receipts only when a Session is supplied',async()=>{
 const f=fixture();try {
  const {loadRelayContextSources}=await import('../src/knowledge/context-sources.ts');
  await loadRelayContextSources({store:f.store,userId:7,projectId:'p1',query:'PRIVATE_QUERY',intent:{projectId:'p1',objective:'',environment:'test'},limit:5,workSessionId:f.session.id});
  const summary=f.service.summarize({actorId:7,sessionId:f.session.id});assert.equal(summary.retrievals.length,3);assert.equal(JSON.stringify({observations:summary.observations,evidence:summary.evidence,retrievals:summary.retrievals,events:summary.events}).includes('PRIVATE_'),false);
  await loadRelayContextSources({store:f.store,userId:7,projectId:'p1',query:'q',intent:{projectId:'p1',objective:'',environment:'test'},limit:5});assert.equal(f.service.summarize({actorId:7,sessionId:f.session.id}).retrievals.length,3);
 }finally{f.done();}
});


test('summary preserves owner Session closure fields and legal non-domain event references',()=>{
 const f=fixture();try {
  f.service.correlateEvent({actorId:7,sessionId:f.session.id,eventId:'custom-event',eventType:'tool.completed',intentStep:'verify',objectiveRef:'objective-1',acceptanceCriterionRef:'criterion-1'});
  const closed=f.service.close({actorId:7,sessionId:f.session.id,result:{summary:'Owner visible result',unknowns:['Remaining follow-up'],acceptanceResults:{verified:true}}});
  const summary=f.service.summarize({actorId:7,sessionId:f.session.id});assert.deepEqual(summary.session,closed);
  const event=f.service.listEvents({actorId:7,sessionId:f.session.id})[0];assert.ok(event.id);assert.equal(event.event_id,'custom-event');assert.equal(event.intent_step,'verify');assert.equal(event.objective_ref,'objective-1');assert.equal(event.acceptance_criterion_ref,'criterion-1');
  assert.equal(summary.observations.length,0);assert.equal(summary.evidence.length,0);
 }finally{f.done();}
});
