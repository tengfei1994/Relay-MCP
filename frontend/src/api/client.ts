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
  knowledgeEvidence: (id: string) => request<{ evidence: any }>("GET", `/knowledge/evidence/${encodeURIComponent(id)}`),
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
  knowledgeCandidates: (projectId: number, status?: string) => request<{ candidates: any[]; page: any }>("GET", `/knowledge/candidates?projectId=${projectId}${status ? `&status=${encodeURIComponent(status)}` : ""}`),
  knowledgeIndexStatus: (projectId: number) => request<{ projectId: string; stale: boolean; counts: any[]; lastIngest?: any }>("GET", `/knowledge/index-status?projectId=${projectId}`),
  knowledgeDashboard: (projectId: number) => request<{ projectId: string; totals: any[]; counts: any[]; recent: any; capture: any }>("GET", `/knowledge/dashboard?projectId=${projectId}`),
  productDocuments: (params: Record<string, string | number | undefined> = {}) => { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return request<{ documents: any[] }>("GET", `/knowledge/product-docs?${query.toString()}`); },
  productDocument: (id: string) => request<{ document: any; sections: any[] }>("GET", `/knowledge/product-docs/${encodeURIComponent(id)}`),
  productDocumentDiff: (id: string, against: string) => request<any>("GET", `/knowledge/product-docs/${encodeURIComponent(id)}/diff?against=${encodeURIComponent(against)}`),
  knowledgeIngest: (projectId: number, casebookRoot?: string, contextFiles?: string[]) => request<any>("POST", "/knowledge/ingest", { projectId, casebookRoot, contextFiles }),
  knowledgeReindex: (projectId: number) => request<any>("POST", "/knowledge/reindex", { projectId }),
  knowledgeReview: (body: Record<string, unknown>, idempotencyKey?: string) => request<any>("POST", "/knowledge/reviews", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  knowledgeFeedback: (body: Record<string, unknown>, idempotencyKey?: string) => request<any>("POST", "/knowledge/feedback", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),

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
