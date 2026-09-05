import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { assertQualityThresholds, evaluateGoldenSet, evaluateRanking, type GoldenSet } from "../src/knowledge/evaluation.ts";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { searchKnowledge } from "../src/knowledge/retriever.ts";

const goldenSet = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/knowledge-golden-set.v1.json"), "utf8")) as GoldenSet;
const now = "2026-09-05T00:00:00.000Z";

function document(id: string, title: string, body: string, projectId: string, sampleManagerVersion: string, lifecycle: "verified" | "deprecated" = "verified") {
  return { id, kind: "case" as const, title, body, projectId, sampleManagerVersion, lifecycle, locator: `golden:${id}`, createdAt: now, updatedAt: now };
}

test("golden-set metrics calculate Recall@K, MRR, nDCG and forbidden negatives", () => {
  const score = evaluateRanking(goldenSet.queries[0], [{ id: "miss" }, { id: "cache-211" }, { id: "cache-20" }], 3);
  assert.equal(score.recallAtK, 1);
  assert.equal(score.reciprocalRank, 0.5);
  assert.equal(score.ndcgAtK, 1 / Math.log2(3));
  assert.deepEqual(score.forbiddenReturned, ["cache-20"]);
  assert.throws(() => assertQualityThresholds({ goldenSetVersion: "x", k: 3, queryCount: 1, recallAtK: 1, mrr: 0.5, ndcgAtK: score.ndcgAtK, forbiddenReturnCount: 1, queries: [score] }, { minRecallAtK: 1, minMrr: 0.9, minNdcgAtK: 0.9 }), /quality gate failed/);
});

test("version, ACL and deprecated golden negatives cannot enter qualified search results", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-golden-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    store.grantAcl("p1", 7);
    store.upsertDocument(document("cache-211", "FormsBin cache", "FormsBin stale cache C:\\ProgramData\\Thermo\\SampleManager", "p1", "21.1"));
    store.upsertDocument(document("instrument-211", "仪器保存", "仪器保存 静态必填 mandatory", "p1", "21.1"));
    store.upsertDocument(document("cache-20", "FormsBin cache", "FormsBin stale cache", "p1", "20.0"));
    store.upsertDocument(document("instrument-20", "仪器保存", "仪器保存 静态必填", "p1", "20.0"));
    store.upsertDocument(document("cache-deprecated", "FormsBin cache", "FormsBin stale cache", "p1", "21.1", "deprecated"));
    store.upsertDocument(document("instrument-deprecated", "仪器保存", "仪器保存 静态必填", "p1", "21.1", "deprecated"));
    store.upsertDocument(document("cache-other-project", "FormsBin cache", "FormsBin stale cache", "p2", "21.1"));
    store.upsertDocument(document("instrument-other-project", "仪器保存", "仪器保存 静态必填", "p2", "21.1"));
    const evaluation = await evaluateGoldenSet(goldenSet, async (query) => (await searchKnowledge(store, { userId: query.userId, projectId: query.projectId, query: query.query, sampleManagerVersion: query.sampleManagerVersion, limit: 10, providers: { embedding: undefined } })).results, 10);
    assertQualityThresholds(evaluation, { minRecallAtK: 1, minMrr: 0.8, minNdcgAtK: 0.8, maxForbiddenReturns: 0 });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
