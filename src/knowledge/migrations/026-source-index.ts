/** Derived source chunks for fast, bounded agent retrieval. Rebuildable from source artifacts. */
export const SOURCE_INDEX_MIGRATION = {
  version: "026-source-index",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_source_chunks (
  id TEXT PRIMARY KEY, baseline_id TEXT REFERENCES knowledge_source_baselines(id) ON DELETE CASCADE,
  snapshot_id TEXT REFERENCES knowledge_project_snapshots(id) ON DELETE CASCADE,
  source_file_id TEXT NOT NULL, relative_path TEXT NOT NULL, symbol TEXT, line_start INTEGER, line_end INTEGER,
  content TEXT NOT NULL, content_sha256 TEXT NOT NULL, parser_version TEXT NOT NULL, created_at TEXT NOT NULL,
  CHECK ((baseline_id IS NOT NULL) <> (snapshot_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_source_chunks_baseline ON knowledge_source_chunks(baseline_id, relative_path);
CREATE INDEX IF NOT EXISTS idx_source_chunks_snapshot ON knowledge_source_chunks(snapshot_id, relative_path);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_source_chunks_fts USING fts5(chunk_id UNINDEXED, relative_path, symbol, content);
CREATE TABLE IF NOT EXISTS knowledge_artifact_publications (
  artifact_set_id TEXT PRIMARY KEY REFERENCES knowledge_artifact_sets(id) ON DELETE CASCADE,
  status TEXT NOT NULL, published_by INTEGER, published_at TEXT, retired_at TEXT
);
`
};
