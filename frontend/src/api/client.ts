import { buildKnowledgeScope, withKnowledgeScope, type KnowledgeScope } from "../knowledge/integrated-search";

const BASE = "/api";

function getToken() {
  return localStorage.getItem("token");
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  Object.assign(headers, extraHeaders ?? {});

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: options?.signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "Request failed");
  }
  return res.json();
}

export const api = {
  health: () => request<{ ok: boolean; version: string; commit: string; buildTime: string; process: string; ts: string }>("GET", "/health"),
  // Auth
  login: (username: string, password: string) =>
    request<{ token: string; user: { id: number; username: string; isAdmin: boolean } }>(
      "POST", "/auth/login", { username, password }
    ),
  register: (username: string, password: string) =>
    request<{ token: string; user: { id: number; username: string; isAdmin: boolean } }>(
      "POST", "/auth/register", { username, password }
    ),
  me: () =>
    request<{ user: { id: number; username: string; isAdmin: boolean } }>("GET", "/auth/me"),

  // Projects
  listProjects: () =>
    request<{ projects: unknown[] }>("GET", "/projects"),
  listTools: () =>
    request<{ tools: unknown[]; categories: unknown[]; sampleManagerEntities: unknown[] }>("GET", "/tools"),
  createProject: (name: string, description?: string) =>
    request<{ project: unknown }>("POST", "/projects", { name, description }),
  deleteProject: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/projects/${id}`),
  listFiles: (id: number, path = "") =>
    request<{ path: string; entries: unknown[] }>(
      "GET", `/projects/${id}/files?path=${encodeURIComponent(path)}`
    ),

  // Knowledge governance plane
  memorySearch: (params: { projectId: number; q: string; limit?: number; sampleManagerVersion?: string; solution?: string; module?: string; environment?: string; scopeType?: string; scopeKey?: string; kinds?: string; includeDeprecated?: boolean }) => {
    const query = new URLSearchParams({ projectId: String(params.projectId), q: params.q });
    for (const key of ["limit", "sampleManagerVersion", "solution", "module", "environment", "scopeType", "scopeKey", "kinds", "includeDeprecated"] as const) {
      const value = params[key];
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return request<{ retrievalRunId: string; query: string; degraded: boolean; results: unknown[] }>("GET", `/memory/search?${query.toString()}`);
  },
  knowledgeDocument: (id: string, projectId?: number) => request<{ document: unknown; evidenceRefs: string[]; reviews: unknown[] }>("GET", `/knowledge/documents/${encodeURIComponent(id)}${projectId ? `?projectId=${projectId}` : ""}`),
  knowledgeDocuments: (projectId: number, kinds?: string, params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams({ projectId: String(projectId) }); if (kinds) query.set("kinds", kinds); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ documents: unknown[]; page?: unknown }>("GET", `/knowledge/documents?${query.toString()}`); },
  knowledgeEvidence: (id: string) => request<{ evidence: unknown }>("GET", `/knowledge/evidence/${encodeURIComponent(id)}`),
  knowledgeObservation: (id: string) => request<{ observation: unknown }>("GET", `/knowledge/observations/${encodeURIComponent(id)}`),
  knowledgeObservations: (projectId: number, params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams({ projectId: String(projectId) }); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ observations: unknown[]; page?: unknown }>("GET", `/knowledge/observations?${query.toString()}`); },
  knowledgeDocumentEvidence: (id: string, body: { evidenceId: string; operation: "attach" | "detach"; reason: string }, idempotencyKey?: string) => request<unknown>("POST", `/knowledge/documents/${encodeURIComponent(id)}/evidence`, body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeEvidenceList: (projectId?: number, params: Record<string, string | number | undefined> = {}) => {
    const query = new URLSearchParams();
    if (projectId !== undefined) query.set("projectId", String(projectId));
    Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); });
    return request<{ evidence: unknown[]; page?: unknown }>("GET", `/knowledge/evidence?${query.toString()}`);
  },
  knowledgeEvidenceSession: (id: string, maxBytes?: number) => request<{ sessionId: string; evidenceId: string; expiresAt: string; maxBytes: number; mimeType: string; sizeBytes: number; sha256: string }>("POST", `/knowledge/evidence/${encodeURIComponent(id)}/download-session`, maxBytes ? { maxBytes } : {}),
  knowledgeEvidenceContentUrl: (id: string, sessionId: string) => `/api/knowledge/evidence/${encodeURIComponent(id)}/content?sessionId=${encodeURIComponent(sessionId)}`,
  knowledgeRelations: (params: { projectId: number; objectId?: string; relationType?: string; verifiedOnly?: boolean; limit?: number }) => {
    const query = new URLSearchParams({ projectId: String(params.projectId) });
    for (const key of ["objectId", "relationType", "verifiedOnly", "limit"] as const) {
      const value = params[key];
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return request<{ relations: unknown[] }>("GET", `/knowledge/relations?${query.toString()}`);
  },
  knowledgeImpact: (params: { projectId: number; objectId: string; maxDepth?: number; direction?: "upstream" | "downstream" | "both"; verifiedOnly?: boolean }) => {
    const query = new URLSearchParams({ projectId: String(params.projectId), objectId: params.objectId });
    for (const key of ["maxDepth", "direction", "verifiedOnly"] as const) {
      const value = params[key];
      if (value !== undefined) query.set(key, String(value));
    }
    return request<{ root: string; nodes: string[]; relations: unknown[] }>("GET", `/knowledge/relations/impact?${query.toString()}`);
  },
  knowledgeCandidates: (projectId: number, status?: string, params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams({ projectId: String(projectId) }); if (status) query.set("status", status); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ candidates: unknown[]; page: unknown }>("GET", `/knowledge/candidates?${query.toString()}`); },
  knowledgeIndexStatus: (projectId: number) => request<{ projectId: string; stale: boolean; counts: unknown[]; lastIngest?: unknown }>("GET", `/knowledge/index-status?projectId=${projectId}`),
  knowledgeDashboard: (projectId: number) => request<{ projectId: string; totals: unknown[]; counts: unknown[]; recent: unknown; capture: unknown }>("GET", `/knowledge/dashboard?projectId=${projectId}`),
  knowledgeDiagnostics: (projectId: number) => request<unknown>("GET", `/knowledge/diagnostics?projectId=${projectId}`),
  knowledgeIngestRuns: (projectId: number, limit = 50) => request<{ runs: unknown[] }>("GET", `/knowledge/ingest-runs?projectId=${projectId}&limit=${limit}`),
  productDocuments: (params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ documents: unknown[] }>("GET", `/knowledge/product-docs?${query.toString()}`); },
  productDocumentsList: (params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ documents: unknown[]; page?: unknown }>("GET", `/knowledge/product-documents?${query.toString()}`); },
  productDocumentImport: (body: Record<string, unknown>, idempotencyKey?: string) => request<unknown>("POST", "/knowledge/product-docs/import", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  productDocumentImportGlobal: (body: Record<string, unknown>, idempotencyKey?: string) => request<unknown>("POST", "/knowledge/product-documents/import", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  productDocument: (id: string, scope: KnowledgeScope = {}) => request<{ document: unknown; sections: unknown[] }>("GET", withKnowledgeScope(`/knowledge/product-docs/${encodeURIComponent(id)}`, scope)),
  productDocumentGlobal: (id: string, scope: KnowledgeScope = {}) => request<{ document: unknown; sections: unknown[] }>("GET", withKnowledgeScope(`/knowledge/product-documents/${encodeURIComponent(id)}`, scope)),
  productDocumentImports: (limit = 50) => request<{ runs: unknown[] }>("GET", `/knowledge/product-documents/imports?limit=${limit}`),
  productDocumentImportDetail: (id: string) => request<unknown>("GET", `/knowledge/product-documents/imports/${encodeURIComponent(id)}`),
  productDocumentRetry: (id: string, idempotencyKey?: string) => request<unknown>("POST", `/knowledge/product-documents/imports/${encodeURIComponent(id)}/retry`, {}, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  productDocumentVersions: (params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ versions: unknown[]; page?: unknown }>("GET", `/knowledge/product-documents/versions?${query.toString()}`); },
  productDocumentDiffs: (left: string, right: string) => request<unknown>("GET", `/knowledge/product-documents/diffs?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`),
  productDocumentSearch: (params: Record<string, string | number | boolean | undefined> = {}) => { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ results: unknown[]; page?: unknown }>("GET", `/knowledge/product-documents/search?${query.toString()}`); },
  productDocumentDiff: (id: string, against: string) => request<unknown>("GET", `/knowledge/product-docs/${encodeURIComponent(id)}/diff?against=${encodeURIComponent(against)}`),
  productDocumentDiffReview: (id: string, body: { against: string; status: "accepted" | "rejected" | "needs_review"; reason: string }, idempotencyKey?: string) => request<unknown>("POST", `/knowledge/product-docs/${encodeURIComponent(id)}/diff-review`, body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  productTopics: (params: Record<string, string | number | undefined> = {}, options?: { signal?: AbortSignal }) => { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ topics: unknown[]; page?: unknown }>("GET", `/knowledge/product-topics?${query.toString()}`, undefined, undefined, options); },
  productTopic: (id: string, scope: KnowledgeScope = {}, options?: { signal?: AbortSignal }) => request<{ topic: unknown; versions: unknown[]; page?: unknown }>("GET", withKnowledgeScope(`/knowledge/product-topics/${encodeURIComponent(id)}?includeReview=true`, scope), undefined, undefined, options),
  productTopicBindingReview: (id: string, body: { status: "active" | "rejected"; reason: string }) => request<unknown>("POST", `/knowledge/product-topic-bindings/${encodeURIComponent(id)}/review`, body),
  knowledgeArtifactSets: (limit = 100) => request<{ sets: unknown[] }>("GET", `/knowledge/artifact-sets?limit=${limit}`),
  knowledgeArtifactImport: (body: Record<string, unknown>) => request<unknown>("POST", "/knowledge/artifact-sets/import", body),
  knowledgeArtifactPublish: (id: string) => request<unknown>("POST", `/knowledge/artifact-sets/${encodeURIComponent(id)}/publish`, {}),
  knowledgeIngestJob: (id: string) => request<unknown>("GET", `/knowledge/ingest-jobs/${encodeURIComponent(id)}`),
  knowledgeSourceBaselines: (limit = 100, offset = 0) => request<{ baselines: unknown[]; page: unknown }>("GET", `/knowledge/source-baselines?limit=${limit}&offset=${offset}`),
  knowledgeSourceBaselineFiles: (id: string, limit = 100, offset = 0) => request<unknown>("GET", `/knowledge/source-baselines/${encodeURIComponent(id)}/files?limit=${limit}&offset=${offset}`),
  knowledgeSourceSearch: (params: Record<string, string | number | undefined>) => { const q = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") q.set(key, String(value)); }); return request<unknown>("GET", `/knowledge/source-search?${q.toString()}`); },
  knowledgeProjectSnapshots: (limit = 100, offset = 0) => request<{ snapshots: unknown[]; page: unknown }>("GET", `/knowledge/project-snapshots?limit=${limit}&offset=${offset}`),
  knowledgeProjectSnapshot: (body: Record<string, unknown>) => request<unknown>("POST", "/knowledge/project-snapshots/import", body),
  knowledgeUpgradeCompare: (body: Record<string, unknown>) => request<unknown>("POST", "/knowledge/source-baselines/compare", body),
  productDocumentMetadataCorrection: (body: Record<string, unknown>, idempotencyKey?: string) => request<unknown>("PATCH", "/knowledge/product-docs/metadata", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeIngest: (projectId: number, casebookRoot?: string, contextFiles?: string[]) => request<unknown>("POST", "/knowledge/ingest", { projectId, casebookRoot, contextFiles }),
  knowledgeReindex: (projectId: number) => request<unknown>("POST", "/knowledge/reindex", { projectId }),
  knowledgeReview: (body: Record<string, unknown>, idempotencyKey?: string) => request<unknown>("POST", "/knowledge/reviews", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeFeedback: (body: Record<string, unknown>, idempotencyKey?: string) => request<unknown>("POST", "/knowledge/feedback", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeOperationsCapture: () => request<unknown>("GET", "/knowledge/operations/capture"),
  knowledgeOperationsCaptureEvents: (limit = 10, offset = 0) => request<unknown>("GET", `/knowledge/operations/capture/events?limit=${limit}&offset=${offset}`),
  knowledgeOperationsCaptureQueue: (limit = 20) => request<unknown>("GET", `/knowledge/operations/capture/queue?limit=${limit}`),
  knowledgeOperationsDeadLetters: (limit = 10, offset = 0) => request<unknown>("GET", `/knowledge/operations/capture/dead-letter?limit=${limit}&offset=${offset}`),
  knowledgeOperationsSmokeTest: (body: Record<string, unknown> = {}, idempotencyKey?: string) => request<unknown>("POST", "/knowledge/operations/capture/smoke-test", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeOperationsReplayCapture: (body: Record<string, unknown>, idempotencyKey?: string) => request<unknown>("POST", "/knowledge/operations/capture/replay", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeOperationsIngestRuns: (limit = 50) => request<unknown>("GET", `/knowledge/operations/ingest-runs?limit=${limit}`),
  knowledgeOperationsIngestRun: (id: string) => request<unknown>("GET", `/knowledge/operations/ingest-runs/${encodeURIComponent(id)}`),
  knowledgeOperationsRetryIngest: (id: string, idempotencyKey?: string) => request<unknown>("POST", `/knowledge/operations/ingest-runs/${encodeURIComponent(id)}/retry`, {}, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeOperationsIndex: () => request<unknown>("GET", "/knowledge/operations/index"),
  knowledgeOperationsProviders: () => request<unknown>("GET", "/knowledge/operations/providers"),
  knowledgeOperationsTestProvider: (provider?: string, idempotencyKey?: string) => request<unknown>("POST", "/knowledge/operations/providers/test", provider ? { provider } : {}, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeOperationsRebuildIndex: (projectId?: number, idempotencyKey?: string) => request<unknown>("POST", "/knowledge/operations/index/rebuild", projectId ? { projectId } : {}, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeOperationsInvalidateEmbeddings: (projectId?: number, idempotencyKey?: string) => request<unknown>("POST", "/knowledge/operations/index/invalidate-embeddings", projectId ? { projectId } : {}, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeSessions: (limit = 50) => request<{ sessions: unknown[] }>("GET", `/knowledge/sessions?limit=${limit}`),
  knowledgeSession: (id: string) => request<{ session: unknown }>("GET", `/knowledge/sessions/${encodeURIComponent(id)}`),
  knowledgeSessionEvents: (id: string) => request<{ events: unknown[] }>("GET", `/knowledge/sessions/${encodeURIComponent(id)}/events`),
  knowledgeEngine: () => request<unknown>("GET", "/knowledge/engine"),
  knowledgeEngineInitialize: (body: Record<string, string> = {}) => request<unknown>("POST", "/knowledge/engine/initialize", body),
  knowledgeManagedProviders: () => request<{ providers: unknown[] }>("GET", "/knowledge/providers/managed"),
  knowledgeProviderModels: (body: { baseUrl: string; token: string }) => request<{ models: Array<{ id: string }>; baseUrl: string }>("POST", "/knowledge/providers/managed/models", body),
  knowledgeProviderConfigure: (id: string, body: Record<string, unknown>) => request<{ provider: unknown; report: unknown }>("POST", `/knowledge/providers/managed/${encodeURIComponent(id)}/configure`, body),
  knowledgeProviderToken: (id: string, token: string | null) => request<{ provider: unknown }>("POST", `/knowledge/providers/managed/${encodeURIComponent(id)}/token`, { token }),
  knowledgeManagedProvidersReindex: () => request<{ jobs: unknown[] }>("GET", "/knowledge/providers/managed/reindex"),
  knowledgeManagedProviderUpsert: (id: string, body: Record<string, unknown>) => request<{ provider: unknown }>("PUT", `/knowledge/providers/managed/${encodeURIComponent(id)}`, body),
  knowledgeManagedProviderTest: (id: string) => request<{ report: unknown }>("POST", `/knowledge/providers/managed/${encodeURIComponent(id)}/test`, {}),
  knowledgeManagedProviderRotate: (id: string, secretRef: string) => request<{ provider: unknown }>("POST", `/knowledge/providers/managed/${encodeURIComponent(id)}/rotate`, { secretRef }),
  knowledgeManagedProviderDisable: (id: string) => request<{ provider: unknown }>("POST", `/knowledge/providers/managed/${encodeURIComponent(id)}/disable`, {}),
  knowledgeManagedProviderReindexComplete: (jobId: string) => request<{ job: unknown }>("POST", `/knowledge/providers/managed/reindex/${encodeURIComponent(jobId)}/complete`, {}),
  knowledgeCandidateInsights: (projectId: string | number, params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams({ projectId: String(projectId) }); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ insights: unknown[] }>("GET", `/knowledge/candidate-insights?${query.toString()}`); },
  knowledgeCandidateInsight: (id: string) => request<{ insight: unknown }>("GET", `/knowledge/candidate-insights/${encodeURIComponent(id)}`),
  knowledgeCandidateInsightHistory: (id: string) => request<{ history: unknown[] }>("GET", `/knowledge/candidate-insights/${encodeURIComponent(id)}/history`),
  knowledgeCandidateInsightCompile: (body: Record<string, unknown>) => request<unknown>("POST", "/knowledge/candidate-insights/compile", body),
  knowledgeCandidateInsightConfirm: (id: string, reason: string) => request<{ insight: unknown }>("POST", `/knowledge/candidate-insights/${encodeURIComponent(id)}/confirm`, { reason }),
  knowledgeCandidateInsightReject: (id: string, reason: string) => request<{ insight: unknown }>("POST", `/knowledge/candidate-insights/${encodeURIComponent(id)}/reject`, { reason }),
  knowledgeCandidateInsightEdit: (id: string, patch: Record<string, unknown>, reason: string) => request<{ insight: unknown }>("PATCH", `/knowledge/candidate-insights/${encodeURIComponent(id)}`, { patch, reason }),
  knowledgeCandidateInsightReviewScope: (id: string, reason: string, expectedSessionUpdatedAt: string) => request<{ insight: unknown }>("POST", `/knowledge/candidate-insights/${encodeURIComponent(id)}/review-scope`, { reason, expectedSessionUpdatedAt }),
  knowledgeCandidateInsightPromote: (id: string, body: { target: "fact" | "decision" | "case" | "pattern"; reason: string; title?: string }) => request<{ promotion: unknown }>("POST", `/knowledge/candidate-insights/${encodeURIComponent(id)}/promote`, body),
  knowledgeConfirmedMemories: (projectId: string | number, params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams({ projectId: String(projectId) }); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ memories: unknown[] }>("GET", `/knowledge/confirmed-memories?${query.toString()}`); },
  knowledgeConfirmedMemory: (id: string) => request<{ memory: unknown }>("GET", `/knowledge/confirmed-memories/${encodeURIComponent(id)}`),
  knowledgeWikiPages: (params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ items: unknown[]; total: number; limit: number; offset: number }>("GET", `/knowledge/wiki?${query.toString()}`); },
  knowledgeWikiCreate: (body: Record<string, unknown>) => request<{ page: unknown }>("POST", "/knowledge/wiki", body),
  knowledgeWikiPage: (id: string, scope: KnowledgeScope = {}) => request<{ page: unknown }>("GET", withKnowledgeScope(`/knowledge/wiki/${encodeURIComponent(id)}`, scope)),
  knowledgeWikiResolve: (pageKey: string, scope: KnowledgeScope) => request<{ page: unknown }>("GET", withKnowledgeScope(`/knowledge/wiki/resolve?pageKey=${encodeURIComponent(pageKey)}`, scope)),
  knowledgeWikiEdit: (id: string, body: { title?: string; body?: string; reason: string }, scope: KnowledgeScope = {}) => request<{ page: unknown }>("PATCH", `/knowledge/wiki/${encodeURIComponent(id)}`, { ...body, ...buildKnowledgeScope(scope) }),
  knowledgeWikiPublish: (id: string, reason: string, scope: KnowledgeScope = {}) => request<{ page: unknown }>("POST", `/knowledge/wiki/${encodeURIComponent(id)}/publish`, { reason, ...buildKnowledgeScope(scope) }),
  knowledgeWikiDeprecate: (id: string, reason: string, scope: KnowledgeScope = {}) => request<{ page: unknown }>("POST", `/knowledge/wiki/${encodeURIComponent(id)}/deprecate`, { reason, ...buildKnowledgeScope(scope) }),
  knowledgeWikiRevisions: (id: string, scope: KnowledgeScope = {}) => request<{ revisions: unknown[] }>("GET", withKnowledgeScope(`/knowledge/wiki/${encodeURIComponent(id)}/revisions`, scope)),
  knowledgeWikiDiff: (id: string, fromRevision: number, toRevision: number, scope: KnowledgeScope = {}) => request<{ diff: string }>("GET", withKnowledgeScope(`/knowledge/wiki/${encodeURIComponent(id)}/diff?fromRevision=${fromRevision}&toRevision=${toRevision}`, scope)),
  knowledgeWikiRollback: (id: string, revision: number, reason: string, scope: KnowledgeScope = {}) => request<{ page: unknown }>("POST", `/knowledge/wiki/${encodeURIComponent(id)}/rollback`, { revision, reason, ...buildKnowledgeScope(scope) }),
  knowledgeWeknoraDocuments: (params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ documents: unknown[]; page: { limit: number; offset: number; total: number } }>("GET", `/knowledge/weknora/documents?${query.toString()}`); },
  knowledgeWeknoraDocumentStage: (body: Record<string, unknown>) => request<{ document: unknown }>("POST", "/knowledge/weknora/documents", body),
  knowledgeWeknoraDocumentPublish: (id: string) => request<{ document: unknown }>("POST", `/knowledge/weknora/documents/${encodeURIComponent(id)}/publish`, {}),
  knowledgeWeknoraDocumentDeprecate: (id: string) => request<{ document: unknown }>("POST", `/knowledge/weknora/documents/${encodeURIComponent(id)}/deprecate`, {}),
  knowledgeSearch: (body: Record<string, unknown>) => request<unknown>("POST", "/knowledge/search", body),
  knowledgeProductProvider: () => request<{ provider: string }>("GET", "/knowledge/integrations/product-provider"),
  knowledgeSetProductProvider: (provider: "relay_local" | "weknora", migrationId?: string) => request<{ provider: string; previousProvider: string }>("POST", "/knowledge/integrations/product-provider", { provider, migrationId }),
  knowledgeMigrationFromLocal: (body: Record<string, unknown>) => request<{ migration: unknown; migrationId?: string; job?: { id: string; kind: string; status: string; result?: unknown; error?: string } }>("POST", "/knowledge/migrations/from-local", body),
  knowledgeMigrations: (id: string) => request<{ migration: unknown }>("GET", `/knowledge/migrations/${encodeURIComponent(id)}`),
  knowledgeMigrationPublish: (id: string) => request<{ migration: unknown }>("POST", `/knowledge/migrations/${encodeURIComponent(id)}/publish`, {}),
  knowledgeMigrationRollback: (id: string, reason: string) => request<{ migration: unknown }>("POST", `/knowledge/migrations/${encodeURIComponent(id)}/rollback`, { reason }),
  knowledgeMigrationCleanup: (id: string) => request<unknown>("GET", `/knowledge/migrations/${encodeURIComponent(id)}/cleanup`),
  knowledgeReleaseGates: () => request<unknown>("GET", "/knowledge/release-gates"),

  // Project-Server links
  listProjectServers: (projectId: number) =>
    request<{ servers: unknown[] }>("GET", `/projects/${projectId}/servers`),
  linkServer: (projectId: number, serverId: number, remotePath: string, environment = "production", connectionMode?: "ssh" | "agent", limsInstanceId?: number) =>
    request<{ link: unknown }>("POST", `/projects/${projectId}/servers`, { serverId, remotePath, environment, connectionMode, limsInstanceId }),
  updateProjectServer: (projectId: number, linkId: number, data: { remotePath?: string; environment?: string; connectionMode?: "ssh" | "agent"; limsInstanceId?: number | null }) =>
    request<{ link: unknown }>("PUT", `/projects/${projectId}/servers/${linkId}`, data),
  unlinkServer: (projectId: number, linkId: number) =>
    request<{ ok: boolean }>("DELETE", `/projects/${projectId}/servers/${linkId}`),

  // Servers
  listServers: () =>
    request<{ servers: unknown[] }>("GET", "/servers"),
  addServer: (data: { name: string; host?: string; port?: number; sshUser?: string; os?: "linux" | "windows"; connectionMode?: "ssh" | "agent"; agentId?: string }) =>
    request<{ server: unknown; publicKey: string; instructions: string }>(
      "POST", "/servers", data
    ),
  updateServer: (id: number, data: { name?: string; host?: string; port?: number; sshUser?: string; os?: "linux" | "windows"; connectionMode?: "ssh" | "agent"; agentId?: string }) =>
    request<{ server: unknown }>("PUT", `/servers/${id}`, data),
  testServer: (id: number) =>
    request<{ ok: boolean; output?: string; error?: string }>(
      "POST", `/servers/${id}/test`
    ),
  pushKey: (id: number, password: string) =>
    request<{ ok: boolean; message?: string }>(
      "POST", `/servers/${id}/push-key`, { password }
    ),
  deleteServer: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/servers/${id}`),
  listInstances: (serverId: number) =>
    request<{ instances: unknown[] }>("GET", `/servers/${serverId}/instances`),
  discoverInstances: (serverId: number, rootHints: string[] = []) =>
    request<{ serverId: number; scannedAt: string; readOnly: boolean; instances: unknown[] }>(
      "POST", `/servers/${serverId}/instances/discover`, { rootHints }
    ),
  saveInstance: (serverId: number, instance: Record<string, unknown>) =>
    request<{ instance: unknown }>("POST", `/servers/${serverId}/instances`, instance),
  updateInstance: (id: number, instance: Record<string, unknown>) =>
    request<{ instance: unknown }>("PUT", `/instances/${id}`, instance),
  deleteInstance: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/instances/${id}`),
  setupServer: async (
    id: number,
    password: string,
    onMessage: (type: "log" | "success" | "error", message: string) => void
  ): Promise<void> => {
    const token = getToken();
    const res = await fetch(`${BASE}/servers/${id}/setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ password }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error ?? "Request failed");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const { type, message } = JSON.parse(line.slice(6));
            onMessage(type, message);
          } catch {}
        }
      }
    }
  },

  // MCP API keys (legacy API route and database names remain token-based)
  listTokens: () =>
    request<{ tokens: unknown[] }>("GET", "/tokens"),
  createToken: (data: {
    name: string;
    projectId?: number;
    projectIds?: number[];
    projectServerId?: number;
    defaultServerId?: number;
    serverIds: number[];
    environment?: string;
    allowAllProjects?: boolean;
    canCreateProjects?: boolean;
  }) =>
    request<{ token: string; profile: unknown }>("POST", "/tokens", data),
  updateToken: (id: number, data: {
    name: string;
    projectId?: number;
    projectIds?: number[];
    projectServerId?: number;
    defaultServerId?: number;
    serverIds: number[];
    environment?: string;
    allowAllProjects?: boolean;
    canCreateProjects?: boolean;
  }) =>
    request<{ profile: unknown }>("PUT", `/tokens/${id}`, data),
  deleteApiKey: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/tokens/${id}`),

  // Agent tokens
  listAgentTokens: () =>
    request<{ tokens: unknown[] }>("GET", "/agent-tokens"),
  createAgentToken: (data: { name: string; serverId: number }) =>
    request<{ token: string; profile: unknown }>("POST", "/agent-tokens", data),
  revokeAgentToken: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/agent-tokens/${id}`),

  // Users (admin)
  listUsers: () =>
    request<{ users: unknown[] }>("GET", "/users"),
  createUser: (username: string, password: string, isAdmin = false) =>
    request<{ user: unknown }>("POST", "/users", { username, password, isAdmin }),
  changePassword: (id: number, password: string) =>
    request<{ ok: boolean }>("PATCH", `/users/${id}/password`, { password }),
  toggleAdmin: (id: number, isAdmin: boolean) =>
    request<{ ok: boolean }>("PATCH", `/users/${id}/admin`, { isAdmin }),
  deleteUser: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/users/${id}`),
};
