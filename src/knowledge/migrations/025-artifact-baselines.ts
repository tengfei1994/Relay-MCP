/** Storage model for large Solution packages and immutable source snapshots. */
export const ARTIFACT_BASELINES_MIGRATION = {
  version: "025-artifact-baselines",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_artifact_sets (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, version TEXT,
  source_locator TEXT NOT NULL, storage_uri TEXT, sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready', metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_sets_hash ON knowledge_artifact_sets(sha256);
CREATE TABLE IF NOT EXISTS knowledge_artifacts (
  id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES knowledge_artifact_sets(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL, category TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL, storage_uri TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  UNIQUE(set_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_category ON knowledge_artifacts(set_id, category);
CREATE TABLE IF NOT EXISTS knowledge_source_baselines (
  id TEXT PRIMARY KEY, artifact_set_id TEXT NOT NULL REFERENCES knowledge_artifact_sets(id) ON DELETE CASCADE,
  solution TEXT, version TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, root_locator TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE(solution, version)
);
CREATE TABLE IF NOT EXISTS knowledge_source_files (
  id TEXT PRIMARY KEY, baseline_id TEXT NOT NULL REFERENCES knowledge_source_baselines(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL, language TEXT, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  storage_uri TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  UNIQUE(baseline_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_source_files_lookup ON knowledge_source_files(baseline_id, relative_path);
CREATE TABLE IF NOT EXISTS knowledge_project_snapshots (
  id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL, version TEXT, source_locator TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_project_snapshot_files (
  id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES knowledge_project_snapshots(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL, language TEXT, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  storage_uri TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  UNIQUE(snapshot_id, relative_path)
);
`
};
