import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

test('Wiki key resolution and ID deep links enforce exact current project/environment and ACL',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wiki-navigation-http-'));
 const previous={DB_PATH:process.env.DB_PATH,KNOWLEDGE_DB_PATH:process.env.KNOWLEDGE_DB_PATH,KNOWLEDGE_ENGINE_HOME:process.env.KNOWLEDGE_ENGINE_HOME,WEKNORA_BASE_URL:process.env.WEKNORA_BASE_URL,WEKNORA_KNOWLEDGE_BASE_ID:process.env.WEKNORA_KNOWLEDGE_BASE_ID};
 process.env.DB_PATH=join(root,'app.db');process.env.KNOWLEDGE_DB_PATH=join(root,'knowledge.db');
 process.env.KNOWLEDGE_ENGINE_HOME=join(root,'engine');process.env.WEKNORA_BASE_URL='http://127.0.0.1:1';process.env.WEKNORA_KNOWLEDGE_BASE_ID='private-fixture-kb';
 const {default:Fastify}=await import('fastify');
 const {db,runMigrations}=await import('../src/server/db/index.js');
 const {users,projects}=await import('../src/server/db/schema.js');
 const {knowledgeRoutes}=await import('../src/server/routes/knowledge.js');
 const {getKnowledgeStore}=await import('../src/server/knowledge-context.js');
 const {WikiService}=await import('../src/knowledge/wiki.js');
 runMigrations();db.insert(users).values([{id:7,username:'wiki-owner',passwordHash:'unused',knowledgeEnabled:true},{id:8,username:'wiki-outsider',passwordHash:'unused',knowledgeEnabled:true}]).run();
 db.insert(projects).values([{id:1,userId:7,name:'One',workspacePath:root},{id:2,userId:7,name:'Two',workspacePath:root},{id:3,userId:8,name:'Other',workspacePath:root}]).run();const store=getKnowledgeStore();
 store.grantAcl('1',7,true);store.grantAcl('2',7,true);
 const page=new WikiService(store).create({actorId:7,pageKey:'concept/safe',projectId:'1',title:'Private target',body:'Private target body',reason:'fixture'});
  const app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={id:req.headers['x-other']?8:7,isAdmin:false};});await app.register(knowledgeRoutes);
  try {
  const outline=await app.inject({url:"/api/knowledge/wiki/navigation?projectId=1"});
  assert.equal(outline.statusCode,200,outline.body);assert.ok(Array.isArray(outline.json().nodes));assert.equal(outline.json().descendantTotal,1);
  const query=new URLSearchParams({pageKey:page.pageKey,projectId:'1'});
  const ok=await app.inject({url:`/api/knowledge/wiki/resolve?${query}`});
  assert.equal(ok.statusCode,200,ok.body);assert.equal(ok.json().page.id,page.id);
  for(const url of [`/api/knowledge/wiki/resolve?${new URLSearchParams({pageKey:page.pageKey,projectId:'2'})}`,`/api/knowledge/wiki/resolve?${query}&environment=production`,`/api/knowledge/wiki/resolve?pageKey=${page.pageKey}`,`/api/knowledge/wiki/${page.id}?projectId=2`,`/api/knowledge/wiki/${page.id}?projectId=1&environment=production`]) {
   const denied=await app.inject({url});assert.ok(denied.statusCode>=400,denied.body);assert.doesNotMatch(denied.body,/Private target/);
  }
  const denied=await app.inject({url:`/api/knowledge/wiki/resolve?${query}`,headers:{'x-other':'1'}});assert.ok(denied.statusCode>=400);assert.doesNotMatch(denied.body,/Private target/);
  assert.equal((await app.inject({url:`/api/knowledge/wiki/${page.id}?projectId=1`})).statusCode,200);
  // Exercise the actual managed Wiki service through HTTP with a transport double;
  // no engine or model is contacted, and no list endpoint participates.
  const {getEngineManager}=await import('../src/knowledge/engine-service.js');
  const prefix='engine-wiki:'+createHash('sha256').update('private-fixture-kb').digest('hex').slice(0,16)+':';
  const managedKey=prefix+'entity/samplemanager-pims',managedId=prefix+'target';
  store.db.transaction(()=>{
   store.db.exec('PRAGMA defer_foreign_keys=ON');
   store.db.prepare("UPDATE knowledge_wiki_pages SET id=?,page_key=?,external_slug=?,environment='test' WHERE id=?").run(managedId,managedKey,'entity/samplemanager-pims',page.id);
   store.db.prepare('UPDATE knowledge_wiki_page_revisions SET page_id=? WHERE page_id=?').run(managedId,page.id);
  })();
  store.db.prepare("INSERT INTO knowledge_integration_settings(key,value,updated_by,updated_at) VALUES('product_provider','weknora',7,'now')").run();
  let reads=0;
  const manager=getEngineManager(store);
  manager.request=async()=>{reads++;return {slug:'entity/samplemanager-pims',knowledge_base_id:'private-fixture-kb',title:'Managed target',content:'Managed body',version:1};};
  const managedQuery=new URLSearchParams({pageKey:managedKey,projectId:'1',environment:'test'});
  const managed=await app.inject({url:`/api/knowledge/wiki/resolve?${managedQuery}`});
  assert.equal(managed.statusCode,200,managed.body);assert.equal(managed.json().page.id,managedId);assert.equal(reads,1);
  assert.doesNotMatch(managed.body,/private-fixture-kb/);
  for(const overrides of [{projectId:'2'},{environment:'production'}]) {
   const query=new URLSearchParams(managedQuery);for(const [key,value]of Object.entries(overrides))query.set(key,value);
   const denied=await app.inject({url:`/api/knowledge/wiki/resolve?${query}`});assert.ok(denied.statusCode>=400);assert.doesNotMatch(denied.body,/Managed body/);
  }
  assert.ok((await app.inject({url:`/api/knowledge/wiki/resolve?${managedQuery}`,headers:{'x-other':'1'}})).statusCode>=400);
  assert.equal(reads,1,'cross-scope and ACL failures must precede any upstream read');
  for(const pageKey of [prefix+'../entity/secret',prefix+'entity/%2e%2e',prefix+'https://outside.test']) {
   const query=new URLSearchParams({pageKey,projectId:'1',environment:'test'});
   assert.ok((await app.inject({url:`/api/knowledge/wiki/resolve?${query}`})).statusCode>=400);
  }
  store.db.prepare('UPDATE knowledge_wiki_pages SET project_id=NULL,environment=NULL WHERE id=?').run(managedId);
  const globalPage=await app.inject({url:`/api/knowledge/wiki/resolve?${managedQuery}`});assert.equal(globalPage.statusCode,200,globalPage.body);
  const otherAuthorized=new URLSearchParams(managedQuery);otherAuthorized.set('projectId','2');
  assert.equal((await app.inject({url:`/api/knowledge/wiki/resolve?${otherAuthorized}`})).statusCode,200);
  const noAccess=new URLSearchParams(managedQuery);noAccess.set('projectId','3');
  assert.ok((await app.inject({url:`/api/knowledge/wiki/resolve?${noAccess}`})).statusCode>=400,'an explicitly selected Project still requires its ACL');
  const globalOnly=new URLSearchParams({pageKey:managedKey});assert.equal((await app.inject({url:`/api/knowledge/wiki/resolve?${globalOnly}`})).statusCode,200,'public Wiki can be read without a Project');
  const beforeInvalid=reads;
  for(const [project,environment]of [[null,'test'],['1',null]]) {
   store.db.prepare('UPDATE knowledge_wiki_pages SET project_id=?,environment=? WHERE id=?').run(project,environment,managedId);
   assert.ok((await app.inject({url:`/api/knowledge/wiki/resolve?${managedQuery}`})).statusCode>=400,'partially missing scope is not global');
  }
  assert.equal(reads,beforeInvalid);
 } finally {
  await app.close();store.close();(db as any).session.client.close();
  for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  rmSync(root,{recursive:true,force:true});
 }
});
