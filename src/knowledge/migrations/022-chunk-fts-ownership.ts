/** Chunk projection owns FTS writes; document rowids are not chunk rowids. */
export const CHUNK_FTS_OWNERSHIP_MIGRATION = {
  version: "022-chunk-fts-ownership",
  sql: `DROP TRIGGER IF EXISTS knowledge_documents_ai;
  DROP TRIGGER IF EXISTS knowledge_documents_au;
  DROP TRIGGER IF EXISTS knowledge_documents_ad;
  CREATE TRIGGER knowledge_documents_ad AFTER DELETE ON knowledge_documents BEGIN
    DELETE FROM knowledge_fts WHERE document_id = old.id;
  END;
  DELETE FROM knowledge_fts;
  INSERT INTO knowledge_fts(document_id,title,body)
    SELECT d.id,d.title || ' [chunk ' || (c.ordinal + 1) || ']',c.content
    FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id;
  INSERT INTO knowledge_fts(document_id,title,body)
    SELECT d.id,d.title,d.body FROM knowledge_documents d
    WHERE NOT EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.document_id=d.id);`,
};
