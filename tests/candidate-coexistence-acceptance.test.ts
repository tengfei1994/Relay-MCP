import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';

test('Candidate HTTP faults coexist with real Job Capture, DLQ, retry and replay without sensitive persistence',{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'candidate-coexistence-test-')),report=join(dir,'report.json');
 try {
  const result=await new Promise<{code:number|null;output:string}>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','scripts/knowledge-candidate-coexistence-acceptance.ts','--report',report],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',reject);child.on('close',code=>resolve({code,output}));});
  assert.equal(result.code,0,result.output);const value=JSON.parse(readFileSync(report,'utf8'));
  assert.equal(value.status,'passed_isolated_candidate_coexistence');assert.equal(value.cloudModelCalls,0);assert.equal(value.nonLoopbackRequests,0);
  assert.deepEqual(value.scenarios.map((row:any)=>row.mode),['timeout','rate_limited','invalid_json','retry_recovery']);
  assert.ok(value.scenarios.every((row:any)=>row.mainPathCompletedWhilePending&&row.jobStatuses.join(',')==='succeeded,failed'&&row.queueAttempts===1&&row.replayAdditionalCalls===0));
  assert.deepEqual(value.scenarios.map((row:any)=>row.providerCalls),[1,1,1,2]);
  assert.equal(value.captureRetry.recoveredExactlyOnce,true);assert.equal(value.deadLetter.count,1);assert.equal(value.deadLetter.attempts,5);assert.equal(value.deadLetter.originalEventRetained,true);
  assert.equal(value.replay.sameEvidenceAndCandidateIds,true);assert.equal(value.privacy.canaryMatches,0);assert.equal(value.privacy.promptSensitiveMatches,0);assert.equal(value.evidenceAcl.providerCalls,0);assert.equal(value.promotions,0);
 } finally{rmSync(dir,{recursive:true,force:true});}
});
