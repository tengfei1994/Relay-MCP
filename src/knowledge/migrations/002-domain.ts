export const KNOWLEDGE_DOMAIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  lifecycle TEXT NOT NULL, project_id TEXT, project_name_snapshot TEXT,
  samplemanager_version TEXT, solution TEXT, module TEXT, environment TEXT,
  source_locator TEXT NOT NULL, source_commit TEXT, source_sha256 TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(kind IN ('candidate','case','pattern','playbook','fact','evidence','relation')),
  CHECK(lifecycle IN ('draft','reproduced','verified','approved','deprecated'))
);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES knowledge_documents(id),
  ordinal INTEGER NOT NULL, content TEXT NOT NULL, content_sha256 TEXT NOT NULL,
  UNIQUE(document_id, ordinal)
);
-- Promotable domain projections. The document row remains the canonical
-- searchable/provenance envelope; these tables hold type-specific fields.
CREATE TABLE IF NOT EXISTS knowledge_cases (
  id TEXT PRIMARY KEY REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft',
  customer_case_id TEXT, deployment_id TEXT, job_id TEXT,
  version TEXT NOT NULL DEFAULT '1', samplemanager_version TEXT, solution TEXT, module TEXT, environment TEXT,
  symptoms TEXT, root_cause TEXT,
  fix TEXT, verification TEXT, applicability TEXT,
  created_by INTEGER, reviewed_by INTEGER, verified_at TEXT, expires_at TEXT,
  confidence REAL, evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  source_locator TEXT NOT NULL, source_sha256 TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(status IN ('draft','reproduced','verified','approved','deprecated'))
);
CREATE TABLE IF NOT EXISTS knowledge_patterns (
  id TEXT PRIMARY KEY REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft',
  version TEXT NOT NULL DEFAULT '1', samplemanager_version TEXT, solution TEXT, module TEXT, environment TEXT, applicability TEXT,
  case_refs_json TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER, reviewed_by INTEGER, verified_at TEXT, expires_at TEXT,
  confidence REAL, evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  source_locator TEXT NOT NULL, source_sha256 TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(status IN ('draft','reproduced','verified','approved','deprecated'))
);
CREATE TABLE IF NOT EXISTS knowledge_playbooks (
  id TEXT PRIMARY KEY REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft',
  version TEXT NOT NULL DEFAULT '1', samplemanager_version TEXT, solution TEXT, module TEXT, environment TEXT, steps_json TEXT NOT NULL DEFAULT '[]',
  rollback TEXT, skill_diff TEXT,
  created_by INTEGER, reviewed_by INTEGER, verified_at TEXT, expires_at TEXT,
  confidence REAL, evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  source_locator TEXT NOT NULL, source_sha256 TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(status IN ('draft','reproduced','verified','approved','deprecated'))
);
CREATE TABLE IF NOT EXISTS knowledge_candidates (
  id TEXT PRIMARY KEY REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft',
  candidate_type TEXT NOT NULL DEFAULT 'case', samplemanager_version TEXT, solution TEXT, module TEXT, environment TEXT, event_id TEXT,
  deployment_id TEXT, job_id TEXT, evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  reviewed_by INTEGER, verified_at TEXT,
  source_locator TEXT NOT NULL, source_sha256 TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(status IN ('draft','reproduced','verified','approved','deprecated')),
  CHECK(candidate_type IN ('case','pattern','playbook'))
);
CREATE TABLE IF NOT EXISTS knowledge_facts (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, project_id TEXT, project_name_snapshot TEXT,
  text TEXT NOT NULL, tags_json TEXT NOT NULL, source_locator TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'resolved', created_at TEXT NOT NULL,
  CHECK(status IN ('resolved','unresolved'))
);
CREATE TABLE IF NOT EXISTS knowledge_evidence (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, source_kind TEXT NOT NULL,
  project_id TEXT, source_locator TEXT NOT NULL, retention TEXT NOT NULL,
  created_at TEXT NOT NULL, deleted_at TEXT,
  CHECK(retention IN ('standard','legal_hold','gmp_hold'))
);
CREATE TABLE IF NOT EXISTS knowledge_relations (
  id TEXT PRIMARY KEY, from_document_id TEXT NOT NULL REFERENCES knowledge_documents(id),
  to_document_id TEXT NOT NULL REFERENCES knowledge_documents(id), relation_type TEXT NOT NULL,
  source_locator TEXT NOT NULL, confidence REAL NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
  extraction_version TEXT NOT NULL, created_at TEXT NOT NULL,
  project_id TEXT, samplemanager_version TEXT, solution TEXT, module TEXT, environment TEXT,
  source_sha256 TEXT,
  CHECK(confidence >= 0 AND confidence <= 1),
  CHECK(verified IN (0,1))
);
CREATE TABLE IF NOT EXISTS knowledge_reviews (
  id TEXT PRIMARY KEY, document_id TEXT REFERENCES knowledge_documents(id),
  entity_type TEXT NOT NULL DEFAULT 'case', entity_id TEXT,
  reviewer_id INTEGER NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL,
  before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_feedback (
  id TEXT PRIMARY KEY, document_id TEXT REFERENCES knowledge_documents(id), entity_id TEXT,
  user_id INTEGER NOT NULL, helpful INTEGER, comment TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_acl (
  project_id TEXT NOT NULL, user_id INTEGER NOT NULL, can_read INTEGER NOT NULL DEFAULT 1,
  can_review INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id, user_id),
  CHECK(can_read IN (0,1)), CHECK(can_review IN (0,1))
);
CREATE TABLE IF NOT EXISTS knowledge_entity_evidence (
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES knowledge_evidence(id),
  created_at TEXT NOT NULL, PRIMARY KEY(entity_type, entity_id, evidence_id)
);
CREATE TABLE IF NOT EXISTS knowledge_evidence_acl (
  evidence_id TEXT NOT NULL REFERENCES knowledge_evidence(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(evidence_id, project_id)
);
CREATE TABLE IF NOT EXISTS knowledge_ingest_runs (
  id TEXT PRIMARY KEY, source_locator TEXT NOT NULL, status TEXT NOT NULL,
  imported INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_scope ON knowledge_documents(project_id, lifecycle, kind);
CREATE INDEX IF NOT EXISTS idx_knowledge_facts_scope ON knowledge_facts(user_id, project_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_project ON knowledge_evidence(project_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_cases_version ON knowledge_cases(version, reviewed_by);
CREATE INDEX IF NOT EXISTS idx_knowledge_patterns_version ON knowledge_patterns(version, reviewed_by);
CREATE INDEX IF NOT EXISTS idx_knowledge_playbooks_version ON knowledge_playbooks(version, reviewed_by);
CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_event ON knowledge_candidates(event_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_entity_evidence ON knowledge_entity_evidence(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_acl_project ON knowledge_evidence_acl(project_id, evidence_id);
`;
export const KNOWLEDGE_DOMAIN_MIGRATION = { version: "002-domain", sql: KNOWLEDGE_DOMAIN_SCHEMA };
