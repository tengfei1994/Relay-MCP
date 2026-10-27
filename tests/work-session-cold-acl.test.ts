import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const intent = (projectId: string) => ({ actions:['understand','verify'],phase:'explore',objective:'Check cold project session access',constraints:['nonproduction'],acceptanceCriteria:['Session opens without another Knowledge request'],projectId,environment:'nonprod-session-acl',risk:'read_only',knowledgeMode:'capture',actorId:2 });

test('HTTP and MCP Work Session creation mirrors only current control-plane project access', async t => {
 const root=mkdtempSync(join(tmpdir(),'work-session-cold-acl-'));
 const names=['DB_PATH','KNOWLEDGE_DB_PATH','RELAY_STATE_ROOT','WORKSPACE_ROOT'] as const;
 const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 process.env.DB_PATH=join(root,'app.db');process.env.KNOWLEDGE_DB_PATH=join(root,'knowledge.db');process.env.RELAY_STATE_ROOT=join(root,'state');process.env.WORKSPACE_ROOT=root;
 const {default:Fastify}=await import('fastify');
 const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js');
 const {db,runMigrations}=await import('../src/server/db/index.ts');
 const {eq}=await import('drizzle-orm');
 const {users,projects,mcpTokens,mcpTokenProjectScopes}=await import('../src/server/db/schema.ts');
 const {getKnowledgeStore}=await import('../src/server/knowledge-context.ts');
 const {knowledgeRoutes}=await import('../src/server/routes/knowledge.ts');
 const {ProjectRegistry}=await import('../src/mcp/project-registry.ts');
 const {registerToolsForUser}=await import('../src/mcp/register-tools.ts');
 runMigrations();
 db.insert(users).values([{id:1,username:'owner',passwordHash:'unused'},{id:2,username:'outsider',passwordHash:'unused'}]).run();
 const store=getKnowledgeStore();
 // Projects arrive after the Knowledge store is already running, as in production.
 db.insert(projects).values([{id:1,name:'Cold HTTP',userId:1,workspacePath:root},{id:2,name:'Other owner',userId:2,workspacePath:root},{id:3,name:'Cold MCP',userId:1,workspacePath:root},{id:4,name:'Excluded token project',userId:1,workspacePath:root},{id:5,name:'HTTP reviewer',userId:1,workspacePath:root},{id:6,name:'MCP reviewer',userId:1,workspacePath:root}]).run();
 db.insert(mcpTokens).values({id:31,userId:1,tokenId:'session-test-token-id',name:'Scoped test',projectId:3,allowAllProjects:false}).run();
 db.insert(mcpTokenProjectScopes).values([{tokenId:31,projectId:3},{tokenId:31,projectId:6}]).run();
 const app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={id:1,isAdmin:req.headers['x-admin']==='true'};});await app.register(knowledgeRoutes);
 const registry=new ProjectRegistry();
 const server=new McpServer({name:'work-session-cold-acl',version:'test'});
 registerToolsForUser({id:1,username:'owner',isAdmin:true,tokenDbId:31,defaultProjectId:3,defaultProject:'Cold MCP',allowAllProjects:false},{server,registry,knowledge:store});
 const handler=(server as any)._registeredTools.knowledge_work_session_open.handler as (args:any)=>Promise<any>;
 const acl=(projectId:string)=>store.db.prepare('SELECT can_read,can_review FROM knowledge_acl WHERE project_id=? AND user_id=1').get(projectId) as {can_read:number;can_review:number}|undefined;
 try {
  await t.test('HTTP opens the first session without visiting a mirror-triggering page',async()=>{
   assert.equal(acl('1'),undefined);
   const response=await app.inject({method:'POST',url:'/api/knowledge/sessions',payload:{idempotencyKey:'http-cold',intent:intent('1')}});
   assert.equal(response.statusCode,201,response.body);assert.equal(response.json().session.projectId,'1');assert.equal(response.json().session.actorId,1);assert.deepEqual(acl('1'),{can_read:1,can_review:0});
   const replay=await app.inject({method:'POST',url:'/api/knowledge/sessions',payload:{idempotencyKey:'http-cold',intent:intent('1')}});assert.equal(replay.json().session.id,response.json().session.id);
  });
  await t.test('HTTP mirroring preserves an existing reviewer',async()=>{
   store.grantAcl('5',1,true);const response=await app.inject({method:'POST',url:'/api/knowledge/sessions',payload:{idempotencyKey:'http-reviewer',intent:intent('5')}});assert.equal(response.statusCode,201,response.body);assert.deepEqual(acl('5'),{can_read:1,can_review:1});
  });
  await t.test('HTTP administrator cannot mirror another owners project',async()=>{
   const response=await app.inject({method:'POST',url:'/api/knowledge/sessions',headers:{'x-admin':'true'},payload:{idempotencyKey:'http-forbidden',intent:intent('2')}});assert.equal(response.statusCode,403);assert.equal(acl('2'),undefined);
  });
  await t.test('MCP opens a cold project through actual registry token scopes',async()=>{
   assert.equal(acl('3'),undefined);const result=await handler({idempotencyKey:'mcp-cold',intent:intent('3')});const value=JSON.parse(result.content[0].text);assert.equal(value.session.projectId,'3');assert.equal(value.session.actorId,1);assert.deepEqual(acl('3'),{can_read:1,can_review:0});
  });
  await t.test('MCP retains reviewer grants but rejects existing ACL outside token scope',async()=>{
   store.grantAcl('6',1,true);await handler({idempotencyKey:'mcp-reviewer',intent:intent('6')});assert.deepEqual(acl('6'),{can_read:1,can_review:1});
   store.grantAcl('4',1,true);await assert.rejects(()=>handler({idempotencyKey:'mcp-scope-denied',intent:intent('4')}),/not allowed|access|project/i);assert.equal(store.db.prepare("SELECT 1 FROM knowledge_work_sessions WHERE idempotency_key='mcp-scope-denied'").get(),undefined);
  });
  await t.test('MCP never treats administrator or default project metadata as an access grant',async()=>{
   await assert.rejects(()=>handler({idempotencyKey:'mcp-owner-denied',intent:intent('2')}),/not allowed|access|project/i);assert.equal(acl('2'),undefined);
  });
  await t.test('HTTP rejects another owner even when a legacy Knowledge ACL exists',async()=>{
   store.grantAcl('2',1,true);
   const response=await app.inject({method:'POST',url:'/api/knowledge/sessions',headers:{'x-admin':'true'},payload:{idempotencyKey:'http-legacy-denied',intent:intent('2')}});
   assert.equal(response.statusCode,403);
   assert.deepEqual(acl('2'),{can_read:1,can_review:1});
   assert.equal(store.db.prepare("SELECT 1 FROM knowledge_work_sessions WHERE idempotency_key='http-legacy-denied'").get(),undefined);
  });
  await t.test('HTTP rejects replay after the stored session project changes owner',async()=>{
   db.update(projects).set({userId:2}).where(eq(projects.id,5)).run();
   const response=await app.inject({method:'POST',url:'/api/knowledge/sessions',payload:{idempotencyKey:'http-reviewer',intent:intent('1')}});
   assert.equal(response.statusCode,403);
  });
  await t.test('MCP rejects idempotent replay of a session outside the current token scope',async()=>{
   db.delete(mcpTokenProjectScopes).where(eq(mcpTokenProjectScopes.projectId,6)).run();
   await assert.rejects(()=>handler({idempotencyKey:'mcp-reviewer',intent:intent('3')}),/not allowed|access|project/i);
  });
  await t.test('MCP rechecks revoked scopes and does not fall back to the default project',async()=>{
   db.delete(mcpTokenProjectScopes).run();
   await assert.rejects(()=>handler({idempotencyKey:'mcp-revoked-denied',intent:intent('3')}),/not allowed|access|project/i);
   assert.deepEqual(acl('3'),{can_read:1,can_review:0});
   assert.equal(store.db.prepare("SELECT 1 FROM knowledge_work_sessions WHERE idempotency_key='mcp-revoked-denied'").get(),undefined);
  });
  const sessionRow=(key:string)=>store.db.prepare('SELECT * FROM knowledge_work_sessions WHERE idempotency_key=?').get(key) as {id:string;[key:string]:unknown};
  const transferred=sessionRow('http-reviewer'),revoked=sessionRow('mcp-cold');
  for(const [method,suffix,payload,status] of [
   ['GET','',undefined,404],['GET','/events',undefined,404],
   ['PATCH','',{patch:{summary:'must-not-write'}},403],['POST','/close',{result:{summary:'must-not-close'}},403],
  ] as const){
   await t.test('HTTP '+method+suffix+' rejects a transferred project with a stale ACL',async()=>{
    const response=await app.inject({method,url:'/api/knowledge/sessions/'+transferred.id+suffix,headers:{'x-admin':'true'},payload});
    assert.equal(response.statusCode,status,response.body);assert.deepEqual(sessionRow('http-reviewer'),transferred);
   });
  }
  await t.test('HTTP session list excludes projects no longer owned without revoking legacy grants',async()=>{
   const response=await app.inject({method:'GET',url:'/api/knowledge/sessions',headers:{'x-admin':'true'}});
   assert.equal(response.statusCode,200);assert.equal(response.json().sessions.some((row:any)=>row.id===transferred.id),false);
   assert.ok(response.json().sessions.some((row:any)=>row.projectId==='1'));assert.deepEqual(acl('5'),{can_read:1,can_review:1});
  });
  for(const [operation,args] of [
   ['get',{sessionId:revoked.id}],['update',{sessionId:revoked.id,patch:{summary:'must-not-write'}}],
   ['close',{sessionId:revoked.id,result:{summary:'must-not-close'}}],['list',{sessionId:revoked.id}],
  ] as const){
   await t.test('MCP '+operation+' rejects a revoked token scope with a stale ACL',async()=>{
    const run=(server as any)._registeredTools['knowledge_work_session_'+operation].handler;
    await assert.rejects(()=>run(args),/not allowed|access|project/i);assert.deepEqual(sessionRow('mcp-cold'),revoked);
   });
  }
  await t.test('MCP session list contains no sessions outside the current token scope',async()=>{
   const result=await (server as any)._registeredTools.knowledge_work_session_list.handler({});
   assert.deepEqual(JSON.parse(result.content[0].text).sessions,[]);assert.deepEqual(acl('3'),{can_read:1,can_review:0});
  });
  await t.test('restored MCP scope permits its session but not another actors session',async()=>{
   db.insert(mcpTokenProjectScopes).values({tokenId:31,projectId:3}).run();
   const get=(server as any)._registeredTools.knowledge_work_session_get.handler;
   assert.equal(JSON.parse((await get({sessionId:revoked.id})).content[0].text).session.id,revoked.id);
   const result=await (server as any)._registeredTools.knowledge_work_session_list.handler({});
   assert.deepEqual(JSON.parse(result.content[0].text).sessions.map((row:any)=>row.id),[revoked.id]);
   store.db.prepare('UPDATE knowledge_work_sessions SET actor_id=2 WHERE id=?').run(revoked.id);
   await assert.rejects(()=>get({sessionId:revoked.id}),/not found|access/i);
   store.db.prepare('UPDATE knowledge_work_sessions SET actor_id=1 WHERE id=?').run(revoked.id);
  });
  await t.test('HTTP and MCP expose bounded summary references through the same current scope gate',async()=>{
   const response=await app.inject({method:'GET',url:'/api/knowledge/sessions/'+revoked.id+'/summary?limit=1&offset=0'});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().pagination.events.limit,1);assert.deepEqual(response.json().observations,[]);assert.equal(response.json().session.intent.projectId,'3');
   const result=await (server as any)._registeredTools.knowledge_work_session_list.handler({sessionId:revoked.id,limit:1,offset:0});const value=JSON.parse(result.content[0].text);assert.equal(value.pagination.events.limit,1);assert.deepEqual(value.evidence,[]);
   const denied=await app.inject({method:'GET',url:'/api/knowledge/sessions/'+transferred.id+'/summary'});assert.equal(denied.statusCode,404);
  });
  await t.test('standard HTTP and MCP search persist Session-scoped retrieval receipts',async()=>{
   const before=(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_work_session_events WHERE session_id=? AND event_type='knowledge.retrieval'").get(revoked.id) as any).n;
   const run=(server as any)._registeredTools.knowledge_search.handler;
   await run({workSessionId:revoked.id,query:'private-summary-search'});
   const http=await app.inject({method:'GET',url:'/api/knowledge/search?projectId=3&workSessionId='+revoked.id+'&q=private-summary-search'});assert.equal(http.statusCode,200,http.body);
   const after=(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_work_session_events WHERE session_id=? AND event_type='knowledge.retrieval'").get(revoked.id) as any).n;assert.equal(after-before,2);
   await assert.rejects(()=>run({workSessionId:'missing-session',query:'never-execute'}),/not found|access/i);
  });
  await t.test('Session-associated Candidate job reads reject revoked token scope and transferred project',async()=>{
   const {enqueueCandidateInsight}=await import('../src/knowledge/candidate-worker.ts');
   const mcpJob=enqueueCandidateInsight(store,{actorId:1,sessionId:revoked.id,evidenceRefs:[],context:{}}).job;
   const httpJob=enqueueCandidateInsight(store,{actorId:1,sessionId:transferred.id,evidenceRefs:[],context:{}}).job;
   db.delete(mcpTokenProjectScopes).where(eq(mcpTokenProjectScopes.projectId,3)).run();
   try{await assert.rejects(()=>(server as any)._registeredTools.knowledge_candidate_insight_job_get.handler({id:mcpJob.id}),/not allowed|project|access/i);}
   finally{db.insert(mcpTokenProjectScopes).values({tokenId:31,projectId:3}).run();}
   const response=await app.inject({method:'GET',url:'/api/knowledge/candidate-insight-jobs/'+httpJob.id});assert.equal(response.statusCode,404,response.body);
  });
  await t.test('current control-plane scope cannot override a denied Knowledge ACL',async()=>{
   store.db.prepare('UPDATE knowledge_acl SET can_read=0 WHERE project_id=? AND user_id=1').run('3');
   await assert.rejects(()=>(server as any)._registeredTools.knowledge_work_session_get.handler({sessionId:revoked.id}),/access/i);
   const response=await app.inject({method:'GET',url:'/api/knowledge/sessions/'+revoked.id});assert.equal(response.statusCode,404);
   assert.equal(acl('3')?.can_read,0);
  });
 } finally {
  await server.close();registry.close();await app.close();store.close();(db as any).session.client.close();
  for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}
  rmSync(root,{recursive:true,force:true});
 }
});
