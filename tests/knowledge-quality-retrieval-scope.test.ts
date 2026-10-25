import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {selectRetrievalBindings,retrievalReadiness,type RetrievalScope} from '../scripts/knowledge-quality-retrieval-scope.ts';
import {sha,type Source} from '../scripts/knowledge-quality-common.ts';
const scope:RetrievalScope={migrationId:'flash',operationKey:'flash-key',knowledgeBaseId:'flash-kb',providerId:'qwen',modelId:'qwen3.7-text-embedding-flash',indexVersion:2,dimensions:1024,engineModelId:'engine-flash',modelAlias:'flash-alias',parserVersion:'html-3-flash',providerStatus:'pending_reindex'};
const source={id:'local',bodySha256:sha('body'),sourceSha256:sha('raw'),sourcePath:'source.htm',projectId:'1',environment:'same-env',version:'21.3',solution:null,module:null,language:null} as Source;
const normalized=new Map([['local',sha('normalized')]]);
const provenance={knowledgeBaseId:scope.knowledgeBaseId,providerId:scope.providerId,modelId:scope.modelId,indexVersion:2,dimensions:1024};
function fixture(){
 const db=new Database(':memory:');db.exec(`CREATE TABLE knowledge_migrations(id TEXT,kind TEXT,status TEXT,idempotency_key TEXT,source_manifest_json TEXT);
 CREATE TABLE knowledge_migration_documents(migration_id TEXT,local_document_id TEXT,document_id TEXT,status TEXT,external_document_id TEXT,content_sha256 TEXT,parser_version TEXT);
 CREATE TABLE knowledge_weknora_documents(id TEXT,status TEXT,external_knowledge_base_id TEXT,external_document_id TEXT,external_chunk_ids_json TEXT,upstream_verified_at TEXT,upstream_parse_status TEXT,raw_sha256 TEXT,normalized_content_sha256 TEXT,parser_version TEXT,model_provenance_json TEXT,project_id TEXT,environment TEXT,product_version TEXT,source_path TEXT);
 CREATE TABLE knowledge_provider_configs(id TEXT,status TEXT,model_id TEXT,dimensions INTEGER,index_version INTEGER,updated_at TEXT);
 CREATE TABLE knowledge_integration_settings(key TEXT,value TEXT,migration_id TEXT);`);
 const manifest={parserVersion:scope.parserVersion,documents:[{localDocumentId:source.id,bodySha256:source.bodySha256,sourceSha256:source.sourceSha256,sourcePath:source.sourcePath,productVersion:source.version,projectId:source.projectId,environment:source.environment}]};
 db.prepare('INSERT INTO knowledge_migrations VALUES(?,?,?,?,?)').run('flash','product_knowledge','published','flash-key',JSON.stringify(manifest));
 db.prepare('INSERT INTO knowledge_provider_configs VALUES(?,?,?,?,?,?)').run('qwen','pending_reindex',scope.modelId,1024,2,'revision-a');
 db.prepare('INSERT INTO knowledge_integration_settings VALUES(?,?,?)').run('product_provider','weknora','flash');
 const add=(migration:string,id:string,kb=scope.knowledgeBaseId,model=provenance)=>{
  if(migration!=='flash')db.prepare('INSERT INTO knowledge_migrations VALUES(?,?,?,?,?)').run(migration,'product_knowledge','published',migration,JSON.stringify(manifest));
  db.prepare('INSERT INTO knowledge_weknora_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'published',kb,id+'-external',JSON.stringify([id+'-chunk']),'verified','completed',source.sourceSha256,normalized.get('local'),scope.parserVersion,JSON.stringify(model),'1','same-env','21.3','source.htm');
  db.prepare('INSERT INTO knowledge_migration_documents VALUES(?,?,?,?,?,?,?)').run(migration,'local',id,'published',id+'-external',normalized.get('local'),scope.parserVersion);
 };add('flash','flash-map');
 const control={phase:'ready',knowledgeBaseId:scope.knowledgeBaseId,bindings:[{kind:'embedding',providerId:'qwen',modelId:scope.modelId,indexVersion:2,dimensions:1024,engineModelId:scope.engineModelId,alias:scope.modelAlias}]};
 return {db,add,control};
}
test('exact migration prevents same-environment and same-KB older migrations replacing the frozen mapping',()=>{
 const {db,add}=fixture();try{add('legacy','old-map','old-kb');add('other-new-kb','unrelated-map');const proof=selectRetrievalBindings(db,[source],scope,normalized);assert.equal(proof.missing.length,0);assert.equal(proof.found.get('local')?.row.id,'flash-map');db.prepare("UPDATE knowledge_migration_documents SET status='staged' WHERE migration_id='flash'").run();assert.deepEqual(selectRetrievalBindings(db,[source],scope,normalized).missing,['local']);}finally{db.close();}
});
test('wrong model revision, normalized bytes and legacy parser cannot satisfy readiness',()=>{
 for(const patch of [{model_provenance_json:JSON.stringify({...provenance,indexVersion:1})},{model_provenance_json:JSON.stringify({...provenance,modelId:'legacy-model'})},{model_provenance_json:JSON.stringify({...provenance,providerId:'other-provider'})},{normalized_content_sha256:sha('different')},{parser_version:'old-parser'}]){const {db}=fixture();try{for(const [key,value]of Object.entries(patch))db.prepare('UPDATE knowledge_weknora_documents SET '+key+'=?').run(value);assert.deepEqual(selectRetrievalBindings(db,[source],scope,normalized).missing,['local']);}finally{db.close();}}
});
test('publication, active routing, provider config and current control must all match before any HTTP request',()=>{
 const {db,control}=fixture();try{
  const ready=()=>retrievalReadiness(db,[source],scope,normalized,control);assert.equal(ready().ready,true);const original=ready().fingerprint;
  db.prepare("UPDATE knowledge_provider_configs SET updated_at='rotated'").run();assert.notEqual(ready().fingerprint,original);
  db.prepare("UPDATE knowledge_provider_configs SET status='disabled'").run();assert.equal(ready().ready,false);db.prepare("UPDATE knowledge_provider_configs SET status='pending_reindex'").run();
  db.prepare("UPDATE knowledge_integration_settings SET migration_id='legacy'").run();assert.equal(ready().ready,false);db.prepare("UPDATE knowledge_integration_settings SET migration_id='flash'").run();
  db.prepare("UPDATE knowledge_migrations SET status='staged' WHERE id='flash'").run();assert.equal(ready().ready,false);db.prepare("UPDATE knowledge_migrations SET status='published' WHERE id='flash'").run();
  assert.equal(retrievalReadiness(db,[source],scope,normalized,{...control,knowledgeBaseId:'old-kb'}).ready,false);
  assert.equal(retrievalReadiness(db,[source],scope,normalized,{...control,phase:'initializing'}).ready,false);
 }finally{db.close();}
});
test('changed frozen migration source metadata blocks otherwise valid published mappings',()=>{
 const {db,control}=fixture();try{const row=db.prepare("SELECT source_manifest_json FROM knowledge_migrations WHERE id='flash'").get() as {source_manifest_json:string};const manifest=JSON.parse(row.source_manifest_json);manifest.documents[0].bodySha256='changed';db.prepare("UPDATE knowledge_migrations SET source_manifest_json=? WHERE id='flash'").run(JSON.stringify(manifest));assert.equal(retrievalReadiness(db,[source],scope,normalized,control).ready,false);}finally{db.close();}
});
