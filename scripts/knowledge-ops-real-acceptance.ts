/** Actual deployed nonproduction HTTP/MCP operational acceptance; no fake Job/Deployment rows. */
import {readFile,writeFile,appendFile,chmod,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const ROOT='/home/ftd/relay-knowledge-engine-nonprod', F=ROOT+'/opsfixture', WEB='http://127.0.0.1:18300';
if(process.env.RELAY_E2E_ISOLATED!=='1'||process.platform!=='linux'||resolve(process.cwd())!==ROOT+'/relay')throw new Error('isolated_nonproduction_required');
const mode=process.argv[2]??'execute';
if(!['execute','scope-checks','privacy','after-restart','close'].includes(mode))throw new Error('unsupported_mode');
const state:any=JSON.parse(await readFile(F+'/state.json','utf8'));
const transport:any=JSON.parse(await readFile(F+'/transport.json','utf8'));
const token=(await readFile('data/e2e-admin.jwt','utf8')).trim(), foreignToken=(await readFile('data/e2e-foreign.jwt','utf8')).trim();
const hash=(x:string)=>createHash('sha256').update(x).digest('hex');
const must=(x:unknown,c:string)=>{if(!x)throw new Error(c);};
const report:any={schemaVersion:1,runId:state.runId,mode,startedAt:new Date().toISOString(),status:'running',source:'actual deployed nonproduction HTTP/MCP + real loopback SSH/Git',simulation:false,modelCalls:0,checks:[],http:[],mcp:[],limitations:['The Git fixture is synthetic test content, not a SampleManager production deployment.','Generic deploy has no PM2/Docker workload in the constrained PATH; actual fixture HTTP service is separately started/restarted/stopped by real Jobs.']};
const reportPath=F+'/acceptance-'+mode+'.json';
if(mode==='execute'){try{const previous=JSON.parse(await readFile(reportPath,'utf8'));report.checks=previous.checks??[];report.http=previous.http??[];report.mcp=previous.mcp??[];report.startedAt=previous.startedAt;report.driverResumeCount=(previous.driverResumeCount??0)+1;}catch{}}
let admin:Client|undefined, foreign:Client|undefined;let names:string[]=[];
const db=new Database(ROOT+'/relay/data/knowledge.db',{readonly:true});
const ledger=()=>Number((db.prepare('SELECT count(*) AS n FROM knowledge_provider_admissions').get() as any).n);
const save=async()=>{await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});await chmod(reportPath,0o600);await writeFile(F+'/state.json',JSON.stringify(state,null,2)+'\n',{mode:0o600});};
async function http(op:string,method:string,path:string,body?:any,expected=[200],asForeign=false,headers:Record<string,string>={}){
 const at=performance.now();const r=await fetch(WEB+path,{method,headers:{authorization:'Bearer '+(asForeign?foreignToken:token),'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
 const text=await r.text();report.http.push({operation:op,method,path:path.split('?')[0],status:r.status,latencyMs:Math.round(performance.now()-at),responseBytes:Buffer.byteLength(text)});must(expected.includes(r.status),'http_'+op+'_'+r.status);return r.status>=400?{}:JSON.parse(text);
}
async function connect(auth:string){const c=new Client({name:'relay-real-opsfixture',version:'1.0'});await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18301/mcp'),{requestInit:{headers:{authorization:'Bearer '+auth}}}));return c;}
async function call(name:string,args:any={},denied=false,client=admin!){
 const actual=names.find(n=>n===name||n.endsWith('_'+name));must(actual,'tool_missing_'+name);const at=performance.now();const r:any=await client.callTool({name:actual!,arguments:args},undefined,{timeout:150000});
 const text=(r.content??[]).filter((v:any)=>v.type==='text').map((v:any)=>v.text).join('\n');report.mcp.push({tool:name,isError:r.isError===true,latencyMs:Math.round(performance.now()-at),responseBytes:Buffer.byteLength(text),responseSha256:hash(text)});
 if(denied){must(r.isError===true,'expected_denial_'+name);return {};}
 if(r.isError)report.lastError={tool:name,knownLabels:['not allowed','not found','denied','not usable','status','SSH','environment','scope','JSON','timeout','Connection','invalid'].filter(x=>text.includes(x))};
 must(!r.isError,'tool_failed_'+name);try{return JSON.parse(text);}catch{return {textSha256:hash(text),textLength:text.length};}
}
async function check(name:string,work:()=>Promise<any>){if(mode==='execute'&&report.checks.some((c:any)=>c.name===name&&c.status==='passed'))return;console.log('[ops-e2e] '+name+': running');const c:any={name,status:'running'};report.checks.push(c);await save();try{c.evidence=await work();c.status='passed';}catch(e){c.status='failed';c.code=e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'driver_or_contract_failure';throw e;}finally{await save();console.log('[ops-e2e] '+name+': '+c.status);}}
const correlated=(step:string)=>({project:state.projectName,environment:state.environment,workSessionId:state.sessionId,intentStep:step,objectiveRef:'ops-isolation',acceptanceCriterionRef:'actual-correlation'});
async function job(label:string,command:string,session=true){
 const value:any=await call('exec_remote',{project:state.projectName,environment:state.environment,command,async:true,timeoutMs:15000,...(session?correlated(label):{})});must(value.jobId,'missing_job_id');
 state.jobs??=[];state.jobs.push({id:value.jobId,label,session});await save();
 const terminal:any=await call('job_wait',{jobId:value.jobId,waitMs:25000,pollMs:100});must(terminal.status!=='running','job_not_terminal');
 Object.assign(state.jobs[state.jobs.length-1],{status:terminal.status,workSessionId:terminal.workSessionId,finishedAt:terminal.finishedAt});
 return {id:terminal.id,status:terminal.status,workSessionId:terminal.workSessionId,phase:terminal.phase};
}
async function deployment(label:string,branch:string,session=true){
 const d:any=await call('deploy',{project:state.projectName,environment:state.environment,branch,rollbackOnFailure:true,...(session?correlated(label):{})});
 const safe={id:d.id,label,status:d.status,workSessionId:d.workSessionId,commitBefore:d.commitBefore,commitAfter:d.commitAfter,rollback:d.rollback};state.deployments??=[];state.deployments.push(safe);await save();return safe;
}
function captured(){
 const events:any[]=db.prepare('SELECT event_id,event_type,intent_step,created_at FROM knowledge_work_session_events WHERE session_id=? ORDER BY created_at,rowid').all(state.sessionId);
 const rows:any[]=db.prepare('SELECT id,type,job_id,deployment_id,payload_json FROM relay_domain_events WHERE project_id=? ORDER BY occurred_at,id').all(state.projectId);
 const own=rows.filter(r=>JSON.parse(r.payload_json).workSessionId===state.sessionId);
 const observations:any[]=db.prepare('SELECT id,event_id,evidence_refs_json FROM knowledge_observations WHERE project_id=? ORDER BY id').all(state.projectId);
 const evidence:any[]=db.prepare('SELECT id,sha256,size_bytes,source_kind FROM knowledge_evidence WHERE project_id=? ORDER BY id').all(state.projectId);
 const candidates:any[]=db.prepare('SELECT c.id,c.event_id FROM knowledge_candidates c JOIN knowledge_documents d ON d.id=c.id WHERE d.project_id=? ORDER BY c.id').all(state.projectId);
 return {events,sourceEvents:own.map(({payload_json,...r})=>r),observations,evidence,candidates};
}
async function captureReady(){let result=captured();for(let i=0;i<80;i++){if(result.events.some(e=>e.event_type==='deployment.failed')&&result.events.some(e=>e.event_type==='job.finished')&&result.evidence.length>0)return result;await new Promise(r=>setTimeout(r,250));result=captured();}throw new Error('capture_not_ready');}
try{
 report.ledgerBefore=ledger();await http('health','GET','/api/health');admin=await connect(token);foreign=await connect(foreignToken);names=(await admin.listTools()).tools.map(t=>t.name);
 await check('session_survives_real_service_restart',async()=>{
  const session=(await http('session_after_restart','GET','/api/knowledge/sessions/'+state.sessionId)).session;
  must(session.id===state.beforeRestart.id&&JSON.stringify(session.intent)===JSON.stringify(state.beforeRestart.intent),'restart_session_changed');must(session.status==='open','session_not_open');
  const mcp:any=await call('knowledge_work_session_get',{sessionId:state.sessionId});must(mcp.session.id===session.id,'mcp_session_changed');
  await admin!.close();admin=await connect(token);const again:any=await call('knowledge_work_session_get',{sessionId:state.sessionId});must(again.session.id===session.id,'reconnect_session_changed');
  await http('foreign_session','GET','/api/knowledge/sessions/'+state.sessionId,undefined,[403,404],true);await call('knowledge_work_session_get',{sessionId:state.sessionId},true,foreign!);
  return {sessionId:session.id,status:session.status,createdAt:session.createdAt,preRestartAt:state.beforeRestartAt,intentSha256:hash(JSON.stringify(session.intent)),mcpReconnect:true,foreignDenied:true};
 });
 if(mode==='execute'){
  must(!state.operationsExecuted,'operations_already_executed');
  await check('create_real_isolated_ssh_target',async()=>{
   const servers=(await http('servers','GET','/api/servers')).servers;let server=servers.find((s:any)=>s.name===state.projectName);
   if(!server)server=(await http('server_create','POST','/api/servers',{name:state.projectName,host:'127.0.0.1',port:18322,sshUser:'ftd',os:'linux'},[201])).server;
   must(server.host==='127.0.0.1'&&server.port===18322&&server.connectionMode==='ssh','server_scope_mismatch');
   const auth=await readFile(F+'/authorized_keys','utf8');if(!auth.includes(server.publicKey))await appendFile(F+'/authorized_keys',server.publicKey+'\n');await chmod(F+'/authorized_keys',0o600);
   const tested=await http('server_test','POST','/api/servers/'+server.id+'/test',{});must(tested.ok&&tested.output.trim()==='ok','server_test_failed');state.serverId=server.id;
   const links=(await http('links','GET','/api/projects/'+state.projectId+'/servers')).servers;
   for(const environment of [state.environment,state.environment+'-alt'])if(!links.some((l:any)=>l.environment===environment))await http('link','POST','/api/projects/'+state.projectId+'/servers',{serverId:server.id,remotePath:transport.checkout,environment},[201]);
   return {serverId:server.id,host:server.host,port:server.port,projectId:state.projectId,remotePath:transport.checkout,realSSH:true};
  });
  await check('actual_sync_async_failure_retry_and_fixture_service',async()=>{
   const sync=await call('exec_remote',{...correlated('sync-verify'),command:'relay-fixture verify'});
   const started=await job('service-start','relay-fixture start');must(started.status==='succeeded','fixture_start_failed');
   const failed=await job('intentional-failure','relay-fixture fail');must(failed.status==='failed','fixture_failure_not_recorded');
   const retry=await job('verify-after-failure','relay-fixture verify');must(retry.status==='succeeded','fixture_retry_failed');
   const legacy=await job('legacy-no-session','relay-fixture verify',false);must(legacy.status==='succeeded'&&!legacy.workSessionId,'legacy_job_failed');
   return {syncResponseHash:sync.textSha256,started,failed,retry,legacy,retryMeaning:'A new explicit Job after a controlled exit-17 failure; not an idempotent retry of the same operational job.'};
  });
  await check('actual_git_deployment_rollback_retry_and_legacy',async()=>{
   const failed=await deployment('missing-branch-rollback','fixture-missing-branch');must(failed.status==='failed'&&failed.rollback.status==='succeeded'&&failed.rollback.commit===transport.initialCommit,'git_rollback_failed');
   const success=await deployment('deploy-main','main');must(success.status==='succeeded'&&success.commitBefore===transport.initialCommit&&success.commitAfter===transport.latestCommit,'git_deployment_failed');
   const legacy=await deployment('legacy-deploy','main',false);must(legacy.status==='succeeded'&&!legacy.workSessionId,'legacy_deploy_failed');
   const restart=await job('fixture-service-restart','relay-fixture restart');must(restart.status==='succeeded','fixture_restart_failed');
   const data=await(await fetch('http://127.0.0.1:18323/version.txt')).text();must(hash(data)===hash('isolated fixture version two\n'),'fixture_service_new_revision_missing');
   return {failed,success,legacy,restart,serviceResponseSha256:hash(data),serviceRestart:'actual dedicated Python HTTP child restarted by a real SSH Job',genericDeploymentWorkload:'Git checkout only; no PM2/Docker runtime'};
  });
  await check('diagnostic_and_scope_rejection',async()=>{
   const impact:any=await call('samplemanager_impact_analysis',{...correlated('diagnostic-impact'),objectId:'opsfixture:version.txt'});
   must(JSON.stringify(impact).includes(state.sessionId),'diagnostic_session_missing');
   await call('exec_remote',{...correlated('forged-session'),workSessionId:'session-does-not-exist',command:'relay-fixture verify',async:true},true);
   await call('exec_remote',{...correlated('wrong-environment'),environment:state.environment+'-alt',command:'relay-fixture verify',async:true},true);
   await call('exec_remote',{...correlated('foreign-actor'),command:'relay-fixture verify',async:true},true,foreign!);
   await call('samplemanager_impact_analysis',{...correlated('wrong-diagnostic-environment'),environment:state.environment+'-alt',objectId:'opsfixture'},true);
   return {diagnostic:'real source-backed impact API; no LIMS installed and no relations present',diagnosticHash:hash(JSON.stringify(impact)),forgedSessionDenied:true,environmentDenied:true,foreignActorDenied:true};
  });
  await check('capture_actual_events_and_replay_deduplication',async()=>{
   const before=await captureReady();state.captureBeforeReplay=before;
   const ids=before.sourceEvents.filter(e=>['job.finished','job.failed','deployment.finished','deployment.failed','deployment.rolled_back'].includes(e.type)).map(e=>e.id);must(ids.length>=5,'too_few_actual_events');
   const replay:any=await http('capture_replay','POST','/api/knowledge/operations/capture/replay',{eventIds:ids,includeProcessed:true,dryRun:false,limit:100},[200],false,{'idempotency-key':state.runId+':replay'});
   await new Promise(r=>setTimeout(r,2500));const after=await captureReady();
   must(JSON.stringify(before.events)===JSON.stringify(after.events),'duplicate_session_events');must(JSON.stringify(before.evidence)===JSON.stringify(after.evidence),'duplicate_or_mutated_evidence');must(JSON.stringify(before.observations)===JSON.stringify(after.observations),'duplicate_observations');must(JSON.stringify(before.candidates)===JSON.stringify(after.candidates),'duplicate_candidates');
   state.captureAfterReplay=after;
   for(const evidence of after.evidence.slice(0,2)){const e=(await http('evidence','GET','/api/knowledge/evidence/'+evidence.id)).evidence;must(e.sha256===evidence.sha256,'evidence_hash_changed');await http('foreign_evidence','GET','/api/knowledge/evidence/'+evidence.id,undefined,[403,404],true);}
   return {eventCount:after.events.length,sourceEventCount:after.sourceEvents.length,observationCount:after.observations.length,evidenceCount:after.evidence.length,candidateCount:after.candidates.length,replayResponse:replay,stable:true};
  });
  state.operationsExecuted=true;state.beforeSecondRestart={at:new Date().toISOString(),capture:captured(),jobs:state.jobs,deployments:state.deployments};report.awaitingCoordinatedRestart=true;
 }


 if(mode==='privacy')await check('session_sensitive_field_rejection_and_incremental_scan',async()=>{
  const files=[ROOT+'/runtime/relay-web.log',ROOT+'/runtime/relay-server.log',ROOT+'/runtime/relay-mcp.log',ROOT+'/relay/data/state/audit.jsonl'];
  const offsets=new Map<string,number>();for(const file of files)offsets.set(file,(await stat(file)).size);
  const marker='OPS_HIDDEN_REASONING_MUST_NOT_PERSIST_'+state.runId;
  await http('hidden_field_http','PATCH','/api/knowledge/sessions/'+state.sessionId,{idempotencyKey:state.runId+':hidden-http',patch:{hiddenReasoning:marker}},[400,403]);
  await call('knowledge_work_session_update',{sessionId:state.sessionId,idempotencyKey:state.runId+':hidden-mcp',patch:{hiddenReasoning:marker}},true);
  const rows=[db.prepare('SELECT * FROM knowledge_work_sessions WHERE id=?').get(state.sessionId),...db.prepare('SELECT * FROM knowledge_audit WHERE entity_id=? OR project_id=?').all(state.sessionId,state.projectId),...db.prepare('SELECT * FROM relay_domain_events WHERE project_id=?').all(state.projectId)];
  const encoded=JSON.stringify(rows);const dbScan={bytes:Buffer.byteLength(encoded),hiddenMarkerOccurrences:encoded.split(marker).length-1,credentialOccurrences:[token,foreignToken].filter(secret=>encoded.includes(secret)).length};
  const scans=[];for(const path of files){const bytes=await readFile(path);const start=offsets.get(path)!;must(bytes.length>=start,'log_rotated_during_scan');const delta=bytes.subarray(start).toString('utf8');scans.push({path:path.slice(ROOT.length+1),offset:start,bytes:Buffer.byteLength(delta),hiddenMarkerOccurrences:delta.split(marker).length-1,credentialOccurrences:[token,foreignToken].filter(secret=>delta.includes(secret)).length});}
  report.privacyScan={db:dbScan,logs:scans,markerSha256:hash(marker),markerIsSynthetic:true};
  must(dbScan.hiddenMarkerOccurrences===0&&dbScan.credentialOccurrences===0&&scans.every(s=>s.hiddenMarkerOccurrences===0&&s.credentialOccurrences===0),'session_sensitive_field_leaked');
  return report.privacyScan;
 });
 if(mode==='scope-checks'){
  await check('cross_project_and_sync_scope_enforcement',async()=>{
   const projectName=state.projectName+'-scope';let project=(await http('scope_projects','GET','/api/projects')).projects.find((p:any)=>p.name===projectName);
   if(!project)project=(await http('scope_project_create','POST','/api/projects',{name:projectName,description:'Secondary isolated scope boundary; no production resources.'},[201])).project;
   must(project.workspacePath.startsWith(ROOT+'/'),'scope_workspace_outside_root');
   const links=(await http('scope_links','GET','/api/projects/'+project.id+'/servers')).servers;
   if(!links.some((p:any)=>p.environment===state.environment))await http('scope_link','POST','/api/projects/'+project.id+'/servers',{serverId:state.serverId,remotePath:transport.checkout,environment:state.environment},[201]);
   await call('exec_remote',{...correlated('wrong-project'),project:projectName,command:'relay-fixture verify',async:true},true);
   await call('samplemanager_impact_analysis',{...correlated('wrong-project-diagnostic'),project:projectName,objectId:'opsfixture'},true);
   const results:any[]=[];
   for(const [name,override] of [['forged_sync',{workSessionId:'session-does-not-exist'}],['wrong_environment_sync',{environment:state.environment+'-alt'}],['wrong_project_sync',{project:projectName}]] as const){
    const before=(await readFile(F+'/executions.jsonl','utf8')).trim().split('\n').length;
    const tool=names.find(n=>n==='exec_remote'||n.endsWith('_exec_remote'))!;
    const response:any=await admin!.callTool({name:tool,arguments:{...correlated(name),...override,command:'relay-fixture verify',async:false}});
    const after=(await readFile(F+'/executions.jsonl','utf8')).trim().split('\n').length;
    results.push({name,rejected:response.isError===true,actualFixtureCommands:after-before,responseSha256:hash(JSON.stringify(response))});
   }
   report.scopeFindings=results;state.scopeFindings=results;
   must(results.every(r=>r.rejected&&r.actualFixtureCommands===0),'sync_session_scope_bypass');
   return {crossProjectAsyncDenied:true,crossProjectDiagnosticDenied:true,synchronousChecks:results};
  });
 }
 if(mode==='after-restart'||mode==='close'){
  must(state.operationsExecuted,'operations_not_completed');
  await check('correlations_survive_second_restart',async()=>{const after=captured();must(JSON.stringify(after)===JSON.stringify(state.beforeSecondRestart.capture),'restart_correlations_changed');for(const job of state.jobs){const current:any=await call('job_status',{jobId:job.id});must(current.id===job.id&&current.status===job.status&&current.workSessionId===job.workSessionId,'restart_job_changed');}return {jobCount:state.jobs.length,deploymentCount:state.deployments.length,eventCount:after.events.length,evidenceCount:after.evidence.length,stable:true};});
 }
 if(mode==='close')await check('concurrent_close_and_final_summary',async()=>{
  const result={summary:'Completed real isolated SSH Jobs, Git failure rollback and deployment, actual fixture service restart, Capture replay, ACL, and coordinated Relay restart validation.',unknowns:['No production server or SampleManager instance was exercised.'],acceptanceResults:{realOperations:true,scopeIsolation:true,restartDurability:true,captureReplayStable:true}};
  const args={sessionId:state.sessionId,idempotencyKey:state.runId+':close',result};const second=await connect(token);
  try{const both:any[]=await Promise.all([call('knowledge_work_session_close',args),call('knowledge_work_session_close',args,false,second)]);must(both[0].session.closedAt===both[1].session.closedAt&&both[0].session.status==='completed','concurrent_close_mismatch');}finally{await second.close();}
  const count=(db.prepare("SELECT count(*) n FROM knowledge_audit WHERE action='knowledge.work_session.close' AND entity_id=?").get(state.sessionId) as any).n;must(count===1,'duplicate_close_audit');
  const summary:any=await call('knowledge_work_session_list',{sessionId:state.sessionId});must(summary.session.unknowns.length===1&&summary.session.acceptanceResults.realOperations===true,'final_result_missing');state.closedAt=summary.session.closedAt;
  const stopped=await job('cleanup-stop','relay-fixture stop',false);must(stopped.status==='succeeded','fixture_stop_failed');return {sessionId:state.sessionId,status:summary.session.status,closedAt:summary.session.closedAt,eventCounts:summary.eventCounts,oneEffectiveCloseAudit:true,fixtureServiceStopped:true};
 });
 report.ledgerAfter=ledger();report.providerCounts=db.prepare('SELECT provider_id,count(*) AS admissions FROM knowledge_provider_admissions GROUP BY provider_id').all();report.ownDirectModelRequests=0;report.status='passed';
}catch(error){report.status='failed';report.code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'driver_or_contract_failure';process.exitCode=1;}
finally{await admin?.close();await foreign?.close();db.close();report.finishedAt=new Date().toISOString();await save();console.log('[ops-e2e] '+report.status+(report.code?': '+report.code:''));}
