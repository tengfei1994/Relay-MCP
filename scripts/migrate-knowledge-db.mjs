import { join } from "node:path";
import { migrateKnowledgeDatabase } from "../dist/knowledge/store.js";
import "dotenv/config";

const workspaceRoot = process.env.WORKSPACE_ROOT || "/workspace";
const stateRoot = process.env.RELAY_STATE_ROOT || join(workspaceRoot, ".relay-mcp");
const dbPath = process.env.KNOWLEDGE_DB_PATH || join(stateRoot, "knowledge.db");

console.log(`[knowledge-migration] migrating ${dbPath}`);
migrateKnowledgeDatabase({
  dbPath,
  appDbPath: process.env.DB_PATH || "./data/app.db",
  casebookRoot: process.env.KNOWLEDGE_CASEBOOK_ROOT,
  evidenceRoot: process.env.KNOWLEDGE_EVIDENCE_ROOT || join(stateRoot, "evidence"),
});
console.log(`[knowledge-migration] completed ${dbPath}`);
