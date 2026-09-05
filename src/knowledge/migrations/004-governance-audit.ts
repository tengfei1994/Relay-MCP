export const KNOWLEDGE_GOVERNANCE_AUDIT_MIGRATION = {
  version: "004-governance-audit",
  sql: `CREATE TABLE IF NOT EXISTS knowledge_audit (
    id TEXT PRIMARY KEY,
    actor_id INTEGER,
    project_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    details_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_audit_entity ON knowledge_audit(entity_type, entity_id, occurred_at);`,
};
