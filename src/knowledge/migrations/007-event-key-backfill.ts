/** Repairs databases that already recorded 005 before event-key backfill was introduced. */
export const EVENT_KEY_BACKFILL_MIGRATION = {
  version: "007-event-key-backfill",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_migration_dead_letter (
  event_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
DROP INDEX IF EXISTS idx_relay_domain_events_event_key;
UPDATE relay_domain_events SET event_key = trim(event_key) WHERE event_key IS NOT NULL AND length(trim(event_key)) > 0;
UPDATE relay_domain_events SET event_key = NULL WHERE event_key IS NOT NULL AND length(trim(event_key)) = 0;
UPDATE relay_domain_events
SET event_key = CASE
  WHEN job_id IS NOT NULL THEN 'job:' || job_id || ':' || substr(type, instr(type, '.') + 1)
  WHEN deployment_id IS NOT NULL THEN 'deployment:' || deployment_id || ':' || substr(type, instr(type, '.') + 1)
  ELSE event_key
END
WHERE event_key IS NULL
  AND (job_id IS NOT NULL OR deployment_id IS NOT NULL)
  AND id = (
    SELECT canonical.id FROM relay_domain_events canonical
    WHERE canonical.event_key IS NULL
      AND canonical.job_id IS relay_domain_events.job_id
      AND canonical.deployment_id IS relay_domain_events.deployment_id
      AND canonical.type = relay_domain_events.type
    ORDER BY canonical.occurred_at ASC, canonical.id ASC
    LIMIT 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM relay_domain_events existing
    WHERE existing.event_key = CASE
      WHEN relay_domain_events.job_id IS NOT NULL THEN 'job:' || relay_domain_events.job_id || ':' || substr(relay_domain_events.type, instr(relay_domain_events.type, '.') + 1)
      ELSE 'deployment:' || relay_domain_events.deployment_id || ':' || substr(relay_domain_events.type, instr(relay_domain_events.type, '.') + 1)
    END
  );
INSERT OR IGNORE INTO knowledge_migration_dead_letter(event_id, reason, occurred_at, recorded_at)
SELECT duplicate.id, 'duplicate_derived_event_key', duplicate.occurred_at, datetime('now')
FROM relay_domain_events duplicate
JOIN relay_domain_events canonical
  ON canonical.job_id IS duplicate.job_id
 AND canonical.deployment_id IS duplicate.deployment_id
 AND canonical.type = duplicate.type
 AND canonical.event_key IS NOT NULL
 AND duplicate.id <> canonical.id
WHERE duplicate.event_key IS NULL;
INSERT OR IGNORE INTO knowledge_migration_dead_letter(event_id, reason, occurred_at, recorded_at)
SELECT id, 'event_key_unrecoverable', occurred_at, datetime('now')
FROM relay_domain_events candidate
WHERE candidate.event_key IS NULL
  AND NOT EXISTS (SELECT 1 FROM knowledge_migration_dead_letter dead WHERE dead.event_id = candidate.id);
-- 005 could have added event_key and then failed while creating its unique
-- index. Preserve the earliest event for each already-populated key and
-- dead-letter the later rows before restoring the constraint.
INSERT OR IGNORE INTO knowledge_migration_dead_letter(event_id, reason, occurred_at, recorded_at)
SELECT duplicate.id, 'duplicate_event_key', duplicate.occurred_at, datetime('now')
FROM relay_domain_events duplicate
WHERE duplicate.event_key IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM relay_domain_events canonical
    WHERE canonical.event_key = duplicate.event_key
      AND canonical.id <> duplicate.id
      AND (
        canonical.occurred_at < duplicate.occurred_at
        OR (canonical.occurred_at = duplicate.occurred_at AND canonical.id < duplicate.id)
      )
  );
UPDATE relay_domain_events
SET event_key = NULL
WHERE id IN (
  SELECT event_id
  FROM knowledge_migration_dead_letter
  WHERE reason = 'duplicate_event_key'
);
-- Dead-lettered historical events remain in relay_domain_events for audit, but
-- their delivery metadata must not leave a stale consumer backlog behind.
DELETE FROM knowledge_outbox_claims
WHERE event_id IN (SELECT event_id FROM knowledge_migration_dead_letter);
DELETE FROM knowledge_consumer_checkpoint
WHERE event_id IN (SELECT event_id FROM knowledge_migration_dead_letter);
DELETE FROM knowledge_outbox
WHERE event_id IN (SELECT event_id FROM knowledge_migration_dead_letter);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_domain_events_event_key ON relay_domain_events(event_key) WHERE event_key IS NOT NULL;
`,
};
