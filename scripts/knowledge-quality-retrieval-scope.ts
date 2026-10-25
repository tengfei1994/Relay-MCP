import type Database from 'better-sqlite3';
import {nullable,parseReferences,sha,text,type Row,type Source} from './knowledge-quality-common.js';

export interface RetrievalScope {migrationId:string;operationKey:string;knowledgeBaseId:string;providerId:string;modelId:string;indexVersion:number;dimensions:number;engineModelId:string;modelAlias:string;parserVersion:string;providerStatus:'ready'|'pending_reindex';}
export interface Binding {row:Row;chunks:Set<string>;localId:string;}
export function expectedModel(scope:RetrievalScope){return {knowledgeBaseId:scope.knowledgeBaseId,providerId:scope.providerId,modelId:scope.modelId,indexVersion:scope.indexVersion,dimensions:scope.dimensions};}
function parsed(value:unknown):Row {try{const result=JSON.parse(text(value));return result&&typeof result==='object'&&!Array.isArray(result)?result:{};}catch{return {};}}
function equals(a:Row,b:Row){return Object.keys(a).length===Object.keys(b).length&&Object.entries(b).every(([key,value])=>a[key]===value);}
/** The corpus proof is always migration-specific. The optional inspection view
 * permits other current-model sources only as unjudged hits, never as corpus coverage. */
export function selectRetrievalBindings(db:Database.Database,sources:Source[],scope:RetrievalScope,normalized:Map<string,string>,inspectionOnly=false){
 const byId=new Map(sources.map(s=>[s.id,s])),found=new Map<string,Binding>(),conflicts=new Set<string>();
 const rows=db.prepare("SELECT w.*,md.local_document_id,md.content_sha256 AS migration_content_sha256,md.external_document_id AS migration_external_id,md.parser_version AS migration_parser FROM knowledge_weknora_documents w JOIN knowledge_migration_documents md ON md.document_id=w.id JOIN knowledge_migrations m ON m.id=md.migration_id WHERE w.status='published' AND md.status='published' AND m.status='published' AND w.external_knowledge_base_id=? AND (?='' OR md.migration_id=?) AND w.upstream_verified_at IS NOT NULL AND w.upstream_verified_at<>'' AND w.upstream_parse_status='completed'").all(scope.knowledgeBaseId,inspectionOnly?'':scope.migrationId,inspectionOnly?'':scope.migrationId) as Row[];
 for(const row of rows){const id=text(row.local_document_id),source=byId.get(id);if(!source)continue;const refs=parseReferences(row.external_chunk_ids_json);
  if(row.raw_sha256!==source.sourceSha256||nullable(row.project_id)!==source.projectId||nullable(row.environment)!==source.environment||nullable(row.product_version)!==source.version||row.source_path!==source.sourcePath||refs.malformed||!refs.values.length||!equals(parsed(row.model_provenance_json),expectedModel(scope)))continue;
  if(row.migration_external_id!==row.external_document_id||row.migration_content_sha256!==row.normalized_content_sha256||row.migration_parser!==row.parser_version)continue;
  if(!inspectionOnly&&(!normalized.has(id)||row.normalized_content_sha256!==normalized.get(id)||row.parser_version!==scope.parserVersion))continue;
  if(found.has(id)&&found.get(id)!.row.external_document_id!==row.external_document_id)conflicts.add(id);
  found.set(id,{row,chunks:new Set(refs.values),localId:id});
 }
 for(const id of conflicts)found.delete(id);
 const missing=sources.filter(s=>!found.has(s.id)).map(s=>s.id),modelHashes=found.size?[sha(JSON.stringify(expectedModel(scope)))]:[];
 const fingerprint=sha(JSON.stringify({scope,inspectionOnly,bindings:[...found].map(([id,b])=>[id,b.row.id,b.row.external_document_id,b.row.normalized_content_sha256,b.row.raw_sha256,b.row.parser_version,b.row.model_provenance_json,[...b.chunks].sort()]).sort(([a],[b])=>String(a).localeCompare(String(b)))}));
 return {found,missing,modelHashes,fingerprint};
}
export function retrievalReadiness(db:Database.Database,sources:Source[],scope:RetrievalScope,normalized:Map<string,string>,control:Row){
 const proof=selectRetrievalBindings(db,sources,scope,normalized),flags:string[]=[];
 const migration=db.prepare('SELECT kind,status,idempotency_key,source_manifest_json FROM knowledge_migrations WHERE id=?').get(scope.migrationId) as Row|undefined;
 if(!migration||migration.kind!=='product_knowledge'||migration.idempotency_key!==scope.operationKey||migration.status!=='published')flags.push('selected_migration_not_published');
 const frozen=parsed(migration?.source_manifest_json),documents=Array.isArray(frozen.documents)?frozen.documents as Row[]:[],byId=new Map(documents.map(d=>[text(d.localDocumentId),d]));
 if(frozen.parserVersion!==scope.parserVersion||documents.length!==sources.length||byId.size!==sources.length||sources.some(s=>{const d=byId.get(s.id);return !d||d.bodySha256!==s.bodySha256||d.sourceSha256!==s.sourceSha256||d.sourcePath!==s.sourcePath||nullable(d.productVersion)!==s.version||nullable(d.projectId)!==s.projectId||nullable(d.environment)!==s.environment||nullable(d.solution)!==s.solution||nullable(d.module)!==s.module||nullable(d.language)!==s.language;}))flags.push('selected_migration_source_snapshot_mismatch');
 const provider=db.prepare('SELECT status,model_id,dimensions,index_version,updated_at FROM knowledge_provider_configs WHERE id=?').get(scope.providerId) as Row|undefined;
 if(!provider||!['ready','pending_reindex'].includes(scope.providerStatus)||provider.status!==scope.providerStatus||provider.model_id!==scope.modelId||provider.dimensions!==scope.dimensions||provider.index_version!==scope.indexVersion)flags.push('provider_binding_not_ready');
 const route=db.prepare("SELECT value,migration_id FROM knowledge_integration_settings WHERE key='product_provider'").get() as Row|undefined;
 if(route?.value!=='weknora'||route.migration_id!==scope.migrationId)flags.push('selected_migration_not_active');
 const bindings=Array.isArray(control.bindings)?(control.bindings as Row[]).filter(b=>b.kind==='embedding'):[],binding=bindings[0];
 if(control.phase!=='ready'||control.knowledgeBaseId!==scope.knowledgeBaseId||bindings.length!==1||!binding||binding.providerId!==scope.providerId||binding.modelId!==scope.modelId||binding.indexVersion!==scope.indexVersion||binding.dimensions!==scope.dimensions||binding.engineModelId!==scope.engineModelId||binding.alias!==scope.modelAlias)flags.push('current_engine_binding_mismatch');
 if(proof.missing.length||proof.modelHashes.length!==1)flags.push('selected_corpus_not_published_verified');
 const controlIdentity={phase:control.phase,knowledgeBaseId:control.knowledgeBaseId,embedding:binding?{providerId:binding.providerId,modelId:binding.modelId,indexVersion:binding.indexVersion,dimensions:binding.dimensions,engineModelId:binding.engineModelId,alias:binding.alias}:null};
 return {...proof,ready:flags.length===0,flags,fingerprint:sha(JSON.stringify({proof:proof.fingerprint,provider,route,migration,control:controlIdentity}))};
}
