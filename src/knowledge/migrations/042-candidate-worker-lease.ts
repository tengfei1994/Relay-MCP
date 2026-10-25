export const CANDIDATE_WORKER_LEASE_MIGRATION = {
  version: "042-candidate-worker-lease",
  sql: `ALTER TABLE knowledge_candidate_insight_jobs ADD COLUMN claim_token TEXT;
ALTER TABLE knowledge_candidate_insight_jobs ADD COLUMN lease_until TEXT;
ALTER TABLE knowledge_candidate_insight_jobs ADD COLUMN available_at TEXT;
ALTER TABLE knowledge_candidate_insight_jobs ADD COLUMN provider_id TEXT;
CREATE INDEX idx_candidate_insight_jobs_claim ON knowledge_candidate_insight_jobs(status,available_at,lease_until);`,
};
