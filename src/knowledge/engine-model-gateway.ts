import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { classifyProviderError, type ManagedProviderHandle, type ManagedProviderKind, type ProviderRegistry } from "./provider-registry.js";
import type { ManagedChatMessage } from "./provider-probe.js";

export interface EngineModelBinding {
  providerId: string; kind: ManagedProviderKind; modelId: string; dimensions?: number;
  indexVersion: number; alias: string; engineModelId?: string;
}
interface GatewayOptions { registry: ProviderRegistry; token: () => string | undefined; bindings: () => EngineModelBinding[]; }
class GatewayError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
function strings(value: unknown, max: number): string[] {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || !list.length || list.length > max || list.some(x => typeof x !== "string" || !x.trim() || x.length > 500_000)) throw new GatewayError(400,"invalid_input");
  return list;
}
function messages(value: unknown): ManagedChatMessage[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new GatewayError(400,"invalid_messages");
  return value.map(x=>{
    if (!x || !["system","user","assistant"].includes(x.role) || typeof x.content !== "string") throw new GatewayError(400,"invalid_messages");
    return {role:x.role,content:x.content};
  });
}
function usage(value: {promptTokens?:number;completionTokens?:number;totalTokens?:number}|undefined) {
  return {prompt_tokens:value?.promptTokens??0,completion_tokens:value?.completionTokens??0,total_tokens:value?.totalTokens??0};
}

/** Internal-only alias gateway. Upstream never receives a user's provider credential. */
export async function registerEngineModelGateway(app: FastifyInstance, options: GatewayOptions): Promise<void> {
  const handles = new Map<string,{stamp:string;handle:ManagedProviderHandle}>();
  for (const operation of ["embeddings","chat/completions","rerank"] as const) {
    app.post("/internal/knowledge-engine/v1/"+operation, {bodyLimit:4*1024*1024}, async (request,reply)=>{
      try {
        const expected=options.token(), supplied=request.headers.authorization?.replace(/^Bearer /,"");
        if (!expected || !supplied || Buffer.byteLength(expected)!==Buffer.byteLength(supplied) || !timingSafeEqual(Buffer.from(expected),Buffer.from(supplied))) throw new GatewayError(401,"unauthorized");
        const body=request.body as Record<string,unknown>|undefined;
        const binding=options.bindings().find(x=>x.alias===body?.model);
        if (!binding) throw new GatewayError(403,"unknown_model_alias");
        const expectedKind=operation==="embeddings"?"embedding":operation==="rerank"?"rerank":"wiki_llm";
        if (binding.kind!==expectedKind) throw new GatewayError(403,"model_kind_mismatch");
        const config=options.registry.get(binding.providerId);
        if (!config || config.status==="disabled") throw new GatewayError(503,"provider_disabled");
        if (config.kind!==binding.kind || config.modelId!==binding.modelId || config.indexVersion!==binding.indexVersion || config.dimensions!==binding.dimensions) throw new GatewayError(409,"model_binding_stale");
        const stamp=JSON.stringify(config);
        let cached=handles.get(config.id);
        if (!cached || cached.stamp!==stamp) { cached={stamp,handle:options.registry.resolveCandidateProvider(config.id)}; handles.set(config.id,cached); }
        if (operation==="embeddings") {
          if (body?.dimensions!==undefined && body.dimensions!==binding.dimensions) throw new GatewayError(409,"dimension_mismatch");
          const result=await cached.handle.embed(strings(body?.input,128));
          return {object:"list",model:binding.alias,data:result.vectors.map((embedding,index)=>({object:"embedding",index,embedding})),usage:usage(result.tokenUsage)};
        }
        if (operation==="rerank") {
          const query=strings(body?.query,1)[0];
          const docs=strings(body?.documents,1000);
          const result=await cached.handle.rerank(query,docs.map((text,index)=>({id:String(index),text,score:0})));
          return {results:result.results.map(x=>({index:Number(x.id),relevance_score:x.score})),usage:usage(result.tokenUsage)};
        }
        const maxTokens=body?.max_tokens===undefined?4096:Number(body.max_tokens);
        if (!Number.isInteger(maxTokens)||maxTokens<1||maxTokens>32768) throw new GatewayError(400,"invalid_token_limit");
        const responseFormat=body?.response_format as {type?:string}|undefined;
        if (responseFormat && !["text","json_object"].includes(String(responseFormat.type))) throw new GatewayError(400,"unsupported_response_format");
        const result=await cached.handle.chat(messages(body?.messages),maxTokens,responseFormat as {type:"text"|"json_object"}|undefined);
        const id="chatcmpl-"+randomUUID(),created=Math.floor(Date.now()/1000),model=binding.alias;
        if (body?.stream===true) {
          const chunk={id,object:"chat.completion.chunk",created,model,choices:[{index:0,delta:{role:"assistant",content:result.text},finish_reason:null}]};
          const done={id,object:"chat.completion.chunk",created,model,choices:[{index:0,delta:{},finish_reason:result.finishReason??"stop"}],usage:usage(result.tokenUsage)};
          return reply.type("text/event-stream").header("cache-control","no-cache").send("data: "+JSON.stringify(chunk)+"\n\ndata: "+JSON.stringify(done)+"\n\ndata: [DONE]\n\n");
        }
        return {id,object:"chat.completion",created,model,choices:[{index:0,message:{role:"assistant",content:result.text},finish_reason:result.finishReason??"stop"}],usage:usage(result.tokenUsage)};
      } catch(error) {
        const status=error instanceof GatewayError?error.status:503;
        return reply.code(status).send({error:{code:error instanceof GatewayError?error.code:classifyProviderError(error),message:"Knowledge engine model request failed"}});
      }
    });
  }
}
