export const OBSERVATION_CANDIDATE_MIGRATION = {
  version: "020-observation-candidate",
  sql: `ALTER TABLE knowledge_candidates ADD COLUMN source_observation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_source_observation ON knowledge_candidates(source_observation_id);`,
};
