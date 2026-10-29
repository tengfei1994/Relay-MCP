/** Bounded real HTTP ContextPack scope matrix; no source bodies in reports. */
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const root='/home/ftd/relay-knowledge-engine-nonprod';
if(process.env.RELAY_E2E_ISOLATED!=='1'||process.platform!=='linux'||await realpath(process.cwd())!==root+'/relay')throw new Error('isolated_nonproduction_required');
const runId=process.env.RELAY_CONTEXT_SCOPE_RUN_ID??'context-scope-live';
assert.match(runId,/^[a-zA-Z0-9._-]{1,100}$/);
const token=(await readFile('data/e2e-admin.jwt','utf8')).trim(),foreign=(await readFile('data/e2e-foreign.jwt','utf8')).trim();
const report:any={runId,status:'running',startedAt:new Date().toISOString(),checks:[],limits:['Five real Product/Developer samples; no positive Solution-specific source exists in the approved sample set.','This validates filtering and citations, not gold-set semantic recall.']};
const save=()=>writeFile(resolve(root,'runtime',runId+'.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const baseline={projectId:'1',environment:'nonprod',query:'sentinel SampleManager evidence routing',limit:20};
const matrix=[{name:'combined_product_and_memory',input:{}},{name:'version_21_1',input:{productVersion:'21.1'}},{name:'version_21_3',input:{productVersion:'21.3'}},{name:'module_match',input:{module:'samplemanager'}},{name:'version_mismatch',input:{productVersion:'unmatched-acceptance-version'},empty:true},{name:'module_mismatch',input:{module:'unmatched-acceptance-module'},empty:true},{name:'solution_mismatch',input:{solution:'unmatched-acceptance-solution'},empty:true},{name:'language_mismatch',input:{language:'unmatched-language'},empty:true},{name:'environment_mismatch',input:{environment:'other-environment'},empty:true},{name:'foreign_actor',input:{},denied:true}];
try{
 for(const scenario of matrix){
  const start=Date.now();const response=await fetch('http://127.0.0.1:18300/api/knowledge/search',{method:'POST',headers:{authorization:'Bearer '+(scenario.denied?foreign:token),'content-type':'application/json'},body:JSON.stringify({...baseline,...scenario.input}),signal:AbortSignal.timeout(30_000),redirect:'error'});
  if(scenario.denied){assert.ok([403,404].includes(response.status));report.checks.push({name:scenario.name,httpStatus:response.status,status:'passed'});continue;}
  assert.equal(response.status,200);const value:any=await response.json();const refs=value.references;
  assert.ok(Array.isArray(refs));
  if(scenario.empty)assert.equal(refs.length,0);else{
   assert.ok(refs.length>0);for(const ref of refs){assert.equal(ref.provider,'weknora');assert.ok(ref.documentId&&ref.chunkId&&ref.sourceSha256&&ref.sourceLocator);assert.equal(ref.projectId,'1');assert.equal(ref.environment,'nonprod');if('productVersion' in scenario.input)assert.equal(ref.version,scenario.input.productVersion);if('module' in scenario.input)assert.equal(ref.module,scenario.input.module);}
  }
  if(scenario.name==='combined_product_and_memory')assert.ok(value.contextPack.confirmedKnowledge.some((d:any)=>d.id==='case-insight-78e35171480d35c98533d8d4f4479c6a'&&d.lifecycle==='verified'));
  if(scenario.name==='environment_mismatch')assert.ok(!value.contextPack.confirmedKnowledge.some((d:any)=>d.id==='case-insight-78e35171480d35c98533d8d4f4479c6a'));
  report.checks.push({name:scenario.name,status:'passed',httpStatus:response.status,latencyMs:Date.now()-start,productReferences:refs.length,confirmedMemory:value.contextPack.confirmedKnowledge.length,versions:[...new Set(refs.map((r:any)=>r.version))],modules:[...new Set(refs.map((r:any)=>r.module))]});await save();
 }
 report.status='passed_bounded_scope_matrix';
}catch{report.status='failed';process.exitCode=1;}
report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({runId,status:report.status,passed:report.checks.length,total:matrix.length}));
