import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('all remote execution variants validate Session scope before transport, Jobs, or execution audit',async t=>{
 const root=mkdtempSync(join(tmpdir(),'remote-session-scope-'));
 const keys=['DB_PATH','WORKSPACE_ROOT','RELAY_STATE_ROOT'] as const;
 const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.DB_PATH=join(root,'app.db');process.env.WORKSPACE_ROOT=root;process.env.RELAY_STATE_ROOT=join(root,'state');
 const {db,runMigrations}=await import('../src/server/db/index.ts');
 const {users,projects,servers,projectServers,mcpTokens,mcpTokenProjectScopes,mcpTokenServerScopes}=await import('../src/server/db/schema.ts');
 const {createKnowledgeStore}=await import('../src/knowledge/store.ts');
 const {WorkSessionService}=await import('../src/knowledge/work-session.ts');
 const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js');
 const {ProjectRegistry}=await import('../src/mcp/project-registry.ts');
 const {registerToolsForUser}=await import('../src/mcp/register-tools.ts');
 const {RemoteRunner}=await import('../src/shared/remote-runner.ts');
 const {configureJobStore,listJobs,waitForJobRecord}=await import('../src/shared/job-store.ts');
 const {drainRelayEventSpool}=await import('../src/knowledge/event-sink.ts');
 runMigrations();db.insert(users).values([{id:1,username:'owner',passwordHash:'unused'},{id:2,username:'foreign',passwordHash:'unused'}]).run();
 db.insert(projects).values([1,3,4].map(id=>({id,userId:1,name:'p'+id,workspacePath:root}))).run();
 db.insert(servers).values({id:1,userId:1,name:'isolated',host:'127.0.0.1',sshUser:'unused',privateKeyPath:'unused',publicKey:'unused',status:'connected'}).run();
 db.insert(projectServers).values([1,3,4].flatMap(projectId=>['test','other'].map(environment=>({projectId,serverId:1,remotePath:root,environment})))).run();
 db.insert(mcpTokens).values({id:1,userId:1,tokenId:'fixture',name:'scoped',projectId:1,allowAllProjects:false}).run();
 db.insert(mcpTokenProjectScopes).values([{tokenId:1,projectId:1},{tokenId:1,projectId:3}]).run();db.insert(mcpTokenServerScopes).values({tokenId:1,serverId:1}).run();
 const store=createKnowledgeStore({dbPath:join(root,'knowledge.db')});for(const project of ['1','3','4'])store.grantAcl(project,1);store.grantAcl('1',2);
 const sessions=new WorkSessionService(store);
 const intent={actions:['verify'] as const,phase:'validation' as const,objective:'Bounded remote scope regression',constraints:['isolated test'],acceptanceCriteria:['denied calls do not execute'],projectId:'1',environment:'test',risk:'read_only' as const,knowledgeMode:'capture' as const,actorId:1};
 const open=(key:string,actorId=1)=>sessions.open({actorId,idempotencyKey:key,intent:{...intent,actions:[...intent.actions],actorId}});
 const valid=open('valid'),foreign=open('foreign',2),closed=open('closed');sessions.close({actorId:1,sessionId:closed.id});
 const registry=new ProjectRegistry();const server=new McpServer({name:'remote-scope-regression',version:'test'});const noKnowledge=new McpServer({name:'remote-no-knowledge',version:'test'});
 const user={id:1,username:'owner',tokenDbId:1,defaultProjectId:1,defaultProject:'p1',defaultEnvironment:'test',allowAllProjects:false};
 registerToolsForUser(user,{server,registry,knowledge:store});registerToolsForUser(user,{server:noKnowledge,registry});
 configureJobStore({eventSink:store,resolveProjectId:(_actor,name)=>registry.getProject(1,name)?.id,validateWorkSession:(actor,name,sessionId,environment)=>{try{sessions.assertSessionUsable({actorId:actor,sessionId,projectId:String(registry.getProject(actor,name)?.id),environment});return true;}catch{return false;}}});
 let transports=0;
 const result=()=>{transports++;return Promise.resolve({stdout:'ok',stderr:'',code:0,remotePath:'fixture.ps1',cleanedUp:true});};
 for(const method of ['exec','execPowerShell','execPowerShellScript'] as const)t.mock.method(RemoteRunner.prototype,method,result);
 const invoke=(name:string,args:any,target=server)=>(target as any)._registeredTools[name].handler(args);
 const audit=()=>existsSync(join(root,'state','audit.jsonl'))?readFileSync(join(root,'state','audit.jsonl'),'utf8'):'';
 try{
  for(const name of ['exec_remote','exec_remote_powershell','exec_remote_script'])for(const async of [false,true]){
   await t.test(name+' '+(async?'async':'sync')+' rejects forged, actor, project, environment, closed and token-excluded scope',async()=>{
    for(const override of [{workSessionId:'session-forged'},{workSessionId:foreign.id},{project:'p3'},{environment:'other'},{workSessionId:closed.id},{project:'p4'}]){
     const before={transports,jobs:listJobs(1).length,audit:audit()};
     await assert.rejects(()=>invoke(name,{project:'p1',environment:'test',command:'echo ok',script:'Write-Output ok',workSessionId:valid.id,async,...override}),/session|not found|not allowed|closed|scope|environment|project/i);
     assert.equal(transports,before.transports,'denied input must never reach transport');assert.equal(listJobs(1).length,before.jobs,'denied input must not create Job');assert.equal(audit(),before.audit,'denied input must not write success execution audit');
    }
   });
   await t.test(name+' '+(async?'async':'sync')+' permits matching scope and legacy no-Session calls',async()=>{
    for(const sessionId of [valid.id,undefined]){
     const before=transports;const response=await invoke(name,{project:'p1',environment:'test',command:'echo ok',script:'Write-Output ok',workSessionId:sessionId,async});
     if(async){const id=JSON.parse(response.content[0].text).jobId;const done=await waitForJobRecord(id,1,{waitMs:1000,pollMs:50});assert.equal(done.job.status,'succeeded');assert.equal(done.job.workSessionId,sessionId);}
     assert.equal(transports,before+1);
    }
   });
  }
  await t.test('missing Knowledge fails closed only when Session was supplied',async()=>{
   const before=transports;await assert.rejects(()=>invoke('exec_remote',{command:'echo ok',workSessionId:valid.id,async:false},noKnowledge),/unavailable|session/i);assert.equal(transports,before);
   await invoke('exec_remote',{command:'echo ok',async:false},noKnowledge);assert.equal(transports,before+1);
  });
  await t.test('the selected environment is checked even when omitted by the caller',async()=>{
   const other=new McpServer({name:'other-default',version:'test'});registerToolsForUser({...user,defaultEnvironment:'other'},{server:other,registry,knowledge:store});
   try{await assert.rejects(()=>invoke('exec_remote',{command:'echo ok',workSessionId:valid.id,async:false},other),/environment/i);}finally{await other.close();}
  });
 }finally{
  await drainRelayEventSpool(store);configureJobStore();await server.close();await noKnowledge.close();registry.close();store.close();(db as any).session.client.close();
  for(const k of keys){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}rmSync(root,{recursive:true,force:true});
 }
});
