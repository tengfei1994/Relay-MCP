import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('historical Work Sessions remain Project-scoped on the web and MCP uses current Memory scopes', async () => {
 const root=mkdtempSync(join(tmpdir(),'work-session-cold-acl-'));
 const names=['DB_PATH','KNOWLEDGE_DB_PATH','RELAY_STATE_ROOT','WORKSPACE_ROOT'] as const;
 const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 process.env.DB_PATH=join(root,'app.db');process.env.KNOWLEDGE_DB_PATH=join(root,'knowledge.db');process.env.RELAY_STATE_ROOT=join(root,'state');process.env.WORKSPACE_ROOT=root;
 const {default:Fastify}=await import('fastify');
 const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js');
 const {db,runMigrations}=await import('../src/server/db/index.js');
 const {eq}=await import('drizzle-orm');
 const {users,projects,mcpTokens,mcpTokenProjectScopes}=await import('../src/server/db/schema.js');
 const {getKnowledgeStore}=await import('../src/server/knowledge-context.js');
 const {knowledgeRoutes}=await import('../src/server/routes/knowledge.js');
 const {ProjectRegistry}=await import('../src/mcp/project-registry.js');
 const {registerToolsForUser}=await import('../src/mcp/register-tools.js');
 runMigrations();
 db.insert(users).values([{id:1,username:'owner',passwordHash:'unused'},{id:2,username:'outsider',passwordHash:'unused'}]).run();
 const store=getKnowledgeStore();
 db.insert(projects).values([{id:1,name:'Cold HTTP',userId:1,workspacePath:root},{id:2,name:'Other owner',userId:2,workspacePath:root},{id:3,name:'Cold MCP',userId:1,workspacePath:root}]).run();
 db.insert(mcpTokens).values({id:31,userId:1,tokenId:'scope-test-token',name:'Scoped test',projectId:3,allowAllProjects:false}).run();
 db.insert(mcpTokenProjectScopes).values({tokenId:31,projectId:3}).run();
 const app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={id:1,isAdmin:req.headers['x-admin']==='true'};});await app.register(knowledgeRoutes);
 const registry=new ProjectRegistry(),server=new McpServer({name:'work-session-cold-acl',version:'test'});
 registerToolsForUser({id:1,username:'owner',tokenDbId:31,defaultProjectId:3,defaultProject:'Cold MCP',allowAllProjects:false},{server,registry,knowledge:store});
 const tools=(server as any)._registeredTools;
 const intent=(projectId:string)=>({actions:['understand','verify'],phase:'explore',objective:'Check cold project session access',constraints:['nonproduction'],acceptanceCriteria:['Session is available'],projectId,environment:'nonprod',risk:'read_only',knowledgeMode:'capture'});
 try {
  assert.equal(tools.knowledge_work_session_open,undefined);
  const open=await app.inject({method:'POST',url:'/api/knowledge/sessions',payload:{idempotencyKey:'http-cold',intent:intent('1')}});
  assert.equal(open.statusCode,201,open.body);const id=open.json().session.id;
  assert.equal(open.json().session.actorId,1);assert.equal(open.json().session.projectId,'1');
  const replay=await app.inject({method:'POST',url:'/api/knowledge/sessions',payload:{idempotencyKey:'http-cold',intent:intent('1')}});assert.equal(replay.json().session.id,id);
  store.grantAcl('2',1,true);
  const forbidden=await app.inject({method:'POST',url:'/api/knowledge/sessions',headers:{'x-admin':'true'},payload:{idempotencyKey:'forbidden',intent:intent('2')}});
  assert.equal(forbidden.statusCode,403,'a stale mirrored ACL and administrator role do not grant another Project');
  assert.ok((await tools.memory_search.handler({scope:'project',projectId:'Cold MCP'})).content);
  await assert.rejects(()=>tools.memory_search.handler({scope:'project',projectId:'2'}),/not allowed|access|project/i);
  db.delete(mcpTokenProjectScopes).where(eq(mcpTokenProjectScopes.tokenId,31)).run();
  await assert.rejects(()=>tools.memory_search.handler({scope:'project',projectId:'3'}),/not allowed|access|project/i);
  db.update(projects).set({userId:2}).where(eq(projects.id,1)).run();
  for(const [method,suffix,payload] of [['GET','',undefined],['GET','/events',undefined],['PATCH','',{patch:{summary:'must not write'}}],['POST','/close',{result:{summary:'must not close'}}]] as const) {
   const response=await app.inject({method,url:'/api/knowledge/sessions/'+id+suffix,headers:{'x-admin':'true'},payload});
   assert.ok(response.statusCode>=400,response.body);
  }
  const list=await app.inject({url:'/api/knowledge/sessions'});assert.equal(list.statusCode,200);assert.equal(list.json().sessions.some((row:any)=>row.id===id),false);
 } finally {
  await server.close();registry.close();await app.close();store.close();(db as any).session.client.close();
  for(const name of names) { if(previous[name]===undefined) delete process.env[name]; else process.env[name]=previous[name]; }
  rmSync(root,{recursive:true,force:true});
 }
});
