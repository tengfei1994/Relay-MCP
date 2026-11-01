/** Durable, job-scoped controls for Wiki generation. */
export const WIKI_GENERATION_CONTROLS_MIGRATION = {
  version: "053-wiki-generation-controls",
  sql: `
ALTER TABLE knowledge_ingest_jobs ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'automatic';
ALTER TABLE knowledge_ingest_jobs ADD COLUMN control_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE knowledge_ingest_jobs ADD COLUMN pause_requested_at TEXT;
ALTER TABLE knowledge_ingest_jobs ADD COLUMN paused_at TEXT;
ALTER TABLE knowledge_ingest_jobs ADD COLUMN paused_by INTEGER;
ALTER TABLE knowledge_ingest_jobs ADD COLUMN resumed_at TEXT;
UPDATE knowledge_ingest_jobs
SET trigger_kind='manual'
WHERE kind='wiki_generation'
  AND json_extract(payload_json,'$.triggerId') LIKE 'manual-%';
`,
};
