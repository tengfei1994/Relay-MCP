/** Real CHM-derived Product acceptance. The source corpus is opened read-only. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, chmod, realpath, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

type Row = Record<string, any>;
class Failure extends Error { constructor(readonly code: string) { super(code); } }
const check = (value: unknown, code: string) => { if (!value) throw new Failure(code); };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const parse = (value: unknown): any => typeof value === 'string' ? JSON.parse(value) : value;
const root = '/home/ftd/relay-knowledge-engine-nonprod';
const repo = root + '/relay', data = repo + '/data';
const environment = 'nonprod-chm-acceptance', projectId = '1';
const base = 'http://127.0.0.1:18300';
const runId = process.env.RELAY_CHM_E2E_RUN_ID ?? 'chm-live-20261025b';
const parserVersion = 'relay-chm-markdown-preserve-v2';
const reportPath = root + '/runtime/' + runId + '.json';
const fixtures = [
  { id: 'product-document-236409a33328e596afd36a6f81aadb61', title: 'GET_TABLE_DETAILS', raw: 'a9991638e314fb13ac4b3c6e548981220b392b11a79b7f752aebaade1cc8f96e', body: '5ce047bbfd2221abc69c42a34181f6e54847c58bdb57bb3b3999308def8e0d99' },
  { id: 'product-document-bf98083a4bf0a7526a83e6fa2d1d6fb3', title: 'TABLE_NAME', raw: '102f9c999e4abcadf047ea75b977195f838faa8943566166add299f46fdd5c42', body: 'c7472a3244ce0e016d27163d4817dd280063f25aca75b92877dc52ad6e185c89' },
];
const report: Row = { schemaVersion: 1, status: 'running', runId, targetOrigin: base, projectId, environment, startedAt: new Date().toISOString(), milestones: [], http: [], limitations: ['CHM container provenance, HTML sourceFormat and parser section anchors are preserved in Relay canonical metadata. Engine citations use verified upstream chunk IDs and text locators; original HTML DOM anchor identity is not asserted.'] };
let token = '', foreignToken = '', safe = false, store: any, bulk: any, engineDb: any;
let sourceRows: Row[] = [], mappings: Row[] = [], migration: Row = {}, baseline: Row[] = [];
const sourceById = (id: string) => sourceRows.find(value => value.document.id === id);
const scope = () => ({ projectId, environment });
async function save() { if (!safe) return; const temp = reportPath + `.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(report, null, 2) + '\n', {mode:0o600}); await rename(temp, reportPath); await chmod(reportPath, 0o600); }
async function step(name: string, fn: () => Promise<unknown>) {
  const item: Row = {name, status:'running'}; report.milestones.push(item); await save(); console.log(`[chm-e2e] ${name}: running`); const started=Date.now();
  try { item.evidence=await fn(); item.status='passed'; } catch(error) { item.status='failed'; item.code=error instanceof Failure?error.code:'driver_error'; throw error; }
  finally {item.durationMs=Date.now()-started; await save(); console.log(`[chm-e2e] ${name}: ${item.status}`);}
}
async function request(operation: string, method: string, path: string, options: {body?:Row;query?:Row;expected?:number[];foreign?:boolean} = {}): Promise<Row> {
  const url=new URL(path,base); for(const [key,value] of Object.entries(options.query??{})) if(value!==undefined) url.searchParams.set(key,String(value));
  const event: Row={operation,method,path}; report.http.push(event); const started=Date.now();
  try {
    const response=await fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(150_000),headers:{authorization:`Bearer ${options.foreign?foreignToken:token}`,accept:'application/json',...(options.body?{'content-type':'application/json'}:{})},body:options.body?JSON.stringify(options.body):undefined});
    event.status=response.status; const bytes=new Uint8Array(await response.arrayBuffer()); event.responseBytes=bytes.length;
    check(bytes.length<=4_194_304,'response_exceeds_bound'); check((options.expected??[200]).includes(response.status),`http_${response.status}_${operation}`);
    if(response.status>=400)return {}; return row(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch(error) {if(error instanceof Failure)throw error; throw new Failure('transport_or_json_'+operation);} finally {event.latencyMs=Date.now()-started;}
}
const get = (name:string,path:string,query?:Row) => request(name,'GET',path,{query});
const post = (name:string,path:string,body:Row={},expected=[200]) => request(name,'POST',path,{body,expected});
function canonicalProof(id:string):Row {
  const value=store.db.prepare('SELECT d.id,d.body,d.source_sha256,d.source_locator,d.project_id,d.environment,p.source_path,p.version,p.sections_json,p.metadata_json FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE d.id=?').get(id);
  check(value,'canonical_source_missing'); const metadata=row(parse(value.metadata_json)), sections=rows(parse(value.sections_json));
  return {id:value.id,bodySha256:hash(value.body),sourceSha256:value.source_sha256,sourcePath:value.source_path,sourceLocator:value.source_locator,version:value.version,projectId:value.project_id,environment:value.environment,sourceFormat:metadata.sourceFormat,containerFormat:value.source_path.includes('.chm.expanded-')?'chm':undefined,sectionsSha256:hash(value.sections_json),sectionCount:sections.length,anchorCount:sections.filter(s=>s.anchor).length,anchorsSha256:hash(JSON.stringify(sections.map(s=>s.anchor??null)))};
}
function preservedFive():Row[] {
  return baseline.map(item=>{const d=store.db.prepare('SELECT id,body,source_sha256,project_id,environment FROM knowledge_documents WHERE id=?').get(item.id);check(d,'original_sample_missing');return{id:d.id,bodySha256:hash(d.body),sourceSha256:d.source_sha256,projectId:d.project_id,environment:d.environment};});
}
async function migrate():Promise<Row> {
  const body={...scope(),productVersion:'21.1',limit:2,parserVersion,idempotencyKey:runId+':two-real-chm-pages',asynchronous:true};
  const result=await post('submit_chm_migration','/api/knowledge/migrations/from-local',body,[202]);
  const jobId=String(result.job?.id??''), migrationId=String(result.migrationId??''); check(jobId&&migrationId,'migration_identity_missing');
  report.migration={id:migrationId,jobId};await save(); const start=Date.now(); let last=0;
  for(;;){
    const job=row((await get('migration_job','/api/knowledge/ingest-jobs/'+encodeURIComponent(jobId))).job), progress=row(job.result);
    report.migration={id:migrationId,jobId,status:job.status,processed:progress.processed,mapped:progress.mapped,failed:progress.failed};await save();
    if(job.status==='succeeded')return row((await get('migration_report','/api/knowledge/migrations/'+encodeURIComponent(migrationId))).migration);
    check(job.status!=='failed','migration_job_failed');check(Date.now()-start<1_800_000,'migration_wait_timeout');
    if(Date.now()-last>30_000){console.log(JSON.stringify({event:'chm_migration_progress',status:job.status,processed:Number(progress.processed??0),mapped:Number(progress.mapped??0)}));last=Date.now();}
    await new Promise(done=>setTimeout(done,2000));
  }
}
function validateProduct(value:Row):Row {
  const source=sourceById(String(value.id));check(source,'unexpected_product_result'); const proof=canonicalProof(value.id);
  const mapping=mappings.find(m=>String(m.externalDocumentId??m.external_document_id)===value.externalDocumentId);check(mapping,'product_mapping_missing');
  const allowed=new Set(parse(mapping.externalChunkIds??mapping.external_chunk_ids_json)); const citations=rows(value.citations);
  check(value.provider==='weknora'&&value.projectId===projectId&&value.environment===environment,'product_scope_provider_mismatch');
  check(value.sourcePath===proof.sourcePath&&value.sourceSha256===proof.sourceSha256&&String(value.sampleManagerVersion??value.version)==='21.1','product_source_provenance_mismatch');
  check(citations.length&&citations.every(c=>c.documentId===value.id&&allowed.has(c.chunkId)&&c.sourceSha256===proof.sourceSha256&&String(c.version)==='21.1'&&String(c.sourceLocator??'').split('#')[0]===proof.sourcePath),'unverified_product_citations');
  return{id:value.id,externalDocumentId:value.externalDocumentId,sourcePath:proof.sourcePath,sourceSha256:proof.sourceSha256,version:'21.1',citationCount:citations.length,chunkIds:[...new Set(citations.map(c=>c.chunkId))],locatorTypes:[...new Set(citations.flatMap(c=>rows(c.sourceLocators).map(l=>l.type)))]};
}
function codeBlocks(body:string):string[]{return [...body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(match=>match[1]);}
async function codeIntegrityProof(source:Row,remote:Row):Promise<Row>{
  const upstream=engineDb.prepare('SELECT file_path,file_size FROM knowledges WHERE id=?').get(remote.externalDocumentId);
  check(upstream&&/^resource:\/\/[A-Za-z0-9_-]+$/.test(upstream.file_path),'upstream_source_handle_invalid');
  const resource=engineDb.prepare('SELECT provider,physical_path,size FROM resources WHERE handle=? AND deleted_at IS NULL').get(upstream.file_path.slice('resource://'.length));
  check(resource?.provider==='local','upstream_source_not_local');
  const match=String(resource.physical_path).match(/^storage:\/\/[^/]+\/local:\/\/(.+)$/);check(match,'upstream_source_path_invalid');
  const fileRoot=root+'/runtime/knowledge-engine/data/files',path=resolve(fileRoot,match![1]);
  check(path.startsWith(fileRoot+'/')&&await realpath(path)===path&&!(await lstat(path)).isSymbolicLink(),'upstream_source_path_escape');
  check((await lstat(path)).size<=1_048_576,'upstream_source_exceeds_bound');const bytes=await readFile(path);check(bytes.length<=1_048_576&&bytes.length===Number(resource.size)&&hash(bytes)===hash(source.normalized),'upstream_source_payload_changed');
  const persistedBlocks=codeBlocks(bytes.toString('utf8'));
  check(JSON.stringify(source.codeBlocks.map(hash))===JSON.stringify(persistedBlocks.map(hash)),'upstream_code_hash_mismatch');
  const ranges=rows(remote.sections).map(section=>{const content=String(section.text??'');if(!content)return null;const start=source.normalized.indexOf(content);return start<0?null:{start,end:start+content.length};}).filter(Boolean) as Array<{start:number;end:number}>;
  const coverage=source.codeBlocks.map((code:string)=>{
    const start=source.normalized.indexOf(code);check(start>=0,'normalized_code_missing');const covered=new Uint8Array(code.length);
    for(const range of ranges){const first=Math.max(start,range.start)-start,last=Math.min(start+code.length,range.end)-start;for(let i=Math.max(0,first);i<last;i++)covered[i]=1;}
    const missing=code.split('').filter((char,index)=>!covered[index]&&!/\s/.test(char)).length;
    check(missing===0,'engine_chunks_missing_code_characters');
    return{codeSha256:hash(code),codeBytes:Buffer.byteLength(code),retrievedNonWhitespaceCoverage:true,allCharactersCovered:covered.every(Boolean)};
  });
  return{normalizedSha256:hash(source.normalized),upstreamSourceSha256:hash(bytes),upstreamSourceBytes:bytes.length,sourceAndStoredFenceHashesEqual:true,blocks:coverage};
}
async function main() {
  await step('isolation_and_real_source_seed',async()=>{
    check(process.env.RELAY_E2E_ISOLATED==='1'&&process.platform==='linux'&&/^[a-z0-9-]{1,80}$/.test(runId),'isolation_guard');
    check(resolve(process.cwd())===repo&&await realpath(repo)===repo&&resolve(fileURLToPath(import.meta.url))===repo+'/scripts/knowledge-chm-live-e2e.ts','repository_guard');
    for(const path of [root+'/bulk/knowledge.db',data+'/knowledge.db',data+'/app.db',data+'/e2e-admin.jwt',data+'/e2e-foreign.jwt'])check(await realpath(path)===path&&!(await lstat(path)).isSymbolicLink(),'file_identity_guard');
    token=(await readFile(data+'/e2e-admin.jwt','utf8')).trim(); foreignToken=(await readFile(data+'/e2e-foreign.jwt','utf8')).trim();check(token&&foreignToken&&!/\s/.test(token+foreignToken),'token_file_invalid');safe=true;
    await get('api_health','/api/health');check((await get('active_provider','/api/knowledge/integrations/product-provider')).provider==='weknora','existing_engine_provider_required');
    const engine=await get('engine_ready','/api/knowledge/engine');check(engine.phase==='ready'&&engine.reachable&&engine.wikiReady,'engine_not_ready');
    process.env.DB_PATH=data+'/app.db';process.env.KNOWLEDGE_DB_PATH=data+'/knowledge.db';process.env.KNOWLEDGE_ENGINE_HOME=root+'/runtime/knowledge-engine';
    const [{default:Database},{createKnowledgeStore}]=await Promise.all([import('better-sqlite3'),import('../src/knowledge/store.ts')]);
    bulk=new Database(root+'/bulk/knowledge.db',{readonly:true,fileMustExist:true});store=createKnowledgeStore({dbPath:data+'/knowledge.db',appDbPath:data+'/app.db'});
    check(bulk.prepare('SELECT count(*) n FROM knowledge_provider_configs').get().n===0,'bulk_has_provider_config');
    const engineDatabase=root+'/runtime/knowledge-engine/data/weknora.db';check(await realpath(engineDatabase)===engineDatabase,'engine_database_identity_guard');engineDb=new Database(engineDatabase,{readonly:true,fileMustExist:true});
    const seed=row(JSON.parse(await readFile(data+'/nonprod-seed-manifest.json','utf8')));check(rows(seed.documents).length===5,'original_five_manifest_missing');
    baseline=rows(seed.documents).map(d=>({id:d.id}));baseline=preservedFive();
    sourceRows=fixtures.map(f=>{const document=bulk.prepare('SELECT * FROM knowledge_documents WHERE id=?').get(f.id), product=bulk.prepare('SELECT * FROM knowledge_product_documents WHERE id=?').get(f.id);check(document&&product&&document.title===f.title&&document.source_sha256===f.raw&&hash(document.body)===f.body,'pinned_chm_source_mismatch');check(parse(product.metadata_json).sourceFormat==='innovasys-html'&&product.source_path.includes('.chm.expanded-')&&product.version==='21.1','source_is_not_true_chm');return{document,product};});
    const {normalizeProductContent}=await import('../src/knowledge/weknora-ingest.ts');
    for(const source of sourceRows){
      source.normalized=normalizeProductContent(source.document.body);source.codeBlocks=codeBlocks(source.document.body);
      check(source.codeBlocks.length===2,'expected_real_code_blocks_missing');
      check(JSON.stringify(source.codeBlocks.map(hash))===JSON.stringify(codeBlocks(source.normalized).map(hash)),'normalization_code_hash_mismatch');
    }
    report.normalization=sourceRows.map(source=>({id:source.document.id,parserVersion,sourceBodySha256:hash(source.document.body),normalizedSha256:hash(source.normalized),sourceCodeSha256:source.codeBlocks.map(hash),normalizedCodeSha256:codeBlocks(source.normalized).map(hash),codeBytes:source.codeBlocks.reduce((n:number,s:string)=>n+Buffer.byteLength(s),0)}));
    store.db.transaction(()=>{for(const {document:d,product:p} of sourceRows){
      const existing=store.db.prepare('SELECT body,project_id,environment,source_sha256 FROM knowledge_documents WHERE id=?').get(d.id);
      if(existing){check(hash(existing.body)===hash(d.body)&&existing.project_id===projectId&&existing.environment===environment&&existing.source_sha256===d.source_sha256,'existing_seed_collision');continue;}
      store.upsertDocument({id:d.id,kind:'product_document',title:d.title,body:d.body,lifecycle:d.lifecycle,projectId,projectNameSnapshot:d.project_name_snapshot??undefined,sampleManagerVersion:d.samplemanager_version,solution:d.solution??undefined,module:d.module??undefined,environment,locator:d.source_locator,commit:d.source_commit??undefined,sha256:d.source_sha256,createdAt:d.created_at,updatedAt:d.updated_at,scopeType:'environment',scopeKey:environment,visibility:'project',sourceProjectId:projectId,redactionStatus:'unredacted'});
      if(p.revision_id){const revision=bulk.prepare('SELECT * FROM knowledge_product_revisions WHERE id=?').get(p.revision_id);check(revision,'source_revision_missing');const cols=Object.keys(revision);store.db.prepare(`INSERT OR IGNORE INTO knowledge_product_revisions(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map(k=>revision[k]));}
      const cols=Object.keys(p);store.db.prepare(`INSERT INTO knowledge_product_documents(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map(k=>p[k]));
    }})();
    const proofs=fixtures.map(f=>canonicalProof(f.id));for(const proof of proofs){const p=sourceById(proof.id)!.product;check(proof.sectionsSha256===hash(p.sections_json)&&proof.anchorCount>0&&proof.sourceFormat===parse(p.metadata_json).sourceFormat&&proof.containerFormat==='chm','source_structure_changed');}
    report.sources=proofs;return{sourceDatabaseReadOnly:true,containerFormat:'chm',sourceFormat:'innovasys-html',documents:proofs,existingFiveCount:baseline.length,enginePhase:engine.phase};
  });
  await step('withdraw_superseded_parser_mappings',async()=>{
    const prior=[{id:'weknora-ba05d9ff-f354-400c-a89f-b939cb5a216f',external:'d1cbe811-bef4-472d-8343-c355d23c81a4',fixture:fixtures[0]},{id:'weknora-e88d768e-afc1-434f-8e77-7e7233040e69',external:'a05fbbd7-969c-4ef5-b337-df22a138d29a',fixture:fixtures[1]}];
    const proofs=[];for(const item of prior){
      const previous=store.db.prepare('SELECT id,status,project_id,environment,raw_sha256,external_document_id FROM knowledge_weknora_documents WHERE id=?').get(item.id);
      check(previous&&previous.project_id===projectId&&previous.environment===environment&&previous.raw_sha256===item.fixture.raw&&previous.external_document_id===item.external,'superseded_mapping_identity_mismatch');
      if(previous.status!=='deprecated'){
        const result=row((await post('deprecate_superseded_mapping','/api/knowledge/weknora/documents/'+encodeURIComponent(previous.id)+'/deprecate')).document);
        check(result.status==='deprecated','superseded_mapping_not_withdrawn');
      }
      proofs.push({id:previous.id,externalDocumentId:previous.external_document_id,status:'deprecated'});
    }
    return{mappings:proofs,reason:'Replace the prior parser revision after fenced-code loss; immutable source and prior migration history remain unchanged.'};
  });
  await step('real_http_stage_and_publish',async()=>{
    migration=await migrate();check(['staged','published'].includes(migration.status)&&Number(migration.report?.mapped)===2&&Number(migration.report?.failed)===0,'migration_not_ready');
    const manifest=rows(migration.sourceManifest?.documents);check(manifest.length===2&&manifest.every(d=>{const f=fixtures.find(f=>f.id===d.localDocumentId);return f&&d.bodySha256===f.body&&d.sourceSha256===f.raw&&d.projectId===projectId&&d.environment===environment&&d.productVersion==='21.1';}),'migration_source_manifest_mismatch');
    if(migration.status!=='published')migration=row((await post('publish_chm_migration','/api/knowledge/migrations/'+encodeURIComponent(migration.id)+'/publish')).migration);
    check(migration.status==='published','publication_failed');
    mappings=rows((await get('published_chm_mappings','/api/knowledge/weknora/documents',{...scope(),status:'published',limit:200})).documents).filter(m=>rows(migration.report?.documents).some(d=>d.documentId===m.id));
    check(mappings.length===2&&mappings.every(m=>(m.upstreamParseStatus??m.upstream_parse_status)==='completed'&&parse(m.externalChunkIds??m.external_chunk_ids_json).length>0&&m.parser_version===parserVersion&&!['d1cbe811-bef4-472d-8343-c355d23c81a4','a05fbbd7-969c-4ef5-b337-df22a138d29a'].includes(m.external_document_id)),'verified_new_parser_mapping_missing');
    const proof=mappings.map(m=>({id:m.id,externalDocumentId:m.externalDocumentId??m.external_document_id,chunkIds:parse(m.externalChunkIds??m.external_chunk_ids_json),parseStatus:m.upstreamParseStatus??m.upstream_parse_status,model:parse(m.modelProvenance??m.model_provenance_json)}));
    return{migrationId:migration.id,status:migration.status,mappings:proof};
  });
  await step('real_queries_and_engine_reads',async()=>{
    const results=[];for(const f of fixtures){
      const response=await get('chm_product_search','/api/knowledge/product-documents/search',{...scope(),sampleManagerVersion:'21.1',q:f.title,limit:10});
      const products=rows(response.results);check(products.some(p=>p.id===f.id),'expected_chm_search_hit_missing');
      const found=products.filter(p=>fixtures.some(f=>f.id===p.id));results.push({query:f.title,hitCount:products.length,documents:found.map(validateProduct)});
      const read=row((await get('chm_engine_content','/api/knowledge/product-documents/'+encodeURIComponent(f.id),scope())).document);const proof=validateProduct(read);check(String(read.body??'').includes(f.title)&&String(read.body).length>100,'real_chm_engine_body_missing');
      const integrity=await codeIntegrityProof(sourceById(f.id)!,read);results.push({operation:'read',...proof,bodySha256:hash(read.body),bodyBytes:Buffer.byteLength(read.body),codeIntegrity:integrity});
    }return{results};
  });
  await step('migration_idempotency_and_scope',async()=>{
    const snapshot=()=>store.db.prepare('SELECT id,external_document_id,external_chunk_ids_json,normalized_content_sha256 FROM knowledge_weknora_documents WHERE project_id=? AND environment=? ORDER BY id').all(projectId,environment);
    const before=snapshot();const again=await migrate();check(again.id===migration.id&&again.status==='published','migration_idempotency_mismatch');check(JSON.stringify(before)===JSON.stringify(snapshot()),'mapping_or_chunk_ids_changed');
    const other=await get('other_environment_search','/api/knowledge/product-documents/search',{projectId,environment:'nonprod',sampleManagerVersion:'21.1',q:'GET_TABLE_DETAILS',limit:20});check(!rows(other.results).some(p=>fixtures.some(f=>f.id===p.id)),'environment_isolation_failed');
    await request('foreign_project_read','GET','/api/knowledge/product-documents/'+encodeURIComponent(fixtures[0].id),{query:scope(),foreign:true,expected:[403,404]});
    check((await get('provider_still_engine','/api/knowledge/integrations/product-provider')).provider==='weknora','product_provider_changed');
    check(JSON.stringify(baseline)===JSON.stringify(preservedFive()),'original_five_samples_changed');
    for(const source of sourceRows){const proof=canonicalProof(source.document.id);check(proof.bodySha256===hash(source.document.body)&&proof.sectionsSha256===hash(source.product.sections_json),'canonical_source_changed');}
    return{sameMigrationId:true,stableExternalDocumentAndChunkIds:true,environmentIsolated:true,foreignActorDenied:true,originalFivePreserved:true,provider:'weknora'};
  });
  report.status='passed_real_chm_engine_ingest_search_code_integrity_idempotency';
}
try{await main();}catch(error){report.status='failed';report.failureCode=error instanceof Failure?error.code:'driver_error';process.exitCode=1;}
finally{try{store?.close();bulk?.close();engineDb?.close();}finally{report.finishedAt=new Date().toISOString();await save();console.log(`[chm-e2e] ${report.status}${report.failureCode?': '+report.failureCode:''}`);}}