/** Durable batch/item/revision metadata for Product Document operations. */
export const PRODUCT_DOCUMENT_OPERATIONS_MIGRATION = {
  version: "017-product-document-operations",
  sql: `
ALTER TABLE knowledge_ingest_runs ADD COLUMN operation_idempotency_key TEXT;
ALTER TABLE knowledge_ingest_runs ADD COLUMN batch_metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE knowledge_ingest_runs ADD COLUMN source_root TEXT;
ALTER TABLE knowledge_ingest_runs ADD COLUMN source_commit TEXT;
ALTER TABLE knowledge_ingest_runs ADD COLUMN source_sha256 TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_ingest_idempotency
  ON knowledge_ingest_runs(operation_idempotency_key)
  WHERE operation_idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS knowledge_product_document_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES knowledge_ingest_runs(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  document_id TEXT REFERENCES knowledge_documents(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  source_sha256 TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  warning TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, relative_path),
  CHECK(status IN ('queued','running','imported','updated','unchanged','deprecated','failed','warning'))
);
CREATE INDEX IF NOT EXISTS idx_product_document_items_run
  ON knowledge_product_document_items(run_id, status, relative_path);

CREATE TABLE IF NOT EXISTS knowledge_product_document_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  against_document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  report_json TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'not_reviewed',
  reviewed_by INTEGER,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(document_id, against_document_id),
  CHECK(review_status IN ('not_reviewed','accepted','rejected','needs_review'))
);
CREATE INDEX IF NOT EXISTS idx_product_document_revisions_review
  ON knowledge_product_document_revisions(review_status, updated_at);
`,
};
