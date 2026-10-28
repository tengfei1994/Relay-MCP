import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createKnowledgeStore} from '../src/knowledge/store.ts';
import {WorkSessionService} from '../src/knowledge/work-session.ts';
import {EvidenceStore} from '../src/knowledge/evidence-store.ts';
import {enqueueCandidateInsight} from '../src/knowledge/candidate-worker.ts';
import {CandidateInsightCompiler} from '../src/knowledge/candidate-insight.ts';

const hidden='SYNTHETIC_HIDDEN_CONTEXT_CANARY';
const context={statement:'Observed fixture behavior',objectiveRef:'objective-1',sourceLocator:'fixture://source',hypothesis:'Needs verification',reasoning:hidden,chainOfThought:[hidden],hiddenReasoning:hidden,details:{environment:'nonprod',internalMonologue:hidden,items:[{evidenceRef:'evidence-locator',thinking:hidden}]}};
const expected={statement:'Observed fixture behavior',objectiveRef:'objective-1',sourceLocator:'fixture://source',hypothesis:'Needs verification',details:{environment:'nonprod',items:[{evidenceRef:'evidence-locator'}]}};
async function fixture(run:(f:any)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'candidate-context-privacy-')),store=createKnowledgeStore({dbPath:join(dir,'knowledge.db')});store.grantAcl('p1',7,true);
 const session=new WorkSessionService(store).open({actorId:7,idempotencyKey:'privacy',intent:{actorId:7,projectId:'p1',environment:'nonprod',actions:['verify'],phase:'validation',objective:'Verify a synthetic fixture',constraints:[],acceptanceCriteria:[],risk:'read_only',knowledgeMode:'capture'}});
 const evidence=new EvidenceStore(store,join(dir,'evidence')).put({content:Buffer.from('Observed fixture behavior'),mimeType:'text/plain',sourceKind:'log',projectId:'p1',environment:'nonprod',locator:'fixture://observation'});
 try{await run({store,input:{actorId:7,sessionId:session.id,evidenceRefs:[evidence.id],context}});}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}

test('Candidate queue omits nested hidden reasoning before persistence and preserves legitimate context',()=>fixture(async({store,input})=>{
 const result=enqueueCandidateInsight(store,input);const row=store.db.prepare('SELECT context_json FROM knowledge_candidate_insight_jobs WHERE id=?').get(result.job.id) as any;
 assert.equal(row.context_json.includes(hidden),false,'hidden context must not enter queued JSON');assert.deepEqual(JSON.parse(row.context_json),expected);assert.deepEqual(result.job.context,expected);
}));

test('synchronous Candidate compilation omits hidden context before provider and persistence',()=>fixture(async({store,input})=>{
 let prompt='';const compiler=new CandidateInsightCompiler(store,{providerId:'fixture',modelId:'synthetic',complete:async(request)=>{prompt=request.prompt;return JSON.stringify({kind:'fact',statement:'Observed fixture behavior',whyProposed:'Evidence exists',evidenceRefs:input.evidenceRefs,intentRefs:[],unknowns:[],reuseBoundary:{projectId:'p1'},confirmedFacts:[],observedBehavior:['Observed fixture behavior']});}});
 const result=await compiler.compile(input);assert.equal(prompt.includes(hidden),false,'hidden context must not be sent to provider');assert.ok(prompt.includes('fixture://source'));assert.ok(prompt.includes('Needs verification'));assert.equal(result.generatedBy,'managed-candidate-llm:fixture/synthetic');
 const persisted=JSON.stringify(store.db.prepare('SELECT * FROM knowledge_candidate_insights').all());assert.equal(persisted.includes(hidden),false);
}));

test('ignored hidden context cannot change queued idempotency or provoke another model call',()=>fixture(async({store,input})=>{
 const first=enqueueCandidateInsight(store,input),second=enqueueCandidateInsight(store,{...input,context:expected});assert.equal(second.job.id,first.job.id);assert.equal(second.enqueued,false);
 let calls=0;const compiler=new CandidateInsightCompiler(store,{providerId:'fixture',modelId:'synthetic',complete:async()=>{calls++;return JSON.stringify({kind:'fact',statement:'Observed fixture behavior',whyProposed:'Evidence exists',evidenceRefs:input.evidenceRefs,unknowns:[],reuseBoundary:{projectId:'p1'}});}});
 const a=await compiler.compile(input),b=await compiler.compile({...input,context:expected});assert.equal(a.id,b.id);assert.equal(calls,1);
}));
