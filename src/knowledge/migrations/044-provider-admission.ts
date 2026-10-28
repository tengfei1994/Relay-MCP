/** Persist logical provider admission across Web/MCP/worker processes. */
export const PROVIDER_ADMISSION_MIGRATION = {
  version: "044-provider-admission",
  sql: `CREATE TABLE knowledge_provider_admissions (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    admitted_at INTEGER NOT NULL
  );
  CREATE INDEX idx_provider_admissions_window ON knowledge_provider_admissions(provider_id,admitted_at);
  CREATE INDEX idx_provider_admissions_retention ON knowledge_provider_admissions(admitted_at);
  CREATE TABLE knowledge_provider_admission_barriers (
    provider_id TEXT PRIMARY KEY,
    not_before INTEGER NOT NULL
  );
  -- Pre-044 successful calls were not durably counted. Wait one existing
  -- window instead of treating an upgrade as a fresh, unspent allowance.
  INSERT INTO knowledge_provider_admission_barriers(provider_id,not_before)
    -- Round up to the next second: SQLite's platform clock can trail the JS
    -- millisecond clock slightly. The extra fraction is conservative and
    -- prevents an upgrade from admitting calls before a complete window.
    SELECT id,(unixepoch('now')+1)*1000+quota_window_ms
    FROM knowledge_provider_configs WHERE quota_max_calls IS NOT NULL AND quota_window_ms IS NOT NULL;`,
};
