/** Durable reviewable Candidate Insight drafts compiled from a Context Pack (#47). */
export const CANDIDATE_INSIGHT_MIGRATION = {
  version: "032-candidate-insights",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_candidate_insights (
  id TEXT PRIMARY KEY,
  work_session_id TEXT NOT NULL REFERENCES knowledge_work_sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  statement TEXT NOT NULL,
  why_proposed TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  intent_refs_json TEXT NOT NULL DEFAULT '[]',
  unknowns_json TEXT NOT NULL DEFAULT '[]',
  reuse_boundary_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'draft',
  generated_by TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(work_session_id, input_hash),
  CHECK(kind IN ('fact','pattern','case','playbook','decision','observation')),
  CHECK(status IN ('draft','accepted','edited','rejected'))
);
CREATE INDEX IF NOT EXISTS idx_candidate_insights_session ON knowledge_candidate_insights(work_session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_candidate_insights_project ON knowledge_candidate_insights(project_id, status, updated_at);
`
};
