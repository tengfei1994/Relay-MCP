// Parser changes must have their own cache entry even when the normalized
// bytes happen to match. Existing IDs, hashes and content remain historical.
const columns = `
  id TEXT PRIMARY KEY, normalized_content_sha256 TEXT NOT NULL, raw_sha256 TEXT,
  title TEXT NOT NULL, body TEXT NOT NULL, sections_json TEXT NOT NULL DEFAULT '[]', parser_version TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(normalized_content_sha256, parser_version)
`;
export const PARSER_SCOPED_PRODUCT_REVISIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS knowledge_product_revisions (${columns});`;
export const PRODUCT_REVISION_PARSER_IDENTITY_MIGRATION = {
  version: "046-product-revision-parser-identity",
  // The runner disables FK enforcement before its transaction and validates
  // all references before commit. Renaming the old parent first would rewrite
  // child FK targets; dropping it with FK enabled could trigger referential actions.
  requiresForeignKeysOff: true,
  sql: `
CREATE TABLE knowledge_product_revisions_046 (${columns});
INSERT INTO knowledge_product_revisions_046
  (id,normalized_content_sha256,raw_sha256,title,body,sections_json,parser_version,created_at,updated_at)
  SELECT id,normalized_content_sha256,raw_sha256,title,body,sections_json,parser_version,created_at,updated_at
  FROM knowledge_product_revisions;
DROP TABLE knowledge_product_revisions;
ALTER TABLE knowledge_product_revisions_046 RENAME TO knowledge_product_revisions;
`,
};
