export const OBSERVATION_REVIEW_MIGRATION = {
  version: "021-observation-review",
  sql: `CREATE TABLE IF NOT EXISTS knowledge_observation_reviews (
    observation_id TEXT PRIMARY KEY REFERENCES knowledge_observations(id),
    outcome TEXT NOT NULL,
    reason TEXT NOT NULL,
    rule_version TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    next_review_at TEXT,
    review_count INTEGER NOT NULL DEFAULT 1,
    candidate_id TEXT,
    source_sha256 TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_observation_reviews_due ON knowledge_observation_reviews(next_review_at);`,
};
