#!/usr/bin/env node
// Nonproduction-only live model/privacy proof; no content or credential is reported.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
const root='/home/ftd/relay-knowledge-engine-nonprod',app=root+'/relay',home=root+'/runtime/knowledge-engine';
const sha=v=>createHash('sha256').update(v).digest('hex');
const check=(ok,code)=>{if(!ok)throw new Error(code)};
const guard=p=>{const actual=fs.realpathSync(p);check(actual.startsWith(root+'/'),'isolated_path_required');return actual};
const runId=randomUUID(),report={schemaVersion:1,runId,status:'running',startedAt:new Date().toISOString(),calls:[],logs:[],databaseColumns:[]};
let reportPath,secretBuffers=[];
try{
 check(process.env.RELAY_LOG_SAFETY_ISOLATED==='1'&&process.platform==='linux','explicit_isolated_flag_required');
 check(fs.realpathSync(root)===root,'isolated_root_required');
 const config=JSON.parse(fs.readFileSync(guard(home+'/engine.json'),'utf8'));
 const control=JSON.parse(fs.readFileSync(guard(home+'/control.json'),'utf8'));
 check(config.baseUrl==='http://127.0.0.1:18190'&&config.relayGatewayUrl==='http://127.0.0.1:18300/internal/knowledge-engine/v1'&&control.phase==='ready','isolated_ready_runtime_required');
 const release=guard(config.releasePath);check(release.startsWith(home+'/releases/'),'managed_release_required');
 const manifest=JSON.parse(fs.readFileSync(guard(release+'/manifest.json'),'utf8'));
 const proof=JSON.parse(fs.readFileSync(guard(release+'/relay-log-safety-proof.json'),'utf8'));
 const binary=guard(release+'/WeKnora-lite'),binarySha256=sha(fs.readFileSync(binary));
 check(manifest.securityPolicy==='relay-model-metadata-only-v1'&&proof.status==='passed'&&proof.binarySha256===binarySha256&&manifest.files['WeKnora-lite']===binarySha256,'patched_binary_proof_required');
 const pid=JSON.parse(fs.readFileSync(guard(home+'/run/engine.pid.json'),'utf8')).pid;
 check(Number.isSafeInteger(pid)&&fs.realpathSync('/proc/'+pid+'/exe')===binary,'active_patched_binary_required');
 const activeEnv=fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0');
 const safeEnv=Object.fromEntries(['LOG_LEVEL','LLM_DEBUG_LOG','WEKNORA_LLM_STREAM_RAW_DUMP'].map(k=>[k,activeEnv.find(s=>s.startsWith(k+'='))?.slice(k.length+1)]));
 check(safeEnv.LOG_LEVEL==='warn'&&safeEnv.LLM_DEBUG_LOG==='false'&&safeEnv.WEKNORA_LLM_STREAM_RAW_DUMP==='false','managed_private_log_policy_required');
 report.runtime={pid,binarySha256,manifestSha256:sha(fs.readFileSync(release+'/manifest.json')),securityPolicy:manifest.securityPolicy,environment:safeEnv};
 reportPath=root+'/runtime/model-log-safety-live-'+runId+'.json';
 const env=Object.fromEntries(fs.readFileSync(guard(app+'/.env'),'utf8').split(/\r?\n/).filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')).trim(),l.slice(l.indexOf('=')+1).trim().replace(/^["']|["']$/g,'')]));
 const knowledgeDbPath=guard(path.resolve(app,env.KNOWLEDGE_DB_PATH)),keyFile=guard(path.resolve(app,env.PROVIDER_SECRET_KEY_FILE));
 const db=new Database(knowledgeDbPath,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
 try{
  const {ProviderCredentialStore}=await import(guard(app+'/dist/knowledge/provider-credential-store.js'));
  const store=new ProviderCredentialStore({db},keyFile);
  const tokens=[];
  for(const id of ['qwen','qwen-wiki-nonprod','qwen-candidate-nonprod']){
   const provider=db.prepare('SELECT provider,secret_ref FROM knowledge_provider_configs WHERE id=?').get(id);
   check(provider?.provider==='bailian'&&provider.secret_ref?.startsWith('managed://'),'approved_provider_required');
   const token=await store.resolve(provider.secret_ref);check(token?.length>=16,'approved_credential_required');tokens.push(token);
  }
  secretBuffers=[...new Set(tokens)].map(s=>Buffer.from(s));tokens.fill('');
 }finally{db.close()}
 const paths=[home+'/logs/engine.log',root+'/runtime/relay-web.log',root+'/runtime/relay-mcp.log',root+'/runtime/relay-server.log'].filter(fs.existsSync);
 const offsets=new Map(paths.map(p=>[guard(p),fs.statSync(p).size]));
 const systemMarker='SYS_PRIVATE_'+randomUUID(),answerMarker='LOG_PRIVACY_OK_'+randomUUID();
 const input='Reply exactly with '+answerMarker+'.',system='Respond concisely. This private marker must never be included in logs: '+systemMarker;
 const bodyNeedles=[Buffer.from(systemMarker),Buffer.from(input),Buffer.from(answerMarker)];
 const request=async(method,url,body)=>{
  const response=await fetch(config.baseUrl+url,{method,headers:{'X-API-Key':control.apiKey},body,redirect:'error',signal:AbortSignal.timeout(180000)});
  check(response.ok,'upstream_http_failed');
  const data=await response.json();check(data.success===true,'upstream_request_failed');return data.data;
 };
 const binding=control.bindings.find(b=>b.kind==='wiki_llm');check(binding?.engineModelId,'wiki_model_binding_required');
 const model=await request('GET','/api/v1/models/'+encodeURIComponent(binding.engineModelId));
 check(model.parameters?.base_url===config.relayGatewayUrl&&model.name===binding.alias,'managed_gateway_binding_required');
 const form=new FormData();form.set('input',input);form.set('options',JSON.stringify({system_prompt:system,max_tokens:64,temperature:0,thinking:false}));
 console.log(JSON.stringify({stage:'live-managed-chat',status:'running'}));
 const started=Date.now(),result=await request('POST','/api/v1/models/'+encodeURIComponent(binding.engineModelId)+'/debug',form);
 check(result.ok===true&&typeof result.raw_response?.content==='string'&&result.raw_response.content.includes(answerMarker),'live_chat_not_completed');
 report.calls.push({kind:'wiki_llm',engineModelId:binding.engineModelId,providerId:binding.providerId,status:'passed',latencyMs:Date.now()-started,inputSha256:sha(input),systemSha256:sha(system),responseSha256:sha(result.raw_response.content),responseBytes:Buffer.byteLength(result.raw_response.content)});
 await new Promise(done=>setTimeout(done,300));
 const count=(bytes,needles)=>needles.reduce((total,needle)=>{let at=0;while((at=bytes.indexOf(needle,at))!==-1){total++;at+=needle.length}return total},0);
 let secretMatches=0,bodyMatches=0,shapeMatches=0;
 for(const [file,offset]of offsets){
  const bytes=fs.readFileSync(file);check(bytes.length>=offset,'log_rotated_during_probe');
  const delta=bytes.subarray(offset),text=delta.toString('utf8');
  const tokenCount=count(delta,secretBuffers),bodyCount=count(delta,bodyNeedles);
  const shapeCount=[...text.matchAll(/"messages"\s*:\s*\[|"role"\s*:\s*"system"|"reasoning_content"\s*:\s*"[^"]+|"chain_of_thought"\s*:\s*"[^"]+/g)].length;
  secretMatches+=tokenCount;bodyMatches+=bodyCount;shapeMatches+=shapeCount;
  report.logs.push({file,offsetBytes:offset,endBytes:bytes.length,scannedBytes:delta.length,secretMatchCount:tokenCount,bodyMatchCount:bodyCount,shapeMatchCount:shapeCount});
 }
 for(const [id,file,tables]of [
  ['relay',knowledgeDbPath,{knowledge_audit:['details_json'],knowledge_provider_configs:['base_url','model_id']}],
  ['upstream',guard(home+'/data/weknora.db'),{audit_logs:['details'],knowledge_processing_spans:['input','output','metadata','error_message','error_detail'],models:['parameters']}],
 ]){
  const db=new Database(file,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
  try{for(const [table,columns]of Object.entries(tables))for(const column of columns){let rows=0,tokens=0,bodies=0;
   for(const r of db.prepare('SELECT "'+column+'" AS value FROM "'+table+'"').iterate()){rows++;if(r.value===null)continue;const b=Buffer.isBuffer(r.value)?r.value:Buffer.from(String(r.value));tokens+=count(b,secretBuffers);bodies+=count(b,bodyNeedles)}
   secretMatches+=tokens;bodyMatches+=bodies;report.databaseColumns.push({database:id,table,column,rowCount:rows,secretMatchCount:tokens,bodyMatchCount:bodies});
  }}finally{db.close()}
 }
 report.secretMatchCount=secretMatches;report.bodyMatchCount=bodyMatches;report.shapeMatchCount=shapeMatches;
 check(secretMatches===0&&bodyMatches===0&&shapeMatches===0,'private_data_persisted_after_live_call');
 report.status='passed';
}catch(error){report.status='failed';report.errorCode=/^[a-z_]+$/.test(error.message)?error.message:'unexpected_probe_error';process.exitCode=1}
finally{secretBuffers.forEach(b=>b.fill(0));secretBuffers=[];report.finishedAt=new Date().toISOString();
 if(reportPath)fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({status:report.status,reportPath,callCount:report.calls.length,secretMatchCount:report.secretMatchCount,bodyMatchCount:report.bodyMatchCount,shapeMatchCount:report.shapeMatchCount,errorCode:report.errorCode}));
}
