import type { ContextPackIntent } from "./context-pack.js";
import { searchKnowledge, type KnowledgeSearchResult } from "./retriever.js";
import type { KnowledgeStore } from "./store.js";

export interface RelayContextSourceInput {
  store: KnowledgeStore;
  userId: number;
  projectId: string;
  query: string;
  intent?: ContextPackIntent;
  limit: number;
}

export interface RelayContextSources {
  confirmedKnowledge: KnowledgeSearchResult["results"];
  candidates: KnowledgeSearchResult["results"];
  currentFacts: KnowledgeSearchResult["results"];
  degraded?: Record<string, string>;
}

/** Retrieve Relay-owned sections through the same project/lifecycle ACL gate as normal Knowledge search. */
export async function loadRelayContextSources(input: RelayContextSourceInput): Promise<RelayContextSources> {
  const query = [input.query, input.intent?.objective, ...(input.intent?.actions ?? [])].filter((value): value is string => Boolean(value?.trim())).join(" ").trim() || "knowledge";
  const requestBase = {
    userId: input.userId,
    projectId: input.projectId,
    query,
    limit: Math.max(1, Math.min(100, input.limit)),
    sampleManagerVersion: input.intent?.sampleManagerVersion,
    solution: input.intent?.solution,
    module: input.intent?.module,
    environment: input.intent?.environment,
    providers: { embedding: undefined, rerank: undefined },
  } as const;
  const [confirmed, candidates, facts] = await Promise.all([
    searchKnowledge(input.store, { ...requestBase, kinds: ["case", "pattern", "playbook"] }),
    searchKnowledge(input.store, { ...requestBase, kinds: ["candidate"] }),
    searchKnowledge(input.store, { ...requestBase, kinds: ["fact"] }),
  ]);
  const degraded = confirmed.degraded || candidates.degraded || facts.degraded ? { relayMemory: "fts_only" } : undefined;
  return { confirmedKnowledge: confirmed.results.filter((item) => ["verified", "approved"].includes(item.lifecycle)), candidates: candidates.results, currentFacts: facts.results, degraded };
}
