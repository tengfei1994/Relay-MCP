/** Additive migration for fact search, including databases that already applied 009-search. */
export const KNOWLEDGE_FACTS_SEARCH_MIGRATION = {
  version: "010-facts-search",
  sql: `
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_facts_fts USING fts5(fact_id UNINDEXED, text, tags);
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
