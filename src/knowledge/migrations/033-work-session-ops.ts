/** Persisted idempotency records for Work Session mutations (#44/#45). */
export const WORK_SESSION_OPS_MIGRATION = {
  version: "033-work-session-ops",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_work_session_ops (
  session_id TEXT NOT NULL REFERENCES knowledge_work_sessions(id) ON DELETE CASCADE,
  op TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY(session_id, op, idempotency_key)
);
`
};
