import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { searchKnowledge } from "../src/knowledge/retriever.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-memory-fts-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  store.grantAcl("p1", 7, true);
  const add = (id: string, body: string, options: { projectId?: string; version?: string; updatedAt?: string; locator?: string; visibility?: "global"; lifecycle?: "verified" | "deprecated" } = {}) => {
    const date = options.updatedAt ?? "2026-01-01T00:00:00.000Z";
    store.upsertDocument({ id, kind: "case", title: "Reference", body, lifecycle: options.lifecycle ?? "verified", projectId: options.projectId ?? "p1", sampleManagerVersion: options.version, visibility: options.visibility, locator: options.locator ?? `case:${id}`, createdAt: date, updatedAt: date });
  };
  const search = () => searchKnowledge(store, { userId: 7, projectId: "p1", query: "cache", kinds: ["case"], sampleManagerVersion: "21.1", limit: 20, providers: { embedding: undefined, rerank: undefined } });
  return { store, add, search, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("memory FTS ranks an older relevant document before a newer weak match and excludes substrings", async () => {
  const f = fixture();
  try {
    f.add("older-relevant", "cache cache cache cache cache");
    f.add("newer-weak", `cache ${"unrelated ".repeat(100)}`, { updatedAt: "2026-10-01T00:00:00.000Z" });
    f.add("substring-only", "cacheable", { updatedAt: "2026-10-02T00:00:00.000Z" });
    const result = await f.search();
    assert.deepEqual(result.results.map(row => row.id), ["older-relevant", "newer-weak"]);
  } finally { f.close(); }
});

test("memory FTS uses the best matching chunk once per document and breaks equal ranks by document id", async () => {
  const f = fixture();
  try {
    // The first chunk is deliberately weaker than both middle documents.
    f.add("z-multichunk", `# Weak\ncache ${"unrelated ".repeat(100)}\n# Strong\n${"cache ".repeat(20)}`);
    // Insert ties in reverse id order, with dates favoring that wrong order.
    f.add("b-middle", "cache background", { updatedAt: "2026-10-02T00:00:00.000Z" });
    f.add("a-middle", "cache background", { updatedAt: "2026-10-01T00:00:00.000Z" });
    assert.equal((f.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_fts WHERE document_id = ?").get("z-multichunk") as { n: number }).n, 2);
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await f.search();
      assert.deepEqual(result.results.map(row => row.id), ["z-multichunk", "a-middle", "b-middle"]);
    }
  } finally { f.close(); }
});

test("memory FTS retains project ACL, version, lifecycle and candidate insight scope guards", async () => {
  const f = fixture();
  try {
    f.add("local", "cache", { version: "21.1" });
    f.add("private-other-project", "cache", { projectId: "p2" });
    f.add("wrong-version", "cache", { version: "21.0" });
    f.add("deprecated", "cache", { lifecycle: "deprecated" });
    f.add("missing-candidate-snapshot", "cache", { locator: "candidate-insight:missing" });
    f.add("global-approved", "cache", { projectId: "p2", visibility: "global" });
    const result = await f.search();
    assert.deepEqual(result.results.map(row => row.id), ["global-approved", "local"]);
    await assert.rejects(searchKnowledge(f.store, { userId: 8, projectId: "p1", query: "cache" }), /access denied/);
  } finally { f.close(); }
});

test("memory retrieval keeps LIKE fallback when the FTS table is unavailable", async () => {
  const f = fixture();
  try {
    f.add("local", "cache");
    f.add("private-other-project", "cache", { projectId: "p2" });
    f.add("wrong-version", "cache", { version: "21.0" });
    f.store.db.exec("DROP TABLE knowledge_fts");
    const result = await f.search();
    assert.deepEqual(result.results.map(row => row.id), ["local"]);
  } finally { f.close(); }
});
