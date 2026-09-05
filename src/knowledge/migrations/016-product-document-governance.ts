export const PRODUCT_DOCUMENT_GOVERNANCE_MIGRATION = {
  version: "016-product-document-governance",
  sql: `
ALTER TABLE knowledge_product_documents ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE knowledge_product_documents ADD COLUMN diff_review_status TEXT NOT NULL DEFAULT 'not_reviewed';
ALTER TABLE knowledge_product_documents ADD COLUMN diff_reviewed_by INTEGER;
ALTER TABLE knowledge_product_documents ADD COLUMN diff_reviewed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_product_docs_review ON knowledge_product_documents(diff_review_status, updated_at);
`,
};
