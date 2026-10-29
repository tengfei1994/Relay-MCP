import type { KnowledgeStore } from "./store.js";
import { queryProductGraph, type ProductGraphQueryResult, type ProductGraphEntity } from "./product-graph.js";
import { tokenize } from "./providers.js";

/** Minimal candidate shape kept deliberately independent of Product backend DTOs. */
export interface ProductGraphCandidate {
  id: string;
  score: number;
  matchReasons?: string[];
}

export interface ProductGraphAugmentationRequest {
  actorId: number;
  isAdmin?: boolean;
  projectId: string;
  environment?: string;
  productVersion?: string;
  solution?: string;
  module?: string;
  query: string;
  limit: number;
  maxHops?: number;
  relationTypes?: readonly string[];
}

export interface ProductGraphAugmentationOptions<T extends ProductGraphCandidate = ProductGraphCandidate> {
  /** Maximum graph entities and relation-derived document IDs considered. */
  maxNeighbors?: number;
  /** Maximum graph traversal depth. */
  maxHops?: number;
  /** Maximum number of graph-only candidates loaded by loadCandidates. */
  maxAdded?: number;
  /** Optional loader used to turn graph source document IDs into Product DTOs. */
  loadCandidates?: (documentIds: string[]) => Promise<T[]> | T[];
}

export interface ProductGraphAugmentationResult<T extends ProductGraphCandidate> {
  candidates: T[];
  graph: ProductGraphQueryResult;
  added: number;
}

const text = (value: unknown): string => typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
const candidateDocumentId = (candidate: ProductGraphCandidate): string => text((candidate as unknown as Record<string, unknown>).documentId ?? candidate.id);

function boundedScore(value: unknown, fallback = 0.25): number {
  const score = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(1, score));
}

function querySeeds(entities: ProductGraphEntity[], query: string): Set<string> {
  const terms = tokenize(query);
  if (!terms.length) return new Set(entities.map((entity) => entity.id));
  return new Set(entities.filter((entity) => {
    const haystack = `${entity.name} ${entity.canonicalKey} ${entity.kind}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  }).map((entity) => entity.id));
}

/**
 * Merge graph-related Product documents into an existing search candidate set.
 * Existing vector/keyword candidates are never removed; graph-only candidates
 * are bounded and receive a deterministic score based on provenance confidence.
 */
export async function augmentProductCandidates<T extends ProductGraphCandidate>(
  candidates: T[],
  graph: ProductGraphQueryResult,
  query: string,
  options: ProductGraphAugmentationOptions<T> = {},
): Promise<ProductGraphAugmentationResult<T>> {
  const maxNeighbors = Math.max(1, Math.min(100, Math.trunc(options.maxNeighbors ?? 24)));
  const maxHops = Math.max(0, Math.min(2, Math.trunc(options.maxHops ?? 1)));
  const maxAdded = Math.max(0, Math.min(50, Math.trunc(options.maxAdded ?? 12)));
  const entities = graph.entities.slice(0, maxNeighbors);
  const byEntity = new Map(entities.map((entity) => [entity.id, entity]));
  const seeds = querySeeds(entities, query);
  const seedKeys = new Set(entities.filter((entity) => seeds.has(entity.id)).map((entity) => entity.canonicalKey));
  let frontier = new Set(seeds);
  let frontierKeys = new Set(seedKeys);
  const related = new Set<string>();
  const relatedKeys = new Set<string>();
  const relationQuality = new Map<string, number>();
  for (let hop = 1; hop <= maxHops && frontier.size; hop++) {
    const next = new Set<string>();
    for (const relation of graph.relations.slice(0, maxNeighbors * 2)) {
      const from = byEntity.get(relation.fromEntityId), to = byEntity.get(relation.toEntityId);
      if (!from || !to) continue;
      const fromActive = frontier.has(from.id) || frontierKeys.has(from.canonicalKey);
      const toActive = frontier.has(to.id) || frontierKeys.has(to.canonicalKey);
      if (fromActive === toActive) continue;
      const other = fromActive ? to : from;
      related.add(other.id);
      relatedKeys.add(other.canonicalKey);
      next.add(other.id);
      const quality = boundedScore(relation.confidence, 0.5) * (relation.verified ? 1 : 0.75) / hop;
      relationQuality.set(other.canonicalKey, Math.max(relationQuality.get(other.canonicalKey) ?? 0, quality));
    }
    frontier = next;
    frontierKeys = new Set(entities.filter((entity) => frontier.has(entity.id)).map((entity) => entity.canonicalKey));
  }
  const graphDocuments = new Map<string, number>();
  for (const entity of entities) {
    const seed = seeds.has(entity.id) || seedKeys.has(entity.canonicalKey);
    const neighbor = related.has(entity.id) || relatedKeys.has(entity.canonicalKey);
    if (!seed && !neighbor) continue;
    const quality = boundedScore(entity.confidence, 0.5) * (neighbor ? (relationQuality.get(entity.canonicalKey) ?? 0.5) : 0.75);
    graphDocuments.set(entity.documentId, Math.max(graphDocuments.get(entity.documentId) ?? 0, quality));
  }
  if (!graphDocuments.size) return { candidates, graph, added: 0 };
  const merged = candidates.map((candidate) => ({ ...candidate }));
  const existing = new Map(merged.map((candidate, index) => [candidateDocumentId(candidate), index]));
  for (const candidate of merged) {
    const quality = graphDocuments.get(candidateDocumentId(candidate));
    if (quality === undefined) continue;
    candidate.score = Math.max(0, Math.min(1, boundedScore(candidate.score) + Math.min(0.2, 0.08 * quality)));
    const reasons = candidate.matchReasons ?? [];
    if (!reasons.includes("Product graph match")) candidate.matchReasons = [...reasons, "Product graph match"];
  }
  if (options.loadCandidates && maxAdded > 0) {
    const ids = [...graphDocuments.keys()].filter((id) => !existing.has(id)).slice(0, maxAdded);
    if (ids.length) {
      const loaded = await options.loadCandidates(ids);
      for (const candidate of loaded.slice(0, maxAdded)) {
        const id = candidateDocumentId(candidate);
        if (!id || existing.has(id)) continue;
        const quality = graphDocuments.get(id);
        if (quality === undefined) continue;
        const reasons = candidate.matchReasons ?? [];
        const enriched = {
          ...candidate,
          score: Math.max(0, Math.min(1, boundedScore(candidate.score, 0.25) + Math.min(0.2, 0.12 * quality))),
          matchReasons: [...reasons, "Product graph neighbor"],
        } as T;
        existing.set(id, merged.length);
        merged.push(enriched);
      }
    }
  }
  merged.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return { candidates: merged, graph, added: Math.max(0, merged.length - candidates.length) };
}

/** Query the graph with the same Product scope as search and degrade to the
 * original candidate set for absent/unavailable graph storage. */
export async function queryAndAugmentProductCandidates<T extends ProductGraphCandidate>(
  store: KnowledgeStore,
  request: ProductGraphAugmentationRequest,
  candidates: T[],
  options: ProductGraphAugmentationOptions<T> = {},
): Promise<ProductGraphAugmentationResult<T> | undefined> {
  try {
    const graph = queryProductGraph(store, {
      actorId: request.actorId,
      isAdmin: request.isAdmin,
      projectId: request.projectId,
      environment: request.environment,
      productVersion: request.productVersion,
      solution: request.solution,
      module: request.module,
      relationTypes: request.relationTypes,
      // Query the bounded scoped graph, then perform token matching locally so
      // relation neighbors are available even when their names do not match.
      limit: Math.max(1, Math.min(100, Math.max(request.limit * 4, 24))),
    });
    return await augmentProductCandidates(candidates, graph, request.query, { ...options, maxHops: request.maxHops ?? options.maxHops });
  } catch {
    return undefined;
  }
}
