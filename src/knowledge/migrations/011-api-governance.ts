/** Additive API governance tables used for idempotent mutations and bounded downloads. */
export const KNOWLEDGE_API_GOVERNANCE_MIGRATION = {
  version: "011-api-governance",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_api_idempotency (
  user_id INTEGER NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, operation, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_api_idempotency_created
  ON knowledge_api_idempotency(created_at);
CREATE TABLE IF NOT EXISTS knowledge_download_sessions (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES knowledge_evidence(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_bytes INTEGER NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_download_sessions_expiry
  ON knowledge_download_sessions(expires_at, used_at);
`,
};
