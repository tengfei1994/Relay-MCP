import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { freezePublishedSources, scanPrivateText, verifyRetrievalRows } from "../scripts/knowledge-mcp-real-acceptance.ts";
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
test("privacy scanner detects raw, JSON-escaped and URL-encoded private sentinels without returning content",()=>{
  const secret='private query/with \"quotes\"';
  for(const text of [secret,JSON.stringify(secret),encodeURIComponent(secret)])assert.throws(()=>scanPrivateText(text,[secret]),/privacy_content_detected/);
  assert.deepEqual(scanPrivateText('safe metadata',[secret]),{bytes:13,sha256:hash('safe metadata')});
});
test("retrieval verifier requires the tagged digest and versioned metadata, retaining run identity",()=>{
  const query='private retrieval sentinel', id='retrieval-safe';
  const results={schemaVersion:1,queryHash:hash(query),queryLength:[...query].length,queryBytes:Buffer.byteLength(query),resultCount:1,latencyMs:1,degraded:false,productProvider:'weknora',results:[{id:'case-1',kind:'case',score:0.5,rank:1}]};
  const row={id,query:'sha256:'+hash(query),results_json:JSON.stringify(results)};
  assert.deepEqual(verifyRetrievalRows([row],[{id,query}]),[{id,queryHash:hash(query),resultCount:1}]);
  assert.throws(()=>verifyRetrievalRows([{...row,query}],[{id,query}]),/retrieval_query_not_digest/);
  assert.throws(()=>verifyRetrievalRows([{...row,results_json:JSON.stringify({...results,results:[{id:'case-1',snippet:'content'}]})}],[{id,query}]),/retrieval_content_field/);
  assert.throws(()=>verifyRetrievalRows([],[{id,query}]),/retrieval_row_missing/);
});
test("source freeze includes only published verified current-KB migration mappings and no source body/title",()=>{
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE knowledge_migrations(id TEXT,status TEXT);
    CREATE TABLE knowledge_migration_documents(migration_id TEXT,local_document_id TEXT,document_id TEXT,status TEXT);
    CREATE TABLE knowledge_weknora_documents(id TEXT,external_document_id TEXT,external_knowledge_base_id TEXT,external_chunk_ids_json TEXT,raw_sha256 TEXT,normalized_content_sha256 TEXT,parser_version TEXT,product_version TEXT,source_path TEXT,project_id TEXT,environment TEXT,status TEXT,upstream_verified_at TEXT,model_provenance_json TEXT,topic_id TEXT,solution TEXT,module TEXT,language TEXT);
    INSERT INTO knowledge_migrations VALUES('m','published');`);
  const insert=db.prepare(`INSERT INTO knowledge_weknora_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for(const [id,status,kb,environment,mapped] of [['ok','published','kb','nonprod','published'],['chm','published','kb','nonprod-chm-acceptance','published'],['staged','staged','kb','nonprod','published'],['other','published','other','nonprod','published'],['withdrawn','published','kb','nonprod','withdrawn']]){
    insert.run(id,'external-'+id,kb,'["chunk-1"]',hash(id),hash(id+'body'),'parser-3','21.3',id+'.htm','1',environment,status,'now','{}',null,null,'samplemanager','en');
    db.prepare('INSERT INTO knowledge_migration_documents VALUES(?,?,?,?)').run('m','local-'+id,id,mapped);
  }
  try{const rows=freezePublishedSources(db,'1',['nonprod','nonprod-chm-acceptance'],'kb');assert.deepEqual(rows.map(r=>r.localId),['local-chm','local-ok']);assert.ok(rows.every(r=>!('body' in r)&&!('title' in r)));}finally{db.close();}
});
