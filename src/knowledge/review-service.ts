import { randomUUID } from "node:crypto";
import { assertLifecycleTransition, assertReviewer, type CandidateCard, type KnowledgeDocument, type KnowledgeKind, type KnowledgeLifecycle, type KnowledgeRedactionStatus, type KnowledgeScopeType, type KnowledgeVisibility } from "./domain.js";
import type { KnowledgeStore } from "./store.js";

type Row = Record<string, unknown>;
function entityEvidenceRefs(store: KnowledgeStore, kind: string, id: string): string[] {
  const linked = (store.db.prepare("SELECT evidence_id FROM knowledge_entity_evidence WHERE entity_type = ? AND entity_id = ?").all(kind, id) as Array<{ evidence_id: string }>).map((row) => row.evidence_id);
  const table = projectionTable(kind);
  if (!table) return [...new Set(linked)];
  const row = store.db.prepare(`SELECT evidence_refs_json FROM ${table} WHERE id = ?`).get(id) as { evidence_refs_json?: string } | undefined;
  let stored: string[] = [];
  try { const parsed = row?.evidence_refs_json ? JSON.parse(row.evidence_refs_json) : []; if (Array.isArray(parsed)) stored = parsed.filter((value): value is string => typeof value === "string"); } catch { /* malformed legacy metadata is ignored */ }
  return [...new Set([...linked, ...stored])];
}

function loadReviewerDocument(store: KnowledgeStore, userId: number, documentId: string): Row {
  const row = store.db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(documentId) as Row | undefined;
  if (!row || !store.canRead(userId, row.project_id as string | undefined)) throw new Error("Knowledge access denied");
  const acl = store.db.prepare("SELECT can_review FROM knowledge_acl WHERE project_id = ? AND user_id = ?").get(row.project_id, userId) as { can_review?: number } | undefined;
  assertReviewer(acl?.can_review === 1);
  return row;
}

function projectionTable(kind: unknown): string | undefined {
  if (kind === "case" || kind === "pattern" || kind === "playbook" || kind === "candidate") return `knowledge_${kind === "candidate" ? "candidates" : `${String(kind)}s`}`;
  return undefined;
}

function writeReview(store: KnowledgeStore, row: Row, userId: number, action: string, reason: string, before: unknown, after: unknown, now: string): void {
  store.db.prepare("INSERT INTO knowledge_reviews(id,document_id,entity_type,entity_id,reviewer_id,action,reason,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), String(row.id), String(row.kind), String(row.id), userId, action, reason, JSON.stringify(before), JSON.stringify(after), now);
  store.audit({ actorId: userId, projectId: row.project_id as string, action: `knowledge.${action}`, entityType: String(row.kind), entityId: String(row.id), details: { reason, before, after } });
}

export function reviewDocument(store: KnowledgeStore, userId: number, documentId: string, lifecycle: KnowledgeLifecycle, reason: string): void {
  if (!reason.trim()) throw new Error("Review reason is required");
  const row = loadReviewerDocument(store, userId, documentId);
  assertLifecycleTransition(row.lifecycle as KnowledgeLifecycle, lifecycle);
  const now = new Date().toISOString();
  store.db.transaction(() => {
    store.db.prepare("UPDATE knowledge_documents SET lifecycle = ?, updated_at = ? WHERE id = ?").run(lifecycle, now, documentId);
    const table = projectionTable(row.kind);
    if (table) {
      const verified = lifecycle === "verified" || lifecycle === "approved";
      store.db.prepare(`UPDATE ${table} SET status = ?, reviewed_by = ?, updated_at = ?${verified ? ", verified_at = COALESCE(verified_at, ?)" : ""} WHERE id = ?`)
        .run(...(verified ? [lifecycle, userId, now, now, documentId] : [lifecycle, userId, now, documentId]));
    }
    // Keep the historical action value (e.g. "approved") for consumers that
    // already aggregate review history by lifecycle name.
    writeReview(store, row, userId, lifecycle, reason, { lifecycle: row.lifecycle }, { lifecycle }, now);
  })();
}

export function acceptCandidate(store: KnowledgeStore, userId: number, candidateId: string, reason = "Candidate accepted"): void {
  const row = loadReviewerDocument(store, userId, candidateId);
  if (row.kind !== "candidate") throw new Error("Only candidates can be accepted");
  reviewDocument(store, userId, candidateId, "reproduced", reason);
}

export function rejectCandidate(store: KnowledgeStore, userId: number, candidateId: string, reason: string): void {
  const row = loadReviewerDocument(store, userId, candidateId);
  if (row.kind !== "candidate") throw new Error("Only candidates can be rejected");
  reviewDocument(store, userId, candidateId, "deprecated", reason);
}

export function editDocument(store: KnowledgeStore, userId: number, documentId: string, patch: { title?: string; body?: string }, reason: string): KnowledgeDocument {
  if (!reason.trim() || (patch.title === undefined && patch.body === undefined)) throw new Error("A reason and at least one document field are required");
  const row = loadReviewerDocument(store, userId, documentId);
  const before = { title: row.title, body: row.body };
  const now = new Date().toISOString();
  const title = patch.title ?? String(row.title);
  const body = patch.body ?? String(row.body);
  store.db.transaction(() => {
    store.db.prepare("UPDATE knowledge_documents SET title = ?, body = ?, updated_at = ? WHERE id = ?").run(title, body, now, documentId);
    writeReview(store, row, userId, "edit", reason, before, { title, body }, now);
  })();
  return { id: String(row.id), kind: row.kind as KnowledgeKind, title, body, lifecycle: row.lifecycle as KnowledgeLifecycle, projectId: row.project_id ? String(row.project_id) : undefined, locator: String(row.source_locator), createdAt: String(row.created_at), updatedAt: now };
}

export function editCandidateCard(store: KnowledgeStore, userId: number, candidateId: string, patch: Partial<Omit<CandidateCard, "candidateId" | "updatedAt" | "generatedBy" | "inferenceStatus">>, reason: string): CandidateCard {
  if (!reason.trim()) throw new Error("Card edit reason is required");
  const row = loadReviewerDocument(store, userId, candidateId);
  if (row.kind !== "candidate") throw new Error("Only candidates have Knowledge Cards");
  const existing = store.getCandidateCard(candidateId);
  if (!existing) throw new Error("Candidate Knowledge Card not found");
  if (patch.verifiedConclusion !== undefined && !["verified", "approved"].includes(String(row.lifecycle))) throw new Error("Verified conclusion requires a verified or approved lifecycle");
  const before = { ...existing };
  const next: CandidateCard = {
    ...existing,
    ...patch,
    candidateId,
    hypothesis: patch.hypothesis === undefined ? existing.hypothesis : (/^unconfirmed:/i.test(patch.hypothesis) ? patch.hypothesis : `unconfirmed: ${patch.hypothesis}`),
    confidence: patch.confidence === undefined ? existing.confidence : Math.max(0, Math.min(1, patch.confidence)),
    generatedBy: "reviewer-edit",
    inferenceStatus: "deterministic",
    updatedAt: new Date().toISOString(),
  };
  store.db.transaction(() => {
    store.saveCandidateCard(next);
    writeReview(store, row, userId, "edit.card", reason, before, next, next.updatedAt);
  })();
  return next;
}

export function mergeCandidates(store: KnowledgeStore, userId: number, sourceId: string, targetId: string, reason: string): void {
  if (sourceId === targetId) throw new Error("Cannot merge a document into itself");
  if (!reason.trim()) throw new Error("Merge reason is required");
  const source = loadReviewerDocument(store, userId, sourceId);
  const target = loadReviewerDocument(store, userId, targetId);
  if (source.kind !== "candidate" || target.kind !== "candidate") throw new Error("Merge requires candidate documents");
  if ((source.project_id ?? null) !== (target.project_id ?? null)) throw new Error("Cannot merge documents across projects");
  const now = new Date().toISOString();
  store.db.transaction(() => {
    store.db.prepare("INSERT OR IGNORE INTO knowledge_relations(id,from_document_id,to_document_id,relation_type,source_locator,confidence,verified,extraction_version,created_at,project_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(`merge-${randomUUID()}`, sourceId, targetId, "supersedes", `review:${sourceId}->${targetId}`, 1, 1, "review-v1", now, source.project_id ?? null);
    store.db.prepare("UPDATE knowledge_documents SET lifecycle = 'deprecated', updated_at = ? WHERE id = ?").run(now, sourceId);
    store.db.prepare("UPDATE knowledge_candidates SET status = 'deprecated', reviewed_by = ?, updated_at = ? WHERE id = ?").run(userId, now, sourceId);
    const sourceRefs = entityEvidenceRefs(store, "candidate", sourceId);
    for (const evidenceId of sourceRefs) {
      store.db.prepare("INSERT OR IGNORE INTO knowledge_entity_evidence(entity_type,entity_id,evidence_id,created_at) VALUES ('candidate',?,?,?)").run(targetId, evidenceId, now);
    }
    const targetRefs = entityEvidenceRefs(store, "candidate", targetId);
    store.db.prepare("UPDATE knowledge_candidates SET evidence_refs_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(targetRefs), now, targetId);
    writeReview(store, source, userId, "merge", reason, { targetId, lifecycle: source.lifecycle }, { targetId, lifecycle: "deprecated" }, now);
  })();
}

export function promoteCaseToPattern(store: KnowledgeStore, userId: number, caseId: string, input: { id: string; title: string; body?: string; reason: string; scopeType?: KnowledgeScopeType; scopeKey?: string; visibility?: KnowledgeVisibility; redactionStatus?: KnowledgeRedactionStatus }): KnowledgeDocument {
  const source = loadReviewerDocument(store, userId, caseId);
  if (source.kind !== "case" || !["verified", "approved"].includes(String(source.lifecycle))) throw new Error("Only verified or approved cases can be promoted");
  if (!input.reason.trim()) throw new Error("Promotion reason is required");
  const visibility = input.visibility ?? "project";
  const scopeType = input.scopeType ?? "project";
  const redactionStatus = input.redactionStatus ?? "unknown";
  if ((visibility === "global" || visibility === "organization") && redactionStatus !== "redacted") throw new Error("Cross-project Pattern promotion requires redactionStatus=redacted");
  if ((visibility === "global" || visibility === "organization") && !input.body?.trim()) throw new Error("Cross-project Pattern promotion requires an explicit generalized body");
  const existing = store.db.prepare("SELECT project_id FROM knowledge_documents WHERE id = ?").get(input.id) as { project_id?: string } | undefined;
  if (existing && (existing.project_id ?? null) !== (source.project_id ?? null)) throw new Error("Cannot overwrite a document in another project");
  const now = new Date().toISOString();
  const sourceCase = store.db.prepare("SELECT deployment_id FROM knowledge_cases WHERE id = ?").get(caseId) as { deployment_id?: string } | undefined;
  const sourceProjectId = source.project_id ? String(source.project_id) : undefined;
  const scopeKey = input.scopeKey ?? (scopeType === "version" ? (source.samplemanager_version ? String(source.samplemanager_version) : "") : scopeType === "solution" ? (source.solution ? String(source.solution) : "") : scopeType === "module" ? (source.module ? String(source.module) : "") : scopeType === "project" ? (sourceProjectId ?? "") : "");
  const pattern: KnowledgeDocument = { id: input.id, kind: "pattern", title: input.title, body: input.body ?? String(source.body), lifecycle: "draft", projectId: sourceProjectId, projectNameSnapshot: source.project_name_snapshot ? String(source.project_name_snapshot) : undefined, sampleManagerVersion: source.samplemanager_version ? String(source.samplemanager_version) : undefined, solution: source.solution ? String(source.solution) : undefined, module: source.module ? String(source.module) : undefined, environment: source.environment ? String(source.environment) : undefined, scopeType, scopeKey, visibility, sourceProjectId, sourceCaseId: caseId, sourceDeploymentId: sourceCase?.deployment_id ? String(sourceCase.deployment_id) : undefined, redactionStatus, locator: `promotion:${caseId}`, createdAt: now, updatedAt: now };
  store.upsertDocument(pattern);
  const sourceRefs = entityEvidenceRefs(store, "case", caseId);
  const propagatedRefs = visibility === "global" || visibility === "organization" ? [] : sourceRefs;
  store.db.prepare("UPDATE knowledge_patterns SET case_refs_json = ?, evidence_refs_json = ?, created_by = ?, updated_at = ? WHERE id = ?").run(JSON.stringify([caseId]), JSON.stringify(propagatedRefs), userId, now, input.id);
  for (const evidenceId of propagatedRefs) store.db.prepare("INSERT OR IGNORE INTO knowledge_entity_evidence(entity_type,entity_id,evidence_id,created_at) VALUES ('pattern',?,?,?)").run(input.id, evidenceId, now);
  writeReview(store, source, userId, "promote.case_to_pattern", input.reason, { caseId }, { patternId: input.id }, now);
  store.audit({ actorId: userId, projectId: sourceProjectId, action: "knowledge.scope.promoted", entityType: "pattern", entityId: input.id, details: { scopeType, scopeKey: pattern.scopeKey, visibility, sourceProjectId, sourceCaseId: caseId, redactionStatus, evidenceRefsPropagated: propagatedRefs.length } });
  return pattern;
}

export function proposePlaybook(store: KnowledgeStore, userId: number, input: { id: string; projectId: string; title: string; body: string; skillDiff?: string; reason: string }): KnowledgeDocument {
  if (!input.reason.trim()) throw new Error("Proposal reason is required");
  if (!store.canRead(userId, input.projectId)) throw new Error("Knowledge access denied");
  const acl = store.db.prepare("SELECT can_review FROM knowledge_acl WHERE project_id = ? AND user_id = ?").get(input.projectId, userId) as { can_review?: number } | undefined;
  assertReviewer(acl?.can_review === 1);
  const now = new Date().toISOString();
  const playbook: KnowledgeDocument = { id: input.id, kind: "playbook", title: input.title, body: input.body, lifecycle: "draft", projectId: input.projectId, locator: `proposal:${input.id}`, createdAt: now, updatedAt: now };
  store.upsertDocument(playbook);
  store.db.prepare("UPDATE knowledge_playbooks SET created_by = ?, skill_diff = ?, updated_at = ? WHERE id = ?").run(userId, input.skillDiff ?? null, now, input.id);
  writeReview(store, { id: input.id, kind: "playbook", project_id: input.projectId }, userId, "playbook.proposed", input.reason, {}, { skillDiff: input.skillDiff ?? null }, now);
  return playbook;
}

export const deprecateDocument = (store: KnowledgeStore, userId: number, documentId: string, reason: string) => reviewDocument(store, userId, documentId, "deprecated", reason);

// Short command aliases used by REST/MCP adapters.
export const accept = acceptCandidate;
export const reject = rejectCandidate;
export const edit = editDocument;
export const merge = mergeCandidates;
export const promote = promoteCaseToPattern;
export const deprecate = deprecateDocument;
