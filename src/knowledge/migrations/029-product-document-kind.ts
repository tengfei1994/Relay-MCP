/** Add product_document to legacy knowledge_documents CHECK constraints. */
export const PRODUCT_DOCUMENT_KIND_MIGRATION = {
  version: "029-product-document-kind",
  sql: `
PRAGMA writable_schema=ON;
UPDATE sqlite_master SET sql=replace(sql,
  'CHECK(kind IN (''candidate'',''case'',''pattern'',''playbook'',''fact'',''evidence'',''relation''))',
  'CHECK(kind IN (''candidate'',''case'',''pattern'',''playbook'',''product_document'',''fact'',''evidence'',''relation''))')
  WHERE type='table' AND name='knowledge_documents';
PRAGMA writable_schema=OFF;
PRAGMA schema_version = schema_version + 1;
`,
};
