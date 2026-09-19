/** Logical Product Knowledge topics and version bindings. */
export const PRODUCT_TOPICS_MIGRATION = {
  version: "024-product-topics",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_topics (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  canonical_title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'product_document',
  domain TEXT NOT NULL DEFAULT 'product',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_topics_title ON knowledge_topics(canonical_title);

CREATE TABLE IF NOT EXISTS knowledge_product_document_bindings (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES knowledge_topics(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  product TEXT,
  product_version TEXT NOT NULL,
  source_path TEXT NOT NULL,
  match_method TEXT NOT NULL DEFAULT 'family_id',
  match_confidence REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(topic_id, product_version),
  UNIQUE(document_id)
);
CREATE INDEX IF NOT EXISTS idx_product_bindings_version ON knowledge_product_document_bindings(product_version, status);
CREATE INDEX IF NOT EXISTS idx_product_bindings_topic ON knowledge_product_document_bindings(topic_id, product_version);
`,
};
