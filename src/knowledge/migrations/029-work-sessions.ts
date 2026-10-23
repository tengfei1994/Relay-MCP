/** Durable Work Session and IntentEnvelope correlation tables (#44/#45). */
export const WORK_SESSION_MIGRATION = {
  version: "029-work-sessions",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_work_sessions (
  id TEXT PRIMARY KEY,
  actor_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  environment TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  intent_json TEXT NOT NULL,
  summary TEXT,
  unknowns_json TEXT NOT NULL DEFAULT '[]',
  acceptance_results_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE(actor_id, idempotency_key),
  CHECK(status IN ('open','active','awaiting_review','completed','abandoned','needs_clarification'))
);
CREATE INDEX IF NOT EXISTS idx_work_sessions_scope ON knowledge_work_sessions(project_id, actor_id, status, updated_at);
CREATE TABLE IF NOT EXISTS knowledge_work_session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES knowledge_work_sessions(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  intent_step TEXT,
  objective_ref TEXT,
  acceptance_criterion_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_work_session_events_session ON knowledge_work_session_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_work_session_events_event ON knowledge_work_session_events(event_id);
`
};
