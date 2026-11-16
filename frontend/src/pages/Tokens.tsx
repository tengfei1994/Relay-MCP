import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../api/client";
import { AppPageFrame } from "../components/shell/AppPageFrame";
import { Button, ConfirmDialog, Dialog, Drawer, EmptyState, Field, Input, Select, StatusPill, useToast } from "../components/ui";
type Project = { id: number; name: string };
type Server = { id: number; name: string; host?: string; agentId?: string; sshUser?: string; port?: number; connectionMode?: string };
type ProjectScope = { projectId: number; projectName?: string };
type ServerScope = { serverId: number; serverName?: string };
type ApiToken = {
  id: number;
  name: string;
  projectId?: number;
  projectName?: string;
  projectServerId?: number;
  defaultServerId?: number;
  projectScopes?: ProjectScope[];
  serverScopes?: ServerScope[];
  environment?: string;
  allowAllProjects?: boolean;
  canCreateProjects?: boolean;
  active?: boolean;
  createdAt?: string;
  lastUsedAt?: string;
};
type AgentToken = { id: number; name: string; agentId?: string; serverName?: string; active?: boolean; createdAt?: string; lastUsedAt?: string };
type TokenForm = {
  name: string;
  defaultProjectId: string;
  projectServerId: string;
  projectIds: string[];
  serverIds: string[];
  defaultServerId: string;
  environment: string;
  allowAllProjects: boolean;
  canCreateProjects: boolean;
};

const emptyForm: TokenForm = { name: "", defaultProjectId: "", projectServerId: "", projectIds: [], serverIds: [], defaultServerId: "", environment: "production", allowAllProjects: false, canCreateProjects: false };
function messageOf(reason: unknown) { return reason instanceof Error ? reason.message : "The request could not be completed."; }

export default function TokensPage({ embedded: embeddedProp = false }: { embedded?: boolean }) {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const embedded = embeddedProp || (location.pathname === "/admin" && query.get("view") === "tokens");
  const agentOnly = embedded ? query.get("section") === "agents" : location.pathname === "/tokens/agents";
  const toast = useToast();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [agentTokens, setAgentTokens] = useState<AgentToken[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingTokenId, setEditingTokenId] = useState<number | null>(null);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [createdToken, setCreatedToken] = useState("");
  const [createdAgentToken, setCreatedAgentToken] = useState("");
  const [error, setError] = useState("");
  const [agentError, setAgentError] = useState("");
  const [loading, setLoading] = useState(true);
  const [agentForm, setAgentForm] = useState({ name: "", serverId: "" });
  const [form, setForm] = useState<TokenForm>(emptyForm);
  const [deleteTarget, setDeleteTarget] = useState<ApiToken | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AgentToken | null>(null);
  const selectedProject = useMemo(() => projects.find((project) => String(project.id) === form.defaultProjectId), [projects, form.defaultProjectId]);

  const load = async () => {
    const [tokenResult, agentTokenResult, projectResult, serverResult] = await Promise.all([api.listTokens(), api.listAgentTokens(), api.listProjects(), api.listServers()]);
    setTokens(tokenResult.tokens as ApiToken[]);
    setAgentTokens(agentTokenResult.tokens as AgentToken[]);
    setProjects(projectResult.projects as Project[]);
    setServers(serverResult.servers as Server[]);
  };

  const reload = async () => {
    setLoading(true); setError("");
    try { await load(); } catch (reason: unknown) { setError(messageOf(reason)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);

  useEffect(() => {
    const create = query.get("create");
    if (create === "1" && !agentOnly) setShowCreate(true);
    if (create === "agent" && agentOnly) setShowCreateAgent(true);
  }, [agentOnly, location.search]);

  const toggleProject = (projectId: string) => setForm((current) => {
    const projectIds = current.projectIds.includes(projectId) ? current.projectIds.filter((id) => id !== projectId) : [...current.projectIds, projectId];
    return { ...current, projectIds, defaultProjectId: projectIds.includes(current.defaultProjectId) ? current.defaultProjectId : "", canCreateProjects: projectIds.length > 0 && current.canCreateProjects };
  });
  const toggleServer = (serverId: string) => setForm((current) => {
    const serverIds = current.serverIds.includes(serverId) ? current.serverIds.filter((id) => id !== serverId) : [...current.serverIds, serverId];
    return { ...current, serverIds, defaultServerId: serverIds.includes(current.defaultServerId) ? current.defaultServerId : "" };
  });

  const createToken = async (event: React.FormEvent) => {
    event.preventDefault();
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
      if (editingTokenId) await api.updateToken(editingTokenId, payload);
      else { const result = await api.createToken(payload); setCreatedToken(result.token); }
      setShowCreate(false);
      setEditingTokenId(null);
      setForm(emptyForm);
      await load();
      if (editingTokenId) toast.success("Token permissions saved.");
    } catch (reason: unknown) { setError(messageOf(reason)); }
  };

  const editToken = (token: ApiToken) => {
    setCreatedToken("");
    setError("");
    setEditingTokenId(token.id);
    setForm({
      name: token.name ?? "",
      defaultProjectId: token.projectId ? String(token.projectId) : "",
      projectServerId: token.projectServerId ? String(token.projectServerId) : "",
      projectIds: token.projectScopes?.map((scope) => String(scope.projectId)) ?? [],
      serverIds: token.serverScopes?.map((scope) => String(scope.serverId)) ?? [],
      defaultServerId: token.defaultServerId ? String(token.defaultServerId) : "",
      environment: token.environment ?? "production",
      allowAllProjects: Boolean(token.allowAllProjects),
      canCreateProjects: Boolean(token.canCreateProjects),
    });
    setShowCreate(true);
  };
  const closeTokenForm = () => { setShowCreate(false); setEditingTokenId(null); setError(""); };
  const deleteApiKey = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteApiKey(deleteTarget.id);
      await load();
      setDeleteTarget(null);
      toast.success("Token deleted.");
    } catch (reason: unknown) {
      throw new Error(messageOf(reason));
    }
  };
  const createAgentToken = async (event: React.FormEvent) => {
    event.preventDefault();
    setAgentError("");
    setCreatedAgentToken("");
    try {
      const result = await api.createAgentToken({ name: agentForm.name || "relay-agent", serverId: Number(agentForm.serverId) });
      setCreatedAgentToken(result.token);
      setShowCreateAgent(false);
      setAgentForm({ name: "", serverId: "" });
      await load();
    } catch (reason: unknown) { setAgentError(messageOf(reason)); }
  };
  const revokeAgent = async () => {
    if (!revokeTarget) return;
    try {
      await api.revokeAgentToken(revokeTarget.id);
      await load();
      setRevokeTarget(null);
      toast.success("Relay Agent Token deleted.");
    } catch (reason: unknown) {
      throw new Error(messageOf(reason));
    }
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.success("Token copied."); }
    catch { toast.error("Could not copy the token. Select and copy it manually."); }
  };

  const content = (
      <div className={`tokens-page${embedded ? " admin-embedded-tokens" : ""}`}>
      <div className="tokens-toolbar">
        <nav className={`shell-page-tabs tokens-mobile-tabs${embedded ? " admin-token-tabs" : ""}`} aria-label="Token sections"><Link to={embedded ? "/admin?view=tokens" : "/tokens"} className={`shell-page-tab${!agentOnly ? " active" : ""}`} aria-current={!agentOnly ? "page" : undefined}>MCP Access Tokens</Link><Link to={embedded ? "/admin?view=tokens&section=agents" : "/tokens/agents"} className={`shell-page-tab${agentOnly ? " active" : ""}`} aria-current={agentOnly ? "page" : undefined}>Relay Agent Tokens</Link></nav>
        {agentOnly ? <Button onClick={() => { setAgentError(""); setShowCreateAgent(true); }} variant="accent"><Plus size={15} /> New Relay Agent Token</Button> : <Button onClick={() => { setEditingTokenId(null); setForm(emptyForm); setError(""); setShowCreate(true); }} variant="primary"><Plus size={15} /> New MCP Access Token</Button>}
      </div>

      {loading && <p className="mb-5 text-sm text-muted" role="status">Loading connection tokens…</p>}
      {!loading && error && !showCreate && <div className="mb-5 rounded-[10px] border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-coral" role="alert">{error} <Button variant="ghost" onClick={() => void reload()}>Try again</Button></div>}
      {!loading && !error && <>
      {!agentOnly && (
      <section className="mb-10"><div className="tokens-list-head"><strong>MCP Access Tokens</strong><span>{tokens.length} results</span></div><div className="tokens-list divide-y divide-white/[.09]">{tokens.map((token) => <div key={token.id} className="flex flex-wrap items-start justify-between gap-4 px-4 py-4 sm:px-5"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="font-medium text-fg">{token.name}</p><StatusPill status={token.active ? "active" : "inactive"} /></div><p className="mt-1 text-[13px] text-muted">Default project: {token.projectName ?? "None"}, projects: {token.allowAllProjects ? "all" : `${token.projectScopes?.length ?? 0}`}, servers: {token.serverScopes?.length ?? 0}, create projects: {token.canCreateProjects ? "yes" : "no"}, environment: {token.environment ?? "production"}</p>{!token.allowAllProjects && (token.projectScopes?.length ?? 0) > 0 && <p className="mt-1 text-[13px] text-muted">Projects: {token.projectScopes?.map((scope) => scope.projectName).join(", ")}</p>}{(token.serverScopes?.length ?? 0) > 0 && <p className="mt-1 text-[13px] text-muted">Servers: {token.serverScopes?.map((scope) => scope.serverName).join(", ")}</p>}<p className="mt-1 text-[12px] text-muted">Created: {token.createdAt ?? "-"}, last used: {token.lastUsedAt ?? "-"}</p></div><div className="tokens-row-actions"><Button onClick={() => editToken(token)} variant="ghost" aria-label={`Edit ${token.name}`}><Pencil size={15} /></Button><Button onClick={() => setDeleteTarget(token)} variant="ghost" aria-label={`Delete ${token.name}`}><Trash2 size={15} /></Button></div></div>)}{tokens.length === 0 && <EmptyState title="No MCP Access Tokens yet" description="Create a token to connect an MCP client." />}</div></section>
      )}

      {agentOnly && (
      <section><div className="tokens-list-head"><strong>Relay Agent Tokens</strong><span>{agentTokens.length} results</span></div><div className="tokens-list divide-y divide-white/[.09]">{agentTokens.map((token) => <div key={token.id} className="flex flex-wrap items-start justify-between gap-4 px-4 py-4 sm:px-5"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="font-medium text-fg">{token.name}</p><StatusPill status={token.active ? "active" : "inactive"} /></div><p className="mt-1 text-[13px] text-muted">Agent: {token.agentId ?? "-"}, server: {token.serverName ?? "-"}</p><p className="mt-1 text-[12px] text-muted">Created: {token.createdAt ?? "-"}, last used: {token.lastUsedAt ?? "-"}</p></div><div className="tokens-row-actions"><Button onClick={() => setRevokeTarget(token)} variant="ghost" aria-label={`Delete ${token.name}`}><Trash2 size={15} /></Button></div></div>)}{agentTokens.length === 0 && <EmptyState title="No Relay Agent Tokens yet" description="Create one to authorize a Windows agent." />}</div></section>
      )}
      </>}

      <Drawer open={showCreate} onClose={closeTokenForm} title={editingTokenId ? "Edit token permissions" : "Create MCP Access Token"}>
        <form onSubmit={createToken} className="grid gap-4 sm:grid-cols-2">
          <Field label="Name"><Input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="codex-newpharma" /></Field>
          <Field label="Default project"><Select value={form.defaultProjectId} onChange={(event) => setForm((current) => ({ ...current, defaultProjectId: event.target.value }))}><option value="">No default project</option>{projects.filter((project) => form.allowAllProjects || form.projectIds.includes(String(project.id))).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</Select></Field>
          <Field label="Project access" className="sm:col-span-2"><label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={form.allowAllProjects} onChange={(event) => setForm((current) => ({ ...current, allowAllProjects: event.target.checked, projectIds: event.target.checked ? [] : current.projectIds, canCreateProjects: event.target.checked ? current.canCreateProjects : current.projectIds.length > 0 && current.canCreateProjects }))} /> All current and future projects</label>{!form.allowAllProjects && <div className="mt-2 max-h-32 space-y-1 overflow-auto rounded-[10px] border border-white/[.09] p-2">{projects.map((project) => <label key={project.id} className="flex min-h-8 items-center gap-2 text-sm text-muted"><input type="checkbox" checked={form.projectIds.includes(String(project.id))} onChange={() => toggleProject(String(project.id))} />{project.name}</label>)}{projects.length === 0 && <p className="text-sm text-muted">No projects yet</p>}</div>}</Field>
          <p className="text-sm text-muted sm:col-span-2">With no projects selected, this token cannot access project tools or project Memory. Product Knowledge and general Memory follow your current user permission and need no project or server.</p>
          <Field label="Allowed servers" className="sm:col-span-2"><div className="max-h-32 space-y-1 overflow-auto rounded-[10px] border border-white/[.09] p-2">{servers.map((server) => <label key={server.id} className="flex min-h-8 items-center gap-2 text-sm text-muted"><input type="checkbox" checked={form.serverIds.includes(String(server.id))} onChange={() => toggleServer(String(server.id))} />{server.name}, {(server.connectionMode ?? "ssh") === "agent" ? `agent: ${server.agentId ?? "-"}` : `${server.sshUser}@${server.host}:${server.port}`}</label>)}{servers.length === 0 && <p className="text-sm text-muted">No servers yet</p>}</div></Field>
          <Field label="Default server"><Select value={form.defaultServerId} onChange={(event) => setForm((current) => ({ ...current, defaultServerId: event.target.value }))} disabled={form.serverIds.length === 0}><option value="">No default server</option>{servers.filter((server) => form.serverIds.includes(String(server.id))).map((server) => <option key={server.id} value={server.id}>{server.name}, {(server.connectionMode ?? "ssh") === "agent" ? server.agentId : server.host}</option>)}</Select></Field>
          <Field label="Environment"><Input value={form.environment} onChange={(event) => setForm((current) => ({ ...current, environment: event.target.value }))} /></Field>
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg sm:col-span-2"><input type="checkbox" disabled={!form.allowAllProjects && form.projectIds.length === 0} checked={form.canCreateProjects && (form.allowAllProjects || form.projectIds.length > 0)} onChange={(event) => setForm((current) => ({ ...current, canCreateProjects: event.target.checked }))} /> Allow this client to create projects and project directories</label>
          {error && <p className="text-sm text-coral sm:col-span-2" role="alert">{error}</p>}
          <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="ghost" onClick={closeTokenForm}>Cancel</Button><Button type="submit" variant="primary">{editingTokenId ? "Save permissions" : "Generate token"}</Button></div>
        </form>
      </Drawer>
      <Dialog open={showCreateAgent} onClose={() => setShowCreateAgent(false)} title="Create Relay Agent Token"><form onSubmit={createAgentToken} className="space-y-4"><Field label="Name"><Input value={agentForm.name} onChange={(event) => setAgentForm((current) => ({ ...current, name: event.target.value }))} placeholder="Lab agent token" /></Field><Field label="Agent server"><Select required value={agentForm.serverId} onChange={(event) => setAgentForm((current) => ({ ...current, serverId: event.target.value }))}><option value="">Select an agent server</option>{servers.filter((server) => (server.connectionMode ?? "ssh") === "agent").map((server) => <option key={server.id} value={server.id}>{server.name}, {server.agentId}</option>)}</Select></Field>{agentError && <p className="text-sm text-coral" role="alert">{agentError}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setShowCreateAgent(false)}>Cancel</Button><Button type="submit" variant="accent">Generate token</Button></div></form></Dialog>
      <Dialog open={Boolean(createdToken)} onClose={() => setCreatedToken("")} title="MCP Access Token created"><div className="space-y-3"><pre className="max-h-40 overflow-auto rounded-[10px] border border-white/[.09] bg-black/20 p-3 font-mono text-[13px] text-fg">{createdToken}</pre><Button onClick={() => void copy(createdToken)} variant="ghost"><Copy size={14} /> Copy token</Button><p className="text-xs text-muted">Codex PowerShell setup:</p><pre className="overflow-auto rounded-[10px] border border-white/[.09] bg-black/20 p-3 font-mono text-[12px] text-muted">{`[Environment]::SetEnvironmentVariable("RELAY_MCP_TOKEN", "${createdToken}", "User")`}</pre></div></Dialog>
      <Dialog open={Boolean(createdAgentToken)} onClose={() => setCreatedAgentToken("")} title="Relay Agent Token created"><div className="space-y-3"><pre className="max-h-40 overflow-auto rounded-[10px] border border-white/[.09] bg-black/20 p-3 font-mono text-[13px] text-fg">{createdAgentToken}</pre><Button onClick={() => void copy(createdAgentToken)} variant="ghost"><Copy size={14} /> Copy token</Button><p className="text-sm text-muted">Paste this token into the Agent Client Agent Token field.</p></div></Dialog>
      <ConfirmDialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="Delete token" description="Delete this MCP Access Token permanently? Existing MCP clients using it will stop working." confirmLabel="Delete token" tone="danger" onConfirm={deleteApiKey} />
      <ConfirmDialog open={Boolean(revokeTarget)} onClose={() => setRevokeTarget(null)} title="Delete Relay Agent Token" description="Delete this Relay Agent Token? Subsequent agent requests using it will fail. An in-flight request may finish." confirmLabel="Delete token" tone="danger" onConfirm={revokeAgent} />
      </div>
  );
  return embedded ? content : <AppPageFrame variant="wide">{content}</AppPageFrame>;
}
