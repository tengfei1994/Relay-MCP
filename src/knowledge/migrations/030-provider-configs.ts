/** Relay-owned provider configuration metadata; secret values stay in a resolver. */
export const PROVIDER_CONFIG_MIGRATION = {
  version: "030-provider-configs",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_provider_configs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  base_url TEXT,
  model_id TEXT NOT NULL,
  dimensions INTEGER,
  batch_size INTEGER,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  concurrency INTEGER NOT NULL DEFAULT 4,
  max_retries INTEGER NOT NULL DEFAULT 2,
  data_residency TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  secret_ref TEXT,
  token_configured INTEGER NOT NULL DEFAULT 0,
  reindex_required INTEGER NOT NULL DEFAULT 0,
  last_test_at TEXT,
  last_error_code TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  CHECK(kind IN ('embedding','rerank','wiki_llm','candidate_llm')),
  CHECK(status IN ('ready','pending_reindex','degraded','disabled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_config_kind_provider ON knowledge_provider_configs(kind, provider);
CREATE INDEX IF NOT EXISTS idx_provider_config_status ON knowledge_provider_configs(status, kind);
`
};
