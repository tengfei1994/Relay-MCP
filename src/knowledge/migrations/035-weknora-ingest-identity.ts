/** Retrieval-scoped identity and failure bookkeeping for WeKnora staged documents. */
export const WEKNORA_INGEST_IDENTITY_MIGRATION = {
  version: "035-weknora-ingest-identity",
  sql: `
CREATE INDEX IF NOT EXISTS idx_weknora_documents_retrieval ON knowledge_weknora_documents(status,product_version,solution,module,topic_id);
`
};
