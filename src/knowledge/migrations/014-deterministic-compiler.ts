/** Schema additions for deterministic event classification and provenance. */
export const DETERMINISTIC_COMPILER_MIGRATION = {
  version: "014-deterministic-compiler",
  sql: `
ALTER TABLE knowledge_candidate_cards ADD COLUMN event_class TEXT;
ALTER TABLE knowledge_candidate_cards ADD COLUMN capture_reason TEXT;
ALTER TABLE knowledge_candidate_cards ADD COLUMN impact TEXT;
ALTER TABLE knowledge_cases ADD COLUMN source_candidate_id TEXT;
ALTER TABLE knowledge_cases ADD COLUMN event_id TEXT;
CREATE TABLE IF NOT EXISTS knowledge_observations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT,
  event_class TEXT NOT NULL,
  capture_reason TEXT NOT NULL,
  problem_statement TEXT,
  facts_json TEXT NOT NULL DEFAULT '[]',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  source_locator TEXT NOT NULL,
  source_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_observations_project ON knowledge_observations(project_id, created_at);
`,
};
