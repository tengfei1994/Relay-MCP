/** A durable attempt owner prevents Web/MCP dispatchers from failing each other. */
export const INGEST_OWNERSHIP_MIGRATION = {
  version: "045-ingest-ownership",
  sql: `ALTER TABLE knowledge_ingest_jobs ADD COLUMN owner_token TEXT;
    ALTER TABLE knowledge_ingest_jobs ADD COLUMN owner_pid INTEGER;`,
};
