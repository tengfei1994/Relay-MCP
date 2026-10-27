/** Real MCP transport acceptance against the dedicated nonproduction service. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root='/home/ftd/relay-knowledge-engine-nonprod';
if(process.env.RELAY_E2E_ISOLATED!=='1'||process.platform!=='linux'||resolve(process.cwd())!==root+'/relay')throw new Error('isolated_nonproduction_required');
const runId=process.env.RELAY_MCP_RUN_ID??'mcp-live';
const report:any={runId,startedAt:new Date().toISOString(),status:'running',transport:'streamable-http',checks:[],unproven:['Job/Deployment correlation and full-corpus retrieval quality require separate acceptance.']};
const reportPath=root+'/runtime/'+runId+'.json';
const save=()=>writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
const requireThat=(value:unknown,code:string)=>{if(!value)throw new Error(code);};
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
async function connect(file:string){const token=(await readFile(file,'utf8')).trim();const client=new Client({name:'relay-nonproduction-acceptance',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18301/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}));return client;}
let admin:Client|undefined,foreign:Client|undefined;
let names:string[]=[];
async function call(client:Client,name:string,args:Record<string,unknown>,denied:boolean|string=false){
 const tool=names.find(n=>n===name||n.endsWith('_'+name));requireThat(tool,'tool_missing_'+name);
 const response:any=await client.callTool({name:tool!,arguments:args});
 if(denied){requireThat(response.isError===true,'foreign_tool_not_denied');if(typeof denied==='string')requireThat((response.content??[]).some((v:any)=>v.type==='text'&&v.text.includes(denied)),'unexpected_denial_reason');return {};}
 if(response.isError){
  const encoded=JSON.stringify(response);
  const known=['invalid search result','unverified chunk reference','invalid source chunk','source chunk','rate_limited','unavailable','timeout','invalid_response','Knowledge access denied','not initialized','SQLITE_BUSY','JSON serialization','too large','environment','mismatch','session','source','scope','parent','Unexpected','empty','invalid','undefined','not iterable','unconfigured','Request failed','fetch failed','failed','not found','Unauthorized','quota','limit','HTTP','maximum','exceeded','validation','disabled','limit','denied','JSON','failed','503','unknown','401','429','500','502','400','not a function','Cannot','requires','missing'];
  report.lastToolError={tool:name,knownLabels:known.filter(label=>encoded.toLowerCase().includes(label.toLowerCase())),responseBytes:Buffer.byteLength(encoded),responseSha256:sha(encoded)};
 }
 requireThat(!response.isError,'tool_failed_'+name);
 const text=(response.content??[]).filter((v:any)=>v.type==='text').map((v:any)=>v.text).join('\n');
 try{return JSON.parse(text);}catch{throw new Error('invalid_mcp_payload_'+name);}
}
async function check(name:string,run:()=>Promise<any>){console.log('[mcp-e2e] '+name+': running');const start=Date.now();const result=await run();report.checks.push({name,status:'passed',durationMs:Date.now()-start,evidence:result});await save();console.log('[mcp-e2e] '+name+': passed');}
try{
 admin=await connect('data/e2e-admin.jwt');foreign=await connect('data/e2e-foreign.jwt');names=(await admin.listTools()).tools.map(t=>t.name);
 await check('stable_catalog',async()=>{requireThat(names.length===121,'tool_count_changed');return {toolCount:names.length};});
 const intent={actions:['verify'],phase:'validation',objective:'Verify Relay managed Knowledge integration in isolated nonproduction',constraints:['Nonproduction only','Preserve original sample and sentinel data'],acceptanceCriteria:['MCP session survives reconnect','Foreign actor denied','Published Product citations use selected engine'],projectId:'1',environment:'nonprod',risk:'read_only',knowledgeMode:'retrieve'};
 let sessionId='';
 await check('session_idempotence_reconnect_and_acl',async()=>{
  const args={idempotencyKey:runId,intent};const first:any=await call(admin!,'knowledge_work_session_open',args);sessionId=first.session.id;
  const repeated:any=await call(admin!,'knowledge_work_session_open',args);requireThat(repeated.session.id===sessionId,'session_replay_changed');
  await admin!.close();admin=await connect('data/e2e-admin.jwt');const loaded:any=await call(admin,'knowledge_work_session_get',{sessionId});requireThat(loaded.session.id===sessionId,'session_lost_after_reconnect');
  await call(foreign!,'knowledge_work_session_get',{sessionId},true);return {sessionId,idempotent:true,reconnect:true,foreignActorDenied:true};
 });
 const seed=JSON.parse(await readFile('data/nonprod-seed-manifest.json','utf8'));
 await check('memory_and_evidence_compatibility',async()=>{
  const result:any=await call(admin!,'knowledge_get',{documentId:seed.memory.id});const document=result.document??result;
  requireThat(sha(document.body)===seed.memory.bodySha256,'memory_changed');
  const evidence:any=await call(admin!,'knowledge_evidence_get',{evidenceId:seed.evidence.id});const value=evidence.evidence??evidence;
  requireThat((value.sha256??value.contentHash)===seed.evidence.sha256,'evidence_changed');
  await call(foreign!,'knowledge_get',{documentId:seed.memory.id},true);
  return {memoryId:seed.memory.id,memoryHash:seed.memory.bodySha256,evidenceId:seed.evidence.id,evidenceHash:seed.evidence.sha256};
 });
 if(process.env.RELAY_MCP_REQUIRE_PRODUCT==='1')await check('selected_engine_product_and_context_pack',async()=>{
  const proof:any[]=[];
  for(const source of seed.documents){
   const result:any=await call(admin!,'knowledge_get',{documentId:source.id});const doc=result.document??result;
   requireThat(doc.provider==='weknora'&&doc.citations?.length>0&&doc.sourceSha256===source.sourceSha256,'product_reference_invalid');
   proof.push({documentId:doc.id,bodyHash:sha(doc.body),sourceHash:doc.sourceSha256,citationCount:doc.citations.length,version:doc.version});
  }
  const query=seed.documents[0].title;
  const pack:any=await call(admin!,'knowledge_weknora_search',{projectId:'1',workSessionId:sessionId,query,limit:10});
  requireThat(pack.contextPack?.authoritativeDocs?.length>0,'context_pack_missing_product');
  requireThat(pack.references.every((ref:any)=>ref.provider==='weknora'&&ref.chunkId&&ref.sourceSha256),'context_reference_incomplete');
  await call(foreign!,'knowledge_weknora_search',{projectId:'1',query,limit:10},true);
  return {documents:proof,referenceCount:pack.references.length,foreignActorDenied:true};
 });
 const confirmedCaseId=process.env.RELAY_MCP_CONFIRMED_CASE_ID;
 if(confirmedCaseId)await check('reviewed_memory_reuse_and_environment_isolation',async()=>{
  const query='sentinel evidence routing';
  const selected:any=await call(admin!,'knowledge_weknora_search',{projectId:'1',workSessionId:sessionId,query,limit:20});
  const rows=selected.contextPack?.confirmedKnowledge??[];
  const confirmed=rows.find((item:any)=>item.id===confirmedCaseId);
  requireThat(confirmed && ['verified','approved'].includes(confirmed.lifecycle),'reviewed_memory_missing');
  if(process.env.RELAY_MCP_EXPECT_OUTAGE==='1') {
    requireThat(selected.references.length===0&&selected.contextPack.degraded.productKnowledge==='unavailable','outage_not_degraded');
  } else requireThat(selected.references.length>0,'combined_context_pack_missing_product');
  const other:any=await call(admin!,'knowledge_work_session_open',{idempotencyKey:runId+'-foreign-environment',intent:{...intent,environment:'other-environment',objective:'Check nonproduction memory environment isolation'}});
  await call(admin!,'knowledge_weknora_search',{projectId:'1',workSessionId:other.session.id,query,limit:20},'Work Session environment does not match caller');
  await call(admin!,'knowledge_work_session_close',{sessionId:other.session.id,idempotencyKey:runId+'-foreign-close',result:{summary:'Environment isolation checked'}});
  return {caseId:confirmedCaseId,lifecycle:confirmed.lifecycle,matchingScopeReturned:true,otherEnvironmentDenied:true,matchingProductReferences:selected.references?.length??0};
 });
 await check('session_close_idempotence',async()=>{
  const args={sessionId,idempotencyKey:runId+'-close',result:{summary:'Bounded real MCP acceptance completed',unknowns:['Job/Deployment and full corpus acceptance remain separate'],acceptanceResults:{mcp:true,reconnect:true,acl:true}}};
  const closed:any=await call(admin!,'knowledge_work_session_close',args);const repeated:any=await call(admin!,'knowledge_work_session_close',args);
  requireThat(closed.session.status==='completed'&&closed.session.closedAt===repeated.session.closedAt,'close_not_idempotent');return {sessionId,status:closed.session.status,closedAt:closed.session.closedAt};
 });
 report.status='passed';
}catch(error){report.status='failed';report.code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'mcp_acceptance_failed';process.exitCode=1;}
finally{await admin?.close();await foreign?.close();report.finishedAt=new Date().toISOString();await save();console.log('[mcp-e2e] '+report.status+(report.code?': '+report.code:''));}