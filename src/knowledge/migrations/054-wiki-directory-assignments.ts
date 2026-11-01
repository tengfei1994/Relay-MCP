/** Durable display classification for the Wiki directory. */
export const WIKI_DIRECTORY_ASSIGNMENTS_MIGRATION = {
  version: "054-wiki-directory-assignments",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_wiki_directory_assignments (
  scope_project_id TEXT NOT NULL DEFAULT '',
  scope_environment TEXT NOT NULL DEFAULT '',
  identity_key TEXT NOT NULL,
  page_id TEXT NOT NULL,
  topic_group_id TEXT,
  display_path TEXT NOT NULL,
  directory_context TEXT,
  raw_path TEXT,
  classification_source TEXT NOT NULL DEFAULT 'derived',
  taxonomy_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope_project_id, scope_environment, identity_key),
  UNIQUE(scope_project_id, scope_environment, page_id)
);
CREATE INDEX IF NOT EXISTS idx_wiki_directory_assignments_scope
  ON knowledge_wiki_directory_assignments(scope_project_id, scope_environment, display_path);
CREATE INDEX IF NOT EXISTS idx_wiki_directory_assignments_topic
  ON knowledge_wiki_directory_assignments(scope_project_id, scope_environment, topic_group_id);
`
};
