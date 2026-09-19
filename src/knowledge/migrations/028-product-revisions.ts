/** Content identity separate from version-specific Product Document bindings. */
export const PRODUCT_REVISIONS_MIGRATION = {
  version: "028-product-revisions",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_product_revisions (
  id TEXT PRIMARY KEY, normalized_content_sha256 TEXT NOT NULL UNIQUE, raw_sha256 TEXT,
  title TEXT NOT NULL, body TEXT NOT NULL, sections_json TEXT NOT NULL DEFAULT '[]', parser_version TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
ALTER TABLE knowledge_product_documents ADD COLUMN revision_id TEXT REFERENCES knowledge_product_revisions(id);
CREATE INDEX IF NOT EXISTS idx_product_documents_revision ON knowledge_product_documents(revision_id);
`
};
