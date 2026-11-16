import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import { confirmedMemoryFromRow, CONFIRMED_MEMORY_TYPES, validateConfirmedMemoryDetails, type ConfirmedMemoryType } from "./confirmed-memory.js";
import { scanCandidateContent } from "./candidate-insight.js";
import { publicSourceLocation } from "./source-display.js";

export type MemoryScope = "project" | "general" | "both";
export interface MemoryAccess {
  actorId: number;
  isAdmin: boolean;
  canReadGeneral: () => boolean;
  assertProject: (projectId: string) => void;
}
type Row = Record<string, unknown>;
function parse<T>(value: unknown, fallback: T): T { try { return JSON.parse(String(value ?? "")) as T; } catch { return fallback; } }
function projectAllowed(access: MemoryAccess, projectId?: string | null): boolean {
  if (!projectId) return false;
  try { access.assertProject(projectId); return true; } catch { return false; }
}
function publicMemory(row: Row, access: MemoryAccess) {
  const memory = confirmedMemoryFromRow(row);
  memory.source={...memory.source,locator:publicSourceLocation(memory.source.locator) ?? "Source unavailable",...(memory.source.sourceRefs ? {sourceRefs:memory.source.sourceRefs.map(ref=>publicSourceLocation(ref) ?? "Source unavailable")} : {})};
  const scope = String(row.memory_scope ?? "project");
  const sourceProjectId = row.source_project_id ? String(row.source_project_id) : undefined;
  if (scope === "general" && sourceProjectId && !projectAllowed(access, sourceProjectId)) {
    // The approved general statement is shared; its private source and Evidence are not.
    return { ...memory, scope: { scopeType: "global", scopeKey: "global", visibility: "global" }, evidenceRefs: [], source: { kind: memory.source.kind, locator: "reviewed submission" }, audit: { action:memory.audit.action, reason:"Source details are restricted" }, memoryScope: scope };
  }
  return { ...memory, memoryScope: scope, ...(sourceProjectId ? { sourceProjectId } : {}) };
}

export function searchConfirmedMemories(store: KnowledgeStore, access: MemoryAccess, input: { query?: string; scope?: MemoryScope; projectId?: string; type?: ConfirmedMemoryType; environment?: string; limit?: number; offset?: number }) {
  const scope = input.scope ?? (input.projectId ? "both" : "general");
  const includeProject = scope !== "general";
  const includeGeneral = scope !== "project";
  if (includeProject && !input.projectId) throw new Error("projectId is required for project Memory");
  if (includeProject) access.assertProject(input.projectId!);
  const generalAllowed = includeGeneral && access.canReadGeneral();
  if (scope === "general" && !generalAllowed) throw new Error("Product Knowledge and general Memory access denied");
  const filters: string[] = [], params: unknown[] = [];
  if (includeProject) { filters.push("(memory_scope='project' AND project_id=?)"); params.push(input.projectId); }
  if (generalAllowed) filters.push("memory_scope='general'");
  const where = [`(${filters.join(" OR ") || "0"})`, "status='confirmed'"];
  if (input.type) { where.push("memory_type=?"); params.push(input.type); }
  if (input.environment) { where.push("(memory_scope='general' OR environment IS NULL OR environment=?)"); params.push(input.environment); }
  const words = (input.query ?? "").trim().split(/\s+/u).filter(Boolean).slice(0, 16);
  for (const word of words) {
    const term = `%${word.toLocaleLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
    where.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(statement) LIKE ? ESCAPE '\\' OR lower(details_json) LIKE ? ESCAPE '\\')");
    params.push(term, term, term);
  }
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)));
  const offset = Math.max(0, Math.min(1_000_000, Math.trunc(input.offset ?? 0)));
  const clause = where.join(" AND ");
  const total = Number((store.db.prepare(`SELECT COUNT(*) AS n FROM knowledge_confirmed_memories WHERE ${clause}`).get(...params) as { n: number }).n);
  const rows = store.db.prepare(`SELECT * FROM knowledge_confirmed_memories WHERE ${clause} ORDER BY confirmed_at DESC,id LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[];
  // Recheck immediately before returning content.
  if (includeProject) access.assertProject(input.projectId!);
  if (generalAllowed && !access.canReadGeneral()) throw new Error("Product Knowledge and general Memory access denied");
  return { results: rows.map(row => publicMemory(row, access)), page: { limit, offset, total }, scope, generalAccess: includeGeneral ? (generalAllowed ? "available" : "denied") : "not_requested" };
}

export function getConfirmedMemory(store: KnowledgeStore, access: MemoryAccess, id: string) {
  const row = store.db.prepare("SELECT * FROM knowledge_confirmed_memories WHERE id=? AND status='confirmed'").get(id) as Row | undefined;
  if (!row || row.memory_scope === "review") throw new Error("Confirmed Memory not found");
  if (row.memory_scope === "general") {
    if (!access.canReadGeneral()) throw new Error("Product Knowledge and general Memory access denied");
  } else access.assertProject(String(row.project_id));
  return publicMemory(row, access);
}

/** Legacy cross-project records remain quarantined until an administrator reviews their sharing scope. */
export function legacyMemoryReviewQueue(store: KnowledgeStore, access: MemoryAccess, input:{limit?:number;offset?:number} = {}) {
  if (!access.isAdmin) throw new Error("Administrator access is required");
  const limit=Math.max(1,Math.min(200,Math.trunc(input.limit ?? 50))),offset=Math.max(0,Math.trunc(input.offset ?? 0));
  return (store.db.prepare("SELECT * FROM knowledge_confirmed_memories WHERE memory_scope='review' ORDER BY updated_at DESC,id LIMIT ? OFFSET ?").all(limit,offset) as Row[])
    .map(row => ({ ...confirmedMemoryFromRow(row), sourceProjectId:row.source_project_id ?? row.project_id, memoryScope:"review" }));
}
export function reviewLegacyMemoryScope(store: KnowledgeStore, access: MemoryAccess, input: { id:string; scope:"project"|"general"; reason:string; title?:string; statement?:string }) {
  if (!access.isAdmin) throw new Error("Administrator access is required");
  if (!input.reason.trim()) throw new Error("Review reason is required");
  return store.db.transaction(() => {
    const row = store.db.prepare("SELECT * FROM knowledge_confirmed_memories WHERE id=? AND memory_scope='review'").get(input.id) as Row | undefined;
    if (!row) throw new Error("Legacy Memory is not awaiting scope review");
    const projectId = row.source_project_id ?? row.project_id;
    if (input.scope === "project" && !projectId) throw new Error("Project scope requires a source project");
    const statement = input.statement?.trim() || String(row.statement), title = input.title?.trim() || String(row.title);
    const disallowed = scanCandidateContent({statement,title}); if (disallowed) throw new Error(`Review contains ${disallowed}`);
    const now = new Date().toISOString();
    const binding = input.scope === "general" ? {scopeType:"global",scopeKey:"global",visibility:"global"} : {projectId,scopeType:"project",scopeKey:projectId,visibility:"project"};
    const details = input.scope === "general" && projectId ? safeGeneralDetails(String(row.memory_type) as ConfirmedMemoryType,title,statement) : parse<Record<string,unknown>>(row.details_json,{});
    store.db.prepare("UPDATE knowledge_confirmed_memories SET memory_scope=?,project_id=?,source_project_id=?,scope_json=?,title=?,statement=?,details_json=?,updated_at=? WHERE id=? AND memory_scope='review'").run(input.scope,input.scope === "project" ? projectId : null,projectId ?? null,JSON.stringify(binding),title,statement,JSON.stringify(details),now,input.id);
    store.db.prepare("INSERT INTO knowledge_memory_scope_reviews(id,memory_id,reviewer_id,previous_scope,new_scope,reason,previous_statement,reviewed_statement,previous_title,previous_details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),input.id,access.actorId,"review",input.scope,input.reason,String(row.statement),statement,String(row.title),String(row.details_json),now);
    store.audit({actorId:access.actorId,projectId:projectId ? String(projectId) : undefined,action:"memory.legacy_scope.reviewed",entityType:"confirmed_memory",entityId:input.id,details:{scope:input.scope,reason:input.reason}});
    return { id:input.id, scope:input.scope };
  }).immediate();
}

function safeGeneralDetails(type: ConfirmedMemoryType, title: string, statement: string): Record<string, unknown> {
  const missing = "Not provided";
  return type === "Fact" ? {subject:title,value:statement}
    : type === "Decision" ? {decision:statement,rationale:missing,alternatives:[]}
    : type === "Case" ? {symptoms:statement,rootCause:missing,resolution:missing,verification:missing}
    : {statement,applicability:missing,signals:[],exceptions:[]};
}

export interface MemorySubmissionInput {
  idempotencyKey: string; requestedScope: "project" | "general"; projectId?: string;
  title: string; memoryType: ConfirmedMemoryType; statement: string;
  objective?: string; outcome?: string; applicability?: string; unknowns?: string[];
  evidenceRefs?: string[]; sourceRefs?:string[]; workSessionId?: string;
}
function submissionFromRow(row: Row) {
  return { id: String(row.id), actorId: Number(row.actor_id), projectId: row.project_id ? String(row.project_id) : undefined,
    requestedScope: String(row.requested_scope), title: String(row.title), memoryType: String(row.memory_type), statement: String(row.statement),
    ...parse<Record<string, unknown>>(row.context_json, {}), evidenceRefs: parse<string[]>(row.evidence_refs_json, []),
    workSessionId: row.work_session_id ? String(row.work_session_id) : undefined, status: String(row.status),
    reviewerId: row.reviewer_id == null ? undefined : Number(row.reviewer_id), reviewedAt: row.reviewed_at ?? undefined, reviewReason: row.review_reason ?? undefined,
    memoryId: row.memory_id ?? undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

export function submitMemory(store: KnowledgeStore, access: MemoryAccess, input: MemorySubmissionInput) {
  if (!input.idempotencyKey?.trim() || !input.title?.trim() || !input.statement?.trim()) throw new Error("Submission key, title and statement are required");
  if (!CONFIRMED_MEMORY_TYPES.includes(input.memoryType)) throw new Error("Invalid Memory type");
  if (input.requestedScope === "project" && !input.projectId) throw new Error("projectId is required for project Memory");
  if (input.projectId) access.assertProject(input.projectId);
  else if (!access.canReadGeneral()) throw new Error("Product Knowledge and general Memory access denied");
  const disallowed = scanCandidateContent(input); if (disallowed) throw new Error(`Submission contains ${disallowed}`);
  const refs = [...new Set(input.evidenceRefs ?? [])];
  for (const id of refs) {
    const row = store.db.prepare("SELECT project_id FROM knowledge_evidence WHERE id=? AND deleted_at IS NULL").get(id) as { project_id?: string } | undefined;
    if (!row || !input.projectId || (row.project_id !== input.projectId && !store.db.prepare("SELECT 1 FROM knowledge_evidence_acl WHERE evidence_id=? AND project_id=?").get(id, input.projectId))) throw new Error("Evidence is unavailable in the selected project");
  }
  if (input.workSessionId) {
    const row = store.db.prepare("SELECT actor_id,project_id FROM knowledge_work_sessions WHERE id=?").get(input.workSessionId) as { actor_id: number; project_id: string } | undefined;
    if (!row || row.actor_id !== access.actorId || row.project_id !== input.projectId) throw new Error("Work Session is unavailable in the selected project");
  }
  const context = { objective: input.objective, outcome: input.outcome, applicability: input.applicability, unknowns: input.unknowns ?? [],sourceRefs:input.sourceRefs ?? [] };
  const hash = createHash("sha256").update(JSON.stringify({ ...input, evidenceRefs: refs })).digest("hex");
  return store.db.transaction(() => {
    if (input.projectId) access.assertProject(input.projectId); else if (!access.canReadGeneral()) throw new Error("Product Knowledge and general Memory access denied");
    const existing = store.db.prepare("SELECT * FROM knowledge_memory_submissions WHERE actor_id=? AND idempotency_key=?").get(access.actorId, input.idempotencyKey) as Row | undefined;
    if (existing) { if (existing.input_hash !== hash) throw new Error("Idempotency key belongs to a different submission"); return submissionFromRow(existing); }
    const now = new Date().toISOString(), id = `memory-submission-${randomUUID()}`;
    store.db.prepare(`INSERT INTO knowledge_memory_submissions(id,actor_id,project_id,requested_scope,title,memory_type,statement,context_json,evidence_refs_json,work_session_id,idempotency_key,input_hash,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(id, access.actorId, input.projectId ?? null, input.requestedScope, input.title, input.memoryType, input.statement, JSON.stringify(context), JSON.stringify(refs), input.workSessionId ?? null, input.idempotencyKey, hash, now, now);
    store.audit({ actorId: access.actorId, projectId: input.projectId, action: "memory.submitted", entityType: "memory_submission", entityId: id, details: { requestedScope: input.requestedScope, memoryType: input.memoryType, evidenceCount: refs.length } });
    return submissionFromRow(store.db.prepare("SELECT * FROM knowledge_memory_submissions WHERE id=?").get(id) as Row);
  }).immediate();
}

export function getMemorySubmission(store: KnowledgeStore, access: MemoryAccess, id: string) {
  const row = store.db.prepare("SELECT * FROM knowledge_memory_submissions WHERE id=?").get(id) as Row | undefined;
  if (!row || (Number(row.actor_id) !== access.actorId && !access.isAdmin)) throw new Error("Memory submission not found");
  if (!access.isAdmin && row.project_id) access.assertProject(String(row.project_id));
  if (!access.isAdmin && !row.project_id && !access.canReadGeneral()) throw new Error("Product Knowledge and general Memory access denied");
  return submissionFromRow(row);
}

export function listMemorySubmissions(store: KnowledgeStore, access: MemoryAccess, input: { status?: string; limit?: number; offset?: number } = {}) {
  const limit = Math.max(1, Math.min(200, input.limit ?? 50)), offset = Math.max(0, input.offset ?? 0);
  const where = [access.isAdmin ? "1=1" : "actor_id=?"], params: unknown[] = access.isAdmin ? [] : [access.actorId];
  if (!access.isAdmin) {
    const projects=(store.db.prepare("SELECT DISTINCT project_id FROM knowledge_memory_submissions WHERE actor_id=? AND project_id IS NOT NULL").all(access.actorId) as Array<{project_id:string}>).map(row=>row.project_id).filter(id=>projectAllowed(access,id));
    where.push("(project_id IN (SELECT value FROM json_each(?)) OR (project_id IS NULL AND ?=1))");
    params.push(JSON.stringify(projects),access.canReadGeneral() ? 1 : 0);
  }
  if (input.status) { where.push("status=?"); params.push(input.status); }
  const total=Number((store.db.prepare(`SELECT COUNT(*) AS n FROM knowledge_memory_submissions WHERE ${where.join(" AND ")}`).get(...params) as {n:number}).n);
  const rows = store.db.prepare(`SELECT * FROM knowledge_memory_submissions WHERE ${where.join(" AND ")} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[];
  return { submissions:rows.filter(row => access.isAdmin || (row.project_id ? projectAllowed(access, String(row.project_id)) : access.canReadGeneral())).map(submissionFromRow),page:{limit,offset,total} };
}

export function reviewMemorySubmission(store: KnowledgeStore, access: MemoryAccess, input: { id: string; action: "approve" | "reject" | "needs_info"; reason: string; scope?: "project" | "general"; title?: string; statement?: string; details?: Record<string, unknown> }) {
  if (!access.isAdmin) throw new Error("Administrator access is required");
  if (!input.reason.trim()) throw new Error("Review reason is required");
  const disallowed = scanCandidateContent(input); if (disallowed) throw new Error(`Review contains ${disallowed}`);
  return store.db.transaction(() => {
    const row = store.db.prepare("SELECT * FROM knowledge_memory_submissions WHERE id=?").get(input.id) as Row | undefined;
    if (!row) throw new Error("Memory submission not found");
    if (!["pending", "needs_info"].includes(String(row.status))) throw new Error("Memory submission is already reviewed");
    const now = new Date().toISOString(), scope = input.scope ?? row.requested_scope;
    let memoryId: string | null = null;
    if (input.action === "approve") {
      const projectId = row.project_id ? String(row.project_id) : undefined;
      if (scope === "project" && !projectId) throw new Error("Project scope requires a source project");
      const type = String(row.memory_type) as ConfirmedMemoryType, title = input.title?.trim() || String(row.title), statement = input.statement?.trim() || String(row.statement);
      const context = parse<Record<string, unknown>>(row.context_json, {}), unknowns = Array.isArray(context.unknowns) ? context.unknowns.map(String) : [];
      const missing = "Not provided";
      const details = input.details ?? (scope === "general" && projectId ? safeGeneralDetails(type,title,statement) : type === "Fact" ? { subject: title, value: statement }
        : type === "Decision" ? { decision: statement, rationale: String(context.objective || missing), alternatives: unknowns }
        : type === "Case" ? { symptoms: statement, rootCause: missing, resolution: String(context.outcome || missing), verification: missing }
        : { statement, applicability: String(context.applicability || missing), signals: [], exceptions: unknowns });
      validateConfirmedMemoryDetails(type, details);
      const binding = scope === "general" ? { scopeType: "global", scopeKey: "global", visibility: "global" } : { projectId, scopeType: "project", scopeKey: projectId, visibility: "project" };
      memoryId = `memory-${randomUUID()}`;
      store.db.prepare(`INSERT INTO knowledge_confirmed_memories(id,memory_type,title,statement,details_json,project_id,environment,scope_json,evidence_refs_json,source_json,confirmed_by,confirmed_at,audit_json,status,created_at,updated_at,memory_scope,source_project_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'confirmed',?,?,?,?)`).run(memoryId, type, title, statement, JSON.stringify(details), scope === "project" ? projectId : null, null, JSON.stringify(binding), row.evidence_refs_json, JSON.stringify({ kind: "agent_submission", id: row.id, locator: `submission:${row.id}`,sourceRefs:Array.isArray(context.sourceRefs) ? context.sourceRefs : [] }), access.actorId, now, JSON.stringify({ action: "promote", reason: input.reason }), now, now, scope, projectId ?? null);
      for (const evidenceId of parse<string[]>(row.evidence_refs_json, [])) store.db.prepare("INSERT OR IGNORE INTO knowledge_entity_evidence(entity_type,entity_id,evidence_id,created_at) VALUES ('confirmed_memory',?,?,?)").run(memoryId, evidenceId, now);
    }
    const status = input.action === "approve" ? "approved" : input.action === "reject" ? "rejected" : "needs_info";
    store.db.prepare("UPDATE knowledge_memory_submissions SET status=?,reviewer_id=?,review_reason=?,reviewed_at=?,memory_id=?,updated_at=? WHERE id=?").run(status, access.actorId, input.reason, now, memoryId, now, input.id);
    store.audit({ actorId: access.actorId, projectId: row.project_id ? String(row.project_id) : undefined, action: `memory.submission.${status}`, entityType: "memory_submission", entityId: input.id, details: { scope, memoryId } });
    return submissionFromRow(store.db.prepare("SELECT * FROM knowledge_memory_submissions WHERE id=?").get(input.id) as Row);
  }).immediate();
}
