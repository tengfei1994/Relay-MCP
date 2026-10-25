import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertReviewer } from "./domain.js";
import type { KnowledgeStore } from "./store.js";
import { KnowledgeRepository } from "./repository.js";
import { WorkSessionService } from "./work-session.js";
import { candidateScopeSnapshot } from "./candidate-scope.js";
import {
  CANDIDATE_INSIGHT_KINDS,
  candidateInsightFromRow,
  scanCandidateContent,
  type CandidateInsight,
  type CandidateInsightStatus,
} from "./candidate-insight.js";

export interface CandidateInsightReviewRecord {
  id: string;
  insightId: string;
  reviewerId: number;
  action: "confirm" | "edit" | "reject" | "promote";
  reason: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface CandidateInsightPromotion {
  target: "case" | "decision";
  mode: "persisted" | "metadata_only";
  targetId?: string;
  reason: string;
  promotedBy: number;
  promotedAt: string;
  note?: string;
}

const editPatchSchema = z.object({
  kind: z.enum(CANDIDATE_INSIGHT_KINDS).optional(),
  statement: z.string().trim().min(1).max(4_000).optional(),
  whyProposed: z.string().trim().min(1).max(4_000).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
  intentRefs: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
  unknowns: z.array(z.string().trim().min(1).max(1_000)).max(50).optional(),
  confirmedFacts: z.array(z.string().trim().min(1).max(2_000)).max(50).optional(),
  observedBehavior: z.array(z.string().trim().min(1).max(2_000)).max(50).optional(),
  hypothesis: z.string().trim().min(1).max(2_000).nullable().optional(),
  reusableStatement: z.object({
    statement: z.string().trim().min(1).max(2_000),
    applicability: z.string().trim().min(1).max(2_000).optional(),
    boundary: z.string().trim().min(1).max(2_000).optional(),
  }).strict().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
}).strict();

export type CandidateInsightEditPatch = z.infer<typeof editPatchSchema>;

function requireReason(reason: string): string {
  const trimmed = String(reason ?? "").trim();
  if (!trimmed) throw new Error("A review reason is required");
  return trimmed.slice(0, 2_000);
}

/**
 * Human review workflow for Candidate Insights. Approval is always an
 * explicit reviewer action; no path in this service auto-approves a draft.
 * Every mutation is ACL-checked, transactional and audited.
 */
export class CandidateInsightReviewService {
  constructor(private readonly store: KnowledgeStore, private readonly clock: () => Date = () => new Date()) {}

  private load(id: string): CandidateInsight {
    const row = this.store.db.prepare("SELECT * FROM knowledge_candidate_insights WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Candidate Insight not found");
    return candidateInsightFromRow(row, this.store);
  }

  private assertReader(actorId: number, projectId: string): void {
    if (!this.store.canRead(actorId, projectId)) throw new Error("Knowledge access denied");
  }

  private assertProjectReviewer(actorId: number, projectId: string): void {
    this.assertReader(actorId, projectId);
    const acl = this.store.db.prepare("SELECT can_review FROM knowledge_acl WHERE project_id = ? AND user_id = ?").get(projectId, actorId) as { can_review?: number } | undefined;
    assertReviewer(acl?.can_review === 1);
  }

  /** Edited evidence refs must satisfy the same visibility rule as compilation. */
  private assertEvidenceVisible(insight: CandidateInsight, refs: string[]): void {
    const aclLookup = this.store.db.prepare("SELECT 1 FROM knowledge_evidence_acl WHERE evidence_id = ? AND project_id = ?");
    for (const evidenceId of refs) {
      const row = this.store.db.prepare("SELECT project_id, deleted_at FROM knowledge_evidence WHERE id = ?").get(evidenceId) as { project_id?: string; deleted_at?: string | null } | undefined;
      if (!row || row.deleted_at) throw new Error(`Evidence reference is not available: ${evidenceId}`);
      if (row.project_id !== insight.projectId && !aclLookup.get(evidenceId, insight.projectId)) {
        throw new Error(`Evidence reference is outside the session project: ${evidenceId}`);
      }
    }
  }

  list(input: { actorId: number; projectId: string; status?: CandidateInsightStatus; limit?: number; offset?: number }): CandidateInsight[] {
    this.assertReader(input.actorId, input.projectId);
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const rows = input.status
      ? this.store.db.prepare("SELECT * FROM knowledge_candidate_insights WHERE project_id = ? AND status = ? ORDER BY updated_at DESC, id LIMIT ? OFFSET ?").all(input.projectId, input.status, limit, offset)
      : this.store.db.prepare("SELECT * FROM knowledge_candidate_insights WHERE project_id = ? ORDER BY updated_at DESC, id LIMIT ? OFFSET ?").all(input.projectId, limit, offset);
    return (rows as Array<Record<string, unknown>>).map(row => candidateInsightFromRow(row, this.store));
  }

  listDrafts(input: { actorId: number; projectId: string; limit?: number; offset?: number }): CandidateInsight[] {
    return this.list({ ...input, status: "draft" });
  }

  get(input: { actorId: number; id: string }): CandidateInsight {
    const insight = this.load(input.id);
    this.assertReader(input.actorId, insight.projectId);
    return insight;
  }

  reviewHistory(input: { actorId: number; id: string }): CandidateInsightReviewRecord[] {
    const insight = this.get(input);
    const rows = this.store.db.prepare("SELECT * FROM knowledge_candidate_insight_reviews WHERE insight_id = ? ORDER BY created_at, id").all(insight.id) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), insightId: String(row.insight_id), reviewerId: Number(row.reviewer_id),
      action: String(row.action) as CandidateInsightReviewRecord["action"], reason: String(row.reason),
      before: JSON.parse(String(row.before_json)), after: JSON.parse(String(row.after_json)), createdAt: String(row.created_at),
    }));
  }

  private commit(input: { insight: CandidateInsight; actorId: number; action: CandidateInsightReviewRecord["action"]; reason: string; sql: string; params: unknown[]; after: Record<string, unknown>; before: Record<string, unknown> }): void {
    const now = this.clock().toISOString();
    this.store.db.transaction(() => {
      this.store.db.prepare(input.sql).run(...input.params, now, now, input.insight.id);
      this.store.db.prepare("INSERT INTO knowledge_candidate_insight_reviews(id,insight_id,reviewer_id,action,reason,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(randomUUID(), input.insight.id, input.actorId, input.action, input.reason, JSON.stringify(input.before), JSON.stringify(input.after), now);
      this.store.audit({ actorId: input.actorId, projectId: input.insight.projectId, action: `candidate_insight.${input.action}`, entityType: "candidate_insight", entityId: input.insight.id, details: { reason: input.reason, ...input.after } });
    })();
  }

  /** Confirm a draft/edited insight. Never invoked automatically. Idempotent on replay. */
  confirm(input: { actorId: number; id: string; reason: string }): CandidateInsight {
    return this.store.db.transaction(() => this.confirmLocked(input)).immediate();
  }
  private confirmLocked(input: { actorId: number; id: string; reason: string }): CandidateInsight {
    const reason = requireReason(input.reason);
    const insight = this.load(input.id);
    this.assertProjectReviewer(input.actorId, insight.projectId);
    if (insight.status === "accepted") return insight;
    if (insight.status === "rejected") throw new Error("A rejected Candidate Insight cannot be confirmed");
    this.commit({
      insight, actorId: input.actorId, action: "confirm", reason,
      sql: "UPDATE knowledge_candidate_insights SET status = 'accepted', reviewed_by = ?, review_reason = ?, reviewed_at = ?, updated_at = ? WHERE id = ?",
      params: [input.actorId, reason],
      before: { status: insight.status }, after: { status: "accepted" },
    });
    return this.load(input.id);
  }

  /** Edit a draft insight; the patched content is scanned like provider output. */
  edit(input: { actorId: number; id: string; patch: CandidateInsightEditPatch; reason: string }): CandidateInsight {
    return this.store.db.transaction(() => this.editLocked(input)).immediate();
  }
  private editLocked(input: { actorId: number; id: string; patch: CandidateInsightEditPatch; reason: string }): CandidateInsight {
    const reason = requireReason(input.reason);
    const patch = editPatchSchema.parse(input.patch);
    if (Object.values(patch).every((value) => value === undefined)) throw new Error("At least one edit field is required");
    const disallowed = scanCandidateContent(patch);
    if (disallowed) throw new Error(`Edited content contains ${disallowed}`);
    const insight = this.load(input.id);
    this.assertProjectReviewer(input.actorId, insight.projectId);
    if (insight.status !== "draft" && insight.status !== "edited") throw new Error(`A ${insight.status} Candidate Insight cannot be edited`);
    if (patch.evidenceRefs) this.assertEvidenceVisible(insight, patch.evidenceRefs);
    const before = { status: insight.status, statement: insight.statement, kind: insight.kind };
    const setClauses: string[] = ["status = 'edited'", "reviewed_by = ?", "review_reason = ?", "reviewed_at = ?", "updated_at = ?"];
    const params: unknown[] = [input.actorId, reason];
    const assign = (column: string, value: unknown) => { setClauses.unshift(`${column} = ?`); params.unshift(value); };
    if (patch.kind !== undefined) assign("kind", patch.kind);
    if (patch.statement !== undefined) assign("statement", patch.statement);
    if (patch.whyProposed !== undefined) assign("why_proposed", patch.whyProposed);
    if (patch.evidenceRefs !== undefined) assign("evidence_refs_json", JSON.stringify([...new Set(patch.evidenceRefs)]));
    if (patch.intentRefs !== undefined) assign("intent_refs_json", JSON.stringify(patch.intentRefs));
    if (patch.unknowns !== undefined) assign("unknowns_json", JSON.stringify(patch.unknowns));
    if (patch.confirmedFacts !== undefined) assign("confirmed_facts_json", JSON.stringify(patch.confirmedFacts));
    if (patch.observedBehavior !== undefined) assign("observed_behavior_json", JSON.stringify(patch.observedBehavior));
    if (patch.hypothesis !== undefined) assign("hypothesis", patch.hypothesis);
    if (patch.reusableStatement !== undefined) assign("reusable_statement_json", patch.reusableStatement === null ? null : JSON.stringify(patch.reusableStatement));
    if (patch.confidence !== undefined) assign("confidence", patch.confidence);
    this.commit({
      insight, actorId: input.actorId, action: "edit", reason,
      sql: `UPDATE knowledge_candidate_insights SET ${setClauses.join(", ")} WHERE id = ?`,
      params,
      before, after: { status: "edited", editedFields: Object.keys(patch).filter((key) => (patch as Record<string, unknown>)[key] !== undefined) },
    });
    return this.load(input.id);
  }

  /** Reject an insight; terminal for automatic flows. Idempotent on replay. */
  reject(input: { actorId: number; id: string; reason: string }): CandidateInsight {
    return this.store.db.transaction(() => this.rejectLocked(input)).immediate();
  }
  private rejectLocked(input: { actorId: number; id: string; reason: string }): CandidateInsight {
    const reason = requireReason(input.reason);
    const insight = this.load(input.id);
    this.assertProjectReviewer(input.actorId, insight.projectId);
    if (insight.status === "rejected") return insight;
    this.commit({
      insight, actorId: input.actorId, action: "reject", reason,
      sql: "UPDATE knowledge_candidate_insights SET status = 'rejected', reviewed_by = ?, review_reason = ?, reviewed_at = ?, updated_at = ? WHERE id = ?",
      params: [input.actorId, reason],
      before: { status: insight.status }, after: { status: "rejected" },
    });
    return this.load(input.id);
  }

  /**
   * Promote an accepted insight. Cases reuse the existing repository
   * projection; Decisions have no store-level entity yet, so the promotion is
   * recorded as explicit metadata for the future Decision integration.
   */
  promote(input: { actorId: number; id: string; target: "case" | "decision"; reason: string; title?: string }): CandidateInsightPromotion {
    return this.store.db.transaction(() => this.promoteLocked(input)).immediate();
  }
  private promoteLocked(input: { actorId: number; id: string; target: "case" | "decision"; reason: string; title?: string }): CandidateInsightPromotion {
    const reason = requireReason(input.reason);
    const insight = this.load(input.id);
    this.assertProjectReviewer(input.actorId, insight.projectId);
    if (insight.status !== "accepted") throw new Error("Only an explicitly confirmed Candidate Insight can be promoted");
    if (insight.scopeReviewRequired || !insight.sourceScope) throw new Error("Candidate requires explicit scope review before promotion; review the current Session scope");
    const existing = insight.promotion as CandidateInsightPromotion | undefined;
    if (existing && existing.target === input.target) return existing;
    const now = this.clock().toISOString();
    let promotion: CandidateInsightPromotion;
    if (input.target === "case") {
      const caseId = `case-${insight.id}`;
      const present = this.store.db.prepare("SELECT id FROM knowledge_documents WHERE id = ?").get(caseId) as { id?: string } | undefined;
      promotion = { target: "case", mode: "persisted", targetId: caseId, reason, promotedBy: input.actorId, promotedAt: now };
      if (!present) {
        this.store.db.transaction(() => {
          const body = [
            `Statement: ${insight.statement}`,
            `Why proposed: ${insight.whyProposed}`,
            insight.confirmedFacts.length ? `Confirmed facts: ${insight.confirmedFacts.join("; ")}` : undefined,
            insight.observedBehavior.length ? `Observed behavior: ${insight.observedBehavior.join("; ")}` : undefined,
            insight.hypothesis ? `Hypothesis: ${insight.hypothesis}` : undefined,
            insight.unknowns.length ? `Unknowns: ${insight.unknowns.join("; ")}` : undefined,
            insight.reusableStatement ? `Reusable statement: ${insight.reusableStatement.statement}` : undefined,
          ].filter((line): line is string => typeof line === "string").join("\n");
          const scope = insight.sourceScope!;
          new KnowledgeRepository(this.store).saveCase({
            id: caseId, kind: "case", title: input.title?.trim().slice(0, 300) || `Case: ${insight.statement.slice(0, 180)}`, body,
            lifecycle: "draft", projectId: insight.projectId, evidenceRefs: insight.evidenceRefs, confidence: insight.confidence,
            environment: scope.environment ?? undefined, sampleManagerVersion: scope.sampleManagerVersion ?? undefined,
            solution: scope.solution ?? undefined, module: scope.module ?? undefined,
            createdBy: input.actorId, locator: `candidate-insight:${insight.id}`, createdAt: now, updatedAt: now,
          });
          this.store.db.prepare("UPDATE knowledge_candidate_insights SET promotion_json = ?, reviewed_by = ?, review_reason = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(promotion), input.actorId, reason, now, now, insight.id);
          this.store.db.prepare("INSERT INTO knowledge_candidate_insight_reviews(id,insight_id,reviewer_id,action,reason,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
            .run(randomUUID(), insight.id, input.actorId, "promote", reason, JSON.stringify({ promotion: null }), JSON.stringify(promotion), now);
          this.store.audit({ actorId: input.actorId, projectId: insight.projectId, action: "candidate_insight.promote", entityType: "candidate_insight", entityId: insight.id, details: { reason, target: "case", targetId: caseId, evidenceCount: insight.evidenceRefs.length } });
        })();
      }
      return promotion;
    }
    promotion = {
      target: "decision", mode: "metadata_only", reason, promotedBy: input.actorId, promotedAt: now,
      note: "The Knowledge store has no Decision entity yet; the promotion decision is recorded as explicit metadata for the future Decision integration.",
    };
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE knowledge_candidate_insights SET promotion_json = ?, reviewed_by = ?, review_reason = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(promotion), input.actorId, reason, now, now, insight.id);
      this.store.db.prepare("INSERT INTO knowledge_candidate_insight_reviews(id,insight_id,reviewer_id,action,reason,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(randomUUID(), insight.id, input.actorId, "promote", reason, JSON.stringify({ promotion: null }), JSON.stringify(promotion), now);
      this.store.audit({ actorId: input.actorId, projectId: insight.projectId, action: "candidate_insight.promote", entityType: "candidate_insight", entityId: insight.id, details: { reason, target: "decision", mode: "metadata_only" } });
    })();
    return promotion;
  }

  /** Explicitly recover a legacy or inconsistent scope without changing content approval. */
  reviewScope(input: { actorId: number; id: string; reason: string; expectedSessionUpdatedAt?: string }): CandidateInsight {
    const reason = requireReason(input.reason);
    return this.store.db.transaction(() => {
      const insight = this.load(input.id);
      this.assertProjectReviewer(input.actorId, insight.projectId);
      if (insight.status === "rejected") throw new Error("A rejected Candidate cannot be restored by scope review; create and review a new Candidate");
      const session = new WorkSessionService(this.store).get({ actorId: input.actorId, sessionId: insight.workSessionId });
      if (!session || session.projectId !== insight.projectId) throw new Error("Candidate source Session is unavailable");
      if (input.expectedSessionUpdatedAt !== undefined && session.updatedAt !== input.expectedSessionUpdatedAt) throw new Error("Session scope changed; refresh and review the displayed scope again");
      if (!insight.scopeReviewRequired) return insight;
      this.assertEvidenceVisible(insight, insight.evidenceRefs);
      const now = this.clock().toISOString(), snapshot = candidateScopeSnapshot(session, "review", now);
      const previous = this.store.db.prepare("SELECT scope_snapshot_json FROM knowledge_candidate_insights WHERE id=?").get(insight.id) as { scope_snapshot_json: string | null };
      const caseId = `case-${insight.id}`;
      const caseScope = this.store.db.prepare("SELECT kind,project_id,environment,samplemanager_version,solution,module,lifecycle,source_locator FROM knowledge_documents WHERE id=?").get(caseId) as Record<string, unknown> | undefined;
      if (caseScope && (caseScope.kind !== "case" || caseScope.source_locator !== `candidate-insight:${insight.id}`)) throw new Error("Candidate Case identity is inconsistent; scope review cannot overwrite another source");
      const before = { snapshot: previous.scope_snapshot_json, caseScope: caseScope ?? null };
      this.store.db.prepare("UPDATE knowledge_candidate_insights SET scope_snapshot_json=?,reviewed_by=?,review_reason=?,reviewed_at=?,updated_at=? WHERE id=?").run(JSON.stringify(snapshot), input.actorId, reason, now, now, insight.id);
      if (caseScope) {
        this.store.db.prepare("UPDATE knowledge_documents SET project_id=?,environment=?,samplemanager_version=?,solution=?,module=?,updated_at=? WHERE id=?").run(snapshot.projectId, snapshot.environment, snapshot.sampleManagerVersion, snapshot.solution, snapshot.module, now, caseId);
        this.store.db.prepare("UPDATE knowledge_cases SET environment=?,samplemanager_version=?,solution=?,module=?,updated_at=? WHERE id=?").run(snapshot.environment, snapshot.sampleManagerVersion, snapshot.solution, snapshot.module, now, caseId);
      }
      const after = { scopeReview: true, snapshot, caseId: caseScope ? caseId : undefined };
      this.store.db.prepare("INSERT INTO knowledge_candidate_insight_reviews(id,insight_id,reviewer_id,action,reason,before_json,after_json,created_at) VALUES (?,?,?,'edit',?,?,?,?)").run(randomUUID(), insight.id, input.actorId, reason, JSON.stringify(before), JSON.stringify(after), now);
      this.store.audit({ actorId: input.actorId, projectId: insight.projectId, action: "candidate_insight.review_scope", entityType: "candidate_insight", entityId: insight.id, details: { reason, before, after } });
      return this.load(insight.id);
    }).immediate();
  }
}
