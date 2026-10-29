/** Dedicated Product Knowledge graph entities and relations. */
export const PRODUCT_GRAPH_MIGRATION = {
  version: "049-product-graph",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_product_graph_entities (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  source_locator TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  product_version TEXT,
  solution TEXT,
  module TEXT,
  project_id TEXT,
  environment TEXT,
  confidence REAL NOT NULL,
  extraction_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(document_id, canonical_key, extraction_version),
  CHECK(confidence >= 0 AND confidence <= 1)
);
CREATE INDEX IF NOT EXISTS idx_product_graph_entities_document
  ON knowledge_product_graph_entities(document_id, extraction_version);
CREATE INDEX IF NOT EXISTS idx_product_graph_entities_scope
  ON knowledge_product_graph_entities(project_id, environment, product_version, kind);
CREATE TABLE IF NOT EXISTS knowledge_product_graph_relations (
  id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL REFERENCES knowledge_product_graph_entities(id) ON DELETE CASCADE,
  to_entity_id TEXT NOT NULL REFERENCES knowledge_product_graph_entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  source_locator TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  product_version TEXT,
  solution TEXT,
  module TEXT,
  project_id TEXT,
  environment TEXT,
  confidence REAL NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  extraction_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(document_id, from_entity_id, to_entity_id, relation_type, source_locator, extraction_version),
  CHECK(confidence >= 0 AND confidence <= 1),
  CHECK(verified IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_product_graph_relations_document
  ON knowledge_product_graph_relations(document_id, extraction_version);
CREATE INDEX IF NOT EXISTS idx_product_graph_relations_from
  ON knowledge_product_graph_relations(from_entity_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_product_graph_relations_to
  ON knowledge_product_graph_relations(to_entity_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_product_graph_relations_scope
  ON knowledge_product_graph_relations(project_id, environment, product_version, relation_type);
`
};
