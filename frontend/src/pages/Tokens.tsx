import { useEffect, useMemo, useState } from "react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { api } from "../api/client";

export default function TokensPage() {
  const [tokens, setTokens] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [linkedServers, setLinkedServers] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [createdToken, setCreatedToken] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "",
    defaultProjectId: "",
    projectIds: [] as string[],
    projectServerId: "",
    environment: "production",
    allowAllProjects: true,
    canCreateProjects: true,
  });

  const selectedProject = useMemo(
    () => projects.find((p) => String(p.id) === form.defaultProjectId),
    [projects, form.defaultProjectId]
  );

  const load = async () => {
    const [tokenResult, projectResult] = await Promise.all([
      api.listTokens(),
      api.listProjects(),
    ]);
    setTokens(tokenResult.tokens);
    setProjects(projectResult.projects);
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!form.defaultProjectId) {
      setLinkedServers([]);
      setForm((f) => ({ ...f, projectServerId: "", environment: "production" }));
      return;
    }
    api.listProjectServers(Number(form.defaultProjectId)).then((r) => {
      setLinkedServers(r.servers);
      const first = r.servers[0];
      setForm((f) => ({
        ...f,
        projectServerId: first ? String(first.id) : "",
        environment: first?.environment ?? "production",
      }));
    });
  }, [form.defaultProjectId]);

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

  const createToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setCreatedToken("");
    try {
      const result = await api.createToken({
        name: form.name || `${selectedProject?.name ?? "relay"} token`,
        projectId: form.defaultProjectId ? Number(form.defaultProjectId) : undefined,
        projectIds: form.allowAllProjects ? undefined : form.projectIds.map(Number),
        projectServerId: form.projectServerId ? Number(form.projectServerId) : undefined,
        environment: form.environment || "production",
        allowAllProjects: form.allowAllProjects,
        canCreateProjects: form.canCreateProjects,
      });
      setCreatedToken(result.token);
      setShowCreate(false);
      setForm({
        name: "",
        defaultProjectId: "",
        projectIds: [],
        projectServerId: "",
        environment: "production",
        allowAllProjects: true,
        canCreateProjects: true,
      });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const revoke = async (id: number) => {
    if (!confirm("Revoke this MCP token? Existing agents using it will stop working.")) return;
    await api.revokeToken(id);
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
          <p className="text-xs text-gray-500">Generate agent profiles that can access one or many projects.</p>
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
              <label className="block text-xs text-gray-500 mb-1">Default Server Link</label>
              <select
                value={form.projectServerId}
                onChange={(e) => {
                  const link = linkedServers.find((s) => String(s.id) === e.target.value);
                  setForm((f) => ({ ...f, projectServerId: e.target.value, environment: link?.environment ?? f.environment }));
                }}
                className={inputCls}
                disabled={!form.defaultProjectId || linkedServers.length === 0}
              >
                <option value="">No default server</option>
                {linkedServers.map((s) => (
                  <option key={s.id} value={s.id}>{s.serverName} · {s.environment} · {s.serverHost}</option>
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
              <button type="submit" className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-md">Generate</button>
              <button type="button" onClick={() => setShowCreate(false)} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-md">Cancel</button>
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
                default: {token.projectName ?? "ask agent"} · access: {token.allowAllProjects ? "all projects" : `${token.projectScopes?.length ?? 0} project(s)`} · create: {token.canCreateProjects ? "yes" : "no"} · env: {token.environment ?? "production"} · {token.active ? "active" : "revoked"}
              </p>
              {!token.allowAllProjects && token.projectScopes?.length > 0 && (
                <p className="text-xs text-gray-600">
                  projects: {token.projectScopes.map((scope: any) => scope.projectName).join(", ")}
                </p>
              )}
              <p className="text-xs text-gray-600">created: {token.createdAt ?? "-"} · last used: {token.lastUsedAt ?? "-"}</p>
            </div>
            <button onClick={() => revoke(token.id)} className="text-gray-600 hover:text-red-400" title="Revoke">
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {tokens.length === 0 && <p className="text-sm text-gray-600">No MCP tokens yet.</p>}
      </div>
    </div>
  );
}
