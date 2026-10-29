import assert from "node:assert/strict";
import {once} from "node:events";
import {spawn} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {setTimeout as sleep} from "node:timers/promises";
import {pathToFileURL} from "node:url";
import {join, resolve} from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {createKnowledgeStore} from "../src/knowledge/store.ts";

async function waitForRealLock(ms: number): Promise<void> {
  // This integration test deliberately holds a real SQLite writer lock across
  // a child process; fake timers cannot coordinate the two processes.
  await sleep(ms);
}


test("concurrent KnowledgeStore startup waits through a writer lock and leaves a valid schema", {timeout: 20_000}, async () => {
  const root = mkdtempSync(join(process.cwd(), ".tmp-knowledge-store-concurrency-"));
  const dbPath = join(root, "knowledge.db");
  const first = createKnowledgeStore({dbPath});
  first.close();
  const holder = new Database(dbPath, {timeout: 1_000});
  holder.pragma("busy_timeout = 1000");
  holder.exec("BEGIN IMMEDIATE");
  const storeUrl = pathToFileURL(resolve("src/knowledge/store.ts")).href;
  const script = `import {createKnowledgeStore} from ${JSON.stringify(storeUrl)}; const store=createKnowledgeStore({dbPath:process.env.KNOWLEDGE_TEST_DB}); const check=store.db.pragma('foreign_key_check'); console.log(JSON.stringify({foreignKeyViolations:check.length,hasTopicIndexes:Boolean(store.db.prepare("SELECT 1 FROM schema_migrations WHERE version='048-product-topic-query-indexes'").get()),hasRepairMarker:Boolean(store.db.prepare("SELECT 1 FROM schema_migrations WHERE version='knowledge-post-repair-backfill-v2'").get())})); store.close();`;
  const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {...process.env, KNOWLEDGE_TEST_DB: dbPath, KNOWLEDGE_BUSY_TIMEOUT_MS: "50", KNOWLEDGE_MIGRATION_RETRY_BASE_MS: "20", KNOWLEDGE_MIGRATION_RETRY_LIMIT: "20"},
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.once("error", (error) => { stderr += String(error); });
  try {
    await waitForRealLock(180);
    holder.exec("COMMIT");
    const [exitCode] = await once(child, "close") as [number | null];
    assert.equal(exitCode, 0, stderr || stdout);
    const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
    assert.deepEqual(report, {foreignKeyViolations: 0, hasTopicIndexes: true, hasRepairMarker: true});
  } finally {
    if (holder.inTransaction) holder.exec("ROLLBACK");
    holder.close();
    if (!child.killed) child.kill();
    rmSync(root, {recursive: true, force: true, maxRetries: 3, retryDelay: 20});
  }
});

test("two fresh KnowledgeStore processes converge on one schema", {timeout: 20_000}, async () => {
  const root = mkdtempSync(join(process.cwd(), ".tmp-knowledge-store-fresh-"));
  const dbPath = join(root, "knowledge.db");
  const storeUrl = pathToFileURL(resolve("src/knowledge/store.ts")).href;
  const script = `import {createKnowledgeStore} from ${JSON.stringify(storeUrl)}; const store=createKnowledgeStore({dbPath:process.env.KNOWLEDGE_TEST_DB}); console.log(JSON.stringify({foreignKeyViolations:store.db.pragma('foreign_key_check').length,hasTopicIndexes:Boolean(store.db.prepare("SELECT 1 FROM schema_migrations WHERE version='048-product-topic-query-indexes'").get())})); store.close();`;
  const start = () => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: {...process.env, KNOWLEDGE_TEST_DB: dbPath, KNOWLEDGE_BUSY_TIMEOUT_MS: "100", KNOWLEDGE_MIGRATION_RETRY_BASE_MS: "20", KNOWLEDGE_MIGRATION_RETRY_LIMIT: "20"},
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { stderr += String(error); });
    return once(child, "close").then(([code]) => ({code: code as number | null, stdout, stderr}));
  };
  try {
    const results = await Promise.all([start(), start()]);
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}"), {foreignKeyViolations: 0, hasTopicIndexes: true});
    }
  } finally {
    rmSync(root, {recursive: true, force: true, maxRetries: 3, retryDelay: 20});
  }
});
