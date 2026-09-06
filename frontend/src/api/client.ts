const BASE = "/api";

function getToken() {
  return localStorage.getItem("token");
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
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
    request<{ projects: any[] }>("GET", "/projects"),
  listTools: () =>
    request<{ tools: any[]; categories: any[]; sampleManagerEntities: any[] }>("GET", "/tools"),
  createProject: (name: string, description?: string) =>
    request<{ project: any }>("POST", "/projects", { name, description }),
  deleteProject: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/projects/${id}`),
  listFiles: (id: number, path = "") =>
    request<{ path: string; entries: any[] }>(
      "GET", `/projects/${id}/files?path=${encodeURIComponent(path)}`
    ),

  // Knowledge governance plane
  knowledgeSearch: (params: { projectId: number; q: string; limit?: number; sampleManagerVersion?: string; solution?: string; module?: string; environment?: string; scopeType?: string; scopeKey?: string; kinds?: string; includeDeprecated?: boolean }) => {
    const query = new URLSearchParams({ projectId: String(params.projectId), q: params.q });
    for (const key of ["limit", "sampleManagerVersion", "solution", "module", "environment", "scopeType", "scopeKey", "kinds", "includeDeprecated"] as const) {
      const value = params[key];
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return request<{ retrievalRunId: string; query: string; degraded: boolean; results: any[] }>("GET", `/knowledge/search?${query.toString()}`);
  },
  knowledgeDocument: (id: string, projectId?: number) => request<{ document: any; evidenceRefs: string[]; reviews: any[] }>("GET", `/knowledge/documents/${encodeURIComponent(id)}${projectId ? `?projectId=${projectId}` : ""}`),
  knowledgeDocuments: (projectId: number, kinds?: string, params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams({ projectId: String(projectId) }); if (kinds) query.set("kinds", kinds); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ documents: any[]; page?: any }>("GET", `/knowledge/documents?${query.toString()}`); },
  knowledgeEvidence: (id: string) => request<{ evidence: any }>("GET", `/knowledge/evidence/${encodeURIComponent(id)}`),
  knowledgeObservation: (id: string) => request<{ observation: any }>("GET", `/knowledge/observations/${encodeURIComponent(id)}`),
  knowledgeObservations: (projectId: number, params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams({ projectId: String(projectId) }); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ observations: any[]; page?: any }>("GET", `/knowledge/observations?${query.toString()}`); },
  knowledgeDocumentEvidence: (id: string, body: { evidenceId: string; operation: "attach" | "detach"; reason: string }, idempotencyKey?: string) => request<any>("POST", `/knowledge/documents/${encodeURIComponent(id)}/evidence`, body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeEvidenceList: (projectId?: number, params: Record<string, string | number | undefined> = {}) => {
    const query = new URLSearchParams();
    if (projectId !== undefined) query.set("projectId", String(projectId));
    Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); });
    return request<{ evidence: any[]; page?: any }>("GET", `/knowledge/evidence?${query.toString()}`);
  },
  knowledgeEvidenceSession: (id: string, maxBytes?: number) => request<{ sessionId: string; evidenceId: string; expiresAt: string; maxBytes: number; mimeType: string; sizeBytes: number; sha256: string }>("POST", `/knowledge/evidence/${encodeURIComponent(id)}/download-session`, maxBytes ? { maxBytes } : {}),
  knowledgeEvidenceContentUrl: (id: string, sessionId: string) => `/api/knowledge/evidence/${encodeURIComponent(id)}/content?sessionId=${encodeURIComponent(sessionId)}`,
  knowledgeRelations: (params: { projectId: number; objectId?: string; relationType?: string; verifiedOnly?: boolean; limit?: number }) => {
    const query = new URLSearchParams({ projectId: String(params.projectId) });
    for (const key of ["objectId", "relationType", "verifiedOnly", "limit"] as const) {
      const value = params[key];
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return request<{ relations: any[] }>("GET", `/knowledge/relations?${query.toString()}`);
  },
  knowledgeImpact: (params: { projectId: number; objectId: string; maxDepth?: number; direction?: "upstream" | "downstream" | "both"; verifiedOnly?: boolean }) => {
    const query = new URLSearchParams({ projectId: String(params.projectId), objectId: params.objectId });
    for (const key of ["maxDepth", "direction", "verifiedOnly"] as const) {
      const value = params[key];
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return request<{ root: string; nodes: string[]; relations: any[] }>("GET", `/knowledge/relations/impact?${query.toString()}`);
  },
  knowledgeCandidates: (projectId: number, status?: string, params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams({ projectId: String(projectId) }); if (status) query.set("status", status); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ candidates: any[]; page: any }>("GET", `/knowledge/candidates?${query.toString()}`); },
  knowledgeIndexStatus: (projectId: number) => request<{ projectId: string; stale: boolean; counts: any[]; lastIngest?: any }>("GET", `/knowledge/index-status?projectId=${projectId}`),
  knowledgeDashboard: (projectId: number) => request<{ projectId: string; totals: any[]; counts: any[]; recent: any; capture: any }>("GET", `/knowledge/dashboard?projectId=${projectId}`),
  knowledgeDiagnostics: (projectId: number) => request<any>("GET", `/knowledge/diagnostics?projectId=${projectId}`),
  knowledgeIngestRuns: (projectId: number, limit = 50) => request<{ runs: any[] }>("GET", `/knowledge/ingest-runs?projectId=${projectId}&limit=${limit}`),
  productDocuments: (params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ documents: any[] }>("GET", `/knowledge/product-docs?${query.toString()}`); },
  productDocumentsList: (params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ documents: any[]; page?: any }>("GET", `/knowledge/product-documents?${query.toString()}`); },
  productDocumentImport: (body: Record<string, unknown>, idempotencyKey?: string) => request<any>("POST", "/knowledge/product-docs/import", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  productDocumentImportGlobal: (body: Record<string, unknown>, idempotencyKey?: string) => request<any>("POST", "/knowledge/product-documents/import", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  productDocument: (id: string) => request<{ document: any; sections: any[] }>("GET", `/knowledge/product-docs/${encodeURIComponent(id)}`),
  productDocumentGlobal: (id: string) => request<{ document: any; sections: any[] }>("GET", `/knowledge/product-documents/${encodeURIComponent(id)}`),
  productDocumentImports: (limit = 50) => request<{ runs: any[] }>("GET", `/knowledge/product-documents/imports?limit=${limit}`),
  productDocumentImportDetail: (id: string) => request<any>("GET", `/knowledge/product-documents/imports/${encodeURIComponent(id)}`),
  productDocumentRetry: (id: string, idempotencyKey?: string) => request<any>("POST", `/knowledge/product-documents/imports/${encodeURIComponent(id)}/retry`, {}, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  productDocumentVersions: () => request<{ versions: any[] }>("GET", "/knowledge/product-documents/versions"),
  productDocumentDiffs: (left: string, right: string) => request<any>("GET", `/knowledge/product-documents/diffs?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`),
  productDocumentSearch: (params: Record<string, string | number | boolean | undefined> = {}) => { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ documents: any[]; page?: any }>("GET", `/knowledge/product-documents/search?${query.toString()}`); },
  productDocumentDiff: (id: string, against: string) => request<any>("GET", `/knowledge/product-docs/${encodeURIComponent(id)}/diff?against=${encodeURIComponent(against)}`),
  productDocumentDiffReview: (id: string, body: { against: string; status: "accepted" | "rejected" | "needs_review"; reason: string }, idempotencyKey?: string) => request<any>("POST", `/knowledge/product-docs/${encodeURIComponent(id)}/diff-review`, body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  productDocumentMetadataCorrection: (body: Record<string, unknown>, idempotencyKey?: string) => request<any>("PATCH", "/knowledge/product-docs/metadata", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeIngest: (projectId: number, casebookRoot?: string, contextFiles?: string[]) => request<any>("POST", "/knowledge/ingest", { projectId, casebookRoot, contextFiles }),
  knowledgeReindex: (projectId: number) => request<any>("POST", "/knowledge/reindex", { projectId }),
  knowledgeReview: (body: Record<string, unknown>, idempotencyKey?: string) => request<any>("POST", "/knowledge/reviews", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeFeedback: (body: Record<string, unknown>, idempotencyKey?: string) => request<any>("POST", "/knowledge/feedback", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeOperationsCapture: () => request<any>("GET", "/knowledge/operations/capture"),
  knowledgeOperationsCaptureEvents: (limit = 50) => request<any>("GET", `/knowledge/operations/capture/events?limit=${limit}`),
  knowledgeOperationsDeadLetters: () => request<any>("GET", "/knowledge/operations/capture/dead-letter"),
  knowledgeOperationsSmokeTest: (body: Record<string, unknown> = {}, idempotencyKey?: string) => request<any>("POST", "/knowledge/operations/capture/smoke-test", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeOperationsIngestRuns: (limit = 50) => request<any>("GET", `/knowledge/operations/ingest-runs?limit=${limit}`),
  knowledgeOperationsIngestRun: (id: string) => request<any>("GET", `/knowledge/operations/ingest-runs/${encodeURIComponent(id)}`),
  knowledgeOperationsRetryIngest: (id: string, idempotencyKey?: string) => request<any>("POST", `/knowledge/operations/ingest-runs/${encodeURIComponent(id)}/retry`, {}, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeOperationsIndex: () => request<any>("GET", "/knowledge/operations/index"),
  knowledgeOperationsProviders: () => request<any>("GET", "/knowledge/operations/providers"),
  knowledgeOperationsTestProvider: (provider?: string, idempotencyKey?: string) => request<any>("POST", "/knowledge/operations/providers/test", provider ? { provider } : {}, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeOperationsRebuildIndex: (projectId?: number, idempotencyKey?: string) => request<any>("POST", "/knowledge/operations/index/rebuild", projectId ? { projectId } : {}, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeOperationsInvalidateEmbeddings: (projectId?: number, idempotencyKey?: string) => request<any>("POST", "/knowledge/operations/index/invalidate-embeddings", projectId ? { projectId } : {}, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),

  // Project-Server links
  listProjectServers: (projectId: number) =>
    request<{ servers: any[] }>("GET", `/projects/${projectId}/servers`),
  linkServer: (projectId: number, serverId: number, remotePath: string, environment = "production", connectionMode?: "ssh" | "agent", limsInstanceId?: number) =>
    request<{ link: any }>("POST", `/projects/${projectId}/servers`, { serverId, remotePath, environment, connectionMode, limsInstanceId }),
  updateProjectServer: (projectId: number, linkId: number, data: { remotePath?: string; environment?: string; connectionMode?: "ssh" | "agent"; limsInstanceId?: number | null }) =>
    request<{ link: any }>("PUT", `/projects/${projectId}/servers/${linkId}`, data),
  unlinkServer: (projectId: number, linkId: number) =>
    request<{ ok: boolean }>("DELETE", `/projects/${projectId}/servers/${linkId}`),

  // Servers
  listServers: () =>
    request<{ servers: any[] }>("GET", "/servers"),
  addServer: (data: { name: string; host?: string; port?: number; sshUser?: string; os?: "linux" | "windows"; connectionMode?: "ssh" | "agent"; agentId?: string }) =>
    request<{ server: any; publicKey: string; instructions: string }>(
      "POST", "/servers", data
    ),
  updateServer: (id: number, data: { name?: string; host?: string; port?: number; sshUser?: string; os?: "linux" | "windows"; connectionMode?: "ssh" | "agent"; agentId?: string }) =>
    request<{ server: any }>("PUT", `/servers/${id}`, data),
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
    request<{ instances: any[] }>("GET", `/servers/${serverId}/instances`),
  discoverInstances: (serverId: number, rootHints: string[] = []) =>
    request<{ serverId: number; scannedAt: string; readOnly: boolean; instances: any[] }>(
      "POST", `/servers/${serverId}/instances/discover`, { rootHints }
    ),
  saveInstance: (serverId: number, instance: any) =>
    request<{ instance: any }>("POST", `/servers/${serverId}/instances`, instance),
  updateInstance: (id: number, instance: any) =>
    request<{ instance: any }>("PUT", `/instances/${id}`, instance),
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
    request<{ tokens: any[] }>("GET", "/tokens"),
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
    request<{ token: string; profile: any }>("POST", "/tokens", data),
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
    request<{ profile: any }>("PUT", `/tokens/${id}`, data),
  deleteApiKey: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/tokens/${id}`),

  // Agent tokens
  listAgentTokens: () =>
    request<{ tokens: any[] }>("GET", "/agent-tokens"),
  createAgentToken: (data: { name: string; serverId: number }) =>
    request<{ token: string; profile: any }>("POST", "/agent-tokens", data),
  revokeAgentToken: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/agent-tokens/${id}`),

  // Users (admin)
  listUsers: () =>
    request<{ users: any[] }>("GET", "/users"),
  createUser: (username: string, password: string, isAdmin = false) =>
    request<{ user: any }>("POST", "/users", { username, password, isAdmin }),
  changePassword: (id: number, password: string) =>
    request<{ ok: boolean }>("PATCH", `/users/${id}/password`, { password }),
  toggleAdmin: (id: number, isAdmin: boolean) =>
    request<{ ok: boolean }>("PATCH", `/users/${id}/admin`, { isAdmin }),
  deleteUser: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/users/${id}`),
};
