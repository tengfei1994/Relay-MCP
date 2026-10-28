import {readFile,writeFile,chmod,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const ROOT='/home/ftd/relay-knowledge-engine-nonprod',F=ROOT+'/opsfixture';
if(process.env.RELAY_E2E_ISOLATED!=='1'||process.platform!=='linux'||resolve(process.cwd())!==ROOT+'/relay')throw Error('isolated_root_required');
const require=createRequire(ROOT+'/relay/package.json');
const Database=require('better-sqlite3');const {Client}=require('@modelcontextprotocol/sdk/client/index.js');const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const state=JSON.parse(await readFile(F+'/state.json','utf8')),token=(await readFile(ROOT+'/relay/data/e2e-admin.jwt','utf8')).trim(),foreignToken=(await readFile(ROOT+'/relay/data/e2e-foreign.jwt','utf8')).trim();
const scopedToken=(await readFile(F+'/mcp-scoped.jwt','utf8')).trim();
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex'),must=(ok,code)=>{if(!ok)throw Error(code);};
const db=new Database(ROOT+'/relay/data/knowledge.db',{readonly:true});
const report={schemaVersion:1,source:'actual upgraded HTTP/MCP and original operational Session',simulation:false,directCloudCalls:0,authScope:{temporaryTokenId:state.scopedTokenId,projectId:state.projectId,environment:state.environment,originalCrossEnvironmentTokenDenied:true},startedAt:new Date().toISOString(),sessionId:state.sessionId,status:'running',checks:[],http:[],mcp:[]};
const output=F+'/acceptance-postupgrade-summary-close-v2.json',save=()=>writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});let admin,foreign,second,names=[];
const ledger=()=>db.prepare('SELECT provider_id, count(*) AS admissions FROM knowledge_provider_admissions GROUP BY provider_id ORDER BY provider_id').all();
async function http(method,path,body,asForeign=false,expected=[200]){const start=Date.now(),res=await fetch('http://127.0.0.1:18300'+path,{method,headers:{authorization:'Bearer '+(asForeign?foreignToken:token),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});const raw=await res.text();report.http.push({method,path:path.split('?')[0],status:res.status,bytes:Buffer.byteLength(raw),durationMs:Date.now()-start});must(expected.includes(res.status),'unexpected_http_status');return res.status>=400?{}:JSON.parse(raw);}
async function connect(auth){const c=new Client({name:'relay-ops-summary-acceptance',version:'1.0'});await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18301/mcp'),{requestInit:{headers:{authorization:'Bearer '+auth}}}));return c;}
async function call(name,args,client=admin,denied=false){const tool=names.find(n=>n===name||n.endsWith('_'+name));must(tool,'tool_missing');const start=Date.now(),res=await client.callTool({name:tool,arguments:args},undefined,{timeout:150000});const raw=(res.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');report.mcp.push({tool:name,isError:res.isError===true,bytes:Buffer.byteLength(raw),responseSha256:hash(raw),durationMs:Date.now()-start});must(denied?res.isError===true:res.isError!==true,'unexpected_mcp_status');return denied?{}:JSON.parse(raw);}
async function step(name,fn){const item={name,status:'running'};report.checks.push(item);await save();console.log('[ops-summary] '+name+': running');try{item.evidence=await fn();item.status='passed';}catch(e){item.status='failed';throw e;}finally{await save();console.log('[ops-summary] '+name+': '+item.status);}}
const sorted=x=>x.map(String).sort();const sameIds=(a,b)=>JSON.stringify(sorted(a))===JSON.stringify(sorted(b));
function expectedRows(){
 const sources=db.prepare('SELECT id,type,project_id,actor_id,payload_json FROM relay_domain_events WHERE project_id=? ORDER BY id').all(state.projectId).filter(r=>{const p=JSON.parse(r.payload_json);return p.workSessionId===state.sessionId&&Number(r.actor_id)===1&&(p.environment??p.env??'')===state.environment;});
 const sourceIds=new Set(sources.map(r=>r.id));
 const observations=db.prepare('SELECT id,event_id FROM knowledge_observations WHERE project_id=? ORDER BY id').all(state.projectId).filter(r=>sourceIds.has(r.event_id));
 const observationIds=new Set(observations.map(r=>r.id));
 const candidateIds=new Set(db.prepare('SELECT c.id,c.event_id,c.environment FROM knowledge_candidates c JOIN knowledge_documents d ON d.id=c.id WHERE d.project_id=?').all(state.projectId).filter(r=>sourceIds.has(r.event_id)&&r.environment===state.environment).map(r=>r.id));
 const evidence=db.prepare("SELECT DISTINCT e.id,e.sha256,e.size_bytes AS sizeBytes,l.entity_type,l.entity_id FROM knowledge_evidence e JOIN knowledge_entity_evidence l ON l.evidence_id=e.id WHERE e.deleted_at IS NULL AND e.environment=? AND (e.project_id=? OR EXISTS(SELECT 1 FROM knowledge_evidence_acl a WHERE a.evidence_id=e.id AND a.project_id=?))").all(state.environment,state.projectId,state.projectId).filter(r=>(r.entity_type==='observation'&&observationIds.has(r.entity_id))||(r.entity_type==='candidate'&&candidateIds.has(r.entity_id)));
 const uniqueEvidence=[...new Map(evidence.map(({entity_id,entity_type,...r})=>[r.id,r])).values()].sort((a,b)=>a.id.localeCompare(b.id));
 const retrievals=db.prepare('SELECT id,query,results_json FROM knowledge_retrieval_runs WHERE project_id=?').all(state.projectId).filter(r=>{const m=JSON.parse(r.results_json);return m.workSessionId===state.sessionId&&m.actorId===1&&m.environment===state.environment;});
 return {sources:sources.map(({payload_json,...r})=>r),observations,evidence:uniqueEvidence,candidates:sorted([...candidateIds]),retrievals};
}
function allCaptured(){const events=db.prepare('SELECT event_id,event_type,intent_step,created_at FROM knowledge_work_session_events WHERE session_id=? ORDER BY created_at,rowid').all(state.sessionId);const obs=db.prepare('SELECT id,event_id,evidence_refs_json FROM knowledge_observations WHERE project_id=? ORDER BY id').all(state.projectId);const ev=db.prepare('SELECT id,sha256,size_bytes,source_kind FROM knowledge_evidence WHERE project_id=? ORDER BY id').all(state.projectId);const cand=db.prepare('SELECT c.id,c.event_id FROM knowledge_candidates c JOIN knowledge_documents d ON d.id=c.id WHERE d.project_id=? ORDER BY c.id').all(state.projectId);return {events,observations:obs,evidence:ev,candidates:cand};}
const summaryPath='/api/knowledge/sessions/'+state.sessionId+'/summary';
function safeSummary(s){return {events:s.events,observations:s.observations,evidence:s.evidence,retrievals:s.retrievals,pagination:s.pagination,coverage:s.coverage,eventCounts:s.eventCounts};}
try{
 report.ledgerBefore=ledger();must((await http('GET','/api/knowledge/sessions/'+state.sessionId)).session.status==='open','session_not_open');
 const restart=JSON.parse(await readFile(F+'/acceptance-after-restart.json','utf8')),scope=JSON.parse(await readFile(F+'/acceptance-scope-checks.json','utf8')),privacy=JSON.parse(await readFile(F+'/acceptance-privacy.json','utf8'));must([restart,scope,privacy].every(x=>x.status==='passed'),'prerequisite_not_passed');report.prerequisiteReportHashes={restart:hash(restart),scope:hash(scope),privacy:hash(privacy)};
 admin=await connect(scopedToken);foreign=await connect(foreignToken);names=(await admin.listTools()).tools.map(t=>t.name);

 await step('original_restart_snapshot_still_preserved',async()=>{
  const current=allCaptured(),baseline=state.beforeSecondRestart.capture;
  for(const key of ['events','observations','evidence','candidates'])for(const prior of baseline[key]){const id=key==='events'?'event_id':'id',now=current[key].find(x=>x[id]===prior[id]);must(JSON.stringify(now)===JSON.stringify(prior),'historical_'+key+'_changed');}
  const session=(await http('GET','/api/knowledge/sessions/'+state.sessionId)).session;must(hash(session.intent)===hash(state.beforeRestart.intent),'historical_intent_changed');
  for(const job of state.beforeSecondRestart.jobs){const now=await call('job_status',{jobId:job.id});must(now.id===job.id&&now.status===job.status&&now.workSessionId===job.workSessionId,'historical_job_changed');}
  return {baselineSnapshotSha256:hash(baseline),originalRowsPreserved:true,knownLaterRowsKept:true,originalJobCount:state.beforeSecondRestart.jobs.length};
 });
 const logFiles=[ROOT+'/runtime/relay-web.log',ROOT+'/runtime/relay-server.log',ROOT+'/runtime/relay-mcp.log',ROOT+'/relay/data/state/audit.jsonl'],offsets=new Map();for(const path of logFiles)offsets.set(path,(await stat(path)).size);
 const privateMarker='OPS_NEW_TOOL_PRIVACY_'+state.runId;
 await step('new_scoped_success_and_exit17_jobs',async()=>{
  state.postUpgradeScopedJobs??=[];
  for(const [label,command,status] of [['verify','relay-fixture verify','succeeded'],['exit17','relay-fixture fail','failed']]){
   let owned=state.postUpgradeScopedJobs.find(x=>x.label===label);
   if(!owned){const q=await call('exec_remote',{project:state.projectName,environment:state.environment,workSessionId:state.sessionId,intentStep:'verify',objectiveRef:'ops-isolation',acceptanceCriterionRef:'actual-correlation',command,async:true,timeoutMs:15000});must(q.jobId,'scoped_job_missing');owned={id:q.jobId,label};state.postUpgradeScopedJobs.push(owned);await writeFile(F+'/state.json',JSON.stringify(state,null,2)+'\n',{mode:0o600});}
   const job=await call('job_wait',{jobId:owned.id,waitMs:25000,pollMs:100});must(job.status===status&&job.workSessionId===state.sessionId&&job.environment===state.environment,'scoped_job_status_or_environment');owned.status=job.status;
  }
  let ready=false;for(let n=0;n<80;n++){const expected=expectedRows(),ids=state.postUpgradeScopedJobs.map(x=>x.id);const records=db.prepare('SELECT job_id,type,payload_json FROM relay_domain_events WHERE project_id=?').all(state.projectId).filter(x=>ids.includes(x.job_id));if(records.length===4){must(records.every(x=>JSON.parse(x.payload_json).environment===state.environment),'new_job_missing_top_level_scope');const failure=state.postUpgradeScopedJobs.find(x=>x.label==='exit17');ready=!!db.prepare('SELECT 1 FROM knowledge_candidates WHERE job_id=? AND environment=?').get(failure.id,state.environment)&&expected.observations.length>=2;if(ready)break;}await new Promise(r=>setTimeout(r,250));}must(ready,'new_scoped_capture_not_ready');
  await writeFile(F+'/state.json',JSON.stringify(state,null,2)+'\n',{mode:0o600});return {jobs:state.postUpgradeScopedJobs,eventEnvironment:state.environment,historicalRecordsBackfilled:false};
 });
 await step('new_get_and_impact_receipts_idempotent_and_scoped',async()=>{
  const schema=(await admin.listTools()).tools.find(x=>x.name==='knowledge_get');must(schema?.inputSchema?.properties?.workSessionId,'new_get_schema_missing');
  const failure=state.postUpgradeScopedJobs.find(x=>x.label==='exit17');const document=db.prepare('SELECT d.id FROM knowledge_documents d JOIN knowledge_candidates c ON c.id=d.id WHERE c.job_id=? AND d.project_id=? AND d.environment=?').get(failure.id,state.projectId,state.environment);must(document,'actual_scoped_candidate_missing');
  const before=await http('GET',summaryPath+'?limit=200'),args={documentId:document.id,project:state.projectName,workSessionId:state.sessionId,hiddenReasoning:privateMarker};
  const first=await call('knowledge_get',args),middle=await http('GET',summaryPath+'?limit=200'),again=await call('knowledge_get',args),after=await http('GET',summaryPath+'?limit=200');
  must(hash(first)===hash(again)&&typeof first.body==='string','get_response_changed');must(middle.retrievals.length===before.retrievals.length+1&&after.retrievals.length===middle.retrievals.length,'get_receipt_not_idempotent');const receipt=middle.retrievals.find(x=>!before.retrievals.some(y=>y.id===x.id));must(receipt.operation==='document_read'&&receipt.resultCount===1,'get_receipt_contract');
  const impact={project:state.projectName,environment:state.environment,objectId:'opsfixture:version.txt',workSessionId:state.sessionId,intentStep:'verify',objectiveRef:privateMarker,acceptanceCriterionRef:privateMarker,hiddenReasoning:privateMarker};
  const result=await call('samplemanager_impact_analysis',impact),one=await http('GET',summaryPath+'?limit=200');await call('samplemanager_impact_analysis',impact);const two=await http('GET',summaryPath+'?limit=200');
  const event=one.events.find(x=>x.event_type==='samplemanager.impact_analysis'&&!after.events.some(y=>y.event_id===x.event_id));must(event&&one.events.length===after.events.length+1&&hash(safeSummary(one))===hash(safeSummary(two)),'impact_receipt_not_idempotent');must(event.intent_step==='verify'&&event.objective_ref==='sha256:'+hash(privateMarker)&&event.acceptance_criterion_ref==='sha256:'+hash(privateMarker),'impact_refs_not_hashed');
  const checkpoint=hash(safeSummary(two));await call('knowledge_get',args,foreign,true);await call('samplemanager_impact_analysis',impact,foreign,true);await call('samplemanager_impact_analysis',{...impact,environment:state.environment+'-alt'},admin,true);must(hash(safeSummary(await http('GET',summaryPath+'?limit=200')))===checkpoint,'denial_created_receipt');
  return {documentId:document.id,bodySha256:hash(first.body),bodyBytes:Buffer.byteLength(first.body),receiptId:receipt.id,impactEventId:event.event_id,impactRelationCount:result.facts?.length??0,getReplayStable:true,impactReplayStable:true,denialsNoReceipt:true};
 });
 const query='relay fixture '+state.runId+' LOCAL_RETRIEVAL_SENTINEL';let sourceRetrieval;

 await step('formal_local_retrieval_receipt',async()=>{
  const params=new URLSearchParams({projectId:String(state.projectId),environment:state.environment,workSessionId:state.sessionId,kinds:'candidate,case,pattern,playbook,fact',q:query,limit:'20'});
  const before=expectedRows().retrievals.length,r=await http('GET','/api/knowledge/search?'+params);sourceRetrieval=r.retrievalRunId;must(typeof sourceRetrieval==='string','retrieval_id_missing');must(r.results.every(x=>x.kind!=='product_document'),'unexpected_product_result');
  const rows=expectedRows().retrievals;must(rows.length===before+1,'receipt_missing');const receipt=rows.find(x=>JSON.parse(x.results_json).sourceRunIdHash===hash(sourceRetrieval));must(receipt&&receipt.query==='sha256:'+hash(query),'receipt_hash_wrong');must(!JSON.stringify(receipt).includes(query),'raw_query_persisted');
  return {sourceRetrievalRunId:sourceRetrieval,receiptId:receipt.id,resultCount:r.results.length,resultIds:r.results.map(x=>x.id),querySha256:hash(query),localOnly:true};
 });
 let summaryBefore;
 await step('formal_http_mcp_summary_scope_and_pagination',async()=>{
  const s=await http('GET',summaryPath+'?limit=200'),m=await call('knowledge_work_session_list',{sessionId:state.sessionId,limit:200});must(JSON.stringify(s)===JSON.stringify(m),'http_mcp_summary_diverged');
  const expected=expectedRows();must(expected.observations.length>0&&expected.evidence.length>0&&expected.sources.length>=8,'real_chain_missing');
  must(sameIds(s.observations.map(x=>x.id),expected.observations.map(x=>x.id)),'summary_observation_scope');must(sameIds(s.evidence.map(x=>x.id),expected.evidence.map(x=>x.id)),'summary_evidence_scope');must(sameIds(s.retrievals.map(x=>x.id),expected.retrievals.map(x=>x.id)),'summary_retrieval_scope');
  for(const e of s.evidence){const actual=expected.evidence.find(x=>x.id===e.id);must(e.sha256===actual.sha256&&e.sizeBytes===actual.sizeBytes,'evidence_integrity');}
  const totals={events:s.events.length,observations:s.observations.length,evidence:s.evidence.length,retrievals:s.retrievals.length};const gathered={events:[],observations:[],evidence:[],retrievals:[]};
  for(let offset=0;offset<Math.max(...Object.values(totals));offset+=7){const page=await http('GET',summaryPath+'?limit=7&offset='+offset);for(const key of Object.keys(gathered)){gathered[key].push(...page[key]);must(page.pagination[key].total===totals[key]&&page.pagination[key].limit===7&&page.pagination[key].offset===offset,'pagination_contract');}}
  for(const key of Object.keys(gathered))must(JSON.stringify(gathered[key])===JSON.stringify(s[key]),'pagination_unstable_'+key);
  await http('GET',summaryPath,undefined,true,[403,404]);await call('knowledge_work_session_list',{sessionId:state.sessionId},foreign,true);
  const joined=JSON.stringify(safeSummary(s));must(!joined.includes(query)&&!joined.includes(token)&&!joined.includes(foreignToken),'summary_privacy');must(!/"(?:body|stdout|stderr|snippet|queryTokens|storage_path|payload_json)"\s*:/.test(joined),'summary_contains_content');
  summaryBefore=s;return {totals,coverage:s.coverage,eventCounts:s.eventCounts,referenceSha256:hash(safeSummary(s)),foreignDenied:true,paginationStable:true,evidenceIdsAndHashes:expected.evidence,originalSourceEvents:expected.sources,historicalUnscopedExcluded:true};
 });
 await step('actual_capture_double_replay_preserves_complete_chain',async()=>{
  const before=allCaptured(),expected=expectedRows();const ids=expected.sources.filter(x=>['job.finished','job.failed','deployment.finished','deployment.failed','deployment.rolled_back'].includes(x.type)).map(x=>x.id);must(ids.length>=5,'terminal_event_set_missing');const replies=[];
  for(let n=0;n<2;n++){const r=await http('POST','/api/knowledge/operations/capture/replay',{eventIds:ids,includeProcessed:true,dryRun:false,limit:100});replies.push({sha256:hash(r),eventCount:ids.length});await new Promise(r=>setTimeout(r,1200));const after=allCaptured();must(JSON.stringify(before)===JSON.stringify(after),'capture_replay_changed_chain');}
  const s=await http('GET',summaryPath+'?limit=200');must(JSON.stringify(safeSummary(s))===JSON.stringify(safeSummary(summaryBefore)),'capture_replay_changed_summary');return {replays:2,replies,snapshotSha256:hash(before),events:before.events.length,observations:before.observations.length,evidence:before.evidence.length,candidates:before.candidates.length,idsAndEvidenceHashesUnchanged:true};
 });

 await step('fresh_session_receipts_do_not_inherit_original_evidence',async()=>{
  const opened=await http('POST','/api/knowledge/sessions',{idempotencyKey:state.runId+':fresh-postupgrade',intent:{...state.beforeRestart.intent,actorId:1}},false,[201]);const fresh=opened.session;state.freshControlSessionId=fresh.id;must(fresh.id!==state.sessionId&&fresh.status==='open','fresh_session_invalid');
  const failure=state.postUpgradeScopedJobs.find(x=>x.label==='exit17'),document=db.prepare('SELECT d.id FROM knowledge_documents d JOIN knowledge_candidates c ON c.id=d.id WHERE c.job_id=? AND d.environment=?').get(failure.id,state.environment);
  const input={documentId:document.id,project:state.projectName,workSessionId:fresh.id};await call('knowledge_get',input);await call('knowledge_get',input);
  const impact={project:state.projectName,environment:state.environment,objectId:'opsfixture:version.txt',workSessionId:fresh.id,intentStep:'verify'};await call('samplemanager_impact_analysis',impact);await call('samplemanager_impact_analysis',impact);
  const value=await http('GET','/api/knowledge/sessions/'+fresh.id+'/summary?limit=200');must(value.retrievals.length===1&&value.events.length===2&&value.observations.length===0&&value.evidence.length===0,'fresh_session_inherited_chain');
  const result=await call('knowledge_work_session_close',{sessionId:fresh.id,idempotencyKey:state.runId+':fresh-close',result:{summary:'Fresh Session receipt isolation verified.',unknowns:[],acceptanceResults:{isolatedReceipts:true}}});must(result.session.status==='completed','fresh_close_failed');await writeFile(F+'/state.json',JSON.stringify(state,null,2)+'\n',{mode:0o600});
  return {sessionId:fresh.id,events:2,retrievals:1,observations:0,evidence:0,status:result.session.status};
 });
 await step('incremental_new_tool_privacy_scan',async()=>{
  const scans=[];for(const path of logFiles){const raw=await readFile(path),offset=offsets.get(path);must(raw.length>=offset,'privacy_log_rotated');const text=raw.subarray(offset).toString('utf8');scans.push({path:path.slice(ROOT.length+1),bytes:Buffer.byteLength(text),privateMarkerOccurrences:text.split(privateMarker).length-1,queryOccurrences:text.split(query).length-1,credentialOccurrences:[token,foreignToken,scopedToken].filter(x=>text.includes(x)).length});}
  const rows=[...db.prepare('SELECT * FROM knowledge_work_session_events WHERE session_id IN (?,?)').all(state.sessionId,state.freshControlSessionId),...db.prepare('SELECT * FROM knowledge_retrieval_runs WHERE project_id=?').all(state.projectId)];const text=JSON.stringify(rows);must(!text.includes(privateMarker)&&!text.includes(query)&&!text.includes(token)&&!text.includes(foreignToken)&&!text.includes(scopedToken),'receipt_db_privacy');must(scans.every(x=>x.privateMarkerOccurrences===0&&x.queryOccurrences===0&&x.credentialOccurrences===0),'new_tool_audit_privacy');return {scans,scopedDatabaseBytes:Buffer.byteLength(text),matches:0};
 });
 await step('concurrent_close_and_final_summary',async()=>{

  const before=allCaptured(),args={sessionId:state.sessionId,idempotencyKey:state.runId+':postupgrade-close',result:{summary:'Real isolated SSH Jobs and Git deployments, controlled failure/rollback, fixture restart, coordinated Relay restart, ACL/privacy and Capture replay verified.',unknowns:['No production server or SampleManager instance was exercised.'],acceptanceResults:{realOperations:true,scopeIsolation:true,restartDurability:true,captureReplayStable:true,summaryReferences:true}}};second=await connect(scopedToken);
  const results=await Promise.all([call('knowledge_work_session_close',args),call('knowledge_work_session_close',args,second)]);must(results.every(x=>x.session.status==='completed')&&results[0].session.closedAt===results[1].session.closedAt,'concurrent_close_mismatch');
  const count=db.prepare("SELECT count(*) n FROM knowledge_audit WHERE action='knowledge.work_session.close' AND entity_id=?").get(state.sessionId).n;must(count===1,'duplicate_close_audit');
  const s=await http('GET',summaryPath+'?limit=200'),m=await call('knowledge_work_session_list',{sessionId:state.sessionId,limit:200});must(JSON.stringify(s)===JSON.stringify(m),'closed_summary_diverged');must(s.session.status==='completed'&&s.session.unknowns.length===1&&s.session.acceptanceResults.summaryReferences===true,'close_result_missing');must(JSON.stringify(before)===JSON.stringify(allCaptured()),'close_mutated_evidence');must(JSON.stringify(safeSummary(summaryBefore))===JSON.stringify(safeSummary(s)),'close_mutated_references');
  state.closedAt=s.session.closedAt;await writeFile(F+'/state.json',JSON.stringify(state,null,2)+'\n',{mode:0o600});return {closedAt:s.session.closedAt,status:s.session.status,closeAuditRows:count,twoConcurrentClients:true,preservedReferenceSha256:hash(safeSummary(s)),unknownCount:1,acceptanceResults:s.session.acceptanceResults};
 });
 await step('legacy_cleanup_stops_only_fixture_service',async()=>{
  const q=await call('exec_remote',{project:state.projectName,environment:state.environment,command:'relay-fixture stop',async:true,timeoutMs:15000});must(q.jobId,'cleanup_job_missing');const j=await call('job_wait',{jobId:q.jobId,waitMs:25000,pollMs:100});must(j.status==='succeeded'&&!j.workSessionId,'legacy_cleanup_failed');
  let reachable=false;try{const r=await fetch('http://127.0.0.1:18323/version.txt',{signal:AbortSignal.timeout(1000)});reachable=r.ok;}catch{}must(!reachable,'fixture_service_still_running');state.cleanupJobId=q.jobId;await writeFile(F+'/state.json',JSON.stringify(state,null,2)+'\n',{mode:0o600});return {jobId:q.jobId,status:j.status,legacyNoSession:true,fixtureServicePort:18323,stopped:true};
 });
 report.ledgerAfter=ledger();report.ledgerInterpretation='Global counts may increase because the authorized full-corpus migration runs concurrently; this packet has no cloud provider invocation path.';report.status='passed';
}catch(e){report.status='failed';report.code=e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'driver_or_contract_failure';report.errorClass=e?.name;process.exitCode=1;}
finally{await second?.close();await foreign?.close();await admin?.close();db.close();report.finishedAt=new Date().toISOString();await save();await chmod(output,0o600);console.log(JSON.stringify({status:report.status,checks:report.checks.length,...(report.code?{code:report.code}:{})}));}
