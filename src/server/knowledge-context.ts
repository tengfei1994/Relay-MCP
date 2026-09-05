import { join } from "path";
import { createKnowledgeStore, type KnowledgeStore } from "../knowledge/store.js";

let store: KnowledgeStore | undefined;

export function getKnowledgeStore(): KnowledgeStore {
  if (store) return store;
  const stateRoot = process.env.RELAY_STATE_ROOT ?? join(process.env.WORKSPACE_ROOT ?? "./data", ".relay-mcp");
  store = createKnowledgeStore({
    dbPath: process.env.KNOWLEDGE_DB_PATH ?? join(stateRoot, "knowledge.db"),
    appDbPath: process.env.DB_PATH ?? "./data/app.db",
    casebookRoot: process.env.KNOWLEDGE_CASEBOOK_ROOT,
    evidenceRoot: process.env.KNOWLEDGE_EVIDENCE_ROOT ?? join(stateRoot, "evidence"),
  });
  return store;
}

