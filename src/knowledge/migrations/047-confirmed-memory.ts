export const CONFIRMED_MEMORY_MIGRATION = {
  version: "047-confirmed-memory",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_confirmed_memories (
  id TEXT PRIMARY KEY,
  memory_type TEXT NOT NULL,
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  details_json TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment TEXT,
  scope_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  source_json TEXT NOT NULL,
  confirmed_by INTEGER NOT NULL,
  confirmed_at TEXT NOT NULL,
  audit_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(memory_type IN ('Fact','Decision','Case','Pattern')),
  CHECK(status IN ('confirmed','deprecated'))
);
CREATE INDEX IF NOT EXISTS idx_confirmed_memory_scope ON knowledge_confirmed_memories(project_id, environment, memory_type, status);
CREATE INDEX IF NOT EXISTS idx_confirmed_memory_confirmed_at ON knowledge_confirmed_memories(confirmed_at);
-- Legacy Candidate Insight rows remain readable, but new writes cannot use
-- the removed observation/playbook kinds.
CREATE TRIGGER IF NOT EXISTS trg_candidate_insight_kind_insert
BEFORE INSERT ON knowledge_candidate_insights
WHEN NEW.kind NOT IN ('fact','decision','case','pattern')
BEGIN SELECT RAISE(ABORT, 'Candidate Insight kind must be fact, decision, case, or pattern'); END;
CREATE TRIGGER IF NOT EXISTS trg_candidate_insight_kind_update
BEFORE UPDATE OF kind ON knowledge_candidate_insights
WHEN NEW.kind NOT IN ('fact','decision','case','pattern')
BEGIN SELECT RAISE(ABORT, 'Candidate Insight kind must be fact, decision, case, or pattern'); END;
`
};
