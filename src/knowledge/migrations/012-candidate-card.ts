/** Structured, reviewable projection for raw event-backed Candidates. */
export const KNOWLEDGE_CANDIDATE_CARD_MIGRATION = {
  version: "012-candidate-card",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_candidate_cards (
  candidate_id TEXT PRIMARY KEY REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  problem_statement TEXT NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '[]',
  symptoms_json TEXT NOT NULL DEFAULT '[]',
  hypothesis TEXT NOT NULL,
  verification_plan_json TEXT NOT NULL DEFAULT '[]',
  verified_conclusion TEXT,
  actions_json TEXT NOT NULL DEFAULT '[]',
  verification_json TEXT NOT NULL DEFAULT '[]',
  applicability TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL,
  generated_by TEXT NOT NULL,
  inference_status TEXT NOT NULL DEFAULT 'deterministic',
  updated_at TEXT NOT NULL,
  CHECK(inference_status IN ('deterministic','provider','rejected')),
  CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_candidate_cards_updated ON knowledge_candidate_cards(updated_at);
`,
};
