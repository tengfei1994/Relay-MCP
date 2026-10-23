/** External Product Knowledge identity and migration control metadata. */
export const WEKNORA_DOCUMENT_MIGRATION = {
  version: "031-weknora-documents",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_weknora_documents (
  id TEXT PRIMARY KEY,
  external_document_id TEXT NOT NULL UNIQUE,
  external_knowledge_base_id TEXT,
  external_chunk_ids_json TEXT NOT NULL DEFAULT '[]',
  title TEXT NOT NULL,
  normalized_content_sha256 TEXT NOT NULL,
  raw_sha256 TEXT,
  parser_version TEXT NOT NULL,
  product_version TEXT,
  solution TEXT,
  module TEXT,
  topic_id TEXT,
  source_path TEXT,
  language TEXT,
  project_id TEXT,
  status TEXT NOT NULL DEFAULT 'staged',
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  deprecated_at TEXT,
  CHECK(status IN ('staged','published','deprecated','failed'))
);
CREATE INDEX IF NOT EXISTS idx_weknora_documents_scope ON knowledge_weknora_documents(product_version,solution,module,status);
CREATE TABLE IF NOT EXISTS knowledge_migrations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  idempotency_key TEXT NOT NULL UNIQUE,
  source_manifest_json TEXT NOT NULL,
  report_json TEXT NOT NULL DEFAULT '{}',
  rollback_manifest_json TEXT NOT NULL DEFAULT '{}',
  rollback_reason TEXT,
  actor_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  rolled_back_at TEXT,
  CHECK(status IN ('created','staged','published','rolled_back','failed'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_migrations_status ON knowledge_migrations(status,updated_at);
`
};
