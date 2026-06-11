const BASE = "/api";

function getToken() {
  return localStorage.getItem("token");
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

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
  createProject: (name: string, description?: string) =>
    request<{ project: any }>("POST", "/projects", { name, description }),
  deleteProject: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/projects/${id}`),
  listFiles: (id: number, path = "") =>
    request<{ path: string; entries: any[] }>(
      "GET", `/projects/${id}/files?path=${encodeURIComponent(path)}`
    ),

  // Project-Server links
  listProjectServers: (projectId: number) =>
    request<{ servers: any[] }>("GET", `/projects/${projectId}/servers`),
  linkServer: (projectId: number, serverId: number, remotePath: string, environment = "production") =>
    request<{ link: any }>("POST", `/projects/${projectId}/servers`, { serverId, remotePath, environment }),
  unlinkServer: (projectId: number, linkId: number) =>
    request<{ ok: boolean }>("DELETE", `/projects/${projectId}/servers/${linkId}`),

  // Servers
  listServers: () =>
    request<{ servers: any[] }>("GET", "/servers"),
  addServer: (data: { name: string; host: string; port: number; sshUser: string; os?: "linux" | "windows" }) =>
    request<{ server: any; publicKey: string; instructions: string }>(
      "POST", "/servers", data
    ),
  updateServer: (id: number, data: { name?: string; host?: string; port?: number; sshUser?: string; os?: "linux" | "windows" }) =>
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
