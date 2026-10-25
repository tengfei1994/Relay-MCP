export const MANAGED_ENGINE_MIGRATION = {
  version: "040-managed-engine",
  sql: `ALTER TABLE knowledge_wiki_pages ADD COLUMN environment TEXT;
ALTER TABLE knowledge_wiki_pages ADD COLUMN external_slug TEXT;
ALTER TABLE knowledge_weknora_documents ADD COLUMN environment TEXT;
ALTER TABLE knowledge_weknora_documents ADD COLUMN upstream_parse_status TEXT;
ALTER TABLE knowledge_weknora_documents ADD COLUMN upstream_verified_at TEXT;
ALTER TABLE knowledge_weknora_documents ADD COLUMN model_provenance_json TEXT NOT NULL DEFAULT '{}';`,
};
