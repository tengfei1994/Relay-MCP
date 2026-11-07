import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Actual registrars and current control-plane token scopes; no SSH or model invocation.
test('knowledge_get and impact analysis persist only authorized Session receipts',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'session-tool-receipts-'));
 const env={DB_PATH:join(dir,'app.db'),KNOWLEDGE_DB_PATH:join(dir,'knowledge.db'),WORKSPACE_ROOT:dir,RELAY_STATE_ROOT:join(dir,'state'),DOTENV_CONFIG_PATH:join(dir,'absent.env')};
 const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
 const [{db,runMigrations},schema,{createKnowledgeStore},{WorkSessionService},{McpServer},{ProjectRegistry},{registerToolsForUser},{extractSampleManagerRelations,persistRelations},{eq},{importKnowledgeProducts}]=await Promise.all([
  import('../src/server/db/index.ts'),import('../src/server/db/schema.ts'),import('../src/knowledge/store.ts'),import('../src/knowledge/work-session.ts'),import('@modelcontextprotocol/sdk/server/mcp.js'),import('../src/mcp/project-registry.ts'),import('../src/mcp/register-tools.ts'),import('../src/knowledge/relations.ts'),import('drizzle-orm'),import('../src/knowledge/knowledge-products.ts')]);
 runMigrations();db.insert(schema.users).values([{id:7,username:'owner',passwordHash:'unused',knowledgeEnabled:true},{id:8,username:'foreign',passwordHash:'unused'}]).run();
 db.insert(schema.projects).values([{id:1,userId:7,name:'Receipt project',workspacePath:dir},{id:2,userId:7,name:'Other project',workspacePath:dir}]).run();
 db.insert(schema.servers).values({id:1,userId:7,name:'unused loopback',host:'127.0.0.1',sshUser:'unused',privateKeyPath:'unused',publicKey:'unused',status:'connected'}).run();
 db.insert(schema.projectServers).values([1,2].flatMap(projectId=>['test','prod'].map(environment=>({projectId,serverId:1,remotePath:dir,environment})))).run();
 db.insert(schema.mcpTokens).values({id:31,userId:7,tokenId:'receipt-token',name:'Scoped receipt',projectId:1,allowAllProjects:false}).run();db.insert(schema.mcpTokenProjectScopes).values([{tokenId:31,projectId:1},{tokenId:31,projectId:2}]).run();db.insert(schema.mcpTokenServerScopes).values({tokenId:31,serverId:1}).run();
 const store=createKnowledgeStore({dbPath:env.KNOWLEDGE_DB_PATH});for(const p of ['1','2'])store.grantAcl(p,7,true);store.grantAcl('1',8);
 const sessions=new WorkSessionService(store),intent={actorId:7,projectId:'1',environment:'test',actions:['verify'] as ('verify')[],phase:'validation' as const,objective:'Verify receipt contract',constraints:[],acceptanceCriteria:[],risk:'read_only' as const,knowledgeMode:'capture' as const};
 const open=(key:string,patch:any={})=>sessions.open({actorId:patch.actorId??7,idempotencyKey:key,intent:{...intent,...patch}});
 const session=open('normal'),foreign=open('foreign',{actorId:8}),closed=open('closed'),noEnv=open('unscoped',{environment:undefined});sessions.close({actorId:7,sessionId:closed.id});
 const now=new Date().toISOString(),document={id:'doc-case',kind:'case' as const,title:'Private title',body:'PRIVATE_DOCUMENT_BODY',lifecycle:'verified' as const,projectId:'1',environment:'test',locator:'PRIVATE_SOURCE_PATH',sha256:'a'.repeat(64),createdAt:now,updatedAt:now};store.upsertDocument(document);store.upsertDocument({...document,id:'doc-wrong-env',environment:'prod'});store.upsertDocument({...document,id:'doc-wrong-project',projectId:'2'});store.upsertDocument({...document,id:'doc-product',kind:'product_document',lifecycle:'approved'});
 const docs=join(dir,'public-docs');mkdirSync(docs);writeFileSync(join(docs,'guide.md'),'# Guide\n\nPublic product knowledge.');
 const productId=importKnowledgeProducts(store,{root:docs,sampleManagerVersion:'21'}).documents[0];store.db.prepare("INSERT INTO knowledge_product_classifications(document_id,classification,updated_at) VALUES (?,'product',?)").run(productId,now);
 const relations=extractSampleManagerRelations({content:'<Form name="PrivateForm"><Control name="PrivateControl"/></Form>',sourceLocator:'PRIVATE_RELATION_PATH',kind:'form-xml',environment:'test'});persistRelations(store,relations,'1');
 const registry=new ProjectRegistry(),server=new McpServer({name:'receipt-tests',version:'test'}),user={id:7,username:'owner',tokenDbId:31,defaultProjectId:1,defaultProject:'Receipt project',defaultEnvironment:'test',allowAllProjects:false};registerToolsForUser(user,{server,registry,knowledge:store});
 const call=(name:string,args:any)=>(server as any)._registeredTools[name].handler(args);const parsed=async(name:string,args:any)=>JSON.parse((await call(name,args)).content[0].text);
 const events=()=>store.db.prepare('SELECT * FROM knowledge_work_session_events WHERE session_id=? ORDER BY created_at,id').all(session.id) as any[];
 const impact={objectId:relations[0].from,workSessionId:session.id,intentStep:'verify',objectiveRef:'PRIVATE_OBJECTIVE_REFERENCE',acceptanceCriterionRef:'PRIVATE_CRITERION_REFERENCE'};
 const restoreScope=()=>db.insert(schema.mcpTokenProjectScopes).values({tokenId:31,projectId:1}).onConflictDoNothing().run();
 try{
  await t.test('product get requires no Work Session and cannot read project cases',async()=>{
   const toolSchema=(server as any)._registeredTools.knowledge_get.inputSchema;assert.equal(toolSchema.shape.workSessionId,undefined);
   assert.equal(Object.keys((server as any)._registeredTools).length,91);
   const result=await parsed('knowledge_get',{documentId:productId});assert.match(result.body,/Public product knowledge/);assert.equal(events().length,0);
   await assert.rejects(()=>call('knowledge_get',{documentId:document.id}),/access|not found/i);
   await assert.rejects(()=>call('knowledge_get',{documentId:productId,chunkId:'foreign-chunk'}),/chunk/i);
  });
  await t.test('product access is independent of Project token scopes and honors live revocation',async()=>{
   db.delete(schema.mcpTokenProjectScopes).where(eq(schema.mcpTokenProjectScopes.projectId,1)).run();
   try { assert.match((await parsed('knowledge_get',{documentId:productId})).body,/Public product knowledge/); }
   finally {restoreScope();}
   const pending=call('knowledge_get',{documentId:productId});db.update(schema.users).set({knowledgeEnabled:false}).where(eq(schema.users.id,7)).run();
   try {await assert.rejects(()=>pending,/denied/i);await assert.rejects(()=>call('knowledge_get',{documentId:productId}),/denied/i);assert.equal(events().length,0);}
   finally {db.update(schema.users).set({knowledgeEnabled:true}).where(eq(schema.users.id,7)).run();}
  });
  await t.test('impact persists safe standalone receipt and cannot authorize joined Evidence',async()=>{
   const old=await parsed('samplemanager_impact_analysis',{objectId:relations[0].from});const before=events().length;const value=await parsed('samplemanager_impact_analysis',impact);assert.deepEqual(value.facts,old.facts);assert.equal(events().length,before+1);assert.equal(value.provenance.workSessionId,session.id);
   await call('samplemanager_impact_analysis',impact);assert.equal(events().length,before+1);
   const summary=sessions.summarize({actorId:7,sessionId:session.id}),receipt=summary.events.find(row=>row.event_type==='samplemanager.impact_analysis');assert.ok(receipt);assert.equal(receipt.intent_step,'verify');assert.equal(JSON.stringify(receipt).includes('PRIVATE_'),false);assert.equal(summary.evidence.length,0);assert.equal(summary.observations.length,0);
   store.db.prepare('INSERT INTO knowledge_observations(id,event_id,project_id,event_class,capture_reason,evidence_refs_json,source_locator,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('forged-observation',receipt.event_id,'1','observation','PRIVATE_REASON','[]','PRIVATE_LOCATOR',now,now);
   assert.equal(sessions.summarize({actorId:7,sessionId:session.id}).observations.length,0,'a standalone receipt cannot authorize a fabricated Observation join');
   assert.equal(store.db.prepare('SELECT 1 FROM relay_domain_events WHERE id=?').get(receipt.event_id),undefined,'standalone receipt must not impersonate an authoritative domain event');
  });
  await t.test('impact rejects invalid Session/environment and preserves denied ACL and reviewer grants',async()=>{
   for(const override of [{workSessionId:'forged'},{workSessionId:foreign.id},{workSessionId:closed.id},{workSessionId:noEnv.id},{project:'Other project'},{environment:'prod'}]){const before=events().length;await assert.rejects(()=>call('samplemanager_impact_analysis',{...impact,...override}),/session|access|environment|project|closed|not found/i);assert.equal(events().length,before);}
   store.db.prepare("UPDATE knowledge_acl SET can_read=0 WHERE project_id='1' AND user_id=7").run();try{await assert.rejects(()=>call('samplemanager_impact_analysis',impact),/access/i);assert.equal((store.db.prepare("SELECT can_read FROM knowledge_acl WHERE project_id='1' AND user_id=7").get() as any).can_read,0);}finally{store.grantAcl('1',7,true);}
   assert.equal((store.db.prepare("SELECT can_review FROM knowledge_acl WHERE project_id='1' AND user_id=7").get() as any).can_review,1);
  });
  await t.test('impact rechecks live token scope after source analysis before recording success',async()=>{
   const original=registry.listScopedProjects.bind(registry);let lookups=0;const mocked=t.mock.method(registry,'listScopedProjects',(...args:any[])=>{lookups++;if(lookups===3)db.delete(schema.mcpTokenProjectScopes).where(eq(schema.mcpTokenProjectScopes.projectId,1)).run();return original(...args as Parameters<typeof original>);});
   const before=events().length;try{await assert.rejects(()=>call('samplemanager_impact_analysis',{...impact,objectId:'different-object'}),/allowed|access|project/i);assert.equal(events().length,before);}finally{mocked.mock.restore();restoreScope();}
  });
  await t.test('missing cold mirror is rebuilt only inside current scope and persisted receipts survive reopen',async()=>{
   store.db.prepare("DELETE FROM knowledge_acl WHERE project_id='1' AND user_id=7").run();await call('samplemanager_impact_analysis',impact);assert.equal(store.canRead(7,'1'),true);
   const before=events().length;const second=createKnowledgeStore({dbPath:env.KNOWLEDGE_DB_PATH});try{assert.equal(new WorkSessionService(second).summarize({actorId:7,sessionId:session.id}).events.length,before);}finally{second.close();}
  });
 }finally{await server.close();registry.close();store.close();(db as any).session.client.close();for(const key of Object.keys(env)){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}rmSync(dir,{recursive:true,force:true});}
});
