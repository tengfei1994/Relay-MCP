import type { KnowledgeReference } from "./weknora.js";

/** Structural subset of the Relay IntentEnvelope; any IntentEnvelope is assignable. */
export interface ContextPackIntent {
  objective: string;
  actions?: readonly string[];
  phase?: string;
  projectId?: string;
  environment?: string;
  sampleManagerVersion?: string;
  solution?: string;
  module?: string;
  knowledgeMode?: "retrieve" | "capture" | "retrieve_and_capture" | string;
}

/** ACL and scope decisions are always resolved by Relay before this layer. */
export interface ContextPackAclFilters {
  /** When set, only these external document ids may appear in authoritativeDocs. */
  documentIds?: readonly string[];
  strictVersion?: boolean;
}

export interface ContextPackInput {
  intent?: ContextPackIntent;
  acl?: ContextPackAclFilters;
  authoritativeDocs?: KnowledgeReference[];
  confirmedKnowledge?: unknown[];
  candidates?: unknown[];
  currentFacts?: unknown[];
  provider?: string;
  degraded?: Record<string, string>;
  maxItemsPerSection?: number;
}

export type ContextPackRequest = ContextPackInput;

export interface ContextPackConflicts {
  /** Same topic surfaced by multiple product versions. */
  versionConflicts: number;
  aclFiltered: number;
  versionFiltered: number;
  scopeFiltered: number;
}

export interface ContextPack {
  provider: string;
  intent?: { objective: string; actions: string[]; phase?: string; projectId?: string; sampleManagerVersion?: string; solution?: string; module?: string };
  authoritativeDocs: KnowledgeReference[];
  confirmedKnowledge: unknown[];
  candidates: unknown[];
  currentFacts: unknown[];
  degraded: Record<string, string>;
  conflicts: ContextPackConflicts;
  counts: { authoritativeDocs: number; confirmedKnowledge: number; candidates: number; currentFacts: number };
}

function versionMatches(reference: KnowledgeReference, intent?: ContextPackIntent): boolean {
  if (!intent?.sampleManagerVersion || !reference.version) return true;
  return reference.version === intent.sampleManagerVersion;
}

function scopeMatches(reference: KnowledgeReference, intent?: ContextPackIntent): boolean {
  if (!intent) return true;
  if (intent.solution && reference.solution && reference.solution !== intent.solution) return false;
  if (intent.module && reference.module && reference.module !== intent.module) return false;
  return true;
}

function intentScore(reference: KnowledgeReference, intent?: ContextPackIntent): number {
  let score = typeof reference.score === "number" ? reference.score : 0;
  if (!intent) return score;
  if (intent.sampleManagerVersion && reference.version === intent.sampleManagerVersion) score += 0.2;
  if (intent.solution && reference.solution === intent.solution) score += 0.1;
  if (intent.module && reference.module === intent.module) score += 0.1;
  return score;
}

function countVersionConflicts(references: KnowledgeReference[]): number {
  const versionsByTopic = new Map<string, Set<string>>();
  for (const reference of references) {
    const topic = reference.topicId;
    if (!topic || !reference.version) continue;
    const versions = versionsByTopic.get(topic) ?? new Set<string>();
    versions.add(reference.version);
    versionsByTopic.set(topic, versions);
  }
  let conflicts = 0;
  for (const versions of versionsByTopic.values()) if (versions.size > 1) conflicts += versions.size - 1;
  return conflicts;
}

/**
 * Intent-aware Context Pack assembly. This is a pure domain service: it
 * receives already-resolved ACL filters, authoritative WeKnora references and
 * Relay-owned memory, and never talks to HTTP or MCP. Partitioning, filtering
 * and conflict counting are deterministic so identical inputs always produce
 * the identical pack.
 */
export class ContextPackService {
  constructor(private readonly defaults: { maxItemsPerSection?: number; provider?: string } = {}) {}

  build(input: ContextPackRequest = {}): ContextPack {
    const limit = Math.max(1, Math.min(500, Math.floor(input.maxItemsPerSection ?? this.defaults.maxItemsPerSection ?? 100)));
    const intent = input.intent;
    const acl = input.acl;
    const allowed = acl?.documentIds ? new Set(acl.documentIds) : undefined;

    let aclFiltered = 0;
    let versionFiltered = 0;
    let scopeFiltered = 0;
    const authoritative = (input.authoritativeDocs ?? []).filter((reference) => {
      if (allowed && !allowed.has(reference.documentId)) { aclFiltered += 1; return false; }
      if (!versionMatches(reference, intent)) { versionFiltered += 1; return false; }
      if (!scopeMatches(reference, intent)) { scopeFiltered += 1; return false; }
      return true;
    });
    authoritative.sort((a, b) => {
      const scoreDelta = intentScore(b, intent) - intentScore(a, intent);
      if (scoreDelta !== 0) return scoreDelta;
      return a.documentId.localeCompare(b.documentId);
    });

    const captureOnly = intent?.knowledgeMode === "capture";
    const authoritativeDocs = (captureOnly ? [] : authoritative).slice(0, limit).map((item) => ({ ...item }));
    const confirmedKnowledge = (input.confirmedKnowledge ?? []).slice(0, limit);
    const candidates = (input.candidates ?? []).slice(0, limit);
    const currentFacts = (input.currentFacts ?? []).slice(0, limit);

    const degraded = { ...(input.degraded ?? {}) };
    if (captureOnly && authoritative.length) degraded.productKnowledge = "skipped_capture_only";

    return {
      provider: input.provider ?? this.defaults.provider ?? "relay",
      intent: intent ? {
        objective: intent.objective,
        actions: [...(intent.actions ?? [])],
        phase: intent.phase,
        projectId: intent.projectId,
        sampleManagerVersion: intent.sampleManagerVersion,
        solution: intent.solution,
        module: intent.module,
      } : undefined,
      authoritativeDocs,
      confirmedKnowledge,
      candidates,
      currentFacts,
      degraded,
      // Count conflicts across the complete eligible set, not only the page
      // returned to the caller. Truncation must not hide known version drift.
      conflicts: { versionConflicts: countVersionConflicts(authoritative), aclFiltered, versionFiltered, scopeFiltered },
      counts: { authoritativeDocs: authoritativeDocs.length, confirmedKnowledge: confirmedKnowledge.length, candidates: candidates.length, currentFacts: currentFacts.length },
    };
  }
}

/**
 * Build the explicit boundary between authoritative Product Knowledge,
 * confirmed Relay memory, draft candidates and current runtime facts.
 * The function is deliberately pure so callers can attach the same pack to
 * HTTP, MCP and UI responses without changing persistence semantics.
 */
export function buildContextPack(input: ContextPackInput = {}): ContextPack {
  return new ContextPackService().build(input);
}
