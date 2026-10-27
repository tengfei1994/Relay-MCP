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

test('Candidate compile audit is an allowlisted metadata copy, including rejected and malformed inputs',()=>{
 const input={sessionId:'session-'+ 'a'.repeat(32),providerId:'private-provider-marker',evidenceRefs:['private-ref-marker'],context:{statement:'private-statement-marker',hiddenReasoning:'private-hidden-marker'},async:true,retry:false,unexpected:'private-extra-marker'};
 const before=structuredClone(input),audit=sanitizeToolAuditArguments('knowledge_candidate_insight_compile',input) as any;
 assert.equal(JSON.stringify(audit).includes('private-'),false);assert.equal(audit.sessionId,input.sessionId);assert.equal(audit.async,true);assert.equal(audit.retry,false);assert.equal(audit.evidenceCount,1);
 for(const key of ['context','providerId','evidenceRefs'] as const){assert.equal(audit[key],undefined);assert.equal(audit[key+'Hash'],digest(input[key]));}
 assert.deepEqual(input,before);
 const cycle:any={};cycle.self=cycle;
 for(const malformed of [undefined,null,'private-top-level',[input],{sessionId:'private-id',context:cycle},{context:3n}])assert.equal(JSON.stringify(sanitizeToolAuditArguments('knowledge_candidate_insight_compile',malformed)).includes('private-'),false);
});

async function freePort(){const server=createServer();await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});const port=(server.address() as {port:number}).port;await new Promise<void>((yes,no)=>server.close(error=>error?no(error):yes()));return port;}
async function stop(child:ChildProcess){if(child.exitCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);try{await exited;}finally{clearTimeout(timer);}}
async function rpc(response:Response){const raw=await response.text(),data=raw.split(/\r?\n/).find(line=>line.startsWith('data:'));return JSON.parse(data?data.slice(5).trim():raw);}

test('real MCP outer logging omits Candidate context on success and rejection without changing handler input',{timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'candidate-audit-http-')),stateRoot=join(root,'state'),appPath=join(root,'app.db'),knowledgePath=join(stateRoot,'knowledge.db'),port=await freePort();
 const appDb=new Database(appPath);appDb.exec('CREATE TABLE projects(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,description TEXT,workspace_path TEXT)');appDb.prepare("INSERT INTO projects VALUES(1,7,'candidate-audit','',?)").run(root);appDb.close();
 const secret=randomBytes(32).toString('hex'),token=jwt.sign({id:7,username:'audit-test'},secret);
 const child=spawn(process.execPath,['--import','tsx','src/mcp/index.ts'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,NODE_ENV:'test',JWT_SECRET:secret,MCP_PORT:String(port),DB_PATH:appPath,KNOWLEDGE_DB_PATH:knowledgePath,RELAY_STATE_ROOT:stateRoot,WORKSPACE_ROOT:root,KNOWLEDGE_ENGINE_HOME:join(root,'absent-engine'),DOTENV_CONFIG_PATH:join(root,'absent.env'),KNOWLEDGE_CAPTURE_INTERVAL_MS:'60000',KNOWLEDGE_OUTBOX_PRUNE_INTERVAL_MS:'86400000',RELAY_MCP_SHUTDOWN_GRACE_MS:'250'},stdio:['ignore','pipe','pipe']});
 let output='',seq=0;child.stdout?.on('data',chunk=>output+=String(chunk));child.stderr?.on('data',chunk=>output+=String(chunk));const base=`http://127.0.0.1:${port}`;
 const call=async(name:string,args:Record<string,unknown>)=>{const response=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token,'mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args}})});assert.equal(response.status,200);return rpc(response);};
 try{
  const deadline=Date.now()+15000;let ready=false;while(Date.now()<deadline){if(child.exitCode!==null)throw new Error('MCP fixture exited');try{ready=(await fetch(base+'/mcp/health/ready')).status===200;}catch{}if(ready)break;await new Promise(yes=>setTimeout(yes,100));}assert.equal(ready,true);
  const opened=await call('knowledge_work_session_open',{idempotencyKey:'candidate-audit',intent:{actions:['verify'],phase:'validation',objective:'Verify a synthetic fixture',constraints:[],acceptanceCriteria:[],projectId:'1',environment:'nonprod',risk:'read_only',knowledgeMode:'capture'}});assert.equal(opened.result?.isError,undefined);const session=JSON.parse(opened.result.content[0].text).session;
  const context={statement:'accepted-private-context-marker',hiddenReasoning:'rejected-private-hidden-marker',details:{reasoning:'nested-private-hidden-marker'}};
  const accepted=await call('knowledge_candidate_insight_compile',{sessionId:session.id,evidenceRefs:[],context});assert.equal(accepted.result?.isError,undefined);const insight=JSON.parse(accepted.result.content[0].text).insight;assert.equal(insight.statement,context.statement,'handler receives the original legitimate context');assert.equal(insight.fallbackReason,'no_evidence');
  const rejected=await call('knowledge_candidate_insight_compile',{sessionId:'missing-session',evidenceRefs:[],context});assert.equal(rejected.result?.isError,true);
  const text=readFileSync(join(stateRoot,'audit.jsonl'),'utf8');for(const value of [context.statement,context.hiddenReasoning,context.details.reasoning]){assert.equal(text.includes(value),false,'Candidate context must not enter pre-handler audit');assert.equal(output.includes(value),false);}
  const audit=text.trim().split(/\r?\n/).map(line=>JSON.parse(line)).filter(row=>row.event==='tool_called'&&row.tool==='knowledge_candidate_insight_compile');assert.equal(audit.length,2);assert.equal(audit[0].arguments.contextHash,digest(context));assert.equal(audit[1].arguments.contextHash,digest(context));assert.equal(audit[0].arguments.context,undefined);assert.equal(audit[0].arguments.sessionId,session.id);
  const knowledge=new Database(knowledgePath,{readonly:true});try{assert.equal((knowledge.prepare('SELECT COUNT(*) n FROM knowledge_provider_admissions').get() as any).n,0);assert.equal(JSON.stringify(knowledge.prepare('SELECT * FROM knowledge_audit').all()).includes(context.hiddenReasoning),false);}finally{knowledge.close();}
 }finally{await stop(child);assert.equal(join(tmpdir(),root.slice(tmpdir().length)),root);rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:20});}
});
