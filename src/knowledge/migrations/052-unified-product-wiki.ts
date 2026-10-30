/**
 * Product Documents are the canonical domain object.  Engine indexing is a
 * projection on the same row, while Wiki pages are topic-group documents with
 * versioned sections and section-level provenance.
 */
export const UNIFIED_PRODUCT_WIKI_MIGRATION = {
  version: "052-unified-product-wiki",
  sql: `
ALTER TABLE knowledge_product_documents ADD COLUMN topic_group_id TEXT;
ALTER TABLE knowledge_product_documents ADD COLUMN normalized_content_sha256 TEXT;
ALTER TABLE knowledge_product_documents ADD COLUMN parser_version TEXT;
ALTER TABLE knowledge_product_documents ADD COLUMN engine_external_document_id TEXT;
ALTER TABLE knowledge_product_documents ADD COLUMN engine_knowledge_base_id TEXT;
ALTER TABLE knowledge_product_documents ADD COLUMN engine_chunk_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE knowledge_product_documents ADD COLUMN engine_identity_hash TEXT;
ALTER TABLE knowledge_product_documents ADD COLUMN engine_idempotency_key TEXT;
ALTER TABLE knowledge_product_documents ADD COLUMN engine_status TEXT NOT NULL DEFAULT 'not_indexed';
ALTER TABLE knowledge_product_documents ADD COLUMN engine_parse_status TEXT;
ALTER TABLE knowledge_product_documents ADD COLUMN engine_verified_at TEXT;
ALTER TABLE knowledge_product_documents ADD COLUMN engine_model_provenance_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE knowledge_product_documents ADD COLUMN engine_failure_code TEXT;
ALTER TABLE knowledge_product_documents ADD COLUMN engine_failure_message TEXT;
ALTER TABLE knowledge_product_documents ADD COLUMN engine_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_product_documents ADD COLUMN engine_published_at TEXT;
ALTER TABLE knowledge_product_documents ADD COLUMN engine_deprecated_at TEXT;
ALTER TABLE knowledge_product_documents ADD COLUMN engine_updated_at TEXT;

UPDATE knowledge_product_documents
SET topic_group_id = COALESCE(
  (SELECT b.topic_id FROM knowledge_product_document_bindings b WHERE b.document_id=knowledge_product_documents.id ORDER BY b.updated_at DESC LIMIT 1),
  'family:' || document_family_id
)
WHERE topic_group_id IS NULL OR trim(topic_group_id)='';
UPDATE knowledge_product_documents
SET normalized_content_sha256 = COALESCE(
  normalized_content_sha256,
  (SELECT json_extract(p.metadata_json,'$.normalizedContentSha256') FROM knowledge_product_documents p WHERE p.id=knowledge_product_documents.id),
  source_sha256
);
UPDATE knowledge_product_documents
SET parser_version = COALESCE(
  parser_version,
  (SELECT json_extract(p.metadata_json,'$.parserVersion') FROM knowledge_product_documents p WHERE p.id=knowledge_product_documents.id),
  'legacy'
);
UPDATE knowledge_product_documents
SET engine_external_document_id = (
      SELECT w.external_document_id FROM knowledge_migration_documents md
      JOIN knowledge_migrations m ON m.id=md.migration_id
      JOIN knowledge_weknora_documents w ON w.id=md.document_id
      WHERE md.local_document_id=knowledge_product_documents.id
      ORDER BY CASE WHEN w.status='published' THEN 0 ELSE 1 END, w.updated_at DESC LIMIT 1
    ),
    engine_knowledge_base_id = (
      SELECT w.external_knowledge_base_id FROM knowledge_migration_documents md
      JOIN knowledge_migrations m ON m.id=md.migration_id
      JOIN knowledge_weknora_documents w ON w.id=md.document_id
      WHERE md.local_document_id=knowledge_product_documents.id
      ORDER BY CASE WHEN w.status='published' THEN 0 ELSE 1 END, w.updated_at DESC LIMIT 1
    ),
    engine_chunk_ids_json = COALESCE((
      SELECT w.external_chunk_ids_json FROM knowledge_migration_documents md
      JOIN knowledge_migrations m ON m.id=md.migration_id
      JOIN knowledge_weknora_documents w ON w.id=md.document_id
      WHERE md.local_document_id=knowledge_product_documents.id
      ORDER BY CASE WHEN w.status='published' THEN 0 ELSE 1 END, w.updated_at DESC LIMIT 1
    ), '[]'),
    engine_status = COALESCE((
      SELECT CASE WHEN w.status='published' THEN 'published' WHEN w.status='failed' THEN 'failed' ELSE 'staged' END
      FROM knowledge_migration_documents md
      JOIN knowledge_migrations m ON m.id=md.migration_id
      JOIN knowledge_weknora_documents w ON w.id=md.document_id
      WHERE md.local_document_id=knowledge_product_documents.id
      ORDER BY CASE WHEN w.status='published' THEN 0 ELSE 1 END, w.updated_at DESC LIMIT 1
    ), 'not_indexed'),
    engine_parse_status = (SELECT w.upstream_parse_status FROM knowledge_migration_documents md JOIN knowledge_weknora_documents w ON w.id=md.document_id WHERE md.local_document_id=knowledge_product_documents.id ORDER BY w.updated_at DESC LIMIT 1),
    engine_verified_at = (SELECT w.upstream_verified_at FROM knowledge_migration_documents md JOIN knowledge_weknora_documents w ON w.id=md.document_id WHERE md.local_document_id=knowledge_product_documents.id ORDER BY w.updated_at DESC LIMIT 1),
    engine_model_provenance_json = COALESCE((SELECT w.model_provenance_json FROM knowledge_migration_documents md JOIN knowledge_weknora_documents w ON w.id=md.document_id WHERE md.local_document_id=knowledge_product_documents.id ORDER BY w.updated_at DESC LIMIT 1), '{}'),
    engine_failure_code = (SELECT md.failure_code FROM knowledge_migration_documents md JOIN knowledge_migrations m ON m.id=md.migration_id WHERE md.local_document_id=knowledge_product_documents.id ORDER BY md.updated_at DESC LIMIT 1),
    engine_failure_message = (SELECT md.failure_message FROM knowledge_migration_documents md JOIN knowledge_migrations m ON m.id=md.migration_id WHERE md.local_document_id=knowledge_product_documents.id ORDER BY md.updated_at DESC LIMIT 1),
    engine_attempt_count = 0,
    engine_published_at = (SELECT w.published_at FROM knowledge_migration_documents md JOIN knowledge_weknora_documents w ON w.id=md.document_id WHERE md.local_document_id=knowledge_product_documents.id ORDER BY w.updated_at DESC LIMIT 1),
    engine_deprecated_at = (SELECT w.deprecated_at FROM knowledge_migration_documents md JOIN knowledge_weknora_documents w ON w.id=md.document_id WHERE md.local_document_id=knowledge_product_documents.id ORDER BY w.updated_at DESC LIMIT 1),
    engine_updated_at = (SELECT w.updated_at FROM knowledge_migration_documents md JOIN knowledge_weknora_documents w ON w.id=md.document_id WHERE md.local_document_id=knowledge_product_documents.id ORDER BY w.updated_at DESC LIMIT 1)
WHERE engine_external_document_id IS NULL;

ALTER TABLE knowledge_wiki_pages ADD COLUMN topic_group_id TEXT;
ALTER TABLE knowledge_wiki_pages ADD COLUMN supported_versions_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE knowledge_wiki_pages ADD COLUMN generation_status TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE knowledge_wiki_pages ADD COLUMN generation_fingerprint TEXT;
ALTER TABLE knowledge_wiki_pages ADD COLUMN directory_path TEXT;
UPDATE knowledge_wiki_pages SET topic_group_id=COALESCE(topic_group_id,topic_id) WHERE topic_group_id IS NULL AND topic_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS knowledge_wiki_sections (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES knowledge_wiki_pages(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  section_kind TEXT NOT NULL,
  product_version TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  current_revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(page_id, section_key),
  CHECK(section_kind IN ('common','version','difference'))
);
CREATE INDEX IF NOT EXISTS idx_wiki_sections_page ON knowledge_wiki_sections(page_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_wiki_sections_version ON knowledge_wiki_sections(product_version, section_kind);

CREATE TABLE IF NOT EXISTS knowledge_wiki_section_citations (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES knowledge_wiki_sections(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  external_document_id TEXT,
  chunk_id TEXT,
  product_version TEXT,
  quote_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(section_id, document_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_wiki_section_citations_section ON knowledge_wiki_section_citations(section_id);
CREATE INDEX IF NOT EXISTS idx_wiki_section_citations_document ON knowledge_wiki_section_citations(document_id, product_version);

CREATE TABLE IF NOT EXISTS knowledge_wiki_generation_state (
  project_id TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT '',
  topic_group_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  source_fingerprint TEXT,
  last_error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  generated_page_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, environment, topic_group_id),
  CHECK(status IN ('queued','running','succeeded','failed'))
);
CREATE INDEX IF NOT EXISTS idx_wiki_generation_state_status ON knowledge_wiki_generation_state(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_product_docs_topic_group ON knowledge_product_documents(topic_group_id, version, updated_at);
CREATE INDEX IF NOT EXISTS idx_product_docs_engine_status ON knowledge_product_documents(engine_status, engine_updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_docs_engine_external ON knowledge_product_documents(engine_external_document_id) WHERE engine_external_document_id IS NOT NULL;
`
};
