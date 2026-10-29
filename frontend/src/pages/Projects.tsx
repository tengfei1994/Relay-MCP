import { useState, useEffect } from "react";
import { Plus, Folder, Trash2, ChevronRight, File, Server as ServerIcon, Link2, Unlink, Settings, Pencil } from "lucide-react";
import { api } from "../api/client";
import { Button, ConfirmDialog, Field, Input, Select } from "../components/ui";

type Project = { id: number; name: string; description?: string };
type FileEntry = { name: string; type?: string; size?: number };
type ProjectServer = {
  id: number;
  serverId: number;
  serverName?: string;
  serverAgentId?: string;
  serverSshUser?: string;
  serverHost?: string;
  serverPort?: number;
  limsInstanceId?: number | null;
  limsInstanceName?: string;
  limsInstanceVersion?: string;
  limsRuntimeKind?: string;
  limsDatabaseName?: string;
  remotePath?: string;
  environment?: string;
  connectionMode?: "ssh" | "agent" | string;
  serverConnectionMode?: "ssh" | "agent" | string;
};
type Server = { id: number; name: string; host?: string; agentId?: string; connectionMode?: "ssh" | "agent" | string };
type Instance = { id: number; name?: string; version?: string; runtimeKind?: string; databaseName?: string };
type ConfirmState = { kind: "project" | "link"; id: number } | null;
function present<T>(value: T | null): value is T {
  return value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function projectFrom(value: unknown): Project | null {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "number" || !("name" in value) || typeof value.name !== "string") return null;
  const record = value as Record<string, unknown>;
  return { id: value.id, name: value.name, description: optionalString(record.description) };
}

function fileFrom(value: unknown): FileEntry | null {
  if (typeof value !== "object" || value === null || !("name" in value) || typeof value.name !== "string") return null;
  const record = value as Record<string, unknown>;
  return { name: value.name, type: optionalString(record.type), size: optionalNumber(record.size) };
}

function projectServerFrom(value: unknown): ProjectServer | null {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "number" || !("serverId" in value) || typeof value.serverId !== "number") return null;
  const record = value as Record<string, unknown>;
  return {
    id: value.id,
    serverId: value.serverId,
    serverName: optionalString(record.serverName),
    serverAgentId: optionalString(record.serverAgentId),
    serverSshUser: optionalString(record.serverSshUser),
    serverHost: optionalString(record.serverHost),
    serverPort: optionalNumber(record.serverPort),
    limsInstanceId: typeof record.limsInstanceId === "number" || record.limsInstanceId === null ? record.limsInstanceId : undefined,
    limsInstanceName: optionalString(record.limsInstanceName),
    limsInstanceVersion: optionalString(record.limsInstanceVersion),
    limsRuntimeKind: optionalString(record.limsRuntimeKind),
    limsDatabaseName: optionalString(record.limsDatabaseName),
    remotePath: optionalString(record.remotePath),
    environment: optionalString(record.environment),
    connectionMode: optionalString(record.connectionMode),
    serverConnectionMode: optionalString(record.serverConnectionMode),
  };
}

function serverFrom(value: unknown): Server | null {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "number" || !("name" in value) || typeof value.name !== "string") return null;
  const record = value as Record<string, unknown>;
  return {
    id: value.id,
    name: value.name,
    host: optionalString(record.host),
    agentId: optionalString(record.agentId),
    connectionMode: optionalString(record.connectionMode),
  };
}

function instanceFrom(value: unknown): Instance | null {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "number") return null;
  const record = value as Record<string, unknown>;
  return {
    id: value.id,
    name: optionalString(record.name),
    version: optionalString(record.version),
    runtimeKind: optionalString(record.runtimeKind),
    databaseName: optionalString(record.databaseName),
  };
}

function projectsFrom(value: unknown): Project[] {
  return typeof value === "object" && value !== null && "projects" in value && Array.isArray(value.projects) ? value.projects.map(projectFrom).filter(present) : [];
}

function filesFrom(value: unknown): FileEntry[] {
  return typeof value === "object" && value !== null && "entries" in value && Array.isArray(value.entries) ? value.entries.map(fileFrom).filter(present) : [];
}

function projectServersFrom(value: unknown): ProjectServer[] {
  return typeof value === "object" && value !== null && "servers" in value && Array.isArray(value.servers) ? value.servers.map(projectServerFrom).filter(present) : [];
}

function serversFrom(value: unknown): Server[] {
  return typeof value === "object" && value !== null && "servers" in value && Array.isArray(value.servers) ? value.servers.map(serverFrom).filter(present) : [];
}

function instancesFrom(value: unknown): Instance[] {
  return typeof value === "object" && value !== null && "instances" in value && Array.isArray(value.instances) ? value.instances.map(instanceFrom).filter(present) : [];
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [selected, setSelected] = useState<Project | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [error, setError] = useState("");

  // Server association
  const [showServers, setShowServers] = useState(false);
  const [linkedServers, setLinkedServers] = useState<ProjectServer[]>([]);
  const [allServers, setAllServers] = useState<Server[]>([]);
  const [availableInstances, setAvailableInstances] = useState<Instance[]>([]);
  const [linkForm, setLinkForm] = useState({ serverId: "", limsInstanceId: "", remotePath: "", environment: "production", connectionMode: "ssh" });
  const [editingLinkId, setEditingLinkId] = useState<number | null>(null);
  const [linkError, setLinkError] = useState("");

  useEffect(() => {
    api.listProjects().then((r) => setProjects(projectsFrom(r)));
    api.listServers().then((r) => setAllServers(serversFrom(r)));
  }, []);

  const openProject = async (project: Project) => {
    setSelected(project);
    setCurrentPath("");
    setShowServers(false);
    const r = await api.listFiles(project.id, "");
    setFiles(filesFrom(r));
  };

  const openDir = async (name: string) => {
    if (!selected) return;
    const projectId = selected.id;
    const newPath = currentPath ? `${currentPath}/${name}` : name;
    setCurrentPath(newPath);
    const r = await api.listFiles(projectId, newPath);
    setFiles(filesFrom(r));
  };

  const goUp = async () => {
    if (!selected) return;
    const projectId = selected.id;
    const parts = currentPath.split("/");
    parts.pop();
    const newPath = parts.join("/");
    setCurrentPath(newPath);
    const r = await api.listFiles(projectId, newPath);
    setFiles(filesFrom(r));
  };

  const openBreadcrumb = async (parts: string[], index: number) => {
    if (!selected) return;
    const projectId = selected.id;
    const newPath = parts.slice(0, index + 1).join("/");
    if (newPath === currentPath) return;
    setCurrentPath(newPath);
    const r = await api.listFiles(projectId, newPath);
    setFiles(filesFrom(r));
  };

  const createProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const r = await api.createProject(newName, newDesc);
      const project = projectFrom(typeof r === "object" && r !== null && "project" in r ? r.project : null);
      if (!project) throw new Error("The server returned an invalid project.");
      setProjects((p) => [...p, project]);
      setShowCreate(false);
      setNewName("");
      setNewDesc("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to create project");
    }
  };

  const deleteProject = async (id: number) => {
    setConfirm({ kind: "project", id });
  };

  const confirmDeleteProject = async () => {
    if (!confirm || confirm.kind !== "project") return;
    await api.deleteProject(confirm.id);
    setProjects((p) => p.filter((proj) => proj.id !== confirm.id));
    if (selected?.id === confirm.id) setSelected(null);
    setConfirm(null);
  };

  const openServerPanel = async (project: Project) => {
    setSelected(project);
    setShowServers(true);
    setLinkError("");
    setEditingLinkId(null);
    setLinkForm({ serverId: "", limsInstanceId: "", remotePath: "", environment: "production", connectionMode: "ssh" });
    setAvailableInstances([]);
    const r = await api.listProjectServers(project.id);
    setLinkedServers(projectServersFrom(r));
  };

  const linkServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const projectId = selected.id;
    setLinkError("");
    if (!linkForm.serverId || (linkForm.connectionMode === "ssh" && !linkForm.remotePath)) {
      setLinkError(linkForm.connectionMode === "ssh" ? "Select a server and enter remote path" : "Select a server");
      return;
    }
    try {
      if (editingLinkId) {
        await api.updateProjectServer(projectId, editingLinkId, {
          remotePath: linkForm.remotePath,
          environment: linkForm.environment,
          connectionMode: linkForm.connectionMode as "ssh" | "agent",
          limsInstanceId: linkForm.limsInstanceId ? Number(linkForm.limsInstanceId) : null,
        });
      } else {
        await api.linkServer(
          projectId,
          Number(linkForm.serverId),
          linkForm.remotePath,
          linkForm.environment,
          linkForm.connectionMode as "ssh" | "agent",
          linkForm.limsInstanceId ? Number(linkForm.limsInstanceId) : undefined
        );
      }
      const r = await api.listProjectServers(projectId);
      setLinkedServers(projectServersFrom(r));
      setEditingLinkId(null);
      setLinkForm({ serverId: "", limsInstanceId: "", remotePath: "", environment: "production", connectionMode: "ssh" });
      setAvailableInstances([]);
    } catch (err: unknown) {
      setLinkError(err instanceof Error ? err.message : "Unable to link server");
    }
  };

  const unlinkServer = async (linkId: number) => {
    setConfirm({ kind: "link", id: linkId });
  };

  const confirmUnlinkServer = async () => {
    if (!confirm || confirm.kind !== "link" || !selected) return;
    await api.unlinkServer(selected.id, confirm.id);
    setLinkedServers((s) => s.filter((l) => l.id !== confirm.id));
    setConfirm(null);
  };

  const editServerLink = async (link: ProjectServer) => {
    setEditingLinkId(link.id);
    setLinkError("");
    setLinkForm({
      serverId: String(link.serverId),
      limsInstanceId: link.limsInstanceId ? String(link.limsInstanceId) : "",
      remotePath: link.remotePath || "",
      environment: link.environment || "production",
      connectionMode: link.connectionMode ?? link.serverConnectionMode ?? "ssh",
    });
    const result = await api.listInstances(link.serverId);
    setAvailableInstances(instancesFrom(result));
  };

  const cancelEditServerLink = () => {
    setEditingLinkId(null);
    setLinkError("");
    setLinkForm({ serverId: "", limsInstanceId: "", remotePath: "", environment: "production", connectionMode: "ssh" });
    setAvailableInstances([]);
  };


  return (
    <div className="flex min-h-full">
      <aside className="flex w-64 flex-col border-r border-line">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-display text-lg font-semibold text-fg">Projects</h2>
          <button type="button" onClick={() => setShowCreate(true)} className="text-muted transition-colors hover:text-mint" aria-label="Create project">
            <Plus size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto p-2">
          {projects.map((p) => (
            <div
              key={p.id}
              onClick={() => openProject(p)}
              className={`group flex cursor-pointer items-center justify-between rounded-ctl px-3 py-2 text-sm transition-colors ${
                selected?.id === p.id && !showServers ? "bg-mint text-ink" : "text-muted hover:bg-white/5 hover:text-fg"
              }`}
            >
              <div className="flex min-w-0 items-center gap-2">
                <Folder size={14} className="shrink-0" />
                <span className="truncate">{p.name}</span>
              </div>
              <div className="hidden items-center gap-1 group-hover:flex">
                <button type="button" onClick={(e) => { e.stopPropagation(); openServerPanel(p); }} className="text-muted hover:text-mint" title="Manage servers" aria-label={`Manage servers for ${p.name}`}>
                  <Settings size={13} />
                </button>
                <button type="button" onClick={(e) => { e.stopPropagation(); deleteProject(p.id); }} className="text-muted hover:text-coral" aria-label={`Delete ${p.name}`}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
          {projects.length === 0 && <p className="px-3 py-2 text-xs text-muted">No projects yet.</p>}
        </div>

        {showCreate && (
          <div className="border-t border-line p-3">
            <form onSubmit={createProject} className="space-y-3">
              <Field label="Name" hint="Use letters, numbers, hyphens, or underscores.">
                <Input autoFocus placeholder="my-project" value={newName} onChange={(e) => setNewName(e.target.value)} required />
              </Field>
              <Field label="Description">
                <Input placeholder="Optional description" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
              </Field>
              {error && <p className="text-sm text-coral" role="alert">{error}</p>}
              <div className="flex gap-2">
                <Button type="submit" size="sm" className="flex-1">Create</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setShowCreate(false)} className="flex-1">Cancel</Button>
              </div>
            </form>
          </div>
        )}
      </aside>

      {/* Main panel */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">Select a project to browse files.</div>
        ) : showServers ? (
          /* Server association panel */
          <div className="max-w-2xl flex-1 overflow-y-auto p-6">

            <div className="mb-6 flex items-center gap-2">
              <ServerIcon size={16} className="text-mint" />
              <h2 className="font-display text-[22px] font-semibold text-fg">Servers for {selected.name}</h2>
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowServers(false)} className="ml-auto">
                Back to files
              </Button>
            </div>

            <div className="mb-6 space-y-2">
              {linkedServers.length === 0 && <p className="text-sm text-muted">No servers linked yet.</p>}
              {linkedServers.map((l) => (
                <div key={l.id} className="glass flex items-center justify-between rounded-panel px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Link2 size={14} className="text-mint" />
                    <div>
                      <p className="text-sm font-medium text-fg">{l.serverName}</p>
                      <p className="text-xs text-muted">
                        {(l.connectionMode ?? l.serverConnectionMode ?? "ssh") === "agent"
                          ? `agent: ${l.serverAgentId ?? "-"}`
                          : `${l.serverSshUser}@${l.serverHost}:${l.serverPort}`}, environment {l.environment}, mode {l.connectionMode ?? "ssh"}
                      </p>
                      <p className="text-xs text-muted">Path: {l.remotePath || "-"}</p>
                      <p className="text-xs text-muted">
                        LIMS: {l.limsInstanceName
                          ? `${l.limsInstanceName} ${l.limsInstanceVersion || ""}, ${l.limsRuntimeKind || "unknown"}, DB ${l.limsDatabaseName || "-"}`
                          : "not bound"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => editServerLink(l)} className="text-muted hover:text-mint" title="Edit link" aria-label="Edit link">
                      <Pencil size={14} />
                    </button>
                    <button type="button" onClick={() => unlinkServer(l.id)} className="text-muted hover:text-coral" title="Unlink" aria-label="Unlink server">
                      <Unlink size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="glass rounded-panel p-5">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-display text-lg font-semibold text-fg">{editingLinkId ? "Edit server link" : "Link a server"}</h3>
                {editingLinkId && <Button type="button" variant="ghost" size="sm" onClick={cancelEditServerLink}>Cancel edit</Button>}
              </div>
              <form onSubmit={linkServer} className="space-y-4">
                <Field label="Server" required>
                  <Select
                    value={linkForm.serverId}
                    disabled={Boolean(editingLinkId)}
                    onChange={(e) => {
                      const server = allServers.find((s) => String(s.id) === e.target.value);
                      setLinkForm((f) => ({ ...f, serverId: e.target.value, limsInstanceId: "", connectionMode: server?.connectionMode ?? "ssh" }));
                      setAvailableInstances([]);
                      if (server) api.listInstances(server.id).then((result) => setAvailableInstances(instancesFrom(result)));
                    }}
                  >
                    <option value="">Select server…</option>
                    {allServers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name} ({(s.connectionMode ?? "ssh") === "agent" ? s.agentId : s.host})</option>
                    ))}
                  </Select>
                </Field>
                <Field label="LIMS instance" hint={linkForm.serverId && availableInstances.length === 0 ? "No confirmed instances on this server. Scan and import one from LIMS Instances." : undefined}>
                  <Select value={linkForm.limsInstanceId} onChange={(e) => setLinkForm((f) => ({ ...f, limsInstanceId: e.target.value }))} disabled={!linkForm.serverId}>
                    <option value="">No instance binding</option>
                    {availableInstances.map((instance) => (
                      <option key={instance.id} value={instance.id}>
                        {instance.name} ({instance.version || "unknown"}, {instance.runtimeKind}, DB {instance.databaseName || "-"})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Connection">
                  <Select value={linkForm.connectionMode} onChange={(e) => setLinkForm((f) => ({ ...f, connectionMode: e.target.value }))}>
                    <option value="ssh">SSH</option>
                    <option value="agent">Relay agent</option>
                  </Select>
                </Field>
                <Field label="Remote path">
                  <Input placeholder={linkForm.connectionMode === "agent" ? "Optional for agent mode" : "/opt/myapp"} value={linkForm.remotePath} onChange={(e) => setLinkForm((f) => ({ ...f, remotePath: e.target.value }))} />
                </Field>
                <Field label="Environment">
                  <Input placeholder="production" value={linkForm.environment} onChange={(e) => setLinkForm((f) => ({ ...f, environment: e.target.value }))} />
                </Field>
                {linkError && <p className="text-sm text-coral" role="alert">{linkError}</p>}
                <Button type="submit" className="w-full">{editingLinkId ? "Save link" : "Link server"}</Button>
              </form>
            </div>
          </div>
        ) : (
          /* File browser */
          <>
            <div className="flex min-w-0 items-center gap-1 border-b border-line px-4 py-3 text-xs text-muted">
              <nav aria-label="Workspace path" className="flex min-w-0 items-center gap-1 overflow-hidden">
                <button
                  type="button"
                  onClick={() => openProject(selected)}
                  title={selected.name}
                  className={`max-w-48 shrink truncate rounded px-1 py-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sun ${currentPath ? "hover:text-fg" : "cursor-default text-fg"}`}
                  aria-current={currentPath ? undefined : "page"}
                >
                  {selected.name}
                </button>
                {currentPath.split("/").filter(Boolean).map((part, i, arr) => (
                  <span key={`${part}-${i}`} className="flex min-w-0 items-center gap-1">
                    <ChevronRight size={11} />
                    {i === arr.length - 1 ? (
                      <span className="max-w-64 truncate px-1 py-0.5 text-fg" title={part} aria-current="page">{part}</span>
                    ) : (
                      <button type="button" onClick={() => openBreadcrumb(arr, i)} title={arr.slice(0, i + 1).join("/")} className="max-w-64 truncate rounded px-1 py-0.5 hover:text-fg">
                        {part}
                      </button>
                    )}
                  </span>
                ))}
              </nav>
              <Button type="button" variant="ghost" size="sm" onClick={() => openServerPanel(selected)} className="ml-auto">
                <ServerIcon size={12} /> Servers
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {currentPath && (
                <button type="button" onClick={goUp} className="mb-1 flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-muted hover:bg-white/5 hover:text-fg">
                  ..
                </button>
              )}
              {files.map((f) => (
                <div
                  key={f.name}
                  onClick={() => f.type === "directory" && openDir(f.name)}
                  className={`flex items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors ${
                    f.type === "directory" ? "cursor-pointer text-fg hover:bg-white/5" : "cursor-default text-muted"
                  }`}
                >
                  {f.type === "directory" ? <Folder size={14} className="shrink-0 text-mint" /> : <File size={14} className="shrink-0" />}
                  <span>{f.name}</span>
                  {f.type === "file" && <span className="ml-auto text-xs text-muted">{f.size ? `${(f.size / 1024).toFixed(1)}KB` : ""}</span>}
                </div>
              ))}
              {files.length === 0 && <p className="px-3 text-xs text-muted">Empty directory</p>}
            </div>
          </>
        )}
      <ConfirmDialog
        open={confirm?.kind === "project"}
        onClose={() => setConfirm(null)}
        title="Delete project?"
        description="This removes the project and its associations. This action cannot be undone."
        confirmLabel="Delete project"
        tone="danger"
        onConfirm={confirmDeleteProject}
      />
      <ConfirmDialog
        open={confirm?.kind === "link"}
        onClose={() => setConfirm(null)}
        title="Unlink server?"
        description="The project will no longer use this server connection."
        confirmLabel="Unlink server"
        tone="danger"
        onConfirm={confirmUnlinkServer}
      />
      </div>
    </div>
  );
}
