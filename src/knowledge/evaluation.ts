/**
 * Versioned, provider-agnostic retrieval quality evaluation helpers.  The
 * golden set deliberately contains expected identities rather than scores so
 * it remains usable when lexical, embedding, or rerank providers change.
 */
export const GOLDEN_SET_FORMAT = "relay-knowledge-golden-set/v1" as const;

export interface GoldenQuery {
  id: string;
  query: string;
  projectId: string;
  userId: number;
  relevantIds: string[];
  /** Documents that must never be returned for this query (ACL/version/status negatives). */
  forbiddenIds?: string[];
  sampleManagerVersion?: string;
  solution?: string;
  module?: string;
  environment?: string;
}

export interface GoldenSet {
  format: typeof GOLDEN_SET_FORMAT;
  version: string;
  description: string;
  queries: GoldenQuery[];
}

export interface RankedResult { id: string; }

export interface QueryEvaluation {
  id: string;
  recallAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  forbiddenReturned: string[];
}

export interface GoldenSetEvaluation {
  goldenSetVersion: string;
  k: number;
  queryCount: number;
  recallAtK: number;
  mrr: number;
  ndcgAtK: number;
  forbiddenReturnCount: number;
  queries: QueryEvaluation[];
}

export interface QualityThresholds {
  minRecallAtK: number;
  minMrr: number;
  minNdcgAtK: number;
  maxForbiddenReturns?: number;
}

export function validateGoldenSet(goldenSet: GoldenSet): void {
  if (goldenSet.format !== GOLDEN_SET_FORMAT) throw new Error(`Unsupported golden set format: ${String(goldenSet.format)}`);
  if (!goldenSet.version.trim()) throw new Error("Golden set version is required");
  if (!goldenSet.queries.length) throw new Error("Golden set must contain at least one query");
  const ids = new Set<string>();
  for (const query of goldenSet.queries) {
    if (!query.id.trim() || ids.has(query.id)) throw new Error(`Golden query id must be unique: ${query.id}`);
    ids.add(query.id);
    if (!query.query.trim() || !query.projectId.trim() || !Number.isInteger(query.userId) || query.userId < 1) throw new Error(`Golden query ${query.id} is incomplete`);
    if (!query.relevantIds.length) throw new Error(`Golden query ${query.id} has no relevant document`);
    const overlap = query.relevantIds.filter((id) => query.forbiddenIds?.includes(id));
    if (overlap.length) throw new Error(`Golden query ${query.id} marks relevant documents as forbidden: ${overlap.join(", ")}`);
  }
}

export function evaluateRanking(query: GoldenQuery, results: RankedResult[], k: number): QueryEvaluation {
  const cutoff = Math.max(1, Math.trunc(k));
  const ids = results.slice(0, cutoff).map((result) => result.id);
  const relevant = new Set(query.relevantIds);
  const hitPositions = ids.map((id, index) => relevant.has(id) ? index + 1 : -1).filter((position) => position > 0);
  const recallAtK = hitPositions.length / relevant.size;
  const reciprocalRank = hitPositions.length ? 1 / hitPositions[0] : 0;
  const dcg = hitPositions.reduce((sum, position) => sum + 1 / Math.log2(position + 1), 0);
  const idealHits = Math.min(relevant.size, cutoff);
  const idealDcg = Array.from({ length: idealHits }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, score) => sum + score, 0);
  const forbidden = new Set(query.forbiddenIds ?? []);
  return {
    id: query.id,
    recallAtK,
    reciprocalRank,
    ndcgAtK: idealDcg ? dcg / idealDcg : 0,
    forbiddenReturned: ids.filter((id) => forbidden.has(id)),
  };
}

export async function evaluateGoldenSet(
  goldenSet: GoldenSet,
  search: (query: GoldenQuery) => Promise<RankedResult[]>,
  k = 10,
): Promise<GoldenSetEvaluation> {
  validateGoldenSet(goldenSet);
  const queries = await Promise.all(goldenSet.queries.map(async (query) => evaluateRanking(query, await search(query), k)));
  const count = queries.length;
  return {
    goldenSetVersion: goldenSet.version,
    k: Math.max(1, Math.trunc(k)),
    queryCount: count,
    recallAtK: queries.reduce((sum, query) => sum + query.recallAtK, 0) / count,
    mrr: queries.reduce((sum, query) => sum + query.reciprocalRank, 0) / count,
    ndcgAtK: queries.reduce((sum, query) => sum + query.ndcgAtK, 0) / count,
    forbiddenReturnCount: queries.reduce((sum, query) => sum + query.forbiddenReturned.length, 0),
    queries,
  };
}

export function assertQualityThresholds(evaluation: GoldenSetEvaluation, thresholds: QualityThresholds): void {
  const failures: string[] = [];
  if (evaluation.recallAtK < thresholds.minRecallAtK) failures.push(`Recall@${evaluation.k} ${evaluation.recallAtK.toFixed(4)} < ${thresholds.minRecallAtK}`);
  if (evaluation.mrr < thresholds.minMrr) failures.push(`MRR ${evaluation.mrr.toFixed(4)} < ${thresholds.minMrr}`);
  if (evaluation.ndcgAtK < thresholds.minNdcgAtK) failures.push(`nDCG@${evaluation.k} ${evaluation.ndcgAtK.toFixed(4)} < ${thresholds.minNdcgAtK}`);
  if (evaluation.forbiddenReturnCount > (thresholds.maxForbiddenReturns ?? 0)) failures.push(`forbidden results ${evaluation.forbiddenReturnCount} > ${thresholds.maxForbiddenReturns ?? 0}`);
  if (failures.length) throw new Error(`Knowledge retrieval quality gate failed: ${failures.join("; ")}`);
}
