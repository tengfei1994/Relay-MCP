/** Consumers that stop heartbeating must not retain every historical outbox row forever. */
export const CONSUMER_HEARTBEAT_MIGRATION = {
  version: "008-consumer-heartbeats",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_consumer_registry (
  consumer_name TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL,
  active_until TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_consumer_registry_active
  ON knowledge_consumer_registry(active_until);
-- Existing installations receive a one-week grace period after upgrading,
-- rather than immediately treating prior consumers as retired.
INSERT OR IGNORE INTO knowledge_consumer_registry(consumer_name, last_seen_at, active_until)
SELECT consumer_name,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days')
FROM (
  SELECT consumer_name FROM knowledge_outbox_claims
  UNION
  SELECT consumer_name FROM knowledge_consumer_checkpoint
);
`,
};
