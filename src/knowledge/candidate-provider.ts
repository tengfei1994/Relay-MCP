import type { ManagedCandidateInsightProvider } from "./candidate-insight.js";
import type { ManagedProviderHandle } from "./provider-registry.js";
import { createManagedProviderRegistry } from "./provider-setup.js";
import type { KnowledgeStore } from "./store.js";

export function candidateProviderAdapter(handle:ManagedProviderHandle,modelId:string):ManagedCandidateInsightProvider {
  return {providerId:handle.providerId,modelId,complete:async(request)=>{
    const result=await handle.chat([{role:"user",content:request.prompt}],request.maxTokens??4096,{type:"json_object"},{signal:request.signal,timeoutMs:request.timeoutMs});
    return result.text;
  }};
}
export function createCandidateInsightProvider(store:KnowledgeStore,providerId?:string):ManagedCandidateInsightProvider {
  if(!providerId)return {providerId:"unconfigured",modelId:"deterministic-fallback",complete:async()=>{throw new Error("Candidate provider is not configured");}};
  const registry=createManagedProviderRegistry(store),config=registry.get(providerId);
  if(!config||config.kind!=="candidate_llm")throw new Error("Candidate provider is unavailable");
  return candidateProviderAdapter(registry.resolveCandidateProvider(config.id),config.modelId);
}
