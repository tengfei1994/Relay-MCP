/** Derived FTS index. Casebook, Evidence, and domain tables remain the source of truth. */
export const KNOWLEDGE_SEARCH_MIGRATION = {
  version: "009-search",
  sql: `
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  document_id UNINDEXED,
  title,
  body
);
DROP TRIGGER IF EXISTS knowledge_documents_ai;
DROP TRIGGER IF EXISTS knowledge_documents_ad;
DROP TRIGGER IF EXISTS knowledge_documents_au;
CREATE TRIGGER knowledge_documents_ai AFTER INSERT ON knowledge_documents BEGIN
  INSERT INTO knowledge_fts(rowid,document_id,title,body) VALUES (new.rowid,new.id,new.title,new.body);
END;
CREATE TRIGGER knowledge_documents_ad AFTER DELETE ON knowledge_documents BEGIN
  DELETE FROM knowledge_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER knowledge_documents_au AFTER UPDATE OF title, body ON knowledge_documents BEGIN
  DELETE FROM knowledge_fts WHERE rowid = old.rowid;
  INSERT INTO knowledge_fts(rowid,document_id,title,body) VALUES (new.rowid,new.id,new.title,new.body);
END;
DELETE FROM knowledge_fts;
INSERT INTO knowledge_fts(rowid,document_id,title,body) SELECT rowid,id,title,body FROM knowledge_documents;
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_facts_fts USING fts5(
  fact_id UNINDEXED,
  text,
  tags
);
DROP TRIGGER IF EXISTS knowledge_facts_ai;
DROP TRIGGER IF EXISTS knowledge_facts_ad;
DROP TRIGGER IF EXISTS knowledge_facts_au;
CREATE TRIGGER knowledge_facts_ai AFTER INSERT ON knowledge_facts BEGIN
  INSERT INTO knowledge_facts_fts(rowid,fact_id,text,tags) VALUES (new.rowid,new.id,new.text,new.tags_json);
END;
CREATE TRIGGER knowledge_facts_ad AFTER DELETE ON knowledge_facts BEGIN
  DELETE FROM knowledge_facts_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER knowledge_facts_au AFTER UPDATE OF text,tags_json ON knowledge_facts BEGIN
  DELETE FROM knowledge_facts_fts WHERE rowid = old.rowid;
  INSERT INTO knowledge_facts_fts(rowid,fact_id,text,tags) VALUES (new.rowid,new.id,new.text,new.tags_json);
END;
DELETE FROM knowledge_facts_fts;
INSERT INTO knowledge_facts_fts(rowid,fact_id,text,tags) SELECT rowid,id,text,tags_json FROM knowledge_facts;
`,
};
