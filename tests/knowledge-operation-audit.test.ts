import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import {sanitizeToolAuditArguments} from '../src/shared/retrieval-audit.ts';

const digest=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const toolNames=['knowledge_get','samplemanager_impact_analysis'];

test('document-read and impact audit allow only metadata, hashing accepted free text and omitting unknown fields',()=>{
 const input={documentId:'private-document',project:'private-project',environment:'private-environment',objectId:'private-object',relationType:'private-relation',intentStep:'private-step',objectiveRef:'private-objective',acceptanceCriterionRef:'private-criterion',workSessionId:'session-'+ 'a'.repeat(32),limit:20,maxDepth:3,direction:'both',verifiedOnly:true,hiddenReasoning:'private-hidden',extra:{body:'private-body'},query:'private-query'};
 const original=structuredClone(input);
 for(const tool of toolNames){
  const audit=sanitizeToolAuditArguments(tool,input) as any;assert.equal(JSON.stringify(audit).includes('private-'),false,'outer audit must not echo free-form or unknown arguments');assert.equal(audit.workSessionId,input.workSessionId);assert.equal(audit.projectHash,digest(input.project));assert.equal(audit.projectLength,input.project.length);assert.equal(audit.hiddenReasoning,undefined);assert.equal(audit.extra,undefined);assert.equal(audit.query,undefined);
  if(tool==='knowledge_get'){assert.equal(audit.documentIdHash,digest(input.documentId));assert.equal(audit.objectIdHash,undefined);assert.equal(audit.limit,undefined);}
  else{for(const key of ['environment','objectId','relationType','intentStep','objectiveRef','acceptanceCriterionRef'] as const)assert.equal(audit[key+'Hash'],digest(input[key]));assert.equal(audit.limit,20);assert.equal(audit.maxDepth,3);assert.equal(audit.direction,'both');assert.equal(audit.verifiedOnly,true);}
 }
 assert.deepEqual(input,original);
 const cycle:any={};cycle.self=cycle;
 for(const tool of toolNames)for(const malformed of [undefined,null,'private-raw',[input],{workSessionId:'private-session',objectId:cycle,documentId:3n,direction:'private-direction',limit:-1,maxDepth:100}])assert.equal(JSON.stringify(sanitizeToolAuditArguments(tool,malformed)).includes('private-'),false);
});

async function freePort(){const server=createServer();await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});const port=(server.address() as {port:number}).port;await new Promise<void>((yes,no)=>server.close(error=>error?no(error):yes()));return port;}
async function stop(child:ChildProcess){if(child.exitCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);try{await exited;}finally{clearTimeout(timer);}}
async function rpc(response:Response){const raw=await response.text(),data=raw.split(/\r?\n/).find(line=>line.startsWith('data:'));return JSON.parse(data?data.slice(5).trim():raw);}

test('real MCP outer audit protects get/impact success, rejection and unknown parameters without changing results',{timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'knowledge-operation-audit-')),stateRoot=join(root,'state'),appPath=join(root,'app.db'),knowledgePath=join(stateRoot,'knowledge.db'),port=await freePort();
 const env={DB_PATH:appPath,KNOWLEDGE_DB_PATH:knowledgePath,WORKSPACE_ROOT:root,RELAY_STATE_ROOT:stateRoot,DOTENV_CONFIG_PATH:join(root,'absent.env')};const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
 const [{db,runMigrations},schema,{createKnowledgeStore}]=await Promise.all([import('../src/server/db/index.ts'),import('../src/server/db/schema.ts'),import('../src/knowledge/store.ts')]);runMigrations();
 db.insert(schema.users).values({id:7,username:'audit-owner',passwordHash:'unused'}).run();db.insert(schema.projects).values({id:1,userId:7,name:'private-project-marker',workspacePath:root}).run();db.insert(schema.servers).values({id:1,userId:7,name:'loopback fixture',host:'127.0.0.1',sshUser:'unused',privateKeyPath:'unused',publicKey:'unused',status:'connected'}).run();db.insert(schema.projectServers).values({projectId:1,serverId:1,remotePath:root,environment:'test'}).run();(db as any).session.client.close();
 const store=createKnowledgeStore({dbPath:knowledgePath});store.grantAcl('1',7,true);const now=new Date().toISOString();store.upsertDocument({id:'private-document-marker',kind:'case',title:'private-title-marker',body:'private-body-marker',lifecycle:'verified',projectId:'1',environment:'test',locator:'private-locator-marker',sha256:'a'.repeat(64),createdAt:now,updatedAt:now});store.close();
 const secret=randomBytes(32).toString('hex'),token=jwt.sign({id:7,username:'audit-owner',defaultProjectId:1,defaultProject:'private-project-marker',defaultEnvironment:'test',allowAllProjects:true},secret);
 const child=spawn(process.execPath,['--import','tsx','src/mcp/index.ts'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,NODE_ENV:'test',JWT_SECRET:secret,MCP_PORT:String(port),KNOWLEDGE_ENGINE_HOME:join(root,'absent-engine'),KNOWLEDGE_CAPTURE_INTERVAL_MS:'60000',KNOWLEDGE_OUTBOX_PRUNE_INTERVAL_MS:'86400000',RELAY_MCP_SHUTDOWN_GRACE_MS:'250'},stdio:['ignore','pipe','pipe']});
 let output='',seq=0;child.stdout?.on('data',chunk=>output+=String(chunk));child.stderr?.on('data',chunk=>output+=String(chunk));const base=`http://127.0.0.1:${port}`;
 const call=async(name:string,args:Record<string,unknown>)=>{const response=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token,'mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args}})});assert.equal(response.status,200);return rpc(response);};
 try{
  const deadline=Date.now()+15000;let ready=false;while(Date.now()<deadline){if(child.exitCode!==null)throw new Error('MCP fixture exited');try{ready=(await fetch(base+'/mcp/health/ready')).status===200;}catch{}if(ready)break;await new Promise(yes=>setTimeout(yes,100));}assert.equal(ready,true);
  const opened=await call('knowledge_work_session_open',{idempotencyKey:'operation-audit',intent:{actions:['verify'],phase:'validation',objective:'Verify a synthetic fixture',constraints:[],acceptanceCriteria:[],projectId:'1',environment:'test',risk:'read_only',knowledgeMode:'capture'}});assert.equal(opened.result?.isError,undefined);const session=JSON.parse(opened.result.content[0].text).session;
  const inputs:Record<string,Record<string,unknown>>={knowledge_get:{documentId:'private-document-marker',project:'private-project-marker',workSessionId:session.id},samplemanager_impact_analysis:{project:'private-project-marker',environment:'test',objectId:'private-object-marker',intentStep:'private-step-marker',objectiveRef:'private-objective-marker',acceptanceCriterionRef:'private-criterion-marker',workSessionId:session.id,limit:5,maxDepth:2,direction:'both',verifiedOnly:true}};
  for(const tool of toolNames){
   const input=inputs[tool],accepted=await call(tool,input);assert.equal(accepted.result?.isError,undefined,tool+' accepted path');const value=JSON.parse(accepted.result.content[0].text);
   if(tool==='knowledge_get'){assert.equal(value.id,input.documentId);assert.equal(value.body,'private-body-marker');}else{assert.equal(value.provenance.objectId,input.objectId);assert.equal(value.provenance.objectiveRef,input.objectiveRef);}
   const unknown=await call(tool,{...input,hiddenReasoning:'private-hidden-marker',extra:{query:'private-query-marker'}});assert.equal(unknown.result?.isError,undefined,tool+' schema strips unknown fields without changing execution');assert.deepEqual(JSON.parse(unknown.result.content[0].text),value);
   const rejected=await call(tool,{...input,workSessionId:'private-forged-session-marker',hiddenReasoning:'private-rejected-hidden-marker'});assert.equal(rejected.result?.isError,true,tool+' rejects forged Session');
  }
  const generic=await call('relay_mcp_info',{ordinaryUnknown:'business-selector',nested:[{hiddenReasoning:'private-generic-hidden-marker'},{value:{reasoning_content:'private-generic-reasoning-marker',chain_of_thought:['private-generic-chain-marker']}}]});assert.equal(generic.result?.isError,undefined);
  const text=readFileSync(join(stateRoot,'audit.jsonl'),'utf8');assert.equal(text.includes('private-'),false,'pre-handler audit must omit every synthetic input/body/private marker');assert.equal(output.includes('private-'),false,'MCP process logs must not contain raw arguments');assert.equal(text.includes(token),false);
  const audit=text.trim().split(/\r?\n/).map(line=>JSON.parse(line)).filter(row=>row.event==='tool_called'&&toolNames.includes(row.tool));assert.equal(audit.length,6);for(const row of audit){assert.equal(row.arguments.projectHash,digest('private-project-marker'));assert.equal(row.arguments.hiddenReasoning,undefined);assert.equal(row.arguments.extra,undefined);}
  assert.equal(audit.filter(row=>row.tool==='knowledge_get').every(row=>row.arguments.documentIdHash===digest('private-document-marker')),true);assert.equal(audit.filter(row=>row.tool==='samplemanager_impact_analysis').every(row=>row.arguments.objectIdHash===digest('private-object-marker')),true);
  const genericAudit=text.trim().split(/\r?\n/).map(line=>JSON.parse(line)).find(row=>row.event==='tool_called'&&row.tool==='relay_mcp_info');assert.equal(genericAudit.arguments.ordinaryUnknown,'business-selector');assert.equal(genericAudit.arguments.nested[0].hiddenReasoning.redacted,true);
  const knowledge=new Database(knowledgePath,{readonly:true});try{for(const table of ['knowledge_audit','knowledge_work_session_events','knowledge_retrieval_runs'])assert.equal(JSON.stringify(knowledge.prepare('SELECT * FROM '+table).all()).includes('private-'),false,'raw markers excluded from '+table);assert.equal((knowledge.prepare('SELECT COUNT(*) n FROM knowledge_provider_admissions').get() as any).n,0);}finally{knowledge.close();}
 }finally{await stop(child);for(const key of Object.keys(env)){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}assert.equal(join(tmpdir(),root.slice(tmpdir().length)),root);rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:20});}
});
