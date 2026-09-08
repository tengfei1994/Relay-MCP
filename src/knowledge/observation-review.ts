import type { KnowledgeStore } from "./store.js";

export const OBSERVATION_REVIEW_RULE = "runtime-signals-v2";
export const OBSERVATION_REVIEW_INTERVAL_MS = 60_000;
export type ObservationReviewOutcome = "deferred" | "promoted" | "error";

/** Save the latest attempt on every pass; audit only decisions that change. */
export function recordObservationReview(store: KnowledgeStore, input: {
  observationId: string; projectId?: string; outcome: ObservationReviewOutcome;
  reason: string; candidateId?: string; now: Date; errorCode?: string;
}): void {
  const reviewedAt = input.now.toISOString();
  const nextReviewAt = input.outcome === "promoted" ? null : new Date(input.now.getTime() + OBSERVATION_REVIEW_INTERVAL_MS).toISOString();
  const source = store.db.prepare("SELECT source_sha256 FROM knowledge_observations WHERE id = ?").get(input.observationId) as { source_sha256: string | null };
  const previous = store.db.prepare("SELECT * FROM knowledge_observation_reviews WHERE observation_id = ?").get(input.observationId) as Record<string, unknown> | undefined;
  store.db.prepare(`INSERT INTO knowledge_observation_reviews
    (observation_id,outcome,reason,rule_version,reviewed_at,next_review_at,review_count,candidate_id,source_sha256)
    VALUES (?,?,?,?,?,?,1,?,?) ON CONFLICT(observation_id) DO UPDATE SET
    outcome=excluded.outcome,reason=excluded.reason,rule_version=excluded.rule_version,
    reviewed_at=excluded.reviewed_at,next_review_at=excluded.next_review_at,
    review_count=knowledge_observation_reviews.review_count+1,candidate_id=excluded.candidate_id,source_sha256=excluded.source_sha256
  `).run(input.observationId, input.outcome, input.reason, OBSERVATION_REVIEW_RULE, reviewedAt, nextReviewAt, input.candidateId ?? null, source.source_sha256);
  const nextAction = input.outcome === "promoted" ? "Review the linked draft Candidate and its Evidence." : input.outcome === "error" ? "Automatic review will retry; inspect source availability if errors persist." : "Retained as an Observation; automatic review will retry in one minute.";
  store.db.prepare("UPDATE knowledge_observations SET human_status=?,next_action=? WHERE id=?").run(input.outcome === "promoted" ? "candidate_created" : input.outcome === "error" ? "review_error" : "observing", nextAction, input.observationId);
  if (!previous || previous.outcome !== input.outcome || previous.reason !== input.reason || previous.rule_version !== OBSERVATION_REVIEW_RULE || previous.candidate_id !== (input.candidateId ?? null) || previous.source_sha256 !== source.source_sha256) {
    store.audit({ projectId: input.projectId, action: "knowledge.observation.reviewed", entityType: "observation", entityId: input.observationId,
      details: { outcome: input.outcome, reason: input.reason, ruleVersion: OBSERVATION_REVIEW_RULE, candidateId: input.candidateId, reviewedAt, nextReviewAt, previousOutcome: previous?.outcome, errorCode: input.errorCode } });
  }
}
