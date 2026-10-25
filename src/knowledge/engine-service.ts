import type {KnowledgeStore} from "./store.js";
import {createManagedProviderRegistry} from "./provider-setup.js";
import {KnowledgeEngineManager} from "./engine-manager.js";
import {EngineError} from "./engine-config.js";
import {WeKnoraClient} from "./weknora.js";
import {WeKnoraClientDocumentWriter,WeKnoraIngestor} from "./weknora-ingest.js";
import {MigrationController} from "./migration-control.js";
import {WikiService} from "./wiki.js";
import {EngineWikiService} from "./engine-wiki.js";
/** Finalizing includes remote summary/Wiki jobs; a two-minute window can time out after successful indexing. */
export function engineReadinessTimeout(value=process.env.KNOWLEDGE_ENGINE_READINESS_TIMEOUT_MS):number {
  if(value===undefined||value.trim()==="")return 600_000;
  const parsed=Number(value);
  if(!Number.isInteger(parsed)||parsed<1_000||parsed>7_200_000)throw new EngineError("engine_readiness_timeout_invalid",400);
  return parsed;
}
const managers=new WeakMap<KnowledgeStore,KnowledgeEngineManager>();
export function getEngineManager(store:KnowledgeStore):KnowledgeEngineManager{
  let manager=managers.get(store);
  if(!manager){manager=new KnowledgeEngineManager({registry:createManagedProviderRegistry(store)});managers.set(store,manager);}
  return manager;
}
export function managedControlPlane(store:KnowledgeStore){
  const manager=getEngineManager(store),runtime=manager.runtime(),control=manager.control();
  if(!runtime){
    // Existing server installations may keep explicit configuration during migration.
    const baseUrl=process.env.WEKNORA_BASE_URL,knowledgeBaseId=process.env.WEKNORA_KNOWLEDGE_BASE_ID;
    if(!baseUrl||!knowledgeBaseId)throw new EngineError("engine_not_installed");
    const client=new WeKnoraClient({baseUrl,secretResolver:async()=>process.env.WEKNORA_API_TOKEN,authMode:process.env.WEKNORA_AUTH_MODE==="jwt"?"jwt":"api_key"});
    return {manager,client,knowledgeBaseId,ingestor:new WeKnoraIngestor(store,new WeKnoraClientDocumentWriter(client,knowledgeBaseId,{readiness:{timeoutMs:engineReadinessTimeout()}}))};
  }
  if(manager.status().phase!=="ready"||!control.knowledgeBaseId)throw new EngineError("engine_not_ready");
  const knowledgeBaseId=control.knowledgeBaseId;
  const binding=control.bindings.find(b=>b.kind==="embedding")!;
  const client=new WeKnoraClient({baseUrl:runtime.baseUrl,secretResolver:async()=>manager.control().apiKey,authMode:"api_key"});
  const modelProvenance={knowledgeBaseId,providerId:binding.providerId,modelId:binding.modelId,dimensions:binding.dimensions!,indexVersion:binding.indexVersion};
  return {manager,client,knowledgeBaseId,ingestor:new WeKnoraIngestor(store,new WeKnoraClientDocumentWriter(client,knowledgeBaseId,{modelProvenance,readiness:{timeoutMs:engineReadinessTimeout()}}))};
}
export function activeWikiService(store:KnowledgeStore):WikiService|EngineWikiService{
  if(new MigrationController(store).activeProductProvider()==="relay_local")return new WikiService(store);
  const {manager,knowledgeBaseId}=managedControlPlane(store);
  return new EngineWikiService(store,{knowledgeBaseId,request:(method,path,body)=>manager.request(method,path,body)});
}
