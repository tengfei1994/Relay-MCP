/** The single executable source for the initial Knowledge Plane schema. */
export const INITIAL_KNOWLEDGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_domain_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  project_id TEXT,
  job_id TEXT,
  deployment_id TEXT,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_outbox (
  event_id TEXT PRIMARY KEY REFERENCES relay_domain_events(id),
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS knowledge_consumer_checkpoint (
  consumer_name TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES relay_domain_events(id),
  consumed_at TEXT NOT NULL,
  PRIMARY KEY (consumer_name, event_id)
);
`;
