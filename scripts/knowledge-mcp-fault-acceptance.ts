/** Deterministic injected-fault evidence. All sockets are fresh loopback listeners;
 * all databases/credentials/documents are synthetic. Never loads server/index.ts,
 * mcp/index.ts, a managed runtime, a worker, or a real service database. */
import {createHash,randomBytes} from "node:crypto";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve,join,dirname} from "node:path";
import {createServer,type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const ALL_FAULTS=["timeout","rate_limited","unauthorized","invalid_json","invalid_ref"] as const;
type Fault=typeof ALL_FAULTS[number];
const option=(name:string)=>{const n=process.argv.indexOf(name);return n<0?undefined:process.argv[n+1];};
const faults=(option("--faults")?.split(",")??[...ALL_FAULTS]) as Fault[];
if(!faults.length||faults.some(f=>!ALL_FAULTS.includes(f))||new Set(faults).size!==faults.length)throw new Error("invalid_fault_selection");
const reportPath=resolve(option("--report")??join("runtime",`mcp53-injected-${Date.now()}.json`));
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
const root=mkdtempSync(join(tmpdir(),"relay-mcp53-faults-"));
let stage="setup",mode:Fault|"healthy"="healthy",logs="";
const secret="synthetic-api-"+randomBytes(18).toString("hex"),adminToken="synthetic-actor-"+randomBytes(18).toString("hex"),foreignToken="synthetic-foreign-"+randomBytes(18).toString("hex");
const privateQuery="private_query_"+randomBytes(12).toString("hex"),privateError="private_upstream_"+randomBytes(12).toString("hex"),privateBody="private_memory_"+randomBytes(12).toString("hex"),privateSnippet="private_excerpt_"+randomBytes(12).toString("hex");
const query="cache "+privateQuery;
const counts={faultHttp:0,relayHttp:0,mcpHttp:0};
const upstreamMetadata:Array<Record<string,unknown>>=[],traces:unknown[]=[],mcpAudit:unknown[]=[],errorResponses:string[]=[];
const report:any={schemaVersion:1,status:"running",injectedFaults:true,scope:"isolated synthetic databases and loopback HTTP; not cloud fault or semantic/model proof",startedAt:new Date().toISOString(),scenarios:[],counts,sourceHashes:Object.fromEntries(["scripts/knowledge-mcp-fault-acceptance.ts","src/knowledge/weknora.ts","src/knowledge/product-backend.ts","src/server/routes/knowledge.ts","src/mcp/tools/knowledge.ts","src/server/request-log.ts","src/shared/retrieval-audit.ts"].map(path=>[path,hash(readFileSync(path,"utf8"))]))};
const check=(condition:unknown,code:string)=>{if(!condition)throw new Error(code);};
const listen=(server:Server,port=0)=>new Promise<string>((yes,no)=>{server.once("error",no);server.listen(port,"127.0.0.1",()=>yes(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));});
const close=(server:Server)=>new Promise<void>(yes=>{server.closeAllConnections();server.close(()=>yes());});
const clients:Client[]=[];let app:any,store:any,appDb:any,mcpHttp:Server|undefined;
const faultHttp=createServer(async(req,res)=>{
 counts.faultHttp++;const requestMode=mode;let raw="";
 for await(const chunk of req){raw+=chunk;if(raw.length>16_384){res.writeHead(413).end();return;}}
 let body:any;try{body=JSON.parse(raw);}catch{res.writeHead(400).end();return;}
 const authValid=req.headers["x-api-key"]===secret,scopeValid=JSON.stringify(body.knowledge_ids)==='["ext-good"]'&&!body.knowledge_base_id&&!body.knowledge_base_ids;
 upstreamMetadata.push({mode:requestMode,method:req.method,path:req.url,syntheticCredentialValid:authValid,documentScopeValid:scopeValid});
 if(req.method!=="POST"||req.url!=="/api/v1/knowledge-search"||!authValid||!scopeValid){res.writeHead(400).end();return;}
 if(requestMode==="timeout")return;
 res.setHeader("content-type","application/json");
 if(requestMode==="rate_limited"){res.setHeader("retry-after","7");res.writeHead(429).end(JSON.stringify({error:privateError}));return;}
 if(requestMode==="unauthorized"){res.writeHead(401).end(JSON.stringify({error:privateError}));return;}
 if(requestMode==="invalid_json"){res.writeHead(200).end('{invalid:'+privateError);return;}
 res.writeHead(200).end(JSON.stringify({success:true,data:[{id:requestMode==="invalid_ref"?"chunk-forged":"chunk-good",knowledge_id:"ext-good",content:privateSnippet,score:0.9}]}));
});
try{
 const faultUrl=await listen(faultHttp);
 Object.assign(process.env,{DB_PATH:join(root,"app.db"),KNOWLEDGE_DB_PATH:join(root,"knowledge.db"),KNOWLEDGE_ENGINE_HOME:join(root,"absent-engine"),RELAY_STATE_ROOT:join(root,"state"),WORKSPACE_ROOT:join(root,"workspace"),KNOWLEDGE_EVIDENCE_ROOT:join(root,"evidence"),KNOWLEDGE_CASEBOOK_ROOT:join(root,"casebook"),DOTENV_CONFIG_PATH:join(root,"absent.env"),WEKNORA_BASE_URL:faultUrl,WEKNORA_KNOWLEDGE_BASE_ID:"kb-fault-fixture",WEKNORA_API_TOKEN:secret,WEKNORA_AUTH_MODE:"api_key"});
 const [{default:Fastify},{default:express},{db,runMigrations},{knowledgeRoutes},{getKnowledgeStore},{KnowledgeRepository},{EvidenceStore},{ConfirmedMemoryService},{registerKnowledgeTools},{safeRequestLogSerializers,safeRequestLogHooks,sendSafeNotFound},{sanitizeToolAuditArguments},{WeKnoraClient,WeKnoraError}]=await Promise.all([
  import("fastify"),import("express"),import("../src/server/db/index.js"),import("../src/server/routes/knowledge.js"),import("../src/server/knowledge-context.js"),import("../src/knowledge/repository.js"),import("../src/knowledge/evidence-store.js"),import("../src/knowledge/confirmed-memory.js"),import("../src/mcp/tools/knowledge.js"),import("../src/server/request-log.js"),import("../src/shared/retrieval-audit.js"),import("../src/knowledge/weknora.js")]);
 appDb=(db as any).session.client;runMigrations();store=getKnowledgeStore();store.grantAcl("p1",7,true);store.grantAcl("p2",10);
 const now=new Date().toISOString();new KnowledgeRepository(store).saveCase({id:"case-fixture",kind:"case",title:"Cache fixture",body:"cache "+privateBody,lifecycle:"approved",projectId:"p1",environment:"dev",locator:"case:fixture",createdAt:now,updatedAt:now} as any);
 const evidence=new EvidenceStore(store,process.env.KNOWLEDGE_EVIDENCE_ROOT!).put({content:Buffer.from("cache "+privateBody),mimeType:"text/plain",sourceKind:"log",projectId:"p1",environment:"dev",locator:"case:fixture"});
 new ConfirmedMemoryService(store).save({id:"case-fixture",type:"Case",title:"Cache fixture",statement:"cache "+privateBody,details:{symptoms:"cache",rootCause:"fixture",resolution:"reviewed",verification:"confirmed"},scope:{projectId:"p1",environment:"dev",scopeType:"environment",scopeKey:"dev",visibility:"project"},evidenceRefs:[evidence.id],source:{kind:"manual",locator:"case:fixture"},confirmedBy:7,confirmedAt:now,audit:{action:"manual",reason:"fixture"}});
 store.db.prepare(`INSERT INTO knowledge_weknora_documents(id,external_document_id,external_knowledge_base_id,external_chunk_ids_json,title,normalized_content_sha256,raw_sha256,parser_version,product_version,source_path,project_id,environment,language,status,idempotency_key,created_at,updated_at,upstream_verified_at,upstream_parse_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("mapping-good","ext-good","kb-fault-fixture",'["chunk-good"]',"Synthetic cache manual",hash("synthetic"),hash("synthetic raw"),"fault-fixture-1","21.3","manual/synthetic.html#cache","p1","dev","en","published","fault-fixture",now,now,now,"completed");
 store.db.prepare("INSERT INTO knowledge_integration_settings(key,value,updated_at) VALUES ('product_provider','weknora',?)").run(now);
 app=Fastify({logger:{stream:{write(line:string){logs+=line;}},serializers:safeRequestLogSerializers,hooks:safeRequestLogHooks}});
 app.addHook("onRequest",async()=>{counts.relayHttp++;});
 app.decorate("authenticate",async(req:any,reply:any)=>{const token=req.headers.authorization; if(token!=="Bearer "+adminToken&&token!=="Bearer "+foreignToken)return reply.code(401).send({error:"Unauthorized"});req.user={id:token==="Bearer "+adminToken?7:10,isAdmin:false};});
 app.setNotFoundHandler((_req:any,reply:any)=>sendSafeNotFound(reply));await app.register(knowledgeRoutes);const relayUrl=await app.listen({host:"127.0.0.1",port:0});
 const mcpApp=express();mcpApp.use(express.json());mcpApp.post("/mcp",async(req,res)=>{
  counts.mcpHttp++;const credential=req.headers.authorization;
  if(credential!=="Bearer "+adminToken&&credential!=="Bearer "+foreignToken){res.status(401).json({error:"Unauthorized"});return;}
  const actor=credential==="Bearer "+adminToken?7:10;
  if(req.body?.method==="tools/call")mcpAudit.push({actor,tool:req.body.params.name,arguments:sanitizeToolAuditArguments(req.body.params.name,req.body.params.arguments)});
  const server=new McpServer({name:"relay-injected-fault-fixture",version:"1.0.0"});
  registerKnowledgeTools({server,knowledge:store,user:{id:actor,username:"fixture-"+actor,defaultProject:actor===7?"p1":"p2",defaultEnvironment:"dev"}});
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
  try{await server.connect(transport);await transport.handleRequest(req,res,req.body);}catch{if(!res.headersSent)res.status(500).json({error:"Fixture transport failure"});}finally{await server.close();await transport.close();}
 });
 mcpApp.all("/mcp",(_req,res)=>{counts.mcpHttp++;res.status(405).end();});mcpHttp=createServer(mcpApp);const mcpUrl=await listen(mcpHttp);
 const connect=async(token:string)=>{const client=new Client({name:"injected-fault-acceptance",version:"1.0.0"});await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl+"/mcp"),{requestInit:{headers:{authorization:"Bearer "+token}}}));clients.push(client);return client;};
 const admin=await connect(adminToken),foreign=await connect(foreignToken);
 const httpSearch=async(token=adminToken,environment="dev")=>{const response=await fetch(relayUrl+"/api/knowledge/weknora/search?private="+privateQuery,{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json","x-private":privateQuery},body:JSON.stringify({query,projectId:"p1",environment,productVersion:"21.3"})});return {status:response.status,body:await response.json() as any};};
 const mcpCall=async(client:Client,name:string,args:Record<string,unknown>)=>{const raw:any=await client.callTool({name,arguments:args},undefined,{timeout:45_000});const text=raw.content?.filter((x:any)=>x.type==="text").map((x:any)=>x.text).join("\n")??"";return {isError:raw.isError===true,text,body:raw.isError?undefined:JSON.parse(text)};};
 const mcpSearch=(client=admin)=>mcpCall(client,"knowledge_weknora_search",{query,projectId:"p1",productVersion:"21.3",extraPrivate:privateQuery});
 const memory=async()=>{const result=await mcpCall(admin,"knowledge_get",{documentId:"case-fixture",project:"p1"});check(!result.isError&&result.text.includes(privateBody),"memory_unavailable");return true;};
 const positive=(body:any)=>{check(body.references?.length===1&&body.references[0].documentId==="ext-good"&&body.references[0].chunkId==="chunk-good","healthy_reference_mismatch");check(body.contextPack.confirmedKnowledge.some((x:any)=>x.id==="case-fixture"),"healthy_memory_missing");};
 const recover=async()=>{mode="healthy";const [http,mcp]=await Promise.all([httpSearch(),mcpSearch()]);check(http.status===200&&!mcp.isError,"healthy_transport_failed");positive(http.body);positive(mcp.body);return "passed";};
 stage="baseline";report.baseline=await recover();
 stage="acl";const beforeAcl=counts.faultHttp;const [deniedHttp,deniedMcp]=await Promise.all([httpSearch(foreignToken),mcpSearch(foreign)]);check(deniedHttp.status===403&&deniedMcp.isError,"foreign_acl_not_denied");check(counts.faultHttp===beforeAcl,"foreign_acl_reached_upstream");errorResponses.push(JSON.stringify(deniedHttp.body),deniedMcp.text);
 const wrongEnvironment=await httpSearch(adminToken,"prod");check(wrongEnvironment.status===200&&wrongEnvironment.body.references.length===0&&counts.faultHttp===beforeAcl,"environment_scope_not_closed");check(wrongEnvironment.body.contextPack.confirmedKnowledge.length===0,"environment_memory_leak");report.acl={deniedWithoutUpstream:true,httpStatus:403,mcpIsError:true,wrongEnvironmentEmpty:true};
 for(const fault of faults){
  stage=fault;mode=fault;const before=counts.faultHttp,started=Date.now();const [http,mcp]=await Promise.all([httpSearch(),mcpSearch()]);
  const elapsedMs=Date.now()-started,upstreamRequests=counts.faultHttp-before;check(upstreamRequests===2,"unexpected_upstream_request_count");
  if(["timeout","rate_limited","unauthorized"].includes(fault)){
   check(http.status===200&&!mcp.isError,"degraded_transport_not_successful");
   for(const body of [http.body,mcp.body]){check(body.references.length===0&&body.contextPack.degraded.productKnowledge===fault,"degraded_code_or_reference_mismatch");check(body.contextPack.confirmedKnowledge.some((x:any)=>x.id==="case-fixture"),"degraded_memory_missing");}
  }else{check(http.status===502&&mcp.isError,"malformed_response_not_rejected");check(!JSON.stringify(http.body).includes(privateSnippet)&&!mcp.text.includes(privateSnippet),"untrusted_reference_content_leaked");errorResponses.push(JSON.stringify(http.body),mcp.text);}
  const memoryAvailable=await memory();
  let direct:any;
  if(fault!=="invalid_ref"){
   const client=new WeKnoraClient({baseUrl:faultUrl,timeoutMs:150,secretResolver:async()=>secret,onTrace:trace=>traces.push(trace)});let error:any;
   try{await client.search({query,knowledgeIds:["ext-good"]});}catch(caught){error=caught;}
   check(error instanceof WeKnoraError,"direct_client_error_missing");const expected=fault==="invalid_json"?"invalid_response":fault;check(error.code===expected,"direct_client_error_code_mismatch");if(fault==="rate_limited")check(error.retryAfterSeconds===7,"retry_after_not_preserved");
   errorResponses.push(String(error));direct={errorCode:error.code,status:error.status,retryAfterSeconds:error.retryAfterSeconds};
  }
  stage=fault+"_recovery";const recovery=await recover();report.scenarios.push({fault,injected:true,httpStatus:http.status,mcpIsError:mcp.isError,errorCode:fault.startsWith("invalid")?"invalid_response":fault,upstreamRequests,elapsedMs,memoryAvailable,recovery,directClient:direct});
 }
 stage="fixture_restart";await close(faultHttp);const [outageHttp,outageMcp]=await Promise.all([httpSearch(),mcpSearch()]);
 check(outageHttp.status===200&&!outageMcp.isError,"restart_outage_failed");
 for(const body of [outageHttp.body,outageMcp.body]){check(body.references.length===0&&body.contextPack.degraded.productKnowledge==="unavailable","restart_outage_code_mismatch");check(body.contextPack.confirmedKnowledge.some((x:any)=>x.id==="case-fixture"),"restart_memory_missing");}
 const restartMemory=await memory();await listen(faultHttp,Number(new URL(faultUrl).port));report.restart={degradedCode:"unavailable",memoryAvailable:restartMemory,recovery:await recover(),scope:"only synthetic upstream listener restarted; actual Relay handler and MCP instances kept alive"};
 stage="privacy";const retrievalRows=store.db.prepare("SELECT query,results_json FROM knowledge_retrieval_runs").all();const auditRows=store.db.prepare("SELECT action,details_json FROM knowledge_audit").all();
 const telemetry=JSON.stringify({logs,retrievalRows,auditRows,mcpAudit,traces,errorResponses});
 for(const value of [secret,adminToken,foreignToken,privateQuery,privateError,privateBody,privateSnippet])for(const form of [value,encodeURIComponent(value),JSON.stringify(value).slice(1,-1)])check(!telemetry.includes(form),"privacy_canary_leaked");
 check(upstreamMetadata.every(row=>row.syntheticCredentialValid&&row.documentScopeValid),"upstream_auth_or_scope_invalid");
 for(const row of retrievalRows){check(row.query.startsWith("sha256:"),"retrieval_query_not_hashed");const metadata=JSON.parse(row.results_json);check(metadata.schemaVersion===1&&!Object.hasOwn(metadata,"queryTokens"),"retrieval_schema_invalid");}
 report.modelCalls=store.db.prepare("SELECT count(*) n FROM knowledge_provider_admissions").get().n;report.providersConfigured=store.db.prepare("SELECT count(*) n FROM knowledge_provider_configs").get().n;report.activeJobs=store.db.prepare("SELECT count(*) n FROM knowledge_ingest_jobs WHERE status IN ('queued','running')").get().n;
 check(report.modelCalls===0&&report.providersConfigured===0&&report.activeJobs===0,"nonzero_model_or_worker_activity");
 report.privacy={canaryMatches:0,retrievalRows:retrievalRows.length,auditRows:auditRows.length,mcpToolAudits:mcpAudit.length,clientTraces:traces.length,logBytes:Buffer.byteLength(logs),logSha256:hash(logs),telemetrySha256:hash(telemetry),scope:"new fixture telemetry and error outputs; successful authorized content is allowed"};
 report.ports={fault:Number(new URL(faultUrl).port),relay:Number(new URL(relayUrl).port),mcp:Number(new URL(mcpUrl).port)};report.upstreamRequests=upstreamMetadata;report.traces=traces;report.status="passed_injected_transport_faults";
}catch(error){report.status="failed";report.failure={stage,check:error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:"unexpected_fixture_error",type:error instanceof Error?error.name:"unknown",frames:error instanceof Error?error.stack?.split("\n").slice(1,4):[]};process.exitCode=1;
}finally{
 await Promise.allSettled(clients.map(client=>client.close()));if(mcpHttp)await close(mcpHttp);if(app)await app.close();await close(faultHttp);store?.close();appDb?.close();rmSync(root,{recursive:true,force:true});report.completedAt=new Date().toISOString();mkdirSync(dirname(reportPath),{recursive:true});writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});console.log(JSON.stringify({status:report.status,reportPath,counts,failure:report.failure}));
}
