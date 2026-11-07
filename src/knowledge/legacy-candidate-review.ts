import { randomUUID } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import { reviewMemorySubmission, submitMemory, type MemoryAccess } from "./memory-v2.js";
import type { ConfirmedMemoryType } from "./confirmed-memory.js";

type Row=Record<string,unknown>;
function evidenceRefs(store:KnowledgeStore,row:Row):string[] {
  let legacy:unknown; try { legacy=JSON.parse(String(row.evidence_refs_json ?? "[]")); } catch { legacy=[]; }
  const linked=store.db.prepare("SELECT evidence_id FROM knowledge_entity_evidence WHERE entity_type='candidate' AND entity_id=?").all(row.id) as Array<{evidence_id:string}>;
  return [...new Set([...(Array.isArray(legacy) ? legacy.filter((value):value is string => typeof value === "string") : []),...linked.map(value=>value.evidence_id)])];
}
function load(store:KnowledgeStore,id:string):Row|undefined {
  return store.db.prepare(`SELECT d.id,d.title,d.body,d.lifecycle,d.project_id,d.environment,d.created_at,d.updated_at,c.candidate_type,c.evidence_refs_json
    FROM knowledge_documents d JOIN knowledge_candidates c ON c.id=d.id WHERE d.kind='candidate' AND d.id=?`).get(id) as Row|undefined;
}
export function listLegacyCandidatesForReview(store:KnowledgeStore,access:MemoryAccess,input:{limit?:number;offset?:number}={}) {
  if(!access.isAdmin) throw new Error("Administrator access is required");
  const limit=Math.max(1,Math.min(200,Math.trunc(input.limit ?? 50))),offset=Math.max(0,Math.trunc(input.offset ?? 0));
  const rows=store.db.prepare(`SELECT d.id,d.title,d.body,d.lifecycle,d.project_id,d.environment,d.created_at,d.updated_at,c.candidate_type,c.evidence_refs_json,
    (SELECT r.action FROM knowledge_legacy_candidate_reviews r WHERE r.candidate_id=d.id ORDER BY r.rowid DESC LIMIT 1) AS review_action,
    (SELECT r.memory_id FROM knowledge_legacy_candidate_reviews r WHERE r.candidate_id=d.id ORDER BY r.rowid DESC LIMIT 1) AS memory_id,
    (SELECT r.reason FROM knowledge_legacy_candidate_reviews r WHERE r.candidate_id=d.id ORDER BY r.rowid DESC LIMIT 1) AS review_reason
    FROM knowledge_documents d JOIN knowledge_candidates c ON c.id=d.id WHERE d.kind='candidate' ORDER BY d.updated_at DESC,d.id LIMIT ? OFFSET ?`).all(limit,offset) as Row[];
  return rows.map(row=>({id:String(row.id),title:String(row.title),statement:String(row.body),projectId:row.project_id ?? undefined,environment:row.environment ?? undefined,
    candidateType:row.candidate_type,evidenceRefs:evidenceRefs(store,row),status:row.review_action ?? "pending",memoryId:row.memory_id ?? undefined,reviewReason:row.review_reason ?? undefined,createdAt:row.created_at,updatedAt:row.updated_at}));
}
export function reviewLegacyCandidate(store:KnowledgeStore,access:MemoryAccess,input:{id:string;action:"approve"|"reject"|"needs_info";reason:string;scope?:"project"|"general";title?:string;statement?:string;memoryType?:ConfirmedMemoryType;evidenceRefs?:string[]}) {
  if(!access.isAdmin) throw new Error("Administrator access is required");
  if(!input.reason.trim()) throw new Error("Review reason is required");
  return store.db.transaction(() => {
    const row=load(store,input.id); if(!row) throw new Error("Historical candidate not found");
    const previous=store.db.prepare("SELECT action,memory_id,submission_id FROM knowledge_legacy_candidate_reviews WHERE candidate_id=? ORDER BY rowid DESC LIMIT 1").get(input.id) as Row|undefined;
    if(previous && ["approve","reject"].includes(String(previous.action))) throw new Error("Historical candidate has already been reviewed");
    const projectId=row.project_id ? String(row.project_id) : undefined;
    let memoryId:string|undefined,submissionId:string|undefined;
    if(input.action==="approve") {
      const scope=input.scope ?? (projectId ? "project" : "general");
      if(scope==="project" && !projectId) throw new Error("Project scope requires a source project");
      const title=input.title?.trim(),statement=input.statement?.trim();
      if(!title || !statement) throw new Error("A reviewed title and experience are required");
      const attached=evidenceRefs(store,row), selected=input.evidenceRefs ?? [];
      if(selected.some(id=>!attached.includes(id))) throw new Error("Evidence is not attached to this candidate");
      // This grant is scoped to the candidate being reviewed and never alters project ACLs.
      const reviewAccess:MemoryAccess={...access,canReadGeneral:()=>true,assertProject:id=>{if(id!==projectId)throw new Error("Project access denied");}};
      const submission=submitMemory(store,reviewAccess,{idempotencyKey:`legacy-review:${input.id}`,requestedScope:scope,projectId,title,statement,memoryType:input.memoryType ?? "Case",evidenceRefs:selected});
      const confirmed=reviewMemorySubmission(store,reviewAccess,{id:submission.id,action:"approve",reason:input.reason,scope,title,statement});
      memoryId=confirmed.memoryId ? String(confirmed.memoryId) : undefined; submissionId=submission.id;
      if(memoryId) store.db.prepare("UPDATE knowledge_confirmed_memories SET source_json=? WHERE id=?").run(JSON.stringify({kind:"legacy",id:input.id,locator:`legacy-candidate:${input.id}`}),memoryId);
    }
    const now=new Date().toISOString();
    store.db.prepare("INSERT INTO knowledge_legacy_candidate_reviews(id,candidate_id,reviewer_id,action,reason,memory_id,submission_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(),input.id,access.actorId,input.action,input.reason,memoryId ?? null,submissionId ?? null,now);
    store.audit({actorId:access.actorId,projectId,action:`memory.legacy_candidate.${input.action}`,entityType:"candidate",entityId:input.id,details:{memoryId,submissionId,reason:input.reason}});
    return {id:input.id,status:input.action,memoryId,submissionId};
  }).immediate();
}
