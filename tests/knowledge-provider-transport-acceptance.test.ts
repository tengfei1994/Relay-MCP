import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

test('isolated provider packet exercises real HTTP setup, queued credential changes, faults, CAS and privacy',{timeout:90_000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'provider51-packet-'));
 try{
  const result=await new Promise<{code:number|null;output:string}>(resolve=>{
   const child=spawn(process.execPath,['--import','tsx','scripts/knowledge-provider-transport-acceptance.ts','--root',root],{env:{...process.env,RELAY_PROVIDER_FIXTURE_TEST:'1'},stdio:['ignore','pipe','pipe']});let output='';
   child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);child.on('close',code=>resolve({code,output}));
  });
  assert.equal(result.code,0,result.output);
  const report=JSON.parse(readFileSync(join(root,'report.json'),'utf8'));
  assert.equal(report.status,'passed_isolated_provider_transport');assert.equal(report.injectedFaults,true);assert.equal(report.externalCloudCalls,0);
  for(const name of ['administrator_acl','setup_encrypted_credentials','queued_rotation','queued_clear','disabled_no_http','failed_config_preserves_previous','configure_cas_conflict','transport_faults_and_recovery','retry_one_logical_admission','privacy'])assert.ok(report.checks.some((c:any)=>c.name===name&&c.status==='passed'),name);
  assert.ok(report.counts.providerHttp>=30);assert.ok(report.counts.relayHttp>=25);assert.equal(report.privacy.matches,0);assert.equal(report.activeJobs,0);assert.equal(report.credentials.synthetic,true);
  const faults=report.checks.find((c:any)=>c.name==='transport_faults_and_recovery').evidence;
  assert.deepEqual(faults.map((r:any)=>r.mode),['unauthorized','rate_limited','invalid_json','invalid_vector','dimension_mismatch','timeout']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
