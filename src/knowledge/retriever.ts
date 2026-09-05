import { createHash, randomUUID } from "crypto";
import type { KnowledgeStore } from "./store.js";
import { defaultKnowledgeProviders, tokenize, type KnowledgeProviders } from "./providers.js";

export interface KnowledgeSearchRequest {
  userId: number;
  projectId: string;
  query: string;
  limit?: number;
  sampleManagerVersion?: string;
  solution?: string;
  module?: string;
  environment?: string;
  kinds?: Array<"candidate" | "case" | "pattern" | "playbook" | "fact">;
  includeDeprecated?: boolean;
  typeQuotas?: Partial<Record<"candidate" | "case" | "pattern" | "playbook" | "fact", number>>;
  providers?: KnowledgeProviders;
}

export interface KnowledgeSearchResult {
  retrievalRunId: string;
  query: string;
  degraded: boolean;
  results: Array<{
    id: string;
    kind: string;
    title: string;
    summary: string;
    score: number;
    lifecycle: string;
    versionMatch: boolean;
    matchReasons: string[];
    applicability: { sampleManagerVersion?: string; solution?: string; module?: string; environment?: string };
    evidenceRefs: string[];
  }>;
}

function escapeFtsQuery(query: string): string {
  const tokens = tokenize(query).slice(0, 32);
  return tokens.length ? tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ") : '""';
}

function documentFingerprint(row: Record<string, unknown>): string {
  return String(row.source_sha256 ?? createHash("sha256").update(`${String(row.title ?? "")}\n${String(row.body ?? "")}`, "utf8").digest("hex"));
}

function evidenceRefs(store: KnowledgeStore, row: Record<string, unknown>): string[] {
  const kind = String(row.kind ?? "");
  const id = String(row.id ?? "");
  const linked = (store.db.prepare("SELECT evidence_id FROM knowledge_entity_evidence WHERE entity_type = ? AND entity_id = ? ORDER BY created_at").all(kind, id) as Array<{ evidence_id: string }>).map((item) => item.evidence_id);
  const table = kind === "candidate" ? "knowledge_candidates" : kind === "case" ? "knowledge_cases" : kind === "pattern" ? "knowledge_patterns" : kind === "playbook" ? "knowledge_playbooks" : undefined;
  if (!table) return [...new Set(linked)];
  const projection = store.db.prepare(`SELECT evidence_refs_json FROM ${table} WHERE id = ?`).get(id) as { evidence_refs_json?: string } | undefined;
  let projected: string[] = [];
  try { const parsed = projection?.evidence_refs_json ? JSON.parse(projection.evidence_refs_json) : []; if (Array.isArray(parsed)) projected = parsed.filter((value): value is string => typeof value === "string"); } catch { /* ignore malformed legacy metadata */ }
  return [...new Set([...linked, ...projected])];
}

function readRows(store: KnowledgeStore, request: KnowledgeSearchRequest): Array<Record<string, unknown>> {
  const conditions = ["d.project_id = @projectId"];
  const params: Record<string, unknown> = { projectId: request.projectId };
  if (!request.includeDeprecated) conditions.push("d.lifecycle <> 'deprecated'");
  if (request.sampleManagerVersion) { conditions.push("(d.samplemanager_version IS NULL OR d.samplemanager_version = @sampleManagerVersion)"); params.sampleManagerVersion = request.sampleManagerVersion; }
  if (request.solution) { conditions.push("(d.solution IS NULL OR d.solution = @solution)"); params.solution = request.solution; }
  if (request.module) { conditions.push("(d.module IS NULL OR d.module = @module)"); params.module = request.module; }
  if (request.environment) { conditions.push("(d.environment IS NULL OR d.environment = @environment)"); params.environment = request.environment; }
  const documentKinds = request.kinds?.filter((kind) => kind !== "fact");
  if (request.kinds?.length && documentKinds?.length === 0) {
    // The caller explicitly requested facts only; avoid broadening the ACL
    // filtered query to every document kind.
    return readFactRows(store, request);
  }
  if (documentKinds?.length) { conditions.push(`d.kind IN (${documentKinds.map((_, index) => `@kind${index}`).join(",")})`); documentKinds.forEach((kind, index) => { params[`kind${index}`] = kind; }); }
  const includeFacts = !request.kinds?.length || request.kinds.includes("fact");
  // Keep a wider lexical candidate pool so vector/lexical fusion can select
  // the final page without sending ACL-filtered content to a provider.
  const limit = Math.max(1, Math.min(request.limit ?? 20, 100));
  const candidateLimit = Math.min(500, Math.max(limit * 5, 50));
  try {
    const query = `SELECT d.*, MIN(bm25(knowledge_fts)) AS rank FROM knowledge_fts JOIN knowledge_documents d ON d.id = knowledge_fts.document_id WHERE knowledge_fts MATCH @match AND ${conditions.join(" AND ")} GROUP BY d.id ORDER BY rank LIMIT ${candidateLimit}`;
    const rows = store.db.prepare(query).all({ ...params, match: escapeFtsQuery(request.query) }) as Array<Record<string, unknown>>;
    if (!includeFacts) return rows;
    try {
      const factConditions = ["f.project_id = @projectId"];
      const factParams: Record<string, unknown> = { projectId: request.projectId, match: escapeFtsQuery(request.query) };
      if (request.kinds?.length && !request.kinds.includes("fact")) return rows;
      const facts = store.db.prepare(`SELECT f.*, bm25(knowledge_facts_fts) AS rank FROM knowledge_facts_fts JOIN knowledge_facts f ON f.id = knowledge_facts_fts.fact_id WHERE knowledge_facts_fts MATCH @match AND ${factConditions.join(" AND ")} ORDER BY rank LIMIT ${limit}`).all(factParams) as Array<Record<string, unknown>>;
      return [...rows, ...facts.map((fact) => ({ ...fact, id: fact.id, kind: "fact", title: `Fact: ${String(fact.text).slice(0, 120)}`, body: fact.text, lifecycle: fact.status === "resolved" ? "verified" : "draft", source_locator: fact.source_locator, samplemanager_version: null, solution: null, module: null, environment: null }))].slice(0, limit);
    } catch { return rows; }
  } catch {
    const terms = tokenize(request.query).slice(0, 8);
    if (!terms.length) return [];
    conditions.push(`(${terms.map((_, index) => `(lower(d.title) LIKE @term${index} OR lower(d.body) LIKE @term${index})`).join(" OR ")})`);
    terms.forEach((term, index) => { params[`term${index}`] = `%${term}%`; });
    const rows = store.db.prepare(`SELECT d.*, 0 AS rank FROM knowledge_documents d WHERE ${conditions.join(" AND ")} ORDER BY d.updated_at DESC LIMIT ${candidateLimit}`).all(params) as Array<Record<string, unknown>>;
    if (!includeFacts) return rows;
    try {
      const terms = tokenize(request.query).slice(0, 8);
      const factConditions = ["f.project_id = @projectId", `(${terms.map((_, index) => `lower(f.text) LIKE @factTerm${index} OR lower(f.tags_json) LIKE @factTerm${index}`).join(" OR ")})`];
      const factParams: Record<string, unknown> = { projectId: request.projectId };
      terms.forEach((term, index) => { factParams[`factTerm${index}`] = `%${term}%`; });
      const facts = terms.length ? store.db.prepare(`SELECT f.*, 0 AS rank FROM knowledge_facts f WHERE ${factConditions.join(" AND ")} ORDER BY f.created_at DESC LIMIT ${limit}`).all(factParams) as Array<Record<string, unknown>> : [];
      return [...rows, ...facts.map((fact) => ({ ...fact, kind: "fact", title: `Fact: ${String(fact.text).slice(0, 120)}`, body: fact.text, lifecycle: fact.status === "resolved" ? "verified" : "draft", source_locator: fact.source_locator, samplemanager_version: null, solution: null, module: null, environment: null }))].slice(0, limit);
    } catch { return rows; }
  }
}

function readFactRows(store: KnowledgeStore, request: KnowledgeSearchRequest): Array<Record<string, unknown>> {
  const limit = Math.max(1, Math.min(request.limit ?? 20, 100));
  const terms = tokenize(request.query).slice(0, 8);
  if (!terms.length) return [];
  const params: Record<string, unknown> = { projectId: request.projectId, match: escapeFtsQuery(request.query) };
  try {
    return store.db.prepare(`SELECT f.*, bm25(knowledge_facts_fts) AS rank FROM knowledge_facts_fts JOIN knowledge_facts f ON f.id = knowledge_facts_fts.fact_id WHERE knowledge_facts_fts MATCH @match AND f.project_id = @projectId ORDER BY rank LIMIT ${limit}`).all(params).map((fact: any) => ({ ...fact, kind: "fact", title: `Fact: ${String(fact.text).slice(0, 120)}`, body: fact.text, lifecycle: fact.status === "resolved" ? "verified" : "draft", source_locator: fact.source_locator, samplemanager_version: null, solution: null, module: null, environment: null })) as Array<Record<string, unknown>>;
  } catch {
    terms.forEach((term, index) => { params[`term${index}`] = `%${term}%`; });
    return store.db.prepare(`SELECT f.*, 0 AS rank FROM knowledge_facts f WHERE f.project_id = @projectId AND (${terms.map((_, index) => `lower(f.text) LIKE @term${index} OR lower(f.tags_json) LIKE @term${index}`).join(" OR ")}) ORDER BY f.created_at DESC LIMIT ${limit}`).all(params).map((fact: any) => ({ ...fact, kind: "fact", title: `Fact: ${String(fact.text).slice(0, 120)}`, body: fact.text, lifecycle: fact.status === "resolved" ? "verified" : "draft", source_locator: fact.source_locator, samplemanager_version: null, solution: null, module: null, environment: null })) as Array<Record<string, unknown>>;
  }
}

export async function searchKnowledge(store: KnowledgeStore, request: KnowledgeSearchRequest): Promise<KnowledgeSearchResult> {
  if (!store.canRead(request.userId, request.projectId)) throw new Error("Knowledge access denied for project");
  const retrievalRunId = `retrieval-${randomUUID()}`;
  const providers = { ...defaultKnowledgeProviders(), ...(request.providers ?? {}) };
  const rows = readRows(store, request);
  const queryTokens = new Set(tokenize(request.query));
  let degraded = false;
  const vectorScores = new Map<string, number>();
  let embeddingModelId: string | undefined;
  // Vector generation happens only after readRows has applied project ACL,
  // lifecycle and version/environment predicates.
  if (providers.embedding && rows.length) {
    try {
      embeddingModelId = providers.embedding.capabilities.modelId;
      const [queryVector] = await providers.embedding.embed([request.query]);
      const documents = rows.filter((row) => String(row.kind) !== "fact");
      const missing = documents.filter((row) => {
        const cached = store.db.prepare("SELECT model_id,dimensions,vector_json,source_sha256 FROM knowledge_embeddings WHERE document_id = ?").get(String(row.id)) as { model_id?: string; dimensions?: number; vector_json?: string; source_sha256?: string } | undefined;
        const fingerprint = documentFingerprint(row);
        if (!cached || cached.model_id !== embeddingModelId || cached.dimensions !== queryVector.length || cached.source_sha256 !== fingerprint) return true;
        try { vectorScores.set(String(row.id), cosine(queryVector, JSON.parse(cached.vector_json!))); return false; } catch { return true; }
      });
      if (missing.length) {
        const vectors = await providers.embedding.embed(missing.map((row) => `${String(row.title ?? "")}\n${String(row.body ?? "")}`));
        const now = new Date().toISOString();
        const save = store.db.prepare("INSERT INTO knowledge_embeddings(document_id,model_id,dimensions,vector_json,source_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET model_id=excluded.model_id,dimensions=excluded.dimensions,vector_json=excluded.vector_json,source_sha256=excluded.source_sha256,updated_at=excluded.updated_at");
        const tx = store.db.transaction(() => missing.forEach((row, index) => { const vector = vectors[index]; save.run(String(row.id), embeddingModelId, vector.length, JSON.stringify(vector), documentFingerprint(row), now, now); vectorScores.set(String(row.id), cosine(queryVector, vector)); })); tx();
      }
    } catch {
      // Missing/unavailable vectors are an expected FTS-only degradation.
      degraded = true;
    }
  } else if (!providers.embedding) degraded = true;
  const resultRows = rows.map((row) => {
    const body = String(row.body ?? "");
    const title = String(row.title ?? "");
    const overlap = tokenize(`${title} ${body}`).filter((token) => queryTokens.has(token)).length;
    const rank = Number(row.rank);
    const lexicalScore = Number.isFinite(rank) && rank !== 0 ? 1 / (1 + Math.max(0, rank)) + overlap / 100 : overlap / Math.max(1, queryTokens.size);
    const vectorScore = vectorScores.get(String(row.id));
    const versionMatch = !request.sampleManagerVersion || !row.samplemanager_version || row.samplemanager_version === request.sampleManagerVersion;
    // Exact scope matches receive a small deterministic boost over unscoped
    // knowledge while still allowing generally applicable records through.
    const scopedBoost = request.sampleManagerVersion && row.samplemanager_version === request.sampleManagerVersion ? 0.1 : 0;
    const score = Math.max(0, Math.min(1, (vectorScore === undefined ? lexicalScore : (0.55 * lexicalScore + 0.45 * ((vectorScore + 1) / 2))) + scopedBoost));
    const reasons = overlap ? [`${overlap} query token${overlap === 1 ? "" : "s"} matched`] : ["FTS/lexical match"];
    if (versionMatch && request.sampleManagerVersion && row.samplemanager_version) reasons.push("SampleManager version matched");
    if (row.lifecycle === "verified" || row.lifecycle === "approved") reasons.push(`${row.lifecycle} knowledge`);
    return {
      id: String(row.id), kind: String(row.kind), title, summary: body.length > 500 ? `${body.slice(0, 500)}…` : body,
      score, lifecycle: String(row.lifecycle), versionMatch, matchReasons: reasons,
      applicability: { sampleManagerVersion: row.samplemanager_version ? String(row.samplemanager_version) : undefined, solution: row.solution ? String(row.solution) : undefined, module: row.module ? String(row.module) : undefined, environment: row.environment ? String(row.environment) : undefined },
      evidenceRefs: evidenceRefs(store, row),
    };
  });
  if (providers.rerank && resultRows.length > 1) {
    try {
      const reranked = await providers.rerank.rerank(request.query, resultRows.map((result) => ({ id: result.id, text: `${result.title}\n${result.summary}`, score: result.score })));
      const byId = new Map(reranked.map((item) => [item.id, item]));
      resultRows.sort((a, b) => (byId.get(b.id)?.score ?? b.score) - (byId.get(a.id)?.score ?? a.score));
      for (const result of resultRows) { const item = byId.get(result.id); if (item?.reason) result.matchReasons.push(item.reason); if (item) result.score = item.score; }
    } catch { degraded = true; }
  }
  const quotas = request.typeQuotas ?? {};
  const quotaCounts = new Map<string, number>();
  const quotaResults = resultRows.filter((result) => {
    const quota = quotas[result.kind as keyof typeof quotas];
    if (quota === undefined) return true;
    const used = quotaCounts.get(result.kind) ?? 0;
    if (used >= Math.max(0, Math.trunc(quota))) return false;
    quotaCounts.set(result.kind, used + 1); return true;
  });
  const finalResults = quotaResults.slice(0, Math.max(1, Math.min(request.limit ?? 20, 100)));
  try {
    store.db.prepare("INSERT OR REPLACE INTO knowledge_retrieval_runs(id,project_id,query,provider_model_id,degraded,results_json,created_at) VALUES (?,?,?,?,?,?,?)").run(retrievalRunId, request.projectId, request.query, embeddingModelId ?? null, degraded ? 1 : 0, JSON.stringify(finalResults), new Date().toISOString());
  } catch { /* older stores may not have the optional replay table */ }
  store.audit({ actorId: request.userId, projectId: request.projectId, action: "knowledge.search", entityType: "retrieval", entityId: retrievalRunId, details: { queryTokens: [...queryTokens], resultCount: finalResults.length, degraded, embeddingModelId } });
  return { retrievalRunId, query: request.query, degraded, results: finalResults };
}

function cosine(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) throw new Error("Embedding dimensions do not match");
  let dot = 0, an = 0, bn = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; an += a[i] * a[i]; bn += b[i] * b[i]; }
  return dot / ((Math.sqrt(an) * Math.sqrt(bn)) || 1);
}
