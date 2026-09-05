/** Source ownership versus reusable Knowledge applicability/visibility. */
export const KNOWLEDGE_SCOPE_MIGRATION = {
  version: "013-knowledge-scope",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_scope_bindings (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  visibility TEXT NOT NULL,
  source_project_id TEXT,
  source_case_id TEXT,
  source_deployment_id TEXT,
  redaction_status TEXT NOT NULL DEFAULT 'unknown',
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(document_id, scope_type, scope_key),
  CHECK(scope_type IN ('system','version','solution','module','organization','project','environment')),
  CHECK(visibility IN ('private','project','organization','global')),
  CHECK(redaction_status IN ('unknown','unredacted','redacted'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_scope_lookup ON knowledge_scope_bindings(scope_type, scope_key, visibility);
CREATE INDEX IF NOT EXISTS idx_knowledge_scope_document ON knowledge_scope_bindings(document_id, visibility);
`,
};
