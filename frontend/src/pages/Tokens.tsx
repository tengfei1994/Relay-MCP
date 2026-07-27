import { useEffect, useMemo, useState } from "react";
import { Copy, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../api/client";

export default function TokensPage() {
  const [tokens, setTokens] = useState<any[]>([]);
  const [agentTokens, setAgentTokens] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingTokenId, setEditingTokenId] = useState<number | null>(null);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [createdToken, setCreatedToken] = useState("");
  const [createdAgentToken, setCreatedAgentToken] = useState("");
  const [error, setError] = useState("");
  const [agentError, setAgentError] = useState("");
  const [agentForm, setAgentForm] = useState({ name: "", serverId: "" });
  const [form, setForm] = useState({
    name: "",
    defaultProjectId: "",
    projectServerId: "",
    projectIds: [] as string[],
    serverIds: [] as string[],
    defaultServerId: "",
    environment: "production",
    allowAllProjects: true,
    canCreateProjects: true,
  });

  const selectedProject = useMemo(
    () => projects.find((p) => String(p.id) === form.defaultProjectId),
    [projects, form.defaultProjectId]
  );

  const load = async () => {
    const [tokenResult, agentTokenResult, projectResult, serverResult] = await Promise.all([
      api.listTokens(),
      api.listAgentTokens(),
      api.listProjects(),
      api.listServers(),
    ]);
    setTokens(tokenResult.tokens);
    setAgentTokens(agentTokenResult.tokens);
    setProjects(projectResult.projects);
    setServers(serverResult.servers);
  };

  useEffect(() => {
    void load();
  }, []);

  const toggleProject = (projectId: string) => {
    setForm((f) => {
      const projectIds = f.projectIds.includes(projectId)
        ? f.projectIds.filter((id) => id !== projectId)
        : [...f.projectIds, projectId];
      return {
        ...f,
        projectIds,
        defaultProjectId: projectIds.includes(f.defaultProjectId) ? f.defaultProjectId : "",
      };
    });
  };

  const toggleServer = (serverId: string) => {
    setForm((f) => {
      const serverIds = f.serverIds.includes(serverId)
        ? f.serverIds.filter((id) => id !== serverId)
        : [...f.serverIds, serverId];
      return {
        ...f,
        serverIds,
        defaultServerId: serverIds.includes(f.defaultServerId) ? f.defaultServerId : "",
      };
    });
  };

  const createToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setCreatedToken("");
    try {
      const payload = {
        name: form.name || `${selectedProject?.name ?? "relay"} token`,
        projectId: form.defaultProjectId ? Number(form.defaultProjectId) : undefined,
        projectIds: form.allowAllProjects ? undefined : form.projectIds.map(Number),
        projectServerId: form.projectServerId ? Number(form.projectServerId) : undefined,
        defaultServerId: form.defaultServerId ? Number(form.defaultServerId) : undefined,
        serverIds: form.serverIds.map(Number),
        environment: form.environment || "production",
        allowAllProjects: form.allowAllProjects,
        canCreateProjects: form.canCreateProjects,
      };
      if (editingTokenId) {
        await api.updateToken(editingTokenId, payload);
      } else {
        const result = await api.createToken(payload);
        setCreatedToken(result.token);
      }
      setShowCreate(false);
      setEditingTokenId(null);
      setForm({
        name: "",
        defaultProjectId: "",
        projectServerId: "",
        projectIds: [],
        serverIds: [],
        defaultServerId: "",
        environment: "production",
        allowAllProjects: true,
        canCreateProjects: true,
      });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const editToken = (token: any) => {
    setCreatedToken("");
    setError("");
    setEditingTokenId(token.id);
    setForm({
      name: token.name ?? "",
      defaultProjectId: token.projectId ? String(token.projectId) : "",
      projectServerId: token.projectServerId ? String(token.projectServerId) : "",
      projectIds: token.projectScopes?.map((scope: any) => String(scope.projectId)) ?? [],
      serverIds: token.serverScopes?.map((scope: any) => String(scope.serverId)) ?? [],
      defaultServerId: token.defaultServerId ? String(token.defaultServerId) : "",
      environment: token.environment ?? "production",
      allowAllProjects: Boolean(token.allowAllProjects),
      canCreateProjects: Boolean(token.canCreateProjects),
    });
    setShowCreate(true);
  };

  const closeTokenForm = () => {
    setShowCreate(false);
    setEditingTokenId(null);
  };

  const revoke = async (id: number) => {
    if (!confirm("Revoke this MCP token? Existing MCP clients using it will stop working.")) return;
    await api.revokeToken(id);
    await load();
  };

  const createAgentToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setAgentError("");
    setCreatedAgentToken("");
    try {
      const result = await api.createAgentToken({
        name: agentForm.name || "relay-agent",
        serverId: Number(agentForm.serverId),
      });
      setCreatedAgentToken(result.token);
      setShowCreateAgent(false);
      setAgentForm({ name: "", serverId: "" });
      await load();
    } catch (err: any) {
      setAgentError(err.message);
    }
  };

  const revokeAgent = async (id: number) => {
    if (!confirm("Revoke this Agent token? The Agent will stop checking in.")) return;
    await api.revokeAgentToken(id);
    await load();
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
  };

  const inputCls = "w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500";

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center gap-3 mb-6">
        <KeyRound size={18} className="text-indigo-400" />
        <div>
          <h2 className="text-lg font-semibold text-gray-100">MCP Tokens</h2>
          <p className="text-xs text-gray-500">Codex access tokens for MCP Project and Server permissions.</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="ml-auto flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-md"
        >
          <Plus size={15} />
          New Token
        </button>
      </div>

      {createdToken && (
        <div className="mb-6 bg-gray-900 border border-indigo-800 rounded-lg p-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <p className="text-sm font-medium text-indigo-300">Token created. Copy it now; it will not be shown again.</p>
            <button onClick={() => copy(createdToken)} className="flex items-center gap-1 text-xs text-gray-300 hover:text-white">
              <Copy size={13} /> Copy
            </button>
          </div>
          <pre className="p-3 bg-gray-950 border border-gray-800 rounded text-xs text-gray-300 overflow-auto">{createdToken}</pre>
          <p className="mt-3 text-xs text-gray-500">Codex PowerShell setup:</p>
          <pre className="mt-1 p-3 bg-gray-950 border border-gray-800 rounded text-xs text-gray-300 overflow-auto">
{`[Environment]::SetEnvironmentVariable("RELAY_MCP_TOKEN", "${createdToken}", "User")`}
          </pre>
        </div>
      )}

      {showCreate && (
        <div className="mb-6 bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="mb-4 text-sm font-medium text-gray-200">{editingTokenId ? "Edit MCP Token Permissions" : "New MCP Token"}</p>
          <form onSubmit={createToken} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Name</label>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputCls} placeholder="codex-newpharma" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Default Project</label>
              <select value={form.defaultProjectId} onChange={(e) => setForm((f) => ({ ...f, defaultProjectId: e.target.value }))} className={inputCls}>
                <option value="">Ask agent to choose/create project</option>
                {projects
                  .filter((p) => form.allowAllProjects || form.projectIds.includes(String(p.id)))
                  .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Project Access</label>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={form.allowAllProjects}
                  onChange={(e) => setForm((f) => ({
                    ...f,
                    allowAllProjects: e.target.checked,
                    projectIds: e.target.checked ? [] : f.projectIds,
                  }))}
                />
                All current and future projects
              </label>
              {!form.allowAllProjects && (
                <div className="mt-2 max-h-28 overflow-auto border border-gray-800 rounded p-2 space-y-1">
                  {projects.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-xs text-gray-400">
                      <input
                        type="checkbox"
                        checked={form.projectIds.includes(String(p.id))}
                        onChange={() => toggleProject(String(p.id))}
                      />
                      {p.name}
                    </label>
                  ))}
                  {projects.length === 0 && <p className="text-xs text-gray-600">No projects yet</p>}
                </div>
              )}
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Allowed Servers</label>
              <div className="max-h-28 overflow-auto border border-gray-800 rounded p-2 space-y-1">
                {servers.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-xs text-gray-400">
                    <input
                      type="checkbox"
                      checked={form.serverIds.includes(String(s.id))}
                      onChange={() => toggleServer(String(s.id))}
                    />
                    {s.name} · {(s.connectionMode ?? "ssh") === "agent" ? `agent:${s.agentId ?? "-"}` : `${s.sshUser}@${s.host}:${s.port}`}
                  </label>
                ))}
                {servers.length === 0 && <p className="text-xs text-gray-600">No servers yet</p>}
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Default Server</label>
              <select
                value={form.defaultServerId}
                onChange={(e) => setForm((f) => ({ ...f, defaultServerId: e.target.value }))}
                className={inputCls}
                disabled={form.serverIds.length === 0}
              >
                <option value="">No default server</option>
                {servers.filter((s) => form.serverIds.includes(String(s.id))).map((s) => (
                  <option key={s.id} value={s.id}>{s.name} · {(s.connectionMode ?? "ssh") === "agent" ? s.agentId : s.host}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Environment</label>
              <input value={form.environment} onChange={(e) => setForm((f) => ({ ...f, environment: e.target.value }))} className={inputCls} />
            </div>
            <label className="md:col-span-2 flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={form.canCreateProjects}
                onChange={(e) => setForm((f) => ({ ...f, canCreateProjects: e.target.checked }))}
              />
              Allow this agent to create projects and project directories
            </label>
            {error && <p className="md:col-span-2 text-xs text-red-400">{error}</p>}
            <div className="md:col-span-2 flex gap-2">
              <button type="submit" className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-md">{editingTokenId ? "Save Permissions" : "Generate"}</button>
              <button type="button" onClick={closeTokenForm} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-md">Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="space-y-2">
        {tokens.map((token) => (
          <div key={token.id} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
            <div>
              <p className="text-sm font-medium text-gray-200">{token.name}</p>
              <p className="text-xs text-gray-500">
                default project: {token.projectName ?? "ask agent"} · projects: {token.allowAllProjects ? "all" : `${token.projectScopes?.length ?? 0}`} · servers: {token.serverScopes?.length ?? 0} · create: {token.canCreateProjects ? "yes" : "no"} · env: {token.environment ?? "production"} · {token.active ? "active" : "revoked"}
              </p>
              {!token.allowAllProjects && token.projectScopes?.length > 0 && (
                <p className="text-xs text-gray-600">
                  projects: {token.projectScopes.map((scope: any) => scope.projectName).join(", ")}
                </p>
              )}
              {token.serverScopes?.length > 0 && (
                <p className="text-xs text-gray-600">
                  servers: {token.serverScopes.map((scope: any) => scope.serverName).join(", ")}
                </p>
              )}
              <p className="text-xs text-gray-600">created: {token.createdAt ?? "-"} · last used: {token.lastUsedAt ?? "-"}</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => editToken(token)} className="text-gray-600 hover:text-indigo-400" title="Edit permissions">
                <Pencil size={15} />
              </button>
              <button onClick={() => revoke(token.id)} className="text-gray-600 hover:text-red-400" title="Revoke">
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
        {tokens.length === 0 && <p className="text-sm text-gray-600">No MCP tokens yet.</p>}
      </div>

      <div className="flex items-center gap-3 mt-10 mb-4">
        <KeyRound size={18} className="text-emerald-400" />
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Agent Tokens</h2>
          <p className="text-xs text-gray-500">One-time authorization for a specific Windows Agent.</p>
        </div>
        <button
          onClick={() => setShowCreateAgent(true)}
          className="ml-auto flex items-center gap-2 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-md"
        >
          <Plus size={15} />
          New Agent Token
        </button>
      </div>

      {createdAgentToken && (
        <div className="mb-6 bg-gray-900 border border-emerald-800 rounded-lg p-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <p className="text-sm font-medium text-emerald-300">Agent token created. Copy it now; it will not be shown again.</p>
            <button onClick={() => copy(createdAgentToken)} className="flex items-center gap-1 text-xs text-gray-300 hover:text-white">
              <Copy size={13} /> Copy
            </button>
          </div>
          <pre className="p-3 bg-gray-950 border border-gray-800 rounded text-xs text-gray-300 overflow-auto">{createdAgentToken}</pre>
          <p className="mt-3 text-xs text-gray-500">Paste this token into the Agent Client Agent Token field.</p>
        </div>
      )}

      {showCreateAgent && (
        <div className="mb-6 bg-gray-900 border border-gray-800 rounded-lg p-4">
          <form onSubmit={createAgentToken} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Name</label>
              <input value={agentForm.name} onChange={(e) => setAgentForm((f) => ({ ...f, name: e.target.value }))} className={inputCls} placeholder="HKJC agent token" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Agent Server</label>
              <select required value={agentForm.serverId} onChange={(e) => setAgentForm((f) => ({ ...f, serverId: e.target.value }))} className={inputCls}>
                <option value="">Select an Agent server</option>
                {servers.filter((s) => (s.connectionMode ?? "ssh") === "agent").map((s) => (
                  <option key={s.id} value={s.id}>{s.name} · {s.agentId}</option>
                ))}
              </select>
            </div>
            {agentError && <p className="md:col-span-2 text-xs text-red-400">{agentError}</p>}
            <div className="md:col-span-2 flex gap-2">
              <button type="submit" className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-md">Generate</button>
              <button type="button" onClick={() => setShowCreateAgent(false)} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-md">Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="space-y-2">
        {agentTokens.map((token) => (
          <div key={token.id} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
            <div>
              <p className="text-sm font-medium text-gray-200">{token.name}</p>
              <p className="text-xs text-gray-500">
                agent: {token.agentId} · server: {token.serverName ?? "-"} · {token.active ? "active" : "revoked"}
              </p>
              <p className="text-xs text-gray-600">created: {token.createdAt ?? "-"} · last used: {token.lastUsedAt ?? "-"}</p>
            </div>
            <button onClick={() => revokeAgent(token.id)} className="text-gray-600 hover:text-red-400" title="Revoke">
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {agentTokens.length === 0 && <p className="text-sm text-gray-600">No Agent tokens yet.</p>}
      </div>
    </div>
  );
}
