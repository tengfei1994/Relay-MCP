/** Optional Evidence scope metadata used by the Project Knowledge filters. */
export const EVIDENCE_METADATA_MIGRATION = {
  version: "018-evidence-metadata",
  sql: `
ALTER TABLE knowledge_evidence ADD COLUMN environment TEXT;
CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_environment ON knowledge_evidence(environment, created_at);
`,
};
