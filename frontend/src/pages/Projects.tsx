import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Archive, ChevronRight, Eye, File, FileImage, FileText, Folder, Plus, Server as ServerIcon, Link2, Unlink, Settings, Pencil, Trash2 } from "lucide-react";
import { api } from "../api/client";
import { useProjectScope } from "../context/ProjectScope";
import { Button, Combobox, ConfirmDialog, Dialog, Drawer, Field, Input, Select } from "../components/ui";
import { AppPageFrame } from "../components/shell/AppPageFrame";

type Project = { id: number; name: string; description?: string };
type FileTarget = { linkId: number; path?: string; server: string; instance?: string; environment?: string };
type FileEntry = { name: string; type?: string; size?: number; modifiedAt?: string; target?: FileTarget; targetInherited?: boolean };
type FilePreview = { path: string; name?: string; content: string; size: number; modifiedAt: string; truncated: boolean };
type PreviewKind = "text" | "image" | "archive";
type PreviewMeta = { size?: number; modifiedAt?: string };
type ArchiveEntry = { path: string; size: number; type: "file" | "directory" };
type ArchivePreview = { path: string; name?: string; size: number; modifiedAt: string; entries: ArchiveEntry[] };
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
  const raw = record.target as Partial<FileTarget> | undefined;
  const target = raw && typeof raw.linkId === "number" && typeof raw.server === "string"
    ? { linkId: raw.linkId, path: optionalString(raw.path), server: raw.server, instance: optionalString(raw.instance), environment: optionalString(raw.environment) }
    : undefined;
  return { name: value.name, target, targetInherited: record.targetInherited === true, type: optionalString(record.type), size: optionalNumber(record.size), modifiedAt: optionalString(record.modifiedAt) };
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
    limsInstanceId: record.limsInstanceId === null ? null : optionalNumber(record.limsInstanceId),
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

const IMAGE_EXTENSIONS: Record<string, true> = { png: true, jpg: true, jpeg: true, gif: true, webp: true, svg: true, bmp: true, ico: true, avif: true };

function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function previewKindFor(path: string): PreviewKind {
  const extension = fileExtension(path);
  if (IMAGE_EXTENSIONS[extension]) return "image";
  if (extension === "zip") return "archive";
  return "text";
}

function formatBytes(value?: number): string {
  if (value === undefined) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function previewKindLabel(kind: PreviewKind): string {
  return kind === "image" ? "Image" : kind === "archive" ? "ZIP archive" : "Text document";
}

function previewIcon(kind: PreviewKind) {
  return kind === "image" ? <FileImage size={14} aria-hidden="true" /> : kind === "archive" ? <Archive size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />;
}

function filePreviewDetails(size?: number, modifiedAt?: string): string {
  return [
    size === undefined ? "" : `${size.toLocaleString()} bytes`,
    formatDate(modifiedAt) ? `modified ${formatDate(modifiedAt)}` : "",
  ].filter(Boolean).join(" · ");
}

export default function ProjectsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { projects, selectedProject: selected, refresh: refreshScope, loading: projectsLoading, error: projectsError } = useProjectScope();
  const params = new URLSearchParams(location.search);
  const currentPath = params.get("path") ?? "";
  const showServers = params.get("view") === "servers";
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [error, setError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [previewPath, setPreviewPath] = useState("");
  const [previewData, setPreviewData] = useState<FilePreview | null>(null);
  const [previewKind, setPreviewKind] = useState<PreviewKind>("text");
  const [previewMeta, setPreviewMeta] = useState<PreviewMeta>({});
  const [previewImageUrl, setPreviewImageUrl] = useState("");
  const [archiveData, setArchiveData] = useState<ArchivePreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ path: string; name: string } | null>(null);
  const [renameName, setRenameName] = useState("");
  const [fileBusy, setFileBusy] = useState(false);
  const [deleteFileTarget, setDeleteFileTarget] = useState<{ path: string; name: string; type?: string } | null>(null);

  // Server association
  const [targetEditor, setTargetEditor] = useState<{ path: string; linkId: string; original?: FileTarget; inherited?: boolean }>();
  const [fallback, setFallback] = useState<FileTarget | null | "unknown" | "loading">(null);
  const targetLock = useRef(false);
  const [targetOptions, setTargetOptions] = useState<ProjectServer[]>();
  const [targetError, setTargetError] = useState("");
  const [targetSaving, setTargetSaving] = useState(false);
  const targetRequest = useRef(0);
  const [linkedServers, setLinkedServers] = useState<ProjectServer[]>([]);
  const [allServers, setAllServers] = useState<Server[]>([]);
  const [availableInstances, setAvailableInstances] = useState<Instance[]>([]);
  const [linkForm, setLinkForm] = useState({ serverId: "", limsInstanceId: "", remotePath: "", environment: "production", connectionMode: "ssh" });
  const [editingLinkId, setEditingLinkId] = useState<number | null>(null);
  const [linkError, setLinkError] = useState("");
  const previewRequest = useRef(0);
  const filesRequest = useRef(0);

  useEffect(() => () => {
    if (previewImageUrl) URL.revokeObjectURL(previewImageUrl);
  }, [previewImageUrl]);

  useEffect(() => {
    let active = true;
    api.listServers().then((r) => { if (active) setAllServers(serversFrom(r)); }).catch((err: unknown) => { if (active) setWorkspaceError(err instanceof Error ? err.message : "Unable to load servers"); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (new URLSearchParams(location.search).get("create") === "1") setShowCreate(true);
  }, [location.search]);

  const pathFor = (name: string) => currentPath ? `${currentPath}/${name}` : name;
  const refreshFiles = async (projectId: number, path: string) => {
    const request = ++filesRequest.current;
    setFilesLoading(true); setFiles([]); setWorkspaceError("");
    try {
      const r = await api.listFiles(projectId, path);
      if (request === filesRequest.current) setFiles(filesFrom(r));
    } catch (err: unknown) {
      if (request === filesRequest.current) setWorkspaceError(err instanceof Error ? err.message : "Unable to load project files");
    } finally {
      if (request === filesRequest.current) setFilesLoading(false);
    }
  };

  const closePreview = () => {
    previewRequest.current += 1;
    setPreviewPath("");
    setPreviewData(null);
    setArchiveData(null);
    setPreviewImageUrl("");
    setPreviewError("");
    setPreviewMeta({});
    setPreviewLoading(false);
  };

  function openLocation(projectId: number, path = "", view?: "servers") {
    const next = new URLSearchParams({ project: String(projectId) });
    if (path) next.set("path", path);
    if (view) next.set("view", view);
    if (next.toString() !== params.toString()) navigate("/projects?" + next.toString());
  }

  const openProject = (project: Project) => openLocation(project.id);

  useLayoutEffect(() => {
    closePreview();
    closeTargetEditor();
    setRenameTarget(null);
    setDeleteFileTarget(null);
    setConfirm(null);
    if (selected && !showServers) void refreshFiles(selected.id, currentPath);
    return () => { filesRequest.current += 1; previewRequest.current += 1; targetRequest.current += 1; };
  }, [selected?.id, currentPath, showServers]);

  const openDir = (name: string) => { if (selected) openLocation(selected.id, pathFor(name)); };
  const goUp = () => {
    if (selected) openLocation(selected.id, currentPath.split("/").slice(0, -1).join("/"));
  };
  const openBreadcrumb = (parts: string[], index: number) => {
    if (selected) openLocation(selected.id, parts.slice(0, index + 1).join("/"));
  };

  const openPreview = async (path: string, entry?: FileEntry) => {
    if (!selected) return;
    const kind = previewKindFor(path);
    const requestId = ++previewRequest.current;
    setPreviewPath(path);
    setPreviewData(null);
    setArchiveData(null);
    setPreviewImageUrl("");
    setPreviewError("");
    setPreviewKind(kind);
    setPreviewMeta({ size: entry?.size, modifiedAt: entry?.modifiedAt });
    setPreviewLoading(true);
    setWorkspaceError("");
    try {
      if (kind === "image") {
        const blob = await api.previewImage(selected.id, path);
        const url = URL.createObjectURL(blob);
        if (requestId !== previewRequest.current) {
          URL.revokeObjectURL(url);
          return;
        }
        setPreviewImageUrl(url);
      } else if (kind === "archive") {
        const archive = await api.previewArchive(selected.id, path);
        if (requestId === previewRequest.current) setArchiveData(archive);
      } else {
        const text = await api.previewFile(selected.id, path);
        if (requestId === previewRequest.current) setPreviewData(text);
      }
    } catch (err: unknown) {
      if (requestId === previewRequest.current) setPreviewError(err instanceof Error ? err.message : "Unable to preview file");
    } finally {
      if (requestId === previewRequest.current) setPreviewLoading(false);
    }
  };

  const submitRename = async () => {
    if (!selected || !renameTarget || !renameName.trim()) return;
    const request = filesRequest.current;
    setFileBusy(true); setWorkspaceError("");
    try { await api.renameFile(selected.id, renameTarget.path, renameName.trim()); if (request !== filesRequest.current) return; setRenameTarget(null); await refreshFiles(selected.id, currentPath); }
    catch (err: unknown) { if (request === filesRequest.current) setWorkspaceError(err instanceof Error ? err.message : "Unable to rename item"); }
    finally { setFileBusy(false); }
  };

  const confirmDeleteFile = async () => {
    if (!selected || !deleteFileTarget) return;
    const request = filesRequest.current;
    setFileBusy(true); setWorkspaceError("");
    try { await api.deleteFile(selected.id, deleteFileTarget.path); if (request !== filesRequest.current) return; setDeleteFileTarget(null); await refreshFiles(selected.id, currentPath); }
    catch (err: unknown) { if (request === filesRequest.current) setWorkspaceError(err instanceof Error ? err.message : "Unable to delete item"); }
    finally { setFileBusy(false); }
  };

  const createProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const r = await api.createProject(newName, newDesc);
      const project = projectFrom(typeof r === "object" && r !== null && "project" in r ? r.project : null);
      if (!project) throw new Error("The server returned an invalid project.");
      refreshScope();
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
    refreshScope();
    setConfirm(null);
  };

  function closeTargetEditor() {
    targetRequest.current += 1;
    setTargetEditor(undefined);
  }

  async function editFileTarget(file: FileEntry) {
    if (!selected || targetLock.current) return;
    const request = ++targetRequest.current;
    setTargetEditor({ path: pathFor(file.name), linkId: file.target && !file.targetInherited ? String(file.target.linkId) : "", original: file.target, inherited: file.targetInherited });
    setFallback(file.targetInherited ? file.target ?? null : currentPath && file.target ? "loading" : null);
    setTargetOptions(undefined);
    setTargetError("");
    if (currentPath && file.target && !file.targetInherited) {
      const parts = currentPath.split("/");
      const parentName = parts.pop();
      void api.listFiles(selected.id, parts.join("/")).then((result) => {
        if (request !== targetRequest.current) return;
        const parent = filesFrom(result).find((item) => item.name === parentName);
        setFallback(parent ? parent.target ?? null : "unknown");
      }).catch(() => { if (request === targetRequest.current) setFallback("unknown"); });
    }
    try {
      const result = await api.listProjectServers(selected.id);
      if (request === targetRequest.current) setTargetOptions(projectServersFrom(result));
    } catch {
      if (request === targetRequest.current) setTargetError("Could not load the project's server links.");
    }
  }

  async function saveFileTarget(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !targetEditor || !targetOptions || targetLock.current) return;
    const revision = targetRequest.current;
    targetLock.current = true;
    setTargetSaving(true);
    setTargetError("");
    try {
      await api.setProjectFileTarget(selected.id, targetEditor.path, targetEditor.linkId ? Number(targetEditor.linkId) : null);
      if (revision === targetRequest.current) {
        closeTargetEditor();
        await refreshFiles(selected.id, currentPath);
      }
    } catch (error) {
      if (revision === targetRequest.current) setTargetError(error instanceof Error ? error.message : "Could not save the target.");
    } finally { targetLock.current = false; setTargetSaving(false); }
  }
  const chosenTarget = targetOptions?.find((option) => String(option.id) === targetEditor?.linkId);
  const linkLabel = (link: ProjectServer) => [link.limsInstanceName ?? "No instance", link.environment].filter(Boolean).join(" / ");
  const effectiveLabel = (target: FileTarget | null | "unknown" | "loading" | undefined) =>
    target === "loading" ? "Checking parent target..." : target === "unknown" ? "Parent target unknown" : target
      ? [target.server, target.instance ?? "No instance", target.environment].filter(Boolean).join(" / ") : "No target assigned";

  const openServerPanel = (project: Project) => openLocation(project.id, "", "servers");

  const linksRequest = useRef(0);
  const instancesRequest = useRef(0);
  const linkLock = useRef(false);
  const [linksLoading, setLinksLoading] = useState(false);
  const [instancesLoading, setInstancesLoading] = useState(false);
  const [linksError, setLinksError] = useState("");
  const [linkSaving, setLinkSaving] = useState(false);
  const [linkLoadAttempt, setLinkLoadAttempt] = useState(0);

  useLayoutEffect(() => {
    const request = ++linksRequest.current;
    instancesRequest.current += 1;
    setLinkedServers([]);
    setAvailableInstances([]);
    setLinkError("");
    setLinksError("");
    setLinksLoading(false);
    setInstancesLoading(false);
    setEditingLinkId(null);
    setLinkForm({ serverId: "", limsInstanceId: "", remotePath: "", environment: "production", connectionMode: "ssh" });
    if (selected && showServers) {
      setLinksLoading(true);
      api.listProjectServers(selected.id)
        .then((result) => { if (request === linksRequest.current) setLinkedServers(projectServersFrom(result)); })
        .catch(() => { if (request === linksRequest.current) setLinksError("Could not load server links."); })
        .finally(() => { if (request === linksRequest.current) setLinksLoading(false); });
    }
    return () => { linksRequest.current += 1; instancesRequest.current += 1; };
  }, [selected?.id, showServers, linkLoadAttempt]);

  async function loadLinkInstances(serverId: number) {
    const request = ++instancesRequest.current;
    setAvailableInstances([]);
    setInstancesLoading(true);
    try {
      const result = await api.listInstances(serverId);
      if (request === instancesRequest.current) setAvailableInstances(instancesFrom(result));
    } catch {
      if (request === instancesRequest.current) setLinkError("Could not load instances for this server.");
    } finally {
      if (request === instancesRequest.current) setInstancesLoading(false);
    }
  }

  const linkServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || linkLock.current || instancesLoading || linksLoading || linksError) return;
    const request = linksRequest.current;
    const projectId = selected.id;
    setLinkError("");
    if (!linkForm.serverId || (linkForm.connectionMode === "ssh" && !linkForm.remotePath)) {
      setLinkError(linkForm.connectionMode === "ssh" ? "Select a server and enter remote path" : "Select a server");
      return;
    }
    linkLock.current = true;
    setLinkSaving(true);
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
      if (request === linksRequest.current) setLinkLoadAttempt((value) => value + 1);
    } catch (err: unknown) {
      if (request === linksRequest.current) setLinkError(err instanceof Error ? err.message : "Unable to link server");
    } finally {
      linkLock.current = false;
      setLinkSaving(false);
    }
  };

  const unlinkServer = async (linkId: number) => {
    setConfirm({ kind: "link", id: linkId });
  };

  const confirmUnlinkServer = async () => {
    if (!confirm || confirm.kind !== "link" || !selected) return;
    const request = linksRequest.current;
    await api.unlinkServer(selected.id, confirm.id);
    if (request !== linksRequest.current) return;
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
    await loadLinkInstances(link.serverId);
  };

  const cancelEditServerLink = () => {
    instancesRequest.current += 1;
    setInstancesLoading(false);
    setEditingLinkId(null);
    setLinkError("");
    setLinkForm({ serverId: "", limsInstanceId: "", remotePath: "", environment: "production", connectionMode: "ssh" });
    setAvailableInstances([]);
  };


  return (
    <AppPageFrame variant="wide" className="app-page-frame-workspace">
      {(workspaceError || projectsError) && <p className="mb-3 rounded-[10px] border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-coral" role="alert">{workspaceError || projectsError}</p>}
      <div className="app-workspace-panel flex min-h-0 flex-1">
      <aside className="app-project-sidebar flex flex-col border-r border-line">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-display text-sm font-medium text-fg">Your projects</h2>
          <button type="button" onClick={() => setShowCreate(true)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded text-muted transition-colors hover:text-mint" aria-label="Create project">
            <Plus size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto p-2">
          {projects.map((p) => (
            <div
              key={p.id}
              className={`group flex items-center justify-between rounded-ctl px-2 py-1 text-sm transition-colors ${
                selected?.id === p.id && !showServers ? "bg-white/10 text-fg" : "text-muted hover:bg-white/5 hover:text-fg"
              }`}
            >
              <button type="button" onClick={() => openProject(p)} aria-current={selected?.id === p.id && !showServers ? "page" : undefined} className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded px-1 text-left">
                <Folder size={14} className="shrink-0" />
                <span className="truncate">{p.name}</span>
              </button>
              <div className="hidden items-center gap-1 group-hover:flex group-focus-within:flex max-sm:flex">
                <button type="button" onClick={() => openServerPanel(p)} className="inline-flex min-h-9 min-w-9 items-center justify-center rounded text-muted hover:text-mint" title="Manage servers" aria-label={`Manage servers for ${p.name}`}>
                  <Settings size={13} />
                </button>
                <button type="button" onClick={() => deleteProject(p.id)} className="inline-flex min-h-9 min-w-9 items-center justify-center rounded text-muted hover:text-coral" aria-label={`Delete ${p.name}`}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
          {projectsLoading ? <p className="px-3 py-2 text-xs text-muted" role="status">Loading projects…</p> : projects.length === 0 && !workspaceError && <p className="px-3 py-2 text-xs text-muted">No projects yet.</p>}
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
          <div className="project-start"><div className="project-start-icon"><Folder size={28} /></div><h2>{projects.length ? "Select a project" : "No projects yet"}</h2><p>{projects.length ? "Open a project to browse files and manage its runtime links." : "Create a project to start organizing files and runtime links."}</p>{!projectsLoading && !workspaceError && <Button variant="ghost" onClick={() => projects.length ? openProject(projects[0]) : setShowCreate(true)}>{projects.length ? "Open a project" : "Create a project"}<ChevronRight size={15} /></Button>}</div>
        ) : showServers ? (
          /* Server association panel */
          <div className="max-w-2xl flex-1 overflow-y-auto p-6">

            <div className="mb-6 flex items-center gap-2">
              <ServerIcon size={16} className="text-mint" />
              <h2 className="font-display text-[22px] font-semibold text-fg">Servers for {selected.name}</h2>
              <Button type="button" variant="ghost" size="sm" onClick={() => selected && openProject(selected)} className="ml-auto">
                Back to files
              </Button>
            </div>

            <div className="mb-6 space-y-2">
              {linksLoading && <p role="status">Loading server links...</p>}
              {linksError && <p role="alert">{linksError} <Button variant="ghost" onClick={() => setLinkLoadAttempt((value) => value + 1)}>Retry</Button></p>}
              {!linksLoading && !linksError && linkedServers.length === 0 && <p className="text-sm text-muted">No servers linked yet.</p>}
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
                      if (server) void loadLinkInstances(server.id);
                      else { instancesRequest.current += 1; setInstancesLoading(false); }
                    }}
                  >
                    <option value="">Select server…</option>
                    {allServers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name} ({(s.connectionMode ?? "ssh") === "agent" ? s.agentId : s.host})</option>
                    ))}
                  </Select>
                </Field>
                <Field label="LIMS instance" hint={instancesLoading ? "Loading instances..." : linkForm.serverId && availableInstances.length === 0 ? "No confirmed instances on this server. Scan and import one from LIMS Instances." : undefined}>
                  <Select value={linkForm.limsInstanceId} onChange={(e) => setLinkForm((f) => ({ ...f, limsInstanceId: e.target.value }))} disabled={!linkForm.serverId || instancesLoading}>
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

            <div className="ui-detail-layout flex-1">
            <div className="flex-1 overflow-y-auto p-4">
              {currentPath && (
                <button type="button" onClick={goUp} className="mb-1 flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-muted hover:bg-white/5 hover:text-fg">
                  ..
                </button>
              )}
              {files.map((f) => (
                <div key={f.name} className="group flex items-center gap-2 rounded px-1 py-0.5 text-sm">
                  <button
                    type="button"
                    onClick={() => f.type === "directory" ? void openDir(f.name) : void openPreview(pathFor(f.name), f)}
                    className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left transition-colors ${
                      f.type === "directory" ? "text-fg hover:bg-white/5" : "text-muted hover:bg-white/5 hover:text-fg"
                    }`}
                    aria-label={`${f.type === "directory" ? "Open folder" : "Preview"} ${f.name}`}
                  >
                    {f.type === "directory" ? <Folder size={14} className="shrink-0 text-mint" /> : <File size={14} className="shrink-0" />}
                                        <span className="min-w-0 flex-1">
                      <span className="block truncate" title={f.name}>{f.name}</span>
                      <span className="block break-words text-xs text-muted">
                        {f.target ? [f.target.server, f.target.instance ?? "No instance", f.target.environment, f.targetInherited ? "Inherited" : ""].filter(Boolean).join(" · ") : "No target assigned"}
                      </span>
                    </span>
                    {f.type === "file" && <span className="shrink-0 text-xs text-muted">{formatBytes(f.size)}</span>}
                  </button>
                  <span className="flex shrink-0 items-center gap-1">
                    <button type="button" className="inline-flex min-h-9 min-w-9 items-center justify-center rounded text-muted hover:text-mint" onClick={() => void editFileTarget(f)} title="Assign target" aria-label={`Assign target for ${f.name}`}><Link2 size={14} /></button>
                    {f.type === "file" && <button type="button" className="inline-flex min-h-9 min-w-9 items-center justify-center rounded text-muted hover:bg-white/10 hover:text-mint" onClick={() => void openPreview(pathFor(f.name), f)} title={`Preview ${f.name}`} aria-label={`Preview ${f.name}`}><Eye size={14} /></button>}
                    <button type="button" className="inline-flex min-h-9 min-w-9 items-center justify-center rounded text-muted hover:bg-white/10 hover:text-mint" onClick={() => { setRenameTarget({ path: pathFor(f.name), name: f.name }); setRenameName(f.name); }} title={`Rename ${f.name}`} aria-label={`Rename ${f.name}`}><Pencil size={14} /></button>
                    <button type="button" className="inline-flex min-h-9 min-w-9 items-center justify-center rounded text-muted hover:bg-coral/10 hover:text-coral" onClick={() => { setDeleteFileTarget({ path: pathFor(f.name), name: f.name, type: f.type }); }} title={`Delete ${f.name}`} aria-label={`Delete ${f.name}`}><Trash2 size={14} /></button>
                  </span>
                </div>
              ))}
              {filesLoading ? <p className="px-3 text-xs text-muted" role="status">Loading files…</p> : files.length === 0 && !workspaceError && <p className="px-3 text-xs text-muted">Empty directory</p>}
            </div>
              <Drawer presentation="responsive" open={!!targetEditor} onClose={closeTargetEditor} busy={targetSaving}
                title="Assign server target" description={selected ? selected.name + " / " + targetEditor?.path : undefined}>
                {targetEditor && <form onSubmit={saveFileTarget} className="space-y-4">
                  {targetError && <p role="alert" className="text-sm text-coral">{targetError}</p>}
                  {!targetOptions && !targetError && <p role="status">Loading linked targets...</p>}
                  {targetOptions && <Combobox label="Server and instance" value={targetEditor.linkId} disabled={targetSaving}
                    onChange={(linkId) => setTargetEditor({ ...targetEditor, linkId })}
                    options={[{ value: "", label: "Use parent assignment" }, ...[...targetOptions]
                      .sort((a, b) => (a.serverName ?? "").localeCompare(b.serverName ?? ""))
                      .map((link) => ({ value: String(link.id), group: link.serverName ?? String(link.serverId), label: linkLabel(link) }))]} />}
                  <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    <div><dt className="text-muted">Current target</dt><dd>{effectiveLabel(targetEditor.original)}</dd>
                      {targetEditor.original && <small>{targetEditor.inherited ? "Inherited from " + (targetEditor.original.path ?? "unknown folder") : "Explicit assignment"}</small>}</div>
                    <div><dt className="text-muted">After saving</dt><dd>{chosenTarget ? (chosenTarget.serverName ?? chosenTarget.serverId) + " / " + linkLabel(chosenTarget) : effectiveLabel(fallback)}</dd>
                      <small>{chosenTarget ? "Explicit assignment" : fallback && typeof fallback === "object" ? "Inherited from " + (fallback.path ?? "unknown folder") : ""}</small></div>
                  </dl>
                  {chosenTarget?.environment?.toLowerCase() === "production" && <p className="text-sm text-sun">This assignment targets production.</p>}
                  {targetOptions?.length === 0 && selected && <Button type="button" variant="ghost" onClick={() => openServerPanel(selected)}>Manage project server links</Button>}
                  <Button type="submit" variant="primary" loading={targetSaving} disabled={!targetOptions || fallback === "loading"}>Save assignment</Button>
                </form>}
              </Drawer>
            </div>
          </>
        )}
      <ConfirmDialog
        open={confirm?.kind === "project"}
        onClose={() => setConfirm(null)}
        title={"Delete " + (projects.find((project) => project.id === confirm?.id)?.name ?? "project") + "?"}
        description="This removes the project and its associations. This action cannot be undone."
        confirmLabel="Delete project"
        tone="danger"
        onConfirm={confirmDeleteProject}
      />
      <ConfirmDialog
        open={confirm?.kind === "link"}
        onClose={() => setConfirm(null)}
        title={"Unlink server from " + (selected?.name ?? "project") + "?"}
        description="The project will no longer use this server connection."
        confirmLabel="Unlink server"
        tone="danger"
        onConfirm={confirmUnlinkServer}
      />
      <Dialog
        open={Boolean(previewPath)}
        onClose={closePreview}
        title={previewData?.name ?? archiveData?.name ?? previewPath.split(/[\\/]/).pop() ?? "File preview"}
        description={
          previewLoading
            ? `Loading ${previewKindLabel(previewKind).toLowerCase()}…`
            : previewError
              ? "Preview unavailable"
              : filePreviewDetails(
                previewData?.size ?? archiveData?.size ?? previewMeta.size,
                previewData?.modifiedAt ?? archiveData?.modifiedAt ?? previewMeta.modifiedAt,
              ) || `${previewKindLabel(previewKind)} preview`
        }
        wide
        busy={previewLoading}
        className="ui-file-preview-dialog"
        footer={<Button variant="ghost" disabled={previewLoading} onClick={closePreview}>Close</Button>}
      >
        {previewLoading ? (
          <div className="ui-file-preview-state" role="status">
            <span className="ui-spinner" aria-hidden="true" />
            <p>Opening a safe, read-only preview…</p>
          </div>
        ) : previewError ? (
          <div className="ui-file-preview-state ui-file-preview-state-error" role="alert">
            <p>We could not render this item.</p>
            <span>{previewError}</span>
          </div>
        ) : previewKind === "image" && previewImageUrl ? (
          <div className="ui-file-preview-stack">
            <div className="ui-file-preview-toolbar">
              <span className="ui-file-preview-type">{previewIcon(previewKind)}{previewKindLabel(previewKind)}</span>
              <span>Fit to window</span>
            </div>
            <div className="ui-file-preview-image-stage">
              <img src={previewImageUrl} alt={`Preview of ${previewData?.name ?? previewPath.split(/[\\/]/).pop() ?? "image"}`} onError={() => setPreviewError("The image format could not be rendered by this browser.")} />
            </div>
          </div>
        ) : previewKind === "archive" && archiveData ? (
          <div className="ui-file-preview-stack">
            <div className="ui-file-preview-toolbar">
              <span className="ui-file-preview-type">{previewIcon(previewKind)}{previewKindLabel(previewKind)}</span>
              <span>{archiveData.entries.length.toLocaleString()} entries</span>
            </div>
            <div className="ui-archive-list" role="list">
              {archiveData.entries.length === 0 ? <p className="ui-file-preview-empty">This ZIP archive is empty.</p> : archiveData.entries.map((entry) => (
                <div key={`${entry.path}-${entry.type}`} className="ui-archive-entry" role="listitem">
                  <span className="ui-archive-entry-name">
                    {entry.type === "directory" ? <Folder size={14} className="shrink-0 text-mint" aria-hidden="true" /> : <File size={14} className="shrink-0 text-muted" aria-hidden="true" />}
                    <span title={entry.path}>{entry.path}</span>
                  </span>
                  <span className="ui-archive-entry-size">{entry.type === "directory" ? "Folder" : formatBytes(entry.size)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : previewData ? (
          <div className="ui-file-preview-stack">
            <div className="ui-file-preview-toolbar">
              <span className="ui-file-preview-type">{previewIcon(previewKind)}{previewKindLabel(previewKind)}</span>
              {previewData.truncated && <span>Preview truncated</span>}
            </div>
            <pre className="ui-file-preview-code">{previewData.content || "(empty file)"}</pre>
          </div>
        ) : null}
      </Dialog>
      <Dialog
        open={Boolean(renameTarget)}
        onClose={() => { if (!fileBusy) setRenameTarget(null); }}
        title={`Rename ${renameTarget?.name ?? "item"}`} description={selected && renameTarget ? selected.name + " / " + renameTarget.path : undefined}
        busy={fileBusy}
        footer={<><Button type="button" variant="ghost" disabled={fileBusy} onClick={() => setRenameTarget(null)}>Cancel</Button><Button type="submit" form="rename-file-form" loading={fileBusy}>Save name</Button></>}
      >
        <form id="rename-file-form" onSubmit={(event) => { event.preventDefault(); void submitRename(); }} className="space-y-3"><Field label="New name" required><Input autoFocus value={renameName} onChange={(event) => setRenameName(event.target.value)} required /></Field></form>
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleteFileTarget)}
        onClose={() => { if (!fileBusy) setDeleteFileTarget(null); }}
        title={`Delete ${deleteFileTarget?.type === "directory" ? "folder" : "file"}?`}
        description={selected && deleteFileTarget ? "Delete " + selected.name + " / " + deleteFileTarget.path + (deleteFileTarget.type === "directory" ? " and everything inside it?" : "?") : undefined}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={confirmDeleteFile}
      />
      </div>
      </div>
    </AppPageFrame>
  );
}
