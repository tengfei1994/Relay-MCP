import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

const runFile=promisify(execFile);
test('nonproduction smoke exercises the real five-tool catalog and authorized reads',{timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'knowledge-v2-smoke-'));
 const probe=createServer();await new Promise<void>((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
 const port=(probe.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
 const env={DB_PATH:join(root,'app.db'),KNOWLEDGE_DB_PATH:join(root,'knowledge.db'),WORKSPACE_ROOT:root,RELAY_STATE_ROOT:join(root,'state'),DOTENV_CONFIG_PATH:join(root,'absent.env')};
 const previous=Object.fromEntries(Object.keys(env).map(name=>[name,process.env[name]]));Object.assign(process.env,env);
 const [{db,runMigrations},schema,{createKnowledgeStore},{importKnowledgeProducts},{submitMemory,reviewMemorySubmission}]=await Promise.all([import('../src/server/db/index.js'),import('../src/server/db/schema.js'),import('../src/knowledge/store.js'),import('../src/knowledge/knowledge-products.js'),import('../src/knowledge/memory-v2.js')]);
 runMigrations();db.insert(schema.users).values({id:7,username:'smoke-owner',passwordHash:'unused',knowledgeEnabled:true}).run();db.insert(schema.mcpTokens).values({userId:7,tokenId:'smoke-token',name:'smoke',active:true}).run();(db as any).session.client.close();
 const store=createKnowledgeStore({dbPath:env.KNOWLEDGE_DB_PATH}),docs=join(root,'docs');mkdirSync(docs);writeFileSync(join(docs,'guide.md'),'# Guide\n\nCalibration instructions for the fixture.');
 const document=importKnowledgeProducts(store,{root:docs,sampleManagerVersion:'21'}).documents[0];store.db.prepare("INSERT INTO knowledge_product_classifications(document_id,classification,updated_at) VALUES (?,'product',?)").run(document,new Date().toISOString());
 const author={actorId:7,isAdmin:false,canReadGeneral:()=>true,assertProject:()=>{throw new Error('No project');}};
 const candidate=submitMemory(store,author,{idempotencyKey:'smoke',requestedScope:'general',title:'General memory',memoryType:'Fact',statement:'A reviewed fixture experience.'});
 reviewMemorySubmission(store,{...author,actorId:8,isAdmin:true},{id:candidate.id,action:'approve',reason:'Synthetic review'});store.close();
 const secret=randomBytes(32).toString('hex'),token=jwt.sign({id:7,username:'smoke-owner',tokenKind:'mcp',tokenId:'smoke-token'},secret),tokenPath=join(root,'token');writeFileSync(tokenPath,token);
 const child=spawn(process.execPath,['--import','tsx','src/mcp/index.ts'],{env:{...process.env,...env,NODE_ENV:'test',JWT_SECRET:secret,MCP_PORT:String(port),KNOWLEDGE_ENGINE_HOME:join(root,'absent-engine'),KNOWLEDGE_CAPTURE_INTERVAL_MS:'60000',RELAY_MCP_SHUTDOWN_GRACE_MS:'250'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout?.on('data',chunk=>logs+=String(chunk));child.stderr?.on('data',chunk=>logs+=String(chunk));
 try {
  const base='http://127.0.0.1:'+port,deadline=Date.now()+15000;let ready=false;
  while(Date.now()<deadline){if(child.exitCode!==null)throw new Error('MCP fixture stopped');try{ready=(await fetch(base+'/mcp/health/ready')).status===200;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(ready,true,logs);
  const {stdout}=await runFile(process.execPath,['--import','tsx','scripts/knowledge-v2-smoke.ts'],{env:{...process.env,...env,KNOWLEDGE_V2_MCP_URL:base+'/mcp',KNOWLEDGE_V2_TOKEN_FILE:tokenPath,KNOWLEDGE_V2_QUERY:'Calibration'},timeout:15000});
  assert.deepEqual(JSON.parse(stdout),{catalog:true,productChunks:1,documentRead:'passed',memories:1,memoryRead:'passed',projectScopeChecked:false});
  assert.equal(stdout.includes(token),false);
 } finally {
  if(child.exitCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);try{await stopped;}finally{clearTimeout(timer);}}
  for(const key of Object.keys(env)){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:20});
 }
});
