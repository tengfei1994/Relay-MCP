// A mapping records historical identity as well as its current routing state.
// Withdrawal never rewrites the original migration report or source manifest.
const timestamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function withdraw(where: string, reason: string): string {
  return `INSERT INTO knowledge_audit(id,actor_id,project_id,action,entity_type,entity_id,details_json,occurred_at)
    SELECT 'withdraw-'||lower(hex(randomblob(16))),NULL,NULL,'knowledge.migration.withdraw_document','migration',migration_id,
      json_object('localDocumentId',local_document_id,'documentId',document_id,'externalDocumentId',external_document_id,'previousStatus',status,'status','withdrawn','reason','${reason}'),${timestamp}
    FROM knowledge_migration_documents WHERE status IN ('staged','published') AND (${where});
    UPDATE knowledge_migration_documents SET status='withdrawn',withdrawn_at=${timestamp},withdrawal_reason='${reason}',updated_at=${timestamp}
    WHERE status IN ('staged','published') AND (${where});`;
}
export const MIGRATION_WITHDRAWAL_MIGRATION = {
  version: "043-migration-withdrawal",
  sql: `CREATE TABLE knowledge_migration_documents_043 (
    migration_id TEXT NOT NULL REFERENCES knowledge_migrations(id) ON DELETE CASCADE,
    local_document_id TEXT NOT NULL,
    document_id TEXT REFERENCES knowledge_weknora_documents(id),
    idempotency_key TEXT NOT NULL,
    external_document_id TEXT,
    status TEXT NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','published','failed','withdrawn')),
    failure_code TEXT, failure_message TEXT, content_sha256 TEXT, parser_version TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    withdrawn_at TEXT, withdrawal_reason TEXT,
    PRIMARY KEY(migration_id,local_document_id)
  );
  INSERT INTO knowledge_migration_documents_043(migration_id,local_document_id,document_id,idempotency_key,external_document_id,status,failure_code,failure_message,content_sha256,parser_version,created_at,updated_at)
    SELECT migration_id,local_document_id,document_id,idempotency_key,external_document_id,status,failure_code,failure_message,content_sha256,parser_version,created_at,updated_at FROM knowledge_migration_documents;
  DROP TABLE knowledge_migration_documents;
  ALTER TABLE knowledge_migration_documents_043 RENAME TO knowledge_migration_documents;
  CREATE INDEX idx_migration_documents_status ON knowledge_migration_documents(migration_id,status);
  CREATE INDEX idx_migration_documents_key ON knowledge_migration_documents(idempotency_key);
  CREATE INDEX idx_migration_documents_source ON knowledge_migration_documents(document_id,status);
  ${withdraw("document_id IN (SELECT id FROM knowledge_weknora_documents WHERE status='deprecated')", "schema043_source_deprecated")}
  CREATE TRIGGER knowledge_migration_source_withdrawal AFTER UPDATE OF status ON knowledge_weknora_documents WHEN NEW.status='deprecated' BEGIN
    ${withdraw("document_id=NEW.id", "source_deprecated")}
  END;
  CREATE TRIGGER knowledge_migration_insert_withdrawal AFTER INSERT ON knowledge_migration_documents
    WHEN NEW.status IN ('staged','published') AND EXISTS(SELECT 1 FROM knowledge_weknora_documents WHERE id=NEW.document_id AND status='deprecated') BEGIN
    ${withdraw("migration_id=NEW.migration_id AND local_document_id=NEW.local_document_id", "source_deprecated")}
  END;
  CREATE TRIGGER knowledge_migration_update_withdrawal AFTER UPDATE OF status,document_id ON knowledge_migration_documents
    WHEN NEW.status IN ('staged','published') AND EXISTS(SELECT 1 FROM knowledge_weknora_documents WHERE id=NEW.document_id AND status='deprecated') BEGIN
    ${withdraw("migration_id=NEW.migration_id AND local_document_id=NEW.local_document_id", "source_deprecated")}
  END;
  CREATE TRIGGER knowledge_migration_withdrawal_terminal BEFORE UPDATE OF status ON knowledge_migration_documents
    WHEN OLD.status='withdrawn' AND NEW.status!='withdrawn' BEGIN
    SELECT RAISE(ABORT,'Withdrawn migration mapping requires a new migration');
  END;`,
};
