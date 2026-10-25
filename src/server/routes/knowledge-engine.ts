import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {getKnowledgeStore} from "../knowledge-context.js";
import {getEngineManager} from "../../knowledge/engine-service.js";
import {registerEngineModelGateway} from "../../knowledge/engine-model-gateway.js";
import {createManagedProviderRegistry} from "../../knowledge/provider-setup.js";
import {EngineError} from "../../knowledge/engine-config.js";
export async function knowledgeEngineRoutes(app:FastifyInstance){
  const store=getKnowledgeStore(),manager=getEngineManager(store);
  await registerEngineModelGateway(app,{registry:createManagedProviderRegistry(store),token:()=>manager.runtime()?.gatewayToken,bindings:()=>manager.bindings()});
  app.get("/api/knowledge/engine",{onRequest:[app.authenticate]},async(request,reply)=>{
    if(!request.user.isAdmin)return reply.code(403).send({error:"Administrator access is required"});
    try{return await manager.inspect();}catch(error){return reply.code(503).send({error:error instanceof EngineError?error.code:"engine_unavailable"});}
  });
  app.post("/api/knowledge/engine/initialize",{onRequest:[app.authenticate]},async(request,reply)=>{
    if(!request.user.isAdmin)return reply.code(403).send({error:"Administrator access is required"});
    const body=z.object({embeddingProviderId:z.string().optional(),wikiProviderId:z.string().optional(),rerankProviderId:z.string().optional()}).safeParse(request.body??{});
    if(!body.success)return reply.code(400).send({error:"Invalid provider selection"});
    try{
      const result=await manager.initialize({actorId:request.user.id,...body.data});
      store.audit({actorId:request.user.id,action:"knowledge.engine.initialize",entityType:"engine",entityId:"managed",details:{phase:result.phase}});
      return result;
    }catch(error){return reply.code(error instanceof EngineError&&error.status<500?error.status:503).send({error:error instanceof EngineError?error.code:"engine_unavailable"});}
  });
}
