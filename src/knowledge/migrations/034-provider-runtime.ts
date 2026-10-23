/** Runtime policy columns and pending reindex jobs for managed providers. */
export const PROVIDER_RUNTIME_MIGRATION = {
  version: "034-provider-runtime",
  sql: `
ALTER TABLE knowledge_provider_configs ADD COLUMN quota_max_calls INTEGER;
ALTER TABLE knowledge_provider_configs ADD COLUMN quota_window_ms INTEGER;
ALTER TABLE knowledge_provider_configs ADD COLUMN index_version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS knowledge_provider_reindex_jobs (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES knowledge_provider_configs(id),
  index_version INTEGER NOT NULL,
  from_model_id TEXT,
  from_dimensions INTEGER,
  to_model_id TEXT NOT NULL,
  to_dimensions INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK(status IN ('pending','running','completed','failed'))
);
CREATE INDEX IF NOT EXISTS idx_provider_reindex_status ON knowledge_provider_reindex_jobs(status, provider_id);
`
};

/** DDL rerun when the columns above were applied before a crash. */
export const PROVIDER_RUNTIME_MIGRATION_RECOVERY_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_provider_reindex_jobs (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES knowledge_provider_configs(id),
  index_version INTEGER NOT NULL,
  from_model_id TEXT,
  from_dimensions INTEGER,
  to_model_id TEXT NOT NULL,
  to_dimensions INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK(status IN ('pending','running','completed','failed'))
);
CREATE INDEX IF NOT EXISTS idx_provider_reindex_status ON knowledge_provider_reindex_jobs(status, provider_id);
`;
