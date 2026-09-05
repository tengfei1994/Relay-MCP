export const EVENT_RELIABILITY_MIGRATION = {
  version: "005-event-reliability",
  sql: `
ALTER TABLE relay_domain_events ADD COLUMN event_key TEXT;
CREATE TABLE IF NOT EXISTS knowledge_outbox_claims (
  event_id TEXT NOT NULL REFERENCES relay_domain_events(id),
  consumer_name TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  claimed_until TEXT,
  claimed_by TEXT,
  last_error TEXT,
  consumed_at TEXT,
  PRIMARY KEY(event_id, consumer_name)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_outbox_claims_ready ON knowledge_outbox_claims(consumer_name, available_at, claimed_until);
`,
};
