/** Vector cache and reproducible retrieval run audit records. */
export const KNOWLEDGE_HYBRID_RETRIEVAL_MIGRATION = {
  version: "011-hybrid-retrieval",
  sql: `
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  document_id TEXT PRIMARY KEY REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  source_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_model ON knowledge_embeddings(model_id, dimensions);
CREATE TABLE IF NOT EXISTS knowledge_retrieval_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  query TEXT NOT NULL,
  provider_model_id TEXT,
  degraded INTEGER NOT NULL DEFAULT 0,
  results_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_retrieval_runs_project ON knowledge_retrieval_runs(project_id, created_at);
`,
};
