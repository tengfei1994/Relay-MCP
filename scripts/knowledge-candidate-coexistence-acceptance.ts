/** Isolated #47 acceptance: real loopback HTTP and local Jobs, never a cloud model or active database. */
import {createHash,randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,basename} from 'node:path';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {spawn} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';

type Row=Record<string,any>;
type Mode='timeout'|'rate_limited'|'invalid_json'|'retry_recovery';
const check=(value:unknown,code:string)=>{if(!value)throw new Error(code);};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const wait=async(predicate:()=>boolean|Promise<boolean>,code:string,ms=10000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await predicate())return;await new Promise(yes=>setTimeout(yes,15));}throw new Error(code);};
const arg=process.argv.indexOf('--report');
const reportPath=resolve(arg<0?join('runtime',`candidate-coexistence-${Date.now()}.json`):process.argv[arg+1]);
check(!existsSync(reportPath),'report_exists');
const root=mkdtempSync(join(tmpdir(),'relay-candidate-coexistence-'));
const privateValues={credential:'SYNTHETIC_CREDENTIAL_'+randomBytes(12).toString('hex'),hidden:'SYNTHETIC_HIDDEN_'+randomBytes(12).toString('hex'),contextSecret:'SYNTHETIC_CONTEXT_SECRET_'+randomBytes(12).toString('hex'),errorBody:'SYNTHETIC_PROVIDER_ERROR_'+randomBytes(12).toString('hex')};
const bodyCanary='SYNTHETIC_EVIDENCE_BODY_'+randomBytes(12).toString('hex');
let stage='setup',logs='',nonLoopbackRequests=0,relayRequests=0,promptSensitiveMatches=0,evidenceId='';
const allowedOrigins=new Set<string>(),originalFetch=globalThis.fetch;
globalThis.fetch=((input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.hostname!=='127.0.0.1'||!allowedOrigins.has(url.origin)){nonLoopbackRequests++;throw new Error('fixture_network_blocked');}return originalFetch(input,init);}) as typeof fetch;
const sourceFiles=['scripts/knowledge-candidate-coexistence-acceptance.ts','src/knowledge/candidate-insight.ts','src/shared/candidate-compile-audit.ts','src/shared/retrieval-audit.ts','src/knowledge/candidate-worker.ts','src/knowledge/candidate-dispatch.ts','src/knowledge/candidate-provider.ts','src/knowledge/capture-worker.ts','src/knowledge/event-sink.ts','src/knowledge/provider-registry.ts','src/knowledge/provider-runtime.ts','src/knowledge/provider-probe.ts','src/shared/job-store.ts','src/server/routes/knowledge.ts'];
const report:Row={schemaVersion:1,status:'running',startedAt:new Date().toISOString(),scenarios:[],sourceHashes:Object.fromEntries(sourceFiles.map(path=>[path,hash(readFileSync(path))])),limits:['Synthetic managed provider on real loopback HTTP; zero cloud calls and no claim of actual model quality.','Actual HTTP routes and Candidate dispatchers; synthetic owner auth hook, not deployed JWT authentication or a new MCP catalog test.','Real local Node subprocess Jobs and real event/Capture services; no SSH, deployment or active database/config changes.','Capture backoff uses a separate store connection with a controlled clock; provider timeout and HTTP retry use real time.','Only fresh synthetic files are scanned; no retrospective cleanup or scan of historical live data.']};
const providerRequests:Row[]=[],release=new Map<Mode,()=>void>(),attempts:Partial<Record<Mode,number>>={};
const listen=(server:Server)=>new Promise<string>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',()=>{const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;allowedOrigins.add(url);yes(url);});});
const close=(server:Server)=>new Promise<void>(yes=>{server.closeAllConnections();server.close(()=>yes());});
const provider=createServer(async(req,res)=>{
 try{
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>65536){res.writeHead(413).end('{}');return;}}
  const body=JSON.parse(raw),mode=body.model as Mode;attempts[mode]=(attempts[mode]??0)+1;
  for(const value of Object.values(privateValues))if(raw.includes(value))promptSensitiveMatches++;
  providerRequests.push({mode,attempt:attempts[mode],credentialValid:req.headers.authorization==='Bearer '+privateValues.credential,jsonMode:body.response_format?.type==='json_object',maxTokens:body.max_tokens,promptLength:raw.length,promptSha256:hash(raw)});
  res.setHeader('content-type','application/json');
  if(mode==='timeout')return;
  if(attempts[mode]===1)await new Promise<void>(yes=>release.set(mode,yes));
  if(mode==='rate_limited'||mode==='retry_recovery'&&attempts[mode]===1){res.writeHead(429,{'retry-after':'0'}).end(JSON.stringify({error:{message:privateValues.errorBody}}));return;}
  const content=mode==='invalid_json'?'{broken':JSON.stringify({kind:'fact',statement:'A controlled fixture completed.',whyProposed:'The visible Evidence records the fixture.',evidenceRefs:[evidenceId],intentRefs:[],unknowns:['Production applicability is untested.'],reuseBoundary:{projectId:'1',environment:'nonprod'},confidence:0.8,confirmedFacts:[],observedBehavior:['The fixture was observed.']});
  res.end(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}));
 }catch{if(!res.headersSent)res.writeHead(500);res.end('{}');}
});
let app:any,store:any,captureStore:any,appDb:any,jobs:any;const dispatchers:Array<{stop:()=>Promise<void>}>=[];
try{
 const providerUrl=await listen(provider);
 Object.assign(process.env,{DB_PATH:join(root,'app.db'),KNOWLEDGE_DB_PATH:join(root,'knowledge.db'),KNOWLEDGE_ENGINE_HOME:join(root,'absent-engine'),RELAY_STATE_ROOT:join(root,'state'),WORKSPACE_ROOT:join(root,'workspace'),KNOWLEDGE_EVIDENCE_ROOT:join(root,'evidence'),KNOWLEDGE_CASEBOOK_ROOT:join(root,'casebook'),DOTENV_CONFIG_PATH:join(root,'absent.env'),PROVIDER_SECRET_KEY_FILE:join(root,'provider.key')});
 const [{default:Fastify},{db,runMigrations},{users,projects},{knowledgeRoutes},{getKnowledgeStore},{ProviderRegistry},{ProviderCredentialStore},{WorkSessionService},{EvidenceStore},{startCandidateInsightDispatcher},{createKnowledgeStore},{captureKnowledgeCandidates},{drainRelayEventSpool},{summarizeExec},{safeRequestLogSerializers,safeRequestLogHooks}]=await Promise.all([
  import('fastify'),import('../src/server/db/index.js'),import('../src/server/db/schema.js'),import('../src/server/routes/knowledge.js'),import('../src/server/knowledge-context.js'),import('../src/knowledge/provider-registry.js'),import('../src/knowledge/provider-credential-store.js'),import('../src/knowledge/work-session.js'),import('../src/knowledge/evidence-store.js'),import('../src/knowledge/candidate-dispatch.js'),import('../src/knowledge/store.js'),import('../src/knowledge/capture-worker.js'),import('../src/knowledge/event-sink.js'),import('../src/shared/output.js'),import('../src/server/request-log.js')]);
 appDb=(db as any).session.client;runMigrations();db.insert(users).values([{id:7,username:'candidate-owner',passwordHash:'unused'},{id:8,username:'candidate-foreign',passwordHash:'unused'}]).run();db.insert(projects).values([{id:1,userId:7,name:'Candidate fixture',workspacePath:root},{id:2,userId:8,name:'Foreign fixture',workspacePath:root}]).run();
 store=getKnowledgeStore();store.grantAcl('1',7,true);store.grantAcl('2',8,true);
 let captureNow=Date.now();captureStore=createKnowledgeStore({dbPath:process.env.KNOWLEDGE_DB_PATH!,clock:()=>new Date(captureNow)});
 const sessions=new WorkSessionService(store),evidence=new EvidenceStore(store,process.env.KNOWLEDGE_EVIDENCE_ROOT!);
 evidenceId=evidence.put({content:Buffer.from('Observed fixture behavior '+bodyCanary),mimeType:'text/plain',sourceKind:'log',projectId:'1',environment:'nonprod',locator:'fixture://visible-evidence'}).id;
 const foreignEvidence=evidence.put({content:Buffer.from('Foreign fixture evidence'),mimeType:'text/plain',sourceKind:'log',projectId:'2',environment:'nonprod',locator:'fixture://foreign-evidence'}).id;
 const secretRef=new ProviderCredentialStore(store).save(privateValues.credential),registry=new ProviderRegistry(store);
 for(const mode of ['timeout','rate_limited','invalid_json','retry_recovery'] as const)registry.upsert({id:'fixture-'+mode,kind:'candidate_llm',provider:'synthetic-openai-compatible-'+mode,baseUrl:providerUrl+'/v1',modelId:mode,secretRef,timeoutMs:3000,concurrency:1,maxRetries:mode==='retry_recovery'?1:0,quota:{maxCalls:20,windowMs:3600000},actorId:7});
 app=Fastify({logger:{stream:{write(line:string){logs+=line;}},serializers:safeRequestLogSerializers,hooks:safeRequestLogHooks}});app.addHook('onRequest',async()=>{relayRequests++;});app.decorate('authenticate',async(req:any,reply:any)=>{if(req.headers.authorization!=='Bearer synthetic-owner')return reply.code(401).send({error:'Unauthorized'});req.user={id:7,isAdmin:false};});await app.register(knowledgeRoutes);const relayUrl=await app.listen({host:'127.0.0.1',port:0});allowedOrigins.add(relayUrl);
 const http=async(path:string,body?:Row)=>{const response=await fetch(relayUrl+path,{method:body?'POST':'GET',headers:{authorization:'Bearer synthetic-owner','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,value:await response.json() as Row};};
 const open=(key:string)=>sessions.open({actorId:7,idempotencyKey:key,intent:{actorId:7,projectId:'1',environment:'nonprod',objective:'Verify a controlled fixture',actions:['verify'],phase:'validation',constraints:[],acceptanceCriteria:[],risk:'read_only',knowledgeMode:'capture'}});
 const count=(table:string)=>Number(store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
 const ids=()=>Object.fromEntries(['knowledge_candidates','knowledge_evidence','knowledge_observations'].map(table=>[table,store.db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map((row:Row)=>row.id)]));
 stage='evidence_acl';const aclSession=open('acl');
 const beforeAcl=providerRequests.length;const rejected=[];for(const ref of ['missing-evidence',foreignEvidence]){const response=await http('/api/knowledge/candidate-insights/compile',{sessionId:aclSession.id,evidenceRefs:[ref],providerId:'fixture-invalid_json',context:{}});check(response.status>=400&&response.status<500,'evidence_acl_accepted');rejected.push(response.status);}check(providerRequests.length===beforeAcl,'evidence_acl_called_provider');report.evidenceAcl={httpStatuses:rejected,providerCalls:0};
 jobs=await import('../src/shared/job-store.js');jobs.configureJobStore({eventSink:store,resolveProjectId:()=>1,validateWorkSession:(actor:number,_project:string,id:string,environment?:string)=>{try{sessions.assertSessionUsable({actorId:actor,sessionId:id,projectId:'1',environment});return true;}catch{return false;}}});
 const execute=(failure:boolean)=>new Promise<string>((yes,no)=>{const child=spawn(process.execPath,['-e',failure?'process.exit(17)':'process.stdout.write("Controlled fixture observation")'],{stdio:['ignore','pipe','pipe']});let stdout='';child.stdout.on('data',data=>stdout+=data);child.on('error',()=>no(new Error('Controlled fixture process failed')));child.on('close',code=>code===0?yes(summarizeExec('fixture verify',{stdout,stderr:'',code:0})):no(new Error('Controlled fixture exit 17')));});
 dispatchers.push(startCandidateInsightDispatcher(()=>store,{intervalMs:25}),startCandidateInsightDispatcher(()=>store,{intervalMs:25}));
 for(const mode of ['timeout','rate_limited','invalid_json','retry_recovery'] as const){
  stage=mode;const session=open(mode),context={statement:'Observed fixture requires review',objectiveRef:'objective-fixture',apiKey:privateValues.contextSecret,reasoning:privateValues.hidden,details:{chainOfThought:[privateValues.hidden],sourceLocator:'fixture://visible-evidence'}};
  const input={sessionId:session.id,evidenceRefs:[evidenceId],providerId:'fixture-'+mode,context,async:true};
  const queued=await http('/api/knowledge/candidate-insights/compile',input);check(queued.status===202&&queued.value.enqueued,'enqueue_failed');const candidateJobId=queued.value.job.id;
  const duplicate=await http('/api/knowledge/candidate-insights/compile',input);check(duplicate.status===202&&!duplicate.value.enqueued&&duplicate.value.job.id===candidateJobId,'queue_duplicate');
  await wait(()=>providerRequests.some(row=>row.mode===mode),'provider_not_started');const started=Date.now();
  const jobInput={environment:'nonprod',workSessionId:session.id,intentStep:'verify'};
  const successful=jobs.startJob({id:7,username:'candidate-owner'},'Candidate fixture','exec_remote',jobInput,()=>execute(false));
  const failed=jobs.startJob({id:7,username:'candidate-owner'},'Candidate fixture','exec_remote',jobInput,()=>execute(true));
  const jobStatuses=[];for(const job of [successful,failed])jobStatuses.push((await jobs.waitForJobRecord(job.id,7,{waitMs:2000,pollMs:10})).job.status);
  check(jobStatuses.join(',')==='succeeded,failed','job_execution_failed');drainRelayEventSpool(store);
  captureNow=Math.max(captureNow,Date.now());const captured=await captureKnowledgeCandidates(captureStore,'knowledge-capture',100);
  const summary=sessions.summarize({actorId:7,sessionId:session.id,limit:200});check(summary.events.length===4&&summary.observations.length===1&&summary.evidence.length>0,'capture_missing_job_evidence');
  const pending=await http('/api/knowledge/candidate-insight-jobs/'+candidateJobId);check(pending.value.job.status==='running','candidate_not_pending_during_capture');
  const mainPathMs=Date.now()-started;
  if(mode==='timeout'){
   const occurredAt=new Date().toISOString();const transient={id:'capture-transient',type:'job.failed',jobId:'capture-transient-job',occurredAt,actorId:7,projectNameSnapshot:'Resolvable fixture',payload:{environment:'nonprod',error:'Controlled retry failure',status:'failed'}};
   captureStore.append(transient);let resolverAvailable=false;const resolver=()=>{if(!resolverAvailable)throw new Error('Controlled resolver outage');return '1';};
   await captureKnowledgeCandidates(captureStore,'knowledge-capture',100,resolver);const transientClaim=captureStore.db.prepare("SELECT attempts,consumed_at FROM knowledge_outbox_claims WHERE event_id=? AND consumer_name='knowledge-capture'").get(transient.id);check(transientClaim.attempts===1&&!transientClaim.consumed_at,'capture_retry_not_deferred');
   captureNow+=40000;resolverAvailable=true;await captureKnowledgeCandidates(captureStore,'knowledge-capture',100,resolver);const transientCandidate='candidate-'+hash(transient.id);check(Boolean(store.db.prepare('SELECT id FROM knowledge_candidates WHERE id=?').get(transientCandidate)),'capture_retry_not_recovered');
   const afterRetry=ids();captureStore.append(transient);await captureKnowledgeCandidates(captureStore,'knowledge-capture',100,resolver);check(isDeepStrictEqual(ids(),afterRetry),'capture_retry_duplicate');report.captureRetry={initialFailures:1,recoveredExactlyOnce:true,controlledClockAdvanceMs:40000,candidateId:transientCandidate};
   const poison={id:'capture-poison',type:'job.failed',jobId:'capture-poison-job',occurredAt,actorId:7,projectNameSnapshot:'Missing fixture',payload:{environment:'nonprod',error:'Controlled poison failure',status:'failed'}};captureStore.append(poison);
   for(let attempt=0;attempt<6;attempt++){await captureKnowledgeCandidates(captureStore,'knowledge-capture',100,()=>undefined);captureNow+=40000;}
   const dlqPath=join(process.env.RELAY_STATE_ROOT!,'knowledge-capture-dead-letter.jsonl'),deadLetters=readFileSync(dlqPath,'utf8').trim().split('\n').map(line=>JSON.parse(line));check(deadLetters.length===1&&deadLetters[0].event.id===poison.id&&deadLetters[0].attempts===5,'dead_letter_invalid');
   const beforeDlqHash=hash(readFileSync(dlqPath));await captureKnowledgeCandidates(captureStore,'knowledge-capture',100,()=>undefined);check(hash(readFileSync(dlqPath))===beforeDlqHash,'dead_letter_duplicate');check(Boolean(store.db.prepare('SELECT id FROM relay_domain_events WHERE id=?').get(poison.id)),'dead_letter_lost_original');report.deadLetter={count:1,attempts:5,reason:deadLetters[0].reason,originalEventRetained:true,sha256:beforeDlqHash};
   check((await http('/api/knowledge/candidate-insight-jobs/'+candidateJobId)).value.job.status==='running','candidate_not_pending_during_retry');
  }
  release.get(mode)?.();
  let completed:Row={};await wait(async()=>{const response=await http('/api/knowledge/candidate-insight-jobs/'+candidateJobId);completed=response.value.job;return completed.status==='done'||completed.status==='failed';},'candidate_not_completed');check(completed.status==='done'&&completed.attempts===1,'candidate_queue_failed');
  const response=await http('/api/knowledge/candidate-insights/'+completed.insightId),insight=response.value.insight;check(response.status===200&&insight.status==='draft'&&insight.evidenceRefs.includes(evidenceId)&&insight.whyProposed&&insight.unknowns.length&&insight.reuseBoundary,'candidate_fallback_contract');
  const fallback=mode==='invalid_json'?'invalid_output':mode;
  if(mode==='retry_recovery')check(insight.generatedBy==='managed-candidate-llm:fixture-retry_recovery/retry_recovery'&&!insight.fallbackReason,'provider_retry_not_recovered');
  else check(insight.generatedBy==='deterministic-fallback-v1'&&insight.fallbackReason===fallback,'fallback_reason_mismatch');
  const callsBefore=providerRequests.length,replayed=await http('/api/knowledge/candidate-insights/compile',input);check(!replayed.value.enqueued&&replayed.value.job.insightId===insight.id,'completed_queue_replayed');
  const syncReplay=await http('/api/knowledge/candidate-insights/compile',{...input,async:false});check(syncReplay.value.insight.id===insight.id&&providerRequests.length===callsBefore,'completed_compile_called_again');
  const callCount=providerRequests.filter(row=>row.mode===mode).length;check(callCount===(mode==='retry_recovery'?2:1),'provider_attempt_count');
  report.scenarios.push({mode,status:'passed',mainPathCompletedWhilePending:true,mainPathMs,jobStatuses,jobIds:[successful.id,failed.id],sessionId:session.id,candidateJobId,insightId:insight.id,queueAttempts:completed.attempts,providerCalls:callCount,captureMaterializations:captured,sessionEvents:summary.events.length,sessionObservations:summary.observations.length,sessionEvidence:summary.evidence.length,fallbackReason:insight.fallbackReason??null,statusAfterCompile:insight.status,replayAdditionalCalls:0});
 }
 stage='replay';const beforeReplay=ids(),eventRows=store.db.prepare('SELECT * FROM relay_domain_events ORDER BY id').all(),eventHash=hash(JSON.stringify(eventRows));
 const replayIds=eventRows.filter((row:Row)=>row.id!=='capture-poison').map((row:Row)=>row.id);const replayed=captureStore.replayCaptureEvents({eventIds:replayIds,limit:100});await captureKnowledgeCandidates(captureStore,'knowledge-capture',100,()=> '1');check(isDeepStrictEqual(ids(),beforeReplay),'replay_materialization_duplicate');check(hash(JSON.stringify(store.db.prepare('SELECT * FROM relay_domain_events ORDER BY id').all()))===eventHash,'replay_mutated_events');report.replay={matched:replayed.matched,queued:replayed.queued,sameEvidenceAndCandidateIds:true,immutableEventSha256:eventHash};
 stage='privacy';const tables=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row:Row)=>row.name);let tableBytes=0;for(const table of tables){const serialized=JSON.stringify(store.db.prepare('SELECT * FROM "'+table.replaceAll('"','""')+'"').all());tableBytes+=Buffer.byteLength(serialized);for(const value of Object.values(privateValues))check(!serialized.includes(value),'sensitive_database_value');}
 const auditRows=store.db.prepare('SELECT details_json FROM knowledge_audit').all(),telemetry=JSON.stringify({auditRows,logs,providerRequests});for(const value of [...Object.values(privateValues),bodyCanary])check(!telemetry.includes(value),'sensitive_telemetry_value');
 const files:string[]=[];const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else files.push(path);}};walk(root);let fileBytes=0;for(const path of files){const bytes=readFileSync(path);fileBytes+=bytes.length;for(const value of Object.values(privateValues))check(!bytes.includes(Buffer.from(value)),'sensitive_file_value');}
 check(promptSensitiveMatches===0&&providerRequests.every(row=>row.credentialValid&&row.jsonMode&&row.maxTokens===4096),'provider_request_contract');
 report.privacy={canaryMatches:0,promptSensitiveMatches,tableCount:tables.length,tableBytes,filesScanned:files.length,fileBytes,auditRows:auditRows.length,logBytes:Buffer.byteLength(logs),telemetrySha256:hash(telemetry)};
 report.promotions=count('knowledge_cases')+count('knowledge_patterns')+count('knowledge_playbooks');check(report.promotions===0,'unexpected_promotion');
 report.counts={relayRequests,providerHttpRequests:providerRequests.length,providerLogicalAdmissions:count('knowledge_provider_admissions'),candidateInsightJobs:count('knowledge_candidate_insight_jobs'),candidateInsights:count('knowledge_candidate_insights'),events:count('relay_domain_events'),evidence:count('knowledge_evidence'),observations:count('knowledge_observations'),captureCandidates:count('knowledge_candidates')};
 check(report.counts.providerLogicalAdmissions===4&&report.counts.candidateInsights===4&&nonLoopbackRequests===0,'unexpected_invocation_count');report.providerRequests=providerRequests;report.policy={timeoutMs:3000,compilerOverallTimeoutMs:30000,concurrencyPerProvider:1,maxRetries:{faults:0,retryRecovery:1},quota:{maxLogicalCalls:20,windowMs:3600000},durableAdmissionUnit:'logical invocation; transport retries share its admission',candidateQueueMaxAttempts:5,captureMaxFailedAttempts:5,dispatcherInstances:2};report.cloudModelCalls=0;report.nonLoopbackRequests=nonLoopbackRequests;report.status='passed_isolated_candidate_coexistence';
}catch(error){report.status='failed';report.failure={stage,code:error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'fixture_error',type:error instanceof Error?error.name:'unknown',frames:error instanceof Error?error.stack?.split('\n').slice(1,3):[]};process.exitCode=1;
}finally{
 for(const callback of release.values())callback();await Promise.allSettled(dispatchers.map(dispatcher=>dispatcher.stop()));if(app)await app.close();await close(provider);jobs?.configureJobStore({});captureStore?.close();store?.close();appDb?.close();globalThis.fetch=originalFetch;
 check(dirname(resolve(root))===resolve(tmpdir())&&basename(root).startsWith('relay-candidate-coexistence-'),'cleanup_path_invalid');rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:20});report.completedAt=new Date().toISOString();mkdirSync(dirname(reportPath),{recursive:true});writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({status:report.status,reportPath,counts:report.counts,failure:report.failure}));
}
