import { resolve } from "node:path";
import { createKnowledgeStore } from "../src/knowledge/store.js";
import { rebuildProductGraph } from "../src/knowledge/product-graph.js";

const dbPath = resolve(process.env.KNOWLEDGE_DB_PATH ?? "./data/knowledge.db");
const appDbPath = resolve(process.env.DB_PATH ?? "./data/app.db");
const batchSize = Math.max(1, Math.min(1000, Number(process.env.PRODUCT_GRAPH_BATCH_SIZE ?? 200)));
const store = createKnowledgeStore({ dbPath, appDbPath });
let afterDocumentId: string | undefined;
let scanned = 0;
let rebuilt = 0;
let failed = 0;
let entityCount = 0;
let relationCount = 0;
try {
  for (;;) {
    const result = rebuildProductGraph(store, { limit: batchSize, afterDocumentId, includeDeprecated: true });
    scanned += result.scanned;
    rebuilt += result.rebuilt;
    failed += result.failed;
    entityCount += result.entityCount;
    relationCount += result.relationCount;
    if (result.errors.length) console.error(JSON.stringify(result.errors));
    if (result.complete || !result.lastDocumentId) break;
    afterDocumentId = result.lastDocumentId;
  }
  console.log(JSON.stringify({ ok: failed === 0, dbPath, scanned, rebuilt, failed, entityCount, relationCount }));
  if (failed) process.exitCode = 1;
} finally {
  store.close();
}
