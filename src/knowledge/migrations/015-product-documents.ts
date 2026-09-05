export const PRODUCT_DOCUMENTS_MIGRATION = { version: "015-product-documents", sql: `
CREATE TABLE IF NOT EXISTS knowledge_product_documents (
  id TEXT PRIMARY KEY, document_family_id TEXT NOT NULL, document_type TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en', authority TEXT NOT NULL DEFAULT 'official',
  source_path TEXT NOT NULL, source_sha256 TEXT, version TEXT NOT NULL,
  sections_json TEXT NOT NULL DEFAULT '[]', review_status TEXT NOT NULL DEFAULT 'approved',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_docs_family ON knowledge_product_documents(document_family_id, version);
` };
