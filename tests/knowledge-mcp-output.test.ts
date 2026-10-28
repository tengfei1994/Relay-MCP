import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createKnowledgeStore} from '../src/knowledge/store.ts';
import {registerKnowledgeTools} from '../src/mcp/tools/knowledge.ts';
import {EvidenceStore} from '../src/knowledge/evidence-store.ts';
import {ConfirmedMemoryService} from '../src/knowledge/confirmed-memory.ts';

test('MCP knowledge_get preserves structured source citations for documents larger than the general output preview limit',async()=>{
  const root=mkdtempSync(join(tmpdir(),'knowledge-mcp-output-')),store=createKnowledgeStore({dbPath:join(root,'k.db')});
  try{
    store.grantAcl('p1',7,true);
    const body='Evidence-backed product source. '.repeat(1000);
    store.db.prepare('INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,source_locator,source_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('product-long','product_document','Long source',body,'approved','p1','manual.html#section','source-hash','now','now');
    store.db.prepare('INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,source_path,source_sha256,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('product-long','family','guide','en','manual.html','source-hash','21.3','now','now');
    const callbacks=new Map<string,Function>();
    registerKnowledgeTools({server:{tool:(name:string,...args:any[])=>callbacks.set(name,args.at(-1)),resource:()=>undefined}as any,user:{id:7,username:'test',defaultProject:'p1',defaultProjectId:'p1'}as any,knowledge:store});
    const result=await callbacks.get('knowledge_get')!({documentId:'product-long'});
    const document=JSON.parse(result.content[0].text);
    assert.equal(document.id,'product-long');assert.equal(document.body,body);
    assert.equal(document.sourceSha256,'source-hash');assert.equal(document.citations[0].sourceLocator,'manual.html#section');
    assert.equal(document.truncated,undefined);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('Knowledge output preserves Context Pack structure and fails explicitly on an oversized result',async()=>{
  const {serializeKnowledgeResult}=await import('../src/mcp/knowledge-output.ts');
  const value={references:Array.from({length:40},(_,i)=>({documentId:`d${i}`,chunkId:`c${i}`,snippet:'x'.repeat(400),sourceLocator:`guide.html#${i}`})),contextPack:{authoritativeDocs:[{provider:'weknora',documentId:'d0'}]}};
  assert.deepEqual(JSON.parse(serializeKnowledgeResult(value)),value);
  assert.throws(()=>serializeKnowledgeResult({body:'文'.repeat(20)},32),/size limit/);
});


test('MCP engine outage preserves confirmed Relay memory and reports an empty degraded Product section',async()=>{
  const root=mkdtempSync(join(tmpdir(),'knowledge-mcp-outage-')),store=createKnowledgeStore({dbPath:join(root,'k.db')});
  const original=process.env.KNOWLEDGE_ENGINE_HOME;process.env.KNOWLEDGE_ENGINE_HOME=join(root,'uninstalled');
  try{
    store.grantAcl('p1',7,true);
    const now=new Date().toISOString();
    const evidence=new EvidenceStore(store,join(root,'evidence')).put({content:Buffer.from('pump sentinel evidence'),mimeType:'text/plain',sourceKind:'log',projectId:'p1',environment:'nonprod',locator:'manual:sentinel'});
    new ConfirmedMemoryService(store).save({id:'verified-memory',type:'Case',title:'pump sentinel',statement:'pump sentinel evidence',details:{symptoms:'pump stopped',rootCause:'fixture',resolution:'reviewed',verification:'confirmed'},scope:{projectId:'p1',environment:'nonprod',scopeType:'environment',scopeKey:'nonprod',visibility:'project'},evidenceRefs:[evidence.id],source:{kind:'manual',locator:'manual:sentinel'},confirmedBy:7,confirmedAt:now,audit:{action:'manual',reason:'fixture'}});
    store.db.prepare("INSERT INTO knowledge_weknora_documents(id,external_document_id,external_knowledge_base_id,external_chunk_ids_json,title,normalized_content_sha256,parser_version,product_version,source_path,project_id,environment,status,idempotency_key,created_at,updated_at,upstream_verified_at,upstream_parse_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('mapping','external','kb','["chunk"]','pump','hash','v1','21.3','pump.html','p1','nonprod','published','mapping',now,now,now,'completed');
    const callbacks=new Map<string,Function>();
    registerKnowledgeTools({server:{tool:(name:string,...args:any[])=>callbacks.set(name,args.at(-1)),resource:()=>undefined}as any,user:{id:7,username:'test',defaultProject:'p1',defaultProjectId:'p1',defaultEnvironment:'nonprod'}as any,knowledge:store});
    const response=await callbacks.get('knowledge_weknora_search')!({projectId:'p1',query:'pump sentinel',limit:10});
    const value=JSON.parse(response.content[0].text);
    assert.deepEqual(value.references,[]);
    assert.equal(value.contextPack.degraded.productKnowledge,'unavailable');
    assert.equal(value.contextPack.confirmedKnowledge[0].id,'verified-memory');
    assert.deepEqual(value.contextPack.authoritativeDocs,[]);
  }finally{if(original===undefined)delete process.env.KNOWLEDGE_ENGINE_HOME;else process.env.KNOWLEDGE_ENGINE_HOME=original;store.close();rmSync(root,{recursive:true,force:true});}
});
