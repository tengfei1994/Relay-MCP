/**
 * Product Knowledge integration routing state and per-document migration
 * linkage (#55). All statements are idempotent so the migration controller can
 * also apply them defensively before the store registers this version.
 */
export const INTEGRATION_ROUTING_MIGRATION = {
  version: "038-integration-routing",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_integration_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  previous_value TEXT,
  migration_id TEXT,
  updated_by INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_migration_documents (
  migration_id TEXT NOT NULL REFERENCES knowledge_migrations(id) ON DELETE CASCADE,
  local_document_id TEXT NOT NULL,
  document_id TEXT REFERENCES knowledge_weknora_documents(id),
  idempotency_key TEXT NOT NULL,
  external_document_id TEXT,
  status TEXT NOT NULL DEFAULT 'staged',
  failure_code TEXT,
  failure_message TEXT,
  content_sha256 TEXT,
  parser_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(migration_id, local_document_id),
  CHECK(status IN ('staged','published','failed'))
);
CREATE INDEX IF NOT EXISTS idx_migration_documents_status ON knowledge_migration_documents(migration_id, status);
CREATE INDEX IF NOT EXISTS idx_migration_documents_key ON knowledge_migration_documents(idempotency_key);
`
};
