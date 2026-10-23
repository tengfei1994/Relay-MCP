/**
 * Candidate Insight structured sections, human review workflow, promotion
 * metadata and the async compile queue (#47/#48). All changes are additive.
 */
export const CANDIDATE_INSIGHT_REVIEW_MIGRATION = {
  version: "036-candidate-insight-review",
  sql: `
ALTER TABLE knowledge_candidate_insights ADD COLUMN confirmed_facts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE knowledge_candidate_insights ADD COLUMN observed_behavior_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE knowledge_candidate_insights ADD COLUMN hypothesis TEXT;
ALTER TABLE knowledge_candidate_insights ADD COLUMN reusable_statement_json TEXT;
ALTER TABLE knowledge_candidate_insights ADD COLUMN fallback_reason TEXT;
ALTER TABLE knowledge_candidate_insights ADD COLUMN reviewed_by INTEGER;
ALTER TABLE knowledge_candidate_insights ADD COLUMN reviewed_at TEXT;
ALTER TABLE knowledge_candidate_insights ADD COLUMN review_reason TEXT;
ALTER TABLE knowledge_candidate_insights ADD COLUMN promotion_json TEXT;

CREATE TABLE IF NOT EXISTS knowledge_candidate_insight_reviews (
  id TEXT PRIMARY KEY,
  insight_id TEXT NOT NULL REFERENCES knowledge_candidate_insights(id) ON DELETE CASCADE,
  reviewer_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(action IN ('confirm','edit','reject','promote'))
);
CREATE INDEX IF NOT EXISTS idx_candidate_insight_reviews_insight ON knowledge_candidate_insight_reviews(insight_id, created_at);

CREATE TABLE IF NOT EXISTS knowledge_candidate_insight_jobs (
  id TEXT PRIMARY KEY,
  work_session_id TEXT NOT NULL REFERENCES knowledge_work_sessions(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  insight_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(status IN ('queued','done','failed'))
);
CREATE INDEX IF NOT EXISTS idx_candidate_insight_jobs_queue ON knowledge_candidate_insight_jobs(status, created_at);
`
};
