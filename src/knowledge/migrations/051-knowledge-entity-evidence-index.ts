/** Reverse lookup index for evidence-link existence and unlinked-evidence counts. */
export const KNOWLEDGE_ENTITY_EVIDENCE_INDEX_MIGRATION = {
  version: "051-knowledge-entity-evidence-index",
  sql: `
CREATE INDEX IF NOT EXISTS idx_knowledge_entity_evidence_evidence_id
  ON knowledge_entity_evidence(evidence_id);
`,
};
