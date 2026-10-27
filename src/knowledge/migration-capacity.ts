import {createHash} from "node:crypto";
import type {KnowledgeStore} from "./store.js";
import type {SourceManifestDocument} from "./migration-control.js";
import {getEngineManager} from "./engine-service.js";
import {inspectProviderAdmission} from "./provider-admission.js";

export interface CapacityDeferral {deferUntil:string;reason:string;}

export class MigrationProviderFailureError extends Error {
 readonly code="migration_provider_failure";
 constructor(){super("Embedding provider failed; migration progress is preserved. Verify the provider before retrying.");}
}
/** The gateway runs in another process. Its durable, metadata-only error audit
 * tells the worker that a failed document was accompanied by a provider fault.
 * Stop the pass instead of submitting more documents to the same failing model. */
export function assertMigrationProviderHealthySince(store:KnowledgeStore,providerId:string,afterAuditRowId:number):void{
 const failed=store.db.prepare("SELECT 1 FROM knowledge_audit WHERE rowid>? AND action='knowledge.provider.invoke_error' AND entity_type='provider' AND entity_id=? LIMIT 1").get(afterAuditRowId,providerId);
 if(failed)throw new MigrationProviderFailureError();
}
/** A conservative forecast, not a reservation. The gateway still admits every
 * real invocation atomically; concurrent consumers can only cause a hard denial,
 * never bypass the quota. Failed parsing is not silently retried. */
export function assessProviderCapacity(store:KnowledgeStore,providerId:string,requests:number,now=new Date()):CapacityDeferral|undefined{
 if(!Number.isSafeInteger(requests)||requests<1)throw new Error("document_embedding_budget_invalid");
 const allowance=inspectProviderAdmission(store,providerId,now);
 if(allowance.maxCalls===null)return;
 if(requests>allowance.maxCalls)throw new Error("document_exceeds_provider_window");
 if(allowance.remaining!==null&&allowance.remaining>=requests)return;
 let next=allowance.blockedUntil?Date.parse(allowance.blockedUntil):0,reason="provider_upgrade_barrier";
 const needed=allowance.used+requests-allowance.maxCalls;
 if(needed>0){
   const row=store.db.prepare("SELECT admitted_at FROM knowledge_provider_admissions WHERE provider_id=? AND admitted_at>? ORDER BY admitted_at LIMIT 1 OFFSET ?").get(providerId,now.getTime()-allowance.windowMs!,needed-1) as {admitted_at:number}|undefined;
   if(!row)throw new Error("provider_admission_forecast_invalid");
   const expires=row.admitted_at+allowance.windowMs!;
   if(expires>next){next=expires;reason="provider_rolling_quota";}
 }
 if(next<=now.getTime())throw new Error("provider_admission_forecast_invalid");
 return {deferUntil:new Date(next).toISOString(),reason};
}

export async function assessMigrationDocumentCapacity(store:KnowledgeStore,document:SourceManifestDocument&{body:string}):Promise<CapacityDeferral|undefined>{
 const manager=getEngineManager(store),control=manager.control();
 if(!manager.runtime()||control.ingestionProfile!=="bulk")return;
 const binding=control.bindings.find(b=>b.kind==="embedding");
 if(!binding)throw new Error("engine_embedding_binding_missing");
 const row=store.db.prepare("SELECT metadata_json FROM knowledge_product_documents WHERE id=?").get(document.localDocumentId) as {metadata_json:string}|undefined;
 const budget=row?JSON.parse(row.metadata_json).engineAcceptance:undefined;
 if(!budget||!/^[a-f0-9]{64}$/.test(budget.manifestSha256??"")||budget.bodySha256!==document.bodySha256||budget.bodySha256!==createHash("sha256").update(document.body).digest("hex"))throw new Error("document_embedding_budget_missing_or_stale");
 return assessProviderCapacity(store,binding.providerId,budget.embeddingRequests);
}
