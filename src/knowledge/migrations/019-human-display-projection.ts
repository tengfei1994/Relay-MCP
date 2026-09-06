/** Human-readable projections are additive; raw event/evidence columns remain immutable. */
export const HUMAN_DISPLAY_PROJECTION_MIGRATION = {
  version: "019-human-display-projection",
  sql: `
ALTER TABLE knowledge_candidate_cards ADD COLUMN record_type TEXT NOT NULL DEFAULT 'candidate';
ALTER TABLE knowledge_candidate_cards ADD COLUMN display_title TEXT;
ALTER TABLE knowledge_candidate_cards ADD COLUMN display_summary TEXT;
ALTER TABLE knowledge_candidate_cards ADD COLUMN unknowns_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE knowledge_candidate_cards ADD COLUMN next_action TEXT;
ALTER TABLE knowledge_candidate_cards ADD COLUMN capture_reason_text TEXT;
ALTER TABLE knowledge_candidate_cards ADD COLUMN human_status TEXT;
ALTER TABLE knowledge_candidate_cards ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE knowledge_observations ADD COLUMN record_type TEXT NOT NULL DEFAULT 'observation';
ALTER TABLE knowledge_observations ADD COLUMN display_title TEXT;
ALTER TABLE knowledge_observations ADD COLUMN display_summary TEXT;
ALTER TABLE knowledge_observations ADD COLUMN unknowns_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE knowledge_observations ADD COLUMN next_action TEXT;
ALTER TABLE knowledge_observations ADD COLUMN human_status TEXT;
ALTER TABLE knowledge_observations ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';
`,
};
