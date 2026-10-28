/** Real loopback HTTP with injected provider responses and synthetic credentials.
 * Never imports application composition roots or opens an existing service DB. */
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createHash,randomBytes} from 'node:crypto';
import {mkdirSync,existsSync,readFileSync,writeFileSync,statSync,realpathSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {tmpdir} from 'node:os';
const option=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const root=resolve(option('--root')??'');
const allowedRoot='/home/ftd/relay-knowledge-engine-nonprod/providerfixture';
const testing=process.env.RELAY_PROVIDER_FIXTURE_TEST==='1';
if(!option('--root')||(!testing&&(process.platform!=='linux'||process.env.RELAY_E2E_ISOLATED!=='1'||!root.startsWith(allowedRoot+'/')))||(testing&&!root.startsWith(resolve(tmpdir())+sep)))throw new Error('isolated_fixture_root_required');
mkdirSync(root,{recursive:true,mode:0o700});
if(realpathSync(root)!==root||existsSync(join(root,'knowledge.db')))throw new Error('fresh_private_fixture_required');
Object.assign(process.env,{DOTENV_CONFIG_PATH:join(root,'absent.env'),NODE_ENV:'test',DB_PATH:join(root,'app.db'),KNOWLEDGE_DB_PATH:join(root,'knowledge.db'),PROVIDER_SECRET_KEY_FILE:join(root,'provider.key'),RELAY_STATE_ROOT:join(root,'state'),WORKSPACE_ROOT:join(root,'workspace'),KNOWLEDGE_EVIDENCE_ROOT:join(root,'evidence'),KNOWLEDGE_CASEBOOK_ROOT:join(root,'casebook'),KNOWLEDGE_ENGINE_HOME:join(root,'uninstalled-engine'),KNOWLEDGE_ENGINE_ENABLED:'false',JWT_SECRET:randomBytes(32).toString('hex'),HOST:'127.0.0.1',PORT:'0',MCP_PORT:'0'});
const hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
const check=(condition:unknown,code:string)=>{if(!condition)throw new Error(code);};
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const tokens={A:'synthetic-A-'+randomBytes(24).toString('hex'),B:'synthetic-B-'+randomBytes(24).toString('hex'),C:'synthetic-C-'+randomBytes(24).toString('hex')};
const gatewayToken='synthetic-engine-'+randomBytes(24).toString('hex'),privateInput='private-fixture-body-'+randomBytes(16).toString('hex'),privateError='private-fixture-error-'+randomBytes(16).toString('hex');
const count={providerHttp:0,relayHttp:0,gatewayEntered:0};
const calls:any[]=[],responses:string[]=[];let logs='',mode='ok',rateRemaining=0;
const holds=new Map<string,{promise:Promise<void>;release:()=>void}>();
function hold(key:string){let release!:()=>void;const promise=new Promise<void>(r=>release=r);holds.set(key,{promise,release});return ()=>{release();holds.delete(key);};}
async function waitFor(condition:()=>boolean,label:string){const deadline=Date.now()+5000;while(!condition()){if(Date.now()>deadline)throw new Error('wait_'+label);await delay(5);}}
const report:any={schemaVersion:1,status:'running',injectedFaults:true,sourceMode:'isolated current-source process using real HTTP sockets',scope:'Synthetic credentials and loopback responder; not real cloud rejection or account-side token revocation',externalCloudCalls:0,credentials:{synthetic:true},startedAt:new Date().toISOString(),checks:[],counts:count,sourceHashes:Object.fromEntries(['scripts/knowledge-provider-transport-acceptance.ts','src/knowledge/provider-setup.ts','src/knowledge/provider-credential-store.ts','src/knowledge/provider-registry.ts','src/knowledge/provider-runtime.ts','src/knowledge/provider-probe.ts','src/knowledge/engine-model-gateway.ts','src/server/routes/knowledge.ts','src/server/request-log.ts'].map(p=>[p,hash(readFileSync(p))]))};
const save=()=>writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function step(name:string,work:()=>Promise<any>){const entry:any={name,status:'running'};report.checks.push(entry);save();console.log('[provider51] '+name+': running');const start=Date.now();try{entry.evidence=await work();entry.status='passed';}catch(e){entry.status='failed';throw e;}finally{entry.durationMs=Date.now()-start;save();console.log('[provider51] '+name+': '+entry.status);}}
const provider=createServer(async(req,res)=>{
 count.providerHttp++;let raw='';for await(const part of req){raw+=part;if(raw.length>1_000_000){res.writeHead(413);res.end();return;}}
 const authorization=String(req.headers.authorization??'');const tokenVersion=Object.entries(tokens).find(([,token])=>authorization==='Bearer '+token)?.[0]??'unknown';
 const body=raw?JSON.parse(raw):{};const input=Array.isArray(body.input)?String(body.input[0]):'';
 const event:any={method:req.method,path:req.url,tokenVersion,bodySha256:hash(raw),bodyBytes:Buffer.byteLength(raw),inputSha256:hash(input),startedAt:Date.now()};calls.push(event);
 res.on('close',()=>{event.closedAt=Date.now();event.completed=res.writableFinished;});
 res.setHeader('content-type','application/json');res.setHeader('x-request-id','synthetic-fixture-request');
 const reply=(status:number,value:unknown)=>{event.status=status;res.writeHead(status);res.end(typeof value==='string'?value:JSON.stringify(value));};
 if(tokenVersion==='unknown'){reply(401,{error:{code:'InvalidApiKey',message:privateError}});return;}
 if(mode==='unauthorized'){reply(401,{error:{code:'InvalidApiKey',message:privateError+' '+tokens.A}});return;}
 if(req.url==='/v1/models'){reply(200,{data:[{id:'fixture-embedding',private:tokens.A},{id:'fixture-embedding'}]});return;}
 if(req.url!=='/v1/embeddings'){reply(404,{error:'fixture endpoint missing'});return;}
 const gate=holds.get('input:'+input)??holds.get('token:'+tokenVersion);if(gate)await gate.promise;
 if(mode==='timeout')await delay(450);
 if(mode==='rate_limited'||rateRemaining>0){if(rateRemaining>0)rateRemaining--;reply(429,{error:{code:'RateLimitExceeded',message:privateError}});return;}
 if(mode==='invalid_json'){reply(200,'not JSON '+privateError);return;}
 const vector=mode==='invalid_vector'?['not-a-number',.2,.3]:mode==='dimension_mismatch'?[.1,.2,.3,.4]:[.1,.2,.3];
 reply(200,{data:(body.input??[]).map((_:unknown,index:number)=>({index,embedding:vector})),usage:{total_tokens:1}});
});
let app:any,store:any,appDb:any;
try{
 await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const providerOrigin='http://127.0.0.1:'+(provider.address() as AddressInfo).port;
 const [{default:Fastify},{default:jwt},{knowledgeRoutes},{getKnowledgeStore},{db,runMigrations},{createManagedProviderRegistry},{registerEngineModelGateway},{safeRequestLogSerializers,safeRequestLogHooks,sendSafeNotFound}]=await Promise.all([import('fastify'),import('@fastify/jwt'),import('../src/server/routes/knowledge.js'),import('../src/server/knowledge-context.js'),import('../src/server/db/index.js'),import('../src/knowledge/provider-setup.js'),import('../src/knowledge/engine-model-gateway.js'),import('../src/server/request-log.js')]);
 runMigrations();appDb=db;store=getKnowledgeStore();const registry=createManagedProviderRegistry(store);const bindings:any[]=[];
 app=Fastify({logger:{serializers:safeRequestLogSerializers,hooks:safeRequestLogHooks,stream:{write:(line:string)=>{logs+=line;}}}});
 await app.register(jwt,{secret:process.env.JWT_SECRET!});
 app.decorate('authenticate',async(req:any,reply:any)=>{try{await req.jwtVerify();}catch{return reply.code(401).send({error:'Unauthorized'});}});
 app.addHook('onRequest',async(req:any)=>{count.relayHttp++;if(req.url.startsWith('/internal/knowledge-engine/'))count.gatewayEntered++;});
 app.setNotFoundHandler((_req:any,reply:any)=>sendSafeNotFound(reply));
 await app.register(knowledgeRoutes);await registerEngineModelGateway(app,{registry,token:()=>gatewayToken,bindings:()=>bindings});await app.listen({port:0,host:'127.0.0.1'});
 const origin='http://127.0.0.1:'+(app.server.address() as AddressInfo).port;report.origins={provider:providerOrigin,relay:origin};
 const adminToken=app.jwt.sign({id:1,username:'synthetic-admin',isAdmin:true}),readerToken=app.jwt.sign({id:2,username:'synthetic-reader',isAdmin:false});
 const forbidden=[...Object.values(tokens),gatewayToken,adminToken,readerToken,privateInput,privateError,process.env.JWT_SECRET!];
 async function http(method:string,path:string,body?:unknown,auth=adminToken){const r=await fetch(origin+path,{method,headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10000)});const text=await r.text();responses.push(text);return {status:r.status,body:text?JSON.parse(text):{},text};}
 const base='/api/knowledge/providers/managed';
 const config=(token:string)=>({kind:'embedding',provider:'synthetic-loopback',baseUrl:providerOrigin+'/v1',modelId:'fixture-embedding',token});
 const configure=(token:string)=>http('POST',base+'/fixture/configure',config(token));
 const rotate=(token:string|null)=>http('POST',base+'/fixture/token',{token});
 const configurePolicy=async(timeoutMs=2000,maxRetries=0)=>{const r=await http('PUT',base+'/fixture',{kind:'embedding',provider:'synthetic-loopback',baseUrl:providerOrigin+'/v1',modelId:'fixture-embedding',dimensions:3,concurrency:1,timeoutMs,maxRetries,quota:{maxCalls:1000,windowMs:60000}});check(r.status===200,'policy_configuration');};
 const refreshBinding=()=>{const c=registry.get('fixture')!;bindings.splice(0,bindings.length,{providerId:c.id,kind:c.kind,modelId:c.modelId,dimensions:c.dimensions,indexVersion:c.indexVersion,alias:'relay-fixture-embedding'});};
 const gateway=(input=privateInput,auth=gatewayToken,extra:Record<string,unknown>={})=>http('POST','/internal/knowledge-engine/v1/embeddings',{model:'relay-fixture-embedding',input:[input],...extra},auth);
 const stateSnapshot=()=>JSON.stringify(store.db.prepare('SELECT * FROM knowledge_provider_configs WHERE id=?').get('fixture'));
 const secretCount=()=>Number(store.db.prepare('SELECT count(*) n FROM knowledge_provider_secrets').get().n);
 const admissions=()=>Number(store.db.prepare('SELECT count(*) n FROM knowledge_provider_admissions').get().n);
 await step('administrator_acl',async()=>{const before=count.providerHttp;for(const [path,body] of [[base+'/models',config(tokens.A)],[base+'/fixture/configure',config(tokens.A)],[base+'/fixture/token',{token:null}],[base+'/fixture/disable',{}]]){const r=await http('POST',path as string,body,readerToken);check(r.status===403,'reader_not_denied');}check((await gateway(privateInput,'wrong-synthetic-gateway-token')).status===401,'gateway_auth');check(count.providerHttp===before,'acl_sent_http');return {readerDenials:4,gatewayUnauthorized:true,providerRequests:0};});
 await step('setup_encrypted_credentials',async()=>{const r=await configure(tokens.A);check(r.status===200&&r.body.provider.dimensions===3&&r.body.report.ok,'configure_failed');await configurePolicy();refreshBinding();check(secretCount()===1,'initial_secret_count');const response=await gateway();check(response.status===200,'initial_gateway');const fresh=createManagedProviderRegistry(store);check((await fresh.resolveCandidateProvider('fixture').probe()).observedDimensions===3,'fresh_registry_credential');const key=statSync(process.env.PROVIDER_SECRET_KEY_FILE!);return {dimensions:3,secretRows:1,keyBytes:key.size,keyMode:process.platform==='win32'?undefined:(key.mode&0o777).toString(8),encrypted:true,realProviderRequests:count.providerHttp};});
 await step('queued_rotation',async()=>{
  const release=hold('input:hold-rotation');const held=gateway('hold-rotation');await waitFor(()=>calls.some(c=>c.inputSha256===hash('hold-rotation')),'rotation_hold');
  const entered=count.gatewayEntered;const queued=gateway('queued-rotation');await waitFor(()=>count.gatewayEntered>entered,'rotation_queue');await delay(30);check(!calls.some(c=>c.inputSha256===hash('queued-rotation')),'rotation_not_queued');
  const previousHandle=registry.resolveCandidateProvider('fixture');const r=await rotate(tokens.B);check(r.status===200,'rotation_failed');const rotatedAt=Date.now();release();
  check((await held).status===200&&(await queued).status===200,'rotation_requests_failed');await previousHandle.embed([privateInput]);check((await gateway()).status===200,'rotated_gateway_failed');
  const queuedCall=calls.find(c=>c.inputSha256===hash('queued-rotation'));check(queuedCall?.tokenVersion==='B','queued_old_token');check(!calls.some(c=>c.startedAt>=rotatedAt&&c.tokenVersion==='A'),'post_rotate_old_token');check(secretCount()===1,'rotation_orphan_secret');return {actuallyQueued:true,queuedCredentialVersion:'B',previouslyResolvedHandleUsesNewToken:true,oldCredentialRequestsAfterCommit:0,inFlightOldCallAllowedToFinish:true};
 });
 await step('queued_clear',async()=>{
  const release=hold('input:hold-clear');const held=gateway('hold-clear');await waitFor(()=>calls.some(c=>c.inputSha256===hash('hold-clear')),'clear_hold');const entered=count.gatewayEntered;const queued=gateway('queued-clear');await waitFor(()=>count.gatewayEntered>entered,'clear_queue');await delay(30);
  const before=count.providerHttp;check((await rotate(null)).status===200,'clear_failed');check(count.providerHttp===before,'clear_sent_http');release();check((await held).status===200,'clear_inflight_failed');check((await queued).status===503,'clear_queue_not_denied');check((await gateway()).status===503,'cleared_gateway_not_denied');check(count.providerHttp===before&&!calls.some(c=>c.inputSha256===hash('queued-clear')),'cleared_call_reached_provider');check(secretCount()===0,'clear_secret_retained');return {actuallyQueued:true,queuedAndFutureRequestsDenied:true,providerRequestsAfterClear:0,remainingSecrets:0};
 });
 await step('disabled_no_http',async()=>{check((await configure(tokens.C)).status===200,'reconfigure');await configurePolicy();refreshBinding();const handle=registry.resolveCandidateProvider('fixture');const before=count.providerHttp;check((await http('POST',base+'/fixture/disable',{})).status===200,'disable');check((await gateway()).status===503,'disabled_gateway');let rejected=false;try{await handle.embed([privateInput]);}catch{rejected=true;}check(rejected&&count.providerHttp===before,'disabled_handle_http');check((await configure(tokens.C)).status===200,'enable_by_reconfigure');await configurePolicy();refreshBinding();return {disabledProviderRequests:0,staleHandleDenied:true};});
 await step('failed_config_preserves_previous',async()=>{const before=stateSnapshot(),secrets=secretCount();mode='unauthorized';const failed=await configure(tokens.B);mode='ok';check(failed.status===502,'failed_config_status');check(stateSnapshot()===before&&secretCount()===secrets,'failed_config_changed_state');check((await gateway()).status===200&&calls.at(-1).tokenVersion==='C','old_config_not_usable');return {httpStatus:failed.status,configurationUnchanged:true,encryptedSecretUnchanged:true,oldCredentialStillWorks:true};});
 await step('configure_cas_conflict',async()=>{
  const release=hold('token:B');const before=count.providerHttp;const slow=configure(tokens.B);await waitFor(()=>calls.slice(before).some(c=>c.path==='/v1/embeddings'&&c.tokenVersion==='B'),'cas_hold');const fast=await configure(tokens.A);check(fast.status===200,'cas_winner_failed');const winner=stateSnapshot();release();const loser=await slow;check(loser.status===400,'cas_stale_save_not_rejected');check(stateSnapshot()===winner&&secretCount()===1,'cas_loser_overwrote_winner');await configurePolicy();refreshBinding();check((await gateway()).status===200&&calls.at(-1).tokenVersion==='A','cas_winner_credential_missing');return {winnerStatus:200,staleContenderStatus:400,retainedWinningConfiguration:true,secretRows:1,actualConcurrentValidation:true};
 });
 await step('transport_faults_and_recovery',async()=>{const results=[];await configurePolicy(100,0);for(const [failure,errorCode] of [['unauthorized','unauthorized'],['rate_limited','rate_limited'],['invalid_json','invalid_response'],['invalid_vector','invalid_vector'],['dimension_mismatch','dimension_mismatch'],['timeout','provider_timeout']]){mode=failure;const before=count.providerHttp,at=Date.now();const r=await gateway();check(r.status===503,'fault_http_'+failure);check([errorCode,'timeout'].includes(r.body.error?.code),'fault_code_'+failure);check(count.providerHttp-before===1,'fault_retry_'+failure);mode='ok';const recovered=await gateway();check(recovered.status===200,'fault_recovery_'+failure);results.push({mode:failure,httpStatus:r.status,code:r.body.error.code,providerRequests:1,durationMs:Date.now()-at,recovery:'passed'});}await configurePolicy();return results;});
 await step('retry_one_logical_admission',async()=>{await configurePolicy(2000,1);rateRemaining=1;const before=count.providerHttp,budget=admissions();const result=await gateway();check(result.status===200,'retry_recovery');check(count.providerHttp-before===2&&admissions()-budget===1,'retry_double_admission');await configurePolicy();return {actualHttpAttempts:2,logicalAdmissions:1,recovered:true};});
 await step('dimension_and_alias_fail_closed',async()=>{const before=count.providerHttp;const dimension=await gateway(privateInput,gatewayToken,{dimensions:4});const unknown=await gateway(privateInput,gatewayToken,{model:'unknown-fixture-alias'});check(dimension.status===409&&unknown.status===403&&count.providerHttp===before,'local_binding_guard');return {dimensionStatus:409,unknownAliasStatus:403,providerRequests:0};});
 await step('privacy',async()=>{
  const metadata=await http('GET',base,undefined,readerToken);check(metadata.status===200,'metadata_read');await delay(20);
  const allRows=['knowledge_provider_configs','knowledge_provider_secrets','knowledge_audit','knowledge_provider_admissions'].map(table=>({table,rows:store.db.prepare('SELECT * FROM '+table).all()}));
  store.db.pragma('wal_checkpoint(TRUNCATE)');const rawDb=readFileSync(join(root,'knowledge.db'));
  const regions={responses:responses.join('\n'),logs,metadataAndAudit:JSON.stringify(allRows)};let matches=0;const scans=Object.entries(regions).map(([name,text])=>{const count=forbidden.filter(v=>text.includes(v)).length;matches+=count;return {name,bytes:Buffer.byteLength(text),matches:count,sha256:hash(text)};});const rawMatches=forbidden.filter(v=>rawDb.includes(Buffer.from(v))).length;matches+=rawMatches;
  check(calls.every(c=>c.tokenVersion!=='unknown'&&['/v1/models','/v1/embeddings'].includes(c.path)),'unexpected_provider_target');report.privacy={matches,scans,rawDatabaseBytes:rawDb.length,rawDatabaseMatches:rawMatches,originalRequestBodiesNotPersisted:true};check(matches===0,'provider_fixture_privacy_leak');return report.privacy;
 });
 report.activeJobs=Number(store.db.prepare("SELECT count(*) n FROM knowledge_ingest_jobs WHERE status IN ('queued','running')").get().n);check(report.activeJobs===0,'fixture_job_started');
 report.observedRequests=calls;report.providerAdmissionCount=admissions();report.status='passed_isolated_provider_transport';
}catch(error){report.status='failed';report.code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'fixture_or_contract_failure';report.errorClass=error instanceof Error?error.name:'Unknown';process.exitCode=1;}
finally{for(const gate of holds.values())gate.release();await app?.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));store?.close();(appDb as any)?.session.client.close();report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,checks:report.checks.length,counts:count,...(report.code?{code:report.code}:{})}));}
