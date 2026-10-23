/**
 * Relay-native Wiki pages and their revision history (#54). Pages carry a
 * stable page_key identity plus optional Product Version/Topic/solution/module
 * scoping metadata; revisions are append-only so rollback never rewrites
 * history. All changes are additive.
 */
export const WIKI_MIGRATION = {
  version: "037-wiki",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_wiki_pages (
  id TEXT PRIMARY KEY,
  page_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  project_id TEXT,
  product_version TEXT,
  topic_id TEXT,
  solution TEXT,
  module TEXT,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  current_revision INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  deprecated_at TEXT,
  CHECK(status IN ('draft','published','deprecated'))
);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_project ON knowledge_wiki_pages(project_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_status ON knowledge_wiki_pages(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_product_version ON knowledge_wiki_pages(product_version);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_topic ON knowledge_wiki_pages(topic_id);

CREATE TABLE IF NOT EXISTS knowledge_wiki_page_revisions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES knowledge_wiki_pages(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  change_reason TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(page_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_wiki_page_revisions_page ON knowledge_wiki_page_revisions(page_id, revision);
`
};
