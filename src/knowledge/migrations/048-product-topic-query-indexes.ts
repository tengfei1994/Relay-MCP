/** Query indexes for bounded Product Knowledge topic lists and details. */
export const PRODUCT_TOPIC_QUERY_INDEXES_MIGRATION = {
  version: "048-product-topic-query-indexes",
  sql: `
CREATE INDEX IF NOT EXISTS idx_knowledge_topics_title_id
  ON knowledge_topics(canonical_title, id);
CREATE INDEX IF NOT EXISTS idx_product_bindings_topic_version_document
  ON knowledge_product_document_bindings(topic_id, product_version, document_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_kind_scope
  ON knowledge_documents(kind, project_id, environment, id);
`
};
