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
    projectId: "",
    projectServerId: "",
    environment: "production",
  });

  const selectedProject = useMemo(
    () => projects.find((p) => String(p.id) === form.projectId),
    [projects, form.projectId]
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
    if (!form.projectId) {
      setLinkedServers([]);
      setForm((f) => ({ ...f, projectServerId: "", environment: "production" }));
      return;
    }
    api.listProjectServers(Number(form.projectId)).then((r) => {
      setLinkedServers(r.servers);
      const first = r.servers[0];
      setForm((f) => ({
        ...f,
        projectServerId: first ? String(first.id) : "",
        environment: first?.environment ?? "production",
      }));
    });
  }, [form.projectId]);

  const createToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setCreatedToken("");
    try {
      const result = await api.createToken({
        name: form.name || `${selectedProject?.name ?? "relay"} token`,
        projectId: form.projectId ? Number(form.projectId) : undefined,
        projectServerId: form.projectServerId ? Number(form.projectServerId) : undefined,
        environment: form.environment || "production",
      });
      setCreatedToken(result.token);
      setShowCreate(false);
      setForm({ name: "", projectId: "", projectServerId: "", environment: "production" });
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
          <p className="text-xs text-gray-500">Generate scoped tokens for local agents and bind default project/server context.</p>
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
              <select value={form.projectId} onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))} className={inputCls}>
                <option value="">Ask agent to choose/create project</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
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
                disabled={!form.projectId || linkedServers.length === 0}
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
                {token.projectName ?? "No default project"} · env: {token.environment ?? "production"} · {token.active ? "active" : "revoked"}
              </p>
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
