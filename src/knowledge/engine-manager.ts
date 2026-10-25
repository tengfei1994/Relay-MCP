import {createHash} from "node:crypto";
import {closeSync,openSync,unlinkSync,readFileSync,writeFileSync,statSync} from "node:fs";
import {join} from "node:path";
import {EngineError,engineHome,readEngineRuntime,readEngineControl,writeEngineControl} from "./engine-config.js";
import type {EngineModelBinding} from "./engine-model-gateway.js";
import type {ManagedProviderKind,ProviderConfigMetadata,ProviderRegistry} from "./provider-registry.js";
interface Options {home?:string;registry:ProviderRegistry;fetchImpl?:typeof fetch;}
type Selection={ingestionProfile?:"standard"|"bulk";actorId:number;embeddingProviderId?:string;wikiProviderId?:string;rerankProviderId?:string};
function signature(c:ProviderConfigMetadata):string {return createHash("sha256").update(JSON.stringify([c.id,c.kind,c.modelId,c.dimensions,c.indexVersion])).digest("hex").slice(0,16);}
function compatible(b:EngineModelBinding,c:ProviderConfigMetadata|undefined):boolean{return !!c&&c.status!=="disabled"&&c.kind===b.kind&&c.modelId===b.modelId&&c.dimensions===b.dimensions&&c.indexVersion===b.indexVersion;}
function rows(value:any):any[]{return Array.isArray(value?.data)?value.data:Array.isArray(value?.data?.items)?value.data.items:[];}
export class KnowledgeEngineManager {
  readonly home:string;
  private readonly registry:ProviderRegistry;
  private readonly fetchImpl:typeof fetch;
  private initializing?:Promise<ReturnType<KnowledgeEngineManager["status"]>>;
  constructor(options:Options){this.home=options.home??engineHome();this.registry=options.registry;this.fetchImpl=options.fetchImpl??fetch;}
  runtime(){return readEngineRuntime(this.home);}
  control(){return readEngineControl(this.home);}
  bindings():EngineModelBinding[]{return this.control().bindings;}
  status(){
    const runtime=this.runtime();if(!runtime)return {phase:"not_installed",wikiReady:false,embeddingProviderId:undefined,version:undefined};
    const state=this.control(),embeddings=state.bindings.filter(b=>b.kind==="embedding"),wiki=state.bindings.filter(b=>b.kind==="wiki_llm");
    // Product reads and bulk indexing require the frozen embedding space only.
    // Optional model availability is enforced independently at its call boundary.
    const stale=embeddings.length===1?!compatible(embeddings[0],this.registry.get(embeddings[0].providerId)):!!state.knowledgeBaseId||embeddings.length>1;
    const phase=state.phase==="initializing"||state.phase==="failed"?state.phase:stale?"stale":state.knowledgeBaseId?"ready":"not_initialized";
    return {phase,version:runtime.version,
      ingestionProfile:state.ingestionProfile??"standard",wikiReady:state.ingestionProfile!=="bulk"&&phase==="ready"&&wiki.length===1&&compatible(wiki[0],this.registry.get(wiki[0].providerId)),
      embeddingProviderId:state.bindings.find(b=>b.kind==="embedding")?.providerId,
      wikiProviderId:state.bindings.find(b=>b.kind==="wiki_llm")?.providerId,
      rerankProviderId:state.bindings.find(b=>b.kind==="rerank")?.providerId,
      bindings:state.bindings.map(({engineModelId:_id,...binding})=>binding)};
  }
  private async raw(method:string,path:string,body?:unknown,jwt?:string):Promise<any>{
    const runtime=this.runtime();if(!runtime)throw new EngineError("engine_not_installed");
    if(!path.startsWith("/api/v1/")||path.includes(".."))throw new EngineError("invalid_engine_path",400);
    const headers:Record<string,string>={"content-type":"application/json"};
    if(jwt)headers.authorization="Bearer "+jwt;
    else {const key=this.control().apiKey;if(key)headers["X-API-Key"]=key;}
    let response:Response;
    try{response=await this.fetchImpl(runtime.baseUrl+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:"error",signal:AbortSignal.timeout(60_000)});}
    catch{throw new EngineError("engine_unavailable");}
    if(!response.ok)throw new EngineError("engine_http_"+response.status,response.status);
    let value:any;try{value=await response.json();}catch{throw new EngineError("engine_invalid_response");}
    if(value?.success===false)throw new EngineError("engine_request_failed");
    return value;
  }
  async request(method:"GET"|"POST"|"PUT"|"DELETE",path:string,body?:unknown):Promise<unknown>{
    if(this.status().phase!=="ready")throw new EngineError("engine_not_ready");
    return this.raw(method,path,body);
  }
  async inspect(){
    const status=this.status();if(status.phase!=="ready")return status;
    try{await this.raw("GET","/api/v1/knowledge-bases/"+encodeURIComponent(this.control().knowledgeBaseId!));return {...status,reachable:true};}
    catch{return {...status,phase:"unavailable",reachable:false};}
  }
  private select(kind:ManagedProviderKind,id:string|undefined,optional=false):ProviderConfigMetadata|undefined{
    if(id){const c=this.registry.get(id);if(!c||c.kind!==kind||c.status==="disabled")throw new EngineError("invalid_"+kind+"_provider",400);return c;}
    const candidates=this.registry.list().filter(c=>c.kind===kind&&c.status!=="disabled");
    if(!candidates.length&&optional)return undefined;
    if(candidates.length!==1)throw new EngineError(candidates.length?"select_"+kind+"_provider":"configure_"+kind+"_provider",400);
    return candidates[0];
  }
  initialize(selection:Selection){
    if(this.initializing)return this.initializing;
    this.initializing=this.provision(selection).finally(()=>{this.initializing=undefined;});
    return this.initializing;
  }
  private async provision(selection:Selection){
    const runtime=this.runtime();if(!runtime)throw new EngineError("engine_not_installed");
    const saved=this.control(),previous=saved.bindings;
    const ingestionProfile=selection.ingestionProfile??saved.ingestionProfile??"standard";
    if(!["standard","bulk"].includes(ingestionProfile))throw new EngineError("invalid_ingestion_profile",400);
    const embedding=this.select("embedding",selection.embeddingProviderId??previous.find(b=>b.kind==="embedding")?.providerId)!;
    if(!embedding.dimensions)throw new EngineError("embedding_dimension_required",400);
    const chat=this.select("wiki_llm",selection.wikiProviderId??previous.find(b=>b.kind==="wiki_llm")?.providerId,true),rerank=this.select("rerank",selection.rerankProviderId??previous.find(b=>b.kind==="rerank")?.providerId,true);
    const lock=join(this.home,"initialize.lock");
    let fd:number;
    try{fd=openSync(lock,"wx",0o600);}catch(error){
      if((error as NodeJS.ErrnoException).code!=="EEXIST")throw new EngineError("engine_lock_unavailable");
      let dead=false;
      try{
        const owner=JSON.parse(readFileSync(lock,"utf8"));
        if(Number.isSafeInteger(owner.pid)&&owner.pid>0){
          try{process.kill(owner.pid,0);}catch(probe){dead=(probe as NodeJS.ErrnoException).code==="ESRCH";}
        }
      }catch{dead=Date.now()-statSync(lock).mtimeMs>60_000;}
      if(!dead)throw new EngineError("engine_initialization_locked",409);
      try{unlinkSync(lock);fd=openSync(lock,"wx",0o600);}catch{throw new EngineError("engine_initialization_locked",409);}
    }
    writeFileSync(fd,JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));

    try{
      let state=this.control();
      if(!state.apiKey){
        let login:any;
        try{login=await this.raw("POST","/api/v1/auth/login",{email:runtime.ownerEmail,password:runtime.ownerPassword});}
        catch(error){
          if(!(error instanceof EngineError)||![400,401,404].includes(error.status))throw error;
          await this.raw("POST","/api/v1/auth/register",{username:"relay-engine",email:runtime.ownerEmail,password:runtime.ownerPassword});
          login=await this.raw("POST","/api/v1/auth/login",{email:runtime.ownerEmail,password:runtime.ownerPassword});
        }
        if(!login.token||!login.active_tenant?.id)throw new EngineError("engine_login_invalid");
        const key=await this.raw("POST","/api/v1/tenants/"+encodeURIComponent(login.active_tenant.id)+"/api-keys",{name:"relay-engine",full_access:true},login.token);
        const apiKey=typeof key.data?.token==="string"?key.data.token:typeof key.data?.api_key==="string"?key.data.api_key:undefined;
        if(!apiKey)throw new EngineError("engine_key_invalid");
        state={...state,apiKey,tenantId:login.active_tenant.id};writeEngineControl(this.home,state);
      }
      const providers=[embedding,...(chat?[chat]:[]),...(rerank?[rerank]:[])];
      const bindings=providers.map(c=>({providerId:c.id,kind:c.kind,modelId:c.modelId,dimensions:c.dimensions,indexVersion:c.indexVersion,alias:"relay-"+c.kind+"-"+signature(c)} as EngineModelBinding));
      // Saving the new bindings before model registration allows upstream model validation to call this gateway.
      state={...state,phase:"initializing",bindings,ingestionProfile};writeEngineControl(this.home,state);
      const existing=rows(await this.raw("GET","/api/v1/models"));
      for(const binding of bindings){
        const candidates=existing.filter(m=>m.name===binding.alias);
        if(candidates.length>1)throw new EngineError("engine_model_alias_ambiguous");
        const found=candidates[0];
        const type=binding.kind==="embedding"?"Embedding":binding.kind==="rerank"?"Rerank":"KnowledgeQA";
        const parameters:any={provider:"generic",base_url:runtime.relayGatewayUrl};
        if(binding.kind==="embedding"){parameters.embedding_parameters={dimension:binding.dimensions,supports_dimension_override:false};parameters.spec={compat:{accepts_truncate_prompt_tokens:false}};}
        if(binding.kind==="wiki_llm")parameters.spec={api:"openai-completions",reasoning:false};
        const body={name:binding.alias,type,source:"remote",parameters};
        if(found){
          // A matching alias cannot authorize changing a persisted vector space.
          if(typeof found.id!=="string"||!found.id||found.type!==type||found.source!=="remote"||
            (binding.kind==="embedding"&&found.parameters?.embedding_parameters?.dimension!==binding.dimensions))throw new EngineError("engine_model_binding_mismatch");
          binding.engineModelId=found.id;
          const path="/api/v1/models/"+encodeURIComponent(found.id);
          await this.raw("PUT",path,body);
          // v0.8.3 ignores api_key in ordinary model PUT. Reapply only Relay's
          // internal gateway credential via the dedicated write-only boundary.
          const credential=await this.raw("PUT",path+"/credentials",{api_key:runtime.gatewayToken});
          if(credential.data?.fields?.api_key?.configured!==true)throw new EngineError("engine_model_credential_unconfirmed");
        }else{
          const result=await this.raw("POST","/api/v1/models",{...body,parameters:{...parameters,api_key:runtime.gatewayToken}});
          if(typeof result.data?.id!=="string"||!result.data.id)throw new EngineError("engine_model_invalid");
          binding.engineModelId=result.data.id;
        }
        const verified=(await this.raw("GET","/api/v1/models/"+encodeURIComponent(binding.engineModelId!))).data;
        if(verified?.id!==binding.engineModelId||verified?.name!==binding.alias||verified?.type!==type||verified?.source!=="remote"||
          verified?.parameters?.provider!=="generic"||verified?.parameters?.base_url!==runtime.relayGatewayUrl||
          (binding.kind==="embedding"&&verified?.parameters?.embedding_parameters?.dimension!==binding.dimensions))throw new EngineError("engine_model_verification_failed");
        writeEngineControl(this.home,state);
      }
      const emb=bindings.find(b=>b.kind==="embedding")!,wiki=bindings.find(b=>b.kind==="wiki_llm");
      const kbName="Relay Product "+signature(embedding);
      const bases=rows(await this.raw("GET","/api/v1/knowledge-bases"));
      const found=bases.find(k=>k.name===kbName);
      const body={name:kbName,type:"document",embedding_model_id:emb.engineModelId,summary_model_id:wiki?.engineModelId,
        indexing_strategy:{vector_enabled:true,keyword_enabled:true,wiki_enabled:!!wiki&&ingestionProfile!=="bulk",graph_enabled:false},
        ...(wiki?{wiki_config:{synthesis_model_id:wiki.engineModelId,ingest_batch_size:1,ingest_map_parallel:1,ingest_reduce_parallel:1}}:{})};
      if(found){
        state.knowledgeBaseId=String(found.id);
        const current=(await this.raw("GET","/api/v1/knowledge-bases/"+encodeURIComponent(state.knowledgeBaseId))).data;
        if(current?.embedding_model_id!==emb.engineModelId)throw new EngineError("engine_embedding_binding_mismatch");
        await this.raw("PUT","/api/v1/knowledge-bases/"+encodeURIComponent(state.knowledgeBaseId),{name:kbName,description:current.description??"",config:{chunking_config:current.chunking_config??{chunk_size:512,chunk_overlap:100,separators:["\n\n","\n"]},indexing_strategy:body.indexing_strategy,...(wiki?{wiki_config:{...current.wiki_config,...body.wiki_config}}:{wiki_config:current.wiki_config})}});
      }
      else{const result=await this.raw("POST","/api/v1/knowledge-bases",body);if(!result.data?.id)throw new EngineError("engine_kb_invalid");state.knowledgeBaseId=String(result.data.id);}
      const verified=(await this.raw("GET","/api/v1/knowledge-bases/"+encodeURIComponent(state.knowledgeBaseId!))).data;
      if(verified?.embedding_model_id!==emb.engineModelId || Boolean(verified?.indexing_strategy?.wiki_enabled)!==Boolean(wiki&&ingestionProfile!=="bulk") || (wiki&&verified?.wiki_config?.synthesis_model_id!==wiki.engineModelId))throw new EngineError("engine_binding_verification_failed");
      state.phase="ready";
      writeEngineControl(this.home,state);
      return this.status();
    }catch(error){const state=this.control();if(state.phase==="initializing"){state.phase="failed";writeEngineControl(this.home,state);}throw error;}finally{closeSync(fd);unlinkSync(lock);}
  }
}
