/** Durable queue for large document/artifact imports. Payloads contain paths and metadata, never file bytes. */
export const INGEST_JOBS_MIGRATION = {
  version: "027-ingest-jobs",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_ingest_jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_ready ON knowledge_ingest_jobs(status, available_at);
`
};
