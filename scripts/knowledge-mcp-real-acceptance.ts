/** Bounded #53 evidence driver. No provider/profile changes, source writes or model searches.
 * Default mode only plans. Execution requires the operator's deployment-window flag.
 */
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync, statSync, openSync, readSync, closeSync, existsSync, type Stats } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type Row=Record<string,any>;
const ROOT="/home/ftd/relay-knowledge-engine-nonprod";
const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
function check(value:unknown,code:string):asserts value {if(!value)throw new Error(code);}
export function scanPrivateText(text:string,forbidden:string[]):{bytes:number;sha256:string}{
  for(const value of forbidden.filter(v=>v.length>=8)){
    for(const variant of new Set([value,JSON.stringify(value).slice(1,-1),encodeURIComponent(value),new URLSearchParams({q:value}).toString().slice(2)]))
      check(!text.includes(variant),"privacy_content_detected");
  }
  return {bytes:Buffer.byteLength(text),sha256:hash(text)};
}
const ENVELOPE_KEYS=new Set(["schemaVersion","queryHash","queryLength","queryBytes","resultCount","latencyMs","degraded","degradedReasons","productProvider","embeddingModelId","rerankModelId","results"]);
const RESULT_KEYS=new Set(["id","kind","rank","score","lifecycle","versionMatch","applicability","scope","evidenceRefs","externalDocumentId","chunkId","upstreamRetrievalRunId","sourceSha256"]);
function noContent(value:unknown):void {
  if(!value||typeof value!=="object")return;
  for(const [key,child] of Object.entries(value)){
    check(!/^(query|queryTokens|body|snippet|summary|title|text|prompt|response|content|arguments)$/i.test(key),"retrieval_content_field");
    noContent(child);
  }
}
export function verifyRetrievalRows(rows:Row[],expected:Array<{id:string;query:string}>):Row[]{
  return expected.map(({id,query})=>{
    const row=rows.find(r=>r.id===id);check(row,"retrieval_row_missing");
    check(row.query==="sha256:"+hash(query),"retrieval_query_not_digest");
    const metadata=JSON.parse(row.results_json);check(metadata.schemaVersion===1&&metadata.queryHash===hash(query),"retrieval_metadata_invalid");
    check(metadata.queryLength===[...query].length&&metadata.queryBytes===Buffer.byteLength(query),"retrieval_length_invalid");
    noContent(metadata);check(Object.keys(metadata).every(k=>ENVELOPE_KEYS.has(k)),"retrieval_extra_metadata");
    check(Array.isArray(metadata.results)&&metadata.results.every((r:Row)=>Object.keys(r).every(k=>RESULT_KEYS.has(k))),"retrieval_extra_result");
    check(metadata.resultCount===metadata.results.length,"retrieval_count_invalid");
    scanPrivateText(row.results_json,[query]);
    return {id,queryHash:hash(query),resultCount:metadata.resultCount};
  });
}
export function freezePublishedSources(db:Database.Database,projectId:string,environments:string[],kbId:string):Row[]{
  check(environments.length>0&&environments.length<=10,"invalid_source_scope");
  const rows=db.prepare(`SELECT DISTINCT md.local_document_id,w.id,w.external_document_id,w.external_chunk_ids_json,
    w.raw_sha256,w.normalized_content_sha256,w.parser_version,w.product_version,w.source_path,w.project_id,w.environment,
    w.model_provenance_json,w.topic_id,w.solution,w.module,w.language
    FROM knowledge_weknora_documents w JOIN knowledge_migration_documents md ON md.document_id=w.id
    JOIN knowledge_migrations m ON m.id=md.migration_id
    WHERE w.status='published' AND w.upstream_verified_at IS NOT NULL AND w.upstream_verified_at<>''
      AND md.status='published' AND m.status='published' AND w.external_knowledge_base_id=?
      AND w.project_id=? AND w.environment IN (${environments.map(()=>"?").join(",")})
    ORDER BY md.local_document_id,w.id`).all(kbId,projectId,...environments) as Row[];
  return rows.map(r=>{
    const chunks=JSON.parse(r.external_chunk_ids_json),model=JSON.parse(r.model_provenance_json);
    check(Array.isArray(chunks)&&chunks.length>0&&chunks.every(c=>typeof c==="string"),"source_chunk_proof_missing");
    return {localId:r.local_document_id,mappingId:r.id,externalId:r.external_document_id,chunkIds:chunks,
      rawSha256:r.raw_sha256,normalizedSha256:r.normalized_content_sha256,parserVersion:r.parser_version,
      productVersion:r.product_version,sourcePath:r.source_path,projectId:r.project_id,environment:r.environment,
      topicId:r.topic_id,solution:r.solution,module:r.module,language:r.language,
      model:{providerId:model.providerId,modelId:model.modelId,dimensions:model.dimensions,indexVersion:model.indexVersion}};
  });
}
function withinRoot(path:string,existing=true):string {
  const absolute=resolve(path),real=existing?realpathSync(absolute):resolve(realpathSync(dirname(absolute)),absolute.split(/[\\/]/).pop()!);
  const rel=relative(realpathSync(ROOT),real);check(rel!==""&&!rel.startsWith("..")&&!isAbsolute(rel),"path_outside_isolation");return real;
}
function args(argv:string[]):Map<string,string[]> {
  const result=new Map<string,string[]>();
  for(let i=0;i<argv.length;i+=2){check(/^--[a-z-]+$/.test(argv[i])&&typeof argv[i+1]==="string"&&!argv[i+1].startsWith("--"),"invalid_arguments");result.set(argv[i],[...(result.get(argv[i])??[]),argv[i+1]]);}
  return result;
}
function fileDelta(path:string,before:Stats):string {
  const after=statSync(path);check(before.dev===after.dev&&before.ino===after.ino&&after.size>=before.size,"log_rotated_or_truncated");
  const length=after.size-before.size;check(length<=16*1024*1024,"log_window_too_large");
  const bytes=Buffer.alloc(length),fd=openSync(path,"r");try{check(readSync(fd,bytes,0,length,before.size)===length,"log_read_incomplete");}finally{closeSync(fd);}return bytes.toString("utf8");
}
async function main():Promise<void>{
  check(process.platform==="linux"&&process.env.RELAY_E2E_ISOLATED==="1"&&realpathSync(process.cwd())===ROOT+"/relay","isolated_nonproduction_required");
  const options=args(process.argv.slice(2)),get=(name:string,fallback?:string)=>options.get(name)?.[0]??fallback;
  const mode=get("--mode","plan");check(mode==="plan"||mode==="run","invalid_mode");
  if(mode==="run")check(process.env.RELAY_MCP_ACCEPTANCE_EXECUTE==="1","deployment_window_required");
  const runId=get("--run-id","mcp-contract-"+randomUUID())!;check(/^[a-zA-Z0-9._-]{1,100}$/.test(runId),"invalid_run_id");
  const output=withinRoot(get("--out",ROOT+"/runtime/"+runId+".json")!,false);check(!existsSync(output),"report_already_exists");
  const dbPath=withinRoot(get("--db",ROOT+"/relay/data/knowledge.db")!);
  const controlPath=withinRoot(get("--control",ROOT+"/runtime/knowledge-engine/control.json")!);
  const controlRaw=readFileSync(controlPath,"utf8"),control=JSON.parse(controlRaw);check(typeof control.knowledgeBaseId==="string","active_kb_missing");
  const token=readFileSync(withinRoot(get("--admin-token",ROOT+"/relay/data/e2e-admin.jwt")!),"utf8").trim();
  const foreignToken=readFileSync(withinRoot(get("--foreign-token",ROOT+"/relay/data/e2e-foreign.jwt")!),"utf8").trim();
  const actor=JSON.parse(Buffer.from(token.split(".")[1],"base64url").toString("utf8"));
  const projectId=String(actor.defaultProjectId??""),environment=String(actor.defaultEnvironment??"");check(projectId&&environment,"token_scope_missing");
  const environments=options.get("--source-environment")??[environment,"nonprod-chm-acceptance"];
  const db=new Database(dbPath,{readonly:true,fileMustExist:true});db.pragma("query_only = ON");
  const report:Row={schemaVersion:1,runId,mode,status:"planned",startedAt:new Date().toISOString(),checks:[],limits:["Zero paid-model path; local deterministic embedding/ranking may run.","No source/model/profile/publication changes. Existing HTTP/MCP telemetry is produced normally.","No live semantic retrieval quality, positive Solution claim, or upstream fault-response success is asserted.","Fault proxy matrix is not executed by this driver; old logs and historical rows remain untouched."]};
  let admin:Client|undefined,foreign:Client|undefined;
  try{
    const sources=freezePublishedSources(db,projectId,environments,control.knowledgeBaseId);check(sources.length>=1&&sources.length<=20,"source_set_not_bounded");
    const expectedCount=Number(get("--expected-source-count","7"));check(Number.isInteger(expectedCount)&&expectedCount>0&&sources.length===expectedCount,"source_count_differs_from_expected");
    report.sourceFreeze={sha256:hash(JSON.stringify(sources)),knowledgeBaseHash:hash(control.knowledgeBaseId),sources};
    const countCalls=()=>Number((db.prepare("SELECT COUNT(*) n FROM knowledge_provider_admissions").get() as Row).n);
    const callsBefore=countCalls();report.providerAdmissionBefore=callsBefore;
    if(mode==="plan")return;
    check(!(db.prepare("SELECT 1 FROM knowledge_ingest_jobs WHERE status='running' LIMIT 1").get()),"active_ingest_prevents_call_attribution");
    const logPaths=(options.get("--log")??[]).map(p=>withinRoot(p));check(logPaths.length>=1,"request_log_required");
    const auditPath=withinRoot(get("--mcp-audit",ROOT+"/relay/data/state/audit.jsonl")!);
    const offsets=new Map([...new Set([...logPaths,auditPath])].map(p=>[p,statSync(p)]));
    const auditRowid=Number((db.prepare("SELECT COALESCE(MAX(rowid),0) n FROM knowledge_audit").get() as Row).n);
    const retrievalRowid=Number((db.prepare("SELECT COALESCE(MAX(rowid),0) n FROM knowledge_retrieval_runs").get() as Row).n);
    const unique=randomUUID().replaceAll("-",""),sentinel="REL53QUERY"+unique,header="REL53HEADER"+unique,body="REL53BODY"+unique;
    const forbidden=[sentinel,header,body,body.slice(0,24),token,foreignToken,...(typeof control.apiKey==="string"?[control.apiKey]:[])];
    const expected:Array<{id:string;query:string}>=[];
    const http=async(path:string,credential=token,init:RequestInit={}):Promise<{status:number;value:any}>=>{
      const response=await fetch("http://127.0.0.1:18300"+path,{...init,headers:{authorization:"Bearer "+credential,"x-relay-privacy-sentinel":header,...init.headers},signal:AbortSignal.timeout(30000),redirect:"error"});
      const text=await response.text();let value:any;try{value=JSON.parse(text);}catch{throw new Error("http_response_not_json");}return {status:response.status,value};
    };
    const health=await http("/api/health");check(health.status===200,"http_not_healthy");
    const connect=async(credential:string)=>{const client=new Client({name:"relay-private-contract-acceptance",version:"1.0.0"});await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:18301/mcp"),{requestInit:{headers:{authorization:"Bearer "+credential}}}));return client;};
    admin=await connect(token);foreign=await connect(foreignToken);
    const catalog=(await admin.listTools()).tools.map(t=>t.name),tool=(name:string)=>{const result=catalog.find(n=>n===name||n.endsWith("_"+name));check(result,"tool_missing");return result;};
    const call=async(client:Client,name:string,input:Row,denied:boolean|string=false):Promise<Row>=>{
      const response:any=await client.callTool({name:tool(name),arguments:input},undefined,{timeout:30000});
      if(denied){check(response.isError===true,"mcp_denial_missing");if(typeof denied==="string")check(new RegExp(denied,"i").test(JSON.stringify(response.content)),"mcp_denial_reason_mismatch");return {};}
      check(!response.isError,"mcp_tool_failed");const value=response.content.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n");try{return JSON.parse(value);}catch{throw new Error("mcp_response_not_json");}
    };
    // Explicit kinds disables Product retrieval. The default Relay providers
    // here are deterministic local implementations; no managed provider call.
    const memories=db.prepare("SELECT id,title FROM knowledge_documents WHERE project_id=? AND (environment IS NULL OR environment=?) AND kind='case' AND lifecycle IN ('verified','approved') ORDER BY id").all(projectId,environment) as Row[];
    check(memories.length>0,"confirmed_memory_required");
    const term=String(memories[0].title).match(/[A-Za-z0-9_]{3,}/)?.[0];check(term,"memory_search_term_missing");
    const httpQuery=term+" "+sentinel;
    const search=await http("/api/knowledge/search?"+new URLSearchParams({projectId,environment,kinds:"case",q:httpQuery,limit:"100"}));
    check(search.status===200&&search.value.query===httpQuery&&Array.isArray(search.value.results)&&search.value.results.some((r:Row)=>r.id===memories[0].id),"http_local_search_unusable");
    expected.push({id:search.value.retrievalRunId,query:httpQuery});
    for(const row of search.value.results)if(typeof row.summary==="string"&&row.summary.length>=40)forbidden.push(row.summary.slice(0,80));
    report.checks.push({name:"http_local_search",status:"passed",retrievalRunId:search.value.retrievalRunId,resultCount:search.value.results.length,matchedMemoryId:memories[0].id});
    // A random absent version gives the real MCP handler an empty Product
    // allowlist without switching the active provider or mutating its profile.
    const absentVersion="acceptance-absent-"+unique;
    check(!db.prepare("SELECT 1 FROM knowledge_weknora_documents WHERE product_version=? LIMIT 1").get(absentVersion),"empty_product_scope_not_empty");
    const mcpQuery="REL53MCP"+unique;forbidden.push(mcpQuery);
    const mcp=await call(admin,"knowledge_search",{project:actor.defaultProject,query:mcpQuery,sampleManagerVersion:absentVersion,environment,limit:10});
    check(mcp.query===mcpQuery&&Array.isArray(mcp.results)&&mcp.results.every((r:Row)=>r.kind!=="product_document"),"mcp_local_search_unusable");
    expected.push({id:mcp.retrievalRunId,query:mcpQuery});
    report.checks.push({name:"mcp_empty_product_scope_search",status:"passed",retrievalRunId:mcp.retrievalRunId,resultCount:mcp.results.length});
    const sourceQuery='"REL53SOURCE'+unique+'"';forbidden.push(sourceQuery,sourceQuery.slice(1,-1));
    // Source search requires a published baseline/snapshot. Do not invent one
    // merely to test logging: exercise the explicit missing-scope rejection.
    await call(admin,"knowledge_source_search",{query:sourceQuery,limit:1},"baselineId or projectSnapshotId is required");
    report.checks.push({name:"mcp_source_unscoped_request_denied",status:"passed",reason:"baseline_or_snapshot_required"});
    check((await http("/api/unknown-privacy-path?q="+encodeURIComponent(sentinel))).status===404,"http_404_contract_failed");
    const malformed=await http("/api/knowledge/weknora/search",token,{method:"POST",headers:{"content-type":"application/json"},body:'{"query":"'+body+'", "invalid":'});
    check(malformed.status===400,"malformed_json_not_rejected");
    for(const source of sources){
      const path="/api/knowledge/product-docs/"+encodeURIComponent(source.localId);
      const query=new URLSearchParams({projectId:source.projectId,environment:source.environment});
      const fetched=await http(path+"?"+query);const doc=fetched.value.document??fetched.value;
      check(fetched.status===200&&doc.provider==="weknora"&&doc.sourceSha256===source.rawSha256&&String(doc.version??doc.sampleManagerVersion)===String(source.productVersion)&&Array.isArray(doc.citations)&&doc.citations.length>0,"published_source_read_invalid");
      check(doc.citations.every((c:Row)=>c.sourceSha256===source.rawSha256&&(!c.chunkId||source.chunkIds.includes(c.chunkId))),"published_source_citation_invalid");
      const denied=await http(path+"?"+query,foreignToken);check([403,404].includes(denied.status),"foreign_source_read_allowed");
      const other=await http(path+"?"+new URLSearchParams({projectId:source.projectId,environment:"acceptance-foreign-"+unique}));check([403,404].includes(other.status),"foreign_environment_read_allowed");
      // MCP only exposes the caller's default environment; CHM's separate
      // environment is checked via HTTP, not impersonated with invented claims.
      if(source.environment===environment){const value=await call(admin,"knowledge_get",{documentId:source.localId});const d=value.document??value;check(d.provider==="weknora"&&d.sourceSha256===source.rawSha256,"mcp_source_read_invalid");await call(foreign,"knowledge_get",{documentId:source.localId},"access denied|not found|published");}
      report.checks.push({name:"published_source_scope_read",status:"passed",localId:source.localId,environment:source.environment,sourceSha256:source.rawSha256,bodySha256:typeof doc.body==="string"?hash(doc.body):null,citations:doc.citations.length,foreignActorDenied:true,foreignEnvironmentDenied:true,mcpDefaultEnvironment:source.environment===environment});
    }
    const hidden=db.prepare(`SELECT id,status FROM knowledge_weknora_documents WHERE external_knowledge_base_id=? AND project_id=? AND environment IN (${environments.map(()=>"?").join(",")}) AND status IN ('staged','deprecated','failed') ORDER BY id LIMIT 3`).all(control.knowledgeBaseId,projectId,...environments) as Row[];
    check(hidden.length>0,"nonpublished_scope_fixture_missing");
    for(const source of hidden){
      const denied=await http("/api/knowledge/product-docs/"+encodeURIComponent(source.id)+"?"+new URLSearchParams({projectId,environment}));
      check([403,404].includes(denied.status),"nonpublished_source_read_allowed");
      await call(admin,"knowledge_get",{documentId:source.id},"access denied|not found|published");
      report.checks.push({name:"nonpublished_source_denied",status:"passed",mappingId:source.id,publicationState:source.status});
    }
    const rows=db.prepare("SELECT id,query,results_json FROM knowledge_retrieval_runs WHERE rowid>?").all(retrievalRowid) as Row[];
    report.retrievalRows=verifyRetrievalRows(rows,expected);scanPrivateText(JSON.stringify(rows),forbidden);
    const audits=db.prepare("SELECT entity_id,action,details_json FROM knowledge_audit WHERE rowid>?").all(auditRowid) as Row[];
    scanPrivateText(JSON.stringify(audits),forbidden);
    for(const item of expected){const row=audits.find(r=>r.action==="knowledge.search"&&r.entity_id===item.id);check(row,"retrieval_audit_missing");const detail=JSON.parse(row.details_json);noContent(detail);check(detail.queryHash===hash(item.query),"retrieval_audit_hash_missing");}
    const auditDelta=fileDelta(auditPath,offsets.get(auditPath)!);scanPrivateText(auditDelta,forbidden);
    const auditEvents=auditDelta.split("\n").filter(Boolean).map(line=>JSON.parse(line));
    const mcpAudited=auditEvents.find(e=>e.event==="tool_called"&&e.tool===tool("knowledge_search")&&e.arguments?.queryHash===hash(mcpQuery));
    check(mcpAudited&&mcpAudited.arguments.schemaVersion===1,"mcp_metadata_audit_missing");noContent(mcpAudited.arguments);
    const sourceAudited=auditEvents.find(e=>e.event==="tool_called"&&e.tool===tool("knowledge_source_search")&&e.arguments?.queryHash===hash(sourceQuery));
    check(sourceAudited&&sourceAudited.arguments.queryLength===[...sourceQuery].length,"mcp_source_metadata_audit_missing");noContent(sourceAudited.arguments);
    report.logWindows=logPaths.map(path=>{const delta=fileDelta(path,offsets.get(path)!);return {path:relative(ROOT,path),...scanPrivateText(delta,forbidden)};});
    check(report.logWindows[0].bytes>0,"request_log_window_empty");
    report.mcpAuditWindow={path:relative(ROOT,auditPath),...scanPrivateText(auditDelta,forbidden),toolCalls:auditEvents.filter(e=>e.event==="tool_called").length};
    report.auditRows=audits.length;report.providerAdmissionAfter=countCalls();
    check(report.providerAdmissionAfter===callsBefore,"provider_calls_changed_during_zero_model_run");
    check(hash(readFileSync(controlPath))===hash(controlRaw),"engine_control_changed_during_run");
    check(hash(JSON.stringify(freezePublishedSources(db,projectId,environments,control.knowledgeBaseId)))===report.sourceFreeze.sha256,"source_freeze_changed_during_run");
    report.status="passed_zero_model_privacy_and_scope";
  }catch(error){report.status="failed";report.failureCode=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:"acceptance_failed";process.exitCode=1;}
  finally{
    await admin?.close().catch(()=>{});await foreign?.close().catch(()=>{});db.close();report.finishedAt=new Date().toISOString();
    writeFileSync(output,JSON.stringify(report,null,2)+"\n",{mode:0o600,flag:"wx"});
    console.log(JSON.stringify({runId,status:report.status,checks:report.checks.length,report:output,...(report.failureCode?{failureCode:report.failureCode}:{})}));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error("acceptance_preflight_failed");process.exitCode=1;});
