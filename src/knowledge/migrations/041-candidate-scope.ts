/** Legacy scope is deliberately unknown until a reviewer revalidates it. */
export const CANDIDATE_SCOPE_MIGRATION = {
  version: "041-candidate-scope",
  sql: "ALTER TABLE knowledge_candidate_insights ADD COLUMN scope_snapshot_json TEXT;",
};
