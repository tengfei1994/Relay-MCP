import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';

test('isolated scope packet proves positive Solution and reference boundaries without cloud models',{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'scope-packet-test-')),report=join(dir,'report.json');
 try {
  const result=await new Promise<{code:number|null;output:string}>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','scripts/knowledge-scope-contract-acceptance.ts','--report',report],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',reject);child.on('close',code=>resolve({code,output}));});
  assert.equal(result.code,0,result.output);const value=JSON.parse(readFileSync(report,'utf8'));
  assert.equal(value.status,'passed_synthetic_scope_contract');assert.equal(value.syntheticSolutionMetadata,true);assert.equal(value.catalog.tools,123);assert.equal(value.catalog.matchesBaseline,true);assert.equal(value.modelCalls,0);assert.equal(value.providersConfigured,0);assert.equal(value.nonLoopbackRequests,0);assert.equal(value.activeJobs,0);
  assert.ok(value.scenarios.length>=10);assert.ok(value.scenarios.every((row:any)=>row.status==='passed'));assert.equal(value.conflict.unscopedVersions,2);assert.equal(value.conflict.versionConflicts,1);assert.equal(value.privacy.canaryMatches,0);assert.equal(value.memory.confirmedKinds.join(','),'Case,Pattern');
 } finally{rmSync(dir,{recursive:true,force:true});}
});
