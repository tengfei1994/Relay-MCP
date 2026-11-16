/** Separate public product documents and explicitly reviewed Memory scopes. */
export const KNOWLEDGE_ACCESS_MIGRATION = {
  version: "055-knowledge-access",
  requiresForeignKeysOff: true,
  sql: `
CREATE TABLE knowledge_confirmed_memories_v2 (
  id TEXT PRIMARY KEY, memory_type TEXT NOT NULL, title TEXT NOT NULL,
  statement TEXT NOT NULL, details_json TEXT NOT NULL, project_id TEXT,
  environment TEXT, scope_json TEXT NOT NULL, evidence_refs_json TEXT NOT NULL,
  source_json TEXT NOT NULL, confirmed_by INTEGER NOT NULL, confirmed_at TEXT NOT NULL,
  audit_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  memory_scope TEXT NOT NULL DEFAULT 'project', source_project_id TEXT,
  CHECK(memory_type IN ('Fact','Decision','Case','Pattern')),
  CHECK(status IN ('confirmed','deprecated')),
  CHECK(memory_scope IN ('project','general','review')),
  CHECK(memory_scope <> 'project' OR project_id IS NOT NULL)
);
INSERT INTO knowledge_confirmed_memories_v2
  (id,memory_type,title,statement,details_json,project_id,environment,scope_json,evidence_refs_json,source_json,confirmed_by,confirmed_at,audit_json,status,created_at,updated_at,memory_scope,source_project_id)
SELECT id,memory_type,title,statement,details_json,project_id,environment,scope_json,evidence_refs_json,source_json,confirmed_by,confirmed_at,audit_json,status,created_at,updated_at,
  CASE WHEN json_valid(scope_json) AND json_extract(scope_json,'$.visibility') IN ('global','organization') THEN 'review' ELSE 'project' END,
  project_id
FROM knowledge_confirmed_memories;
DROP TABLE knowledge_confirmed_memories;
ALTER TABLE knowledge_confirmed_memories_v2 RENAME TO knowledge_confirmed_memories;
CREATE INDEX idx_confirmed_memory_scope ON knowledge_confirmed_memories(memory_scope,project_id,environment,memory_type,status);
CREATE INDEX idx_confirmed_memory_confirmed_at ON knowledge_confirmed_memories(confirmed_at);

CREATE TABLE IF NOT EXISTS knowledge_memory_submissions (
  id TEXT PRIMARY KEY, actor_id INTEGER NOT NULL, project_id TEXT,
  requested_scope TEXT NOT NULL, title TEXT NOT NULL, memory_type TEXT NOT NULL,
  statement TEXT NOT NULL, context_json TEXT NOT NULL DEFAULT '{}',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]', work_session_id TEXT,
  idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', reviewer_id INTEGER, review_reason TEXT,
  reviewed_at TEXT, memory_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(actor_id,idempotency_key),
  CHECK(requested_scope IN ('project','general')),
  CHECK(requested_scope <> 'project' OR project_id IS NOT NULL),
  CHECK(memory_type IN ('Fact','Decision','Case','Pattern')),
  CHECK(status IN ('pending','needs_info','approved','rejected'))
);
CREATE INDEX IF NOT EXISTS idx_memory_submission_queue ON knowledge_memory_submissions(status,updated_at,id);
CREATE INDEX IF NOT EXISTS idx_memory_submission_actor ON knowledge_memory_submissions(actor_id,created_at);

CREATE TABLE IF NOT EXISTS knowledge_memory_scope_reviews (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, reviewer_id INTEGER NOT NULL,
  previous_scope TEXT NOT NULL, new_scope TEXT NOT NULL, reason TEXT NOT NULL,
  previous_statement TEXT NOT NULL, reviewed_statement TEXT NOT NULL, previous_title TEXT NOT NULL,
  previous_details_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_scope_reviews_memory ON knowledge_memory_scope_reviews(memory_id,created_at);

CREATE TABLE IF NOT EXISTS knowledge_legacy_candidate_reviews (
  id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, reviewer_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('approve','reject','needs_info')),
  reason TEXT NOT NULL, memory_id TEXT, submission_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_legacy_candidate_reviews_candidate ON knowledge_legacy_candidate_reviews(candidate_id,created_at);

-- Historical revisions did not record their source set. Only the current
-- revision can be tied to the current page; older unknown histories remain
-- intact but must not be exposed or rolled back without verified provenance.
CREATE TABLE IF NOT EXISTS knowledge_wiki_revision_sources (
  page_id TEXT NOT NULL, revision INTEGER NOT NULL, source_refs_json TEXT NOT NULL,
  PRIMARY KEY(page_id,revision)
);
INSERT OR IGNORE INTO knowledge_wiki_revision_sources(page_id,revision,source_refs_json)
  SELECT p.id,p.current_revision,
    CASE WHEN json_valid(p.source_refs_json) AND json_type(p.source_refs_json)='array' THEN
      (SELECT json_group_array(value) FROM (
        SELECT value FROM json_each(p.source_refs_json)
        UNION SELECT c.document_id AS value FROM knowledge_wiki_section_citations c
          JOIN knowledge_wiki_sections s ON s.id=c.section_id WHERE s.page_id=p.id
      ))
    ELSE p.source_refs_json END
  FROM knowledge_wiki_pages p;
CREATE TRIGGER IF NOT EXISTS knowledge_wiki_revision_sources_insert AFTER INSERT ON knowledge_wiki_page_revisions BEGIN
  INSERT OR IGNORE INTO knowledge_wiki_revision_sources(page_id,revision,source_refs_json)
    SELECT new.page_id,new.revision,
      CASE WHEN json_valid(p.source_refs_json) AND json_type(p.source_refs_json)='array' THEN
        (SELECT json_group_array(value) FROM (
          SELECT value FROM json_each(p.source_refs_json)
          UNION SELECT c.document_id AS value FROM knowledge_wiki_section_citations c
            JOIN knowledge_wiki_sections s ON s.id=c.section_id WHERE s.page_id=p.id
        ))
      ELSE p.source_refs_json END
    FROM knowledge_wiki_pages p WHERE p.id=new.page_id;
END;

-- Bind every search hit to one authoritative chunk identity, including when
-- several chunks happen to contain identical text.
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_product_chunk_fts USING fts5(chunk_id UNINDEXED,document_id UNINDEXED,title,body);
INSERT INTO knowledge_product_chunk_fts(chunk_id,document_id,title,body)
  SELECT c.id,c.document_id,d.title,c.content FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE d.kind='product_document';
CREATE TRIGGER IF NOT EXISTS knowledge_product_chunk_fts_delete AFTER DELETE ON knowledge_documents BEGIN
  DELETE FROM knowledge_product_chunk_fts WHERE document_id=old.id;
END;

CREATE TABLE IF NOT EXISTS knowledge_product_classifications (
  document_id TEXT PRIMARY KEY,
  classification TEXT NOT NULL CHECK(classification IN ('product','project','pending')),
  reviewed_by INTEGER, reason TEXT, updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO knowledge_product_classifications(document_id,classification,reason,updated_at)
SELECT id,'product','Existing published global product',updated_at FROM knowledge_documents
WHERE kind='product_document' AND project_id IS NULL AND environment IS NULL AND lifecycle IN ('approved','verified')
  AND NOT EXISTS (SELECT 1 FROM knowledge_scope_bindings s WHERE s.document_id=knowledge_documents.id AND s.source_project_id IS NOT NULL AND s.source_project_id<>'');
INSERT OR IGNORE INTO knowledge_product_classifications(document_id,classification,reason,updated_at)
SELECT id,'product','Existing published global product',updated_at FROM knowledge_weknora_documents
WHERE project_id IS NULL AND environment IS NULL AND status='published'
  AND NOT EXISTS (SELECT 1 FROM knowledge_migration_documents md JOIN knowledge_documents d ON d.id=md.local_document_id
    WHERE md.document_id=knowledge_weknora_documents.id AND (d.project_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM knowledge_scope_bindings s WHERE s.document_id=d.id AND s.source_project_id IS NOT NULL AND s.source_project_id<>'')));
`,
};
