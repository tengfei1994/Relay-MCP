export const PROVIDER_SECRETS_MIGRATION = {
  version: "039-provider-secrets",
  sql: `CREATE TABLE IF NOT EXISTS knowledge_provider_secrets (
    ref TEXT PRIMARY KEY,
    ciphertext BLOB NOT NULL,
    nonce BLOB NOT NULL,
    tag BLOB NOT NULL
  );`,
};
