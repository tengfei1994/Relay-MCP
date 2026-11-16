import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CircleAlert, File, Folder, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useProjectScope } from "../context/ProjectScope";
import { AppPageFrame } from "../components/shell/AppPageFrame";
import { useAuth } from "../App";
import "./console-overview.css";

type Project = { id: number; name: string; description?: string; createdAt?: string };
type Server = { id: number; name: string; status?: string; connectionMode?: string };
type FileEntry = { name: string; path?: string; type?: string; size?: number; modifiedAt?: string };
type Health = { ok?: boolean; version?: string; commit?: string };

function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function number(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function projectsFrom(value: unknown): Project[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const row = record(item);
    return typeof row.id === "number" && typeof row.name === "string" ? [{ id: row.id, name: row.name, description: typeof row.description === "string" ? row.description : undefined, createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined }] : [];
  }) : [];
}
function serversFrom(value: unknown): Server[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const row = record(item);
    return typeof row.id === "number" && typeof row.name === "string" ? [{ id: row.id, name: row.name, status: typeof row.status === "string" ? row.status : undefined, connectionMode: typeof row.connectionMode === "string" ? row.connectionMode : undefined }] : [];
  }) : [];
}
function filesFrom(value: unknown): FileEntry[] {
  const payload = record(value);
  return Array.isArray(payload.entries) ? payload.entries.flatMap((item) => {
    const row = record(item);
    return typeof row.name === "string" ? [{ name: row.name, type: typeof row.type === "string" ? row.type : undefined, size: typeof row.size === "number" ? row.size : undefined, modifiedAt: typeof row.modifiedAt === "string" ? row.modifiedAt : undefined }] : [];
  }) : [];
}
async function collectProjectEntries(projectId: number, path = "", depth = 2): Promise<FileEntry[]> {
  try {
    const entries = filesFrom(await api.listFiles(projectId, path)).map((entry) => ({ ...entry, path: path ? `${path}/${entry.name}` : entry.name }));
    if (depth <= 0) return entries;
    const directories = entries.filter((entry) => entry.type === "directory").slice(0, 24);
    const nested = await Promise.all(directories.map((entry) => collectProjectEntries(projectId, entry.path ?? entry.name, depth - 1)));
    return [...entries, ...nested.flat()].slice(0, 240);
  } catch {
    return [];
  }
}
function dateLabel(value?: string): string {
  if (!value) return "No file updates";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "No file updates" : date.toLocaleString();
}
function bytesLabel(value?: number): string {
  if (value === undefined) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function WorkspaceOverview() {
  const { projects: scopedProjects } = useProjectScope();
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [health, setHealth] = useState<Health>();
  const [memoryCount, setMemoryCount] = useState<number>();
  const [fileEntries, setFileEntries] = useState<Record<number, FileEntry[]>>({});
  const [loading, setLoading] = useState(true);
  const [filesLoading, setFilesLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    const [projectResult, serverResult, healthResult, memoryResult] = await Promise.allSettled([
      api.listProjects(),
      api.listServers(),
      api.health(),
      user?.knowledgeEnabled ? api.knowledgeConfirmedMemories(undefined, { limit: 1, offset: 0 }) : Promise.resolve(undefined),
    ]);
    if (projectResult.status === "fulfilled") setProjects(projectsFrom(projectResult.value.projects)); else setError("Projects are unavailable. Try again.");
    if (serverResult.status === "fulfilled") setServers(serversFrom(serverResult.value.servers));
    if (healthResult.status === "fulfilled") setHealth(healthResult.value);
    if (memoryResult.status === "fulfilled") setMemoryCount(number(record(record(memoryResult.value).page).total, 0)); else setMemoryCount(undefined);
    setLoading(false);
  };

  useEffect(() => { void load(); }, [user?.knowledgeEnabled]);
  useEffect(() => {
    let active = true;
    const visible = projects.length ? projects : scopedProjects as Project[];
    if (!visible.length) {
      setFileEntries({});
      setFilesLoading(false);
      return () => { active = false; };
    }
    setFilesLoading(true);
    Promise.all(visible.map(async (project) => [project.id, await collectProjectEntries(project.id)] as const)).then((entries) => {
      if (!active) return;
      setFileEntries(Object.fromEntries(entries));
    }).finally(() => { if (active) setFilesLoading(false); });
    return () => { active = false; };
  }, [projects, scopedProjects]);
  useEffect(() => { const previous = document.title; document.title = "Relay MCP — Workspace overview"; return () => { document.title = previous; }; }, []);

  const visibleProjects = projects.length ? projects : scopedProjects as Project[];
  const runtimeCount = servers.filter((server) => !server.status || !/disabled|failed|offline/i.test(server.status)).length;
  const workspaceState = loading ? "loading" : error ? "attention" : health?.ok === false ? "degraded" : "nominal";
  const fileActivity = useMemo(() => visibleProjects.flatMap((project) => (fileEntries[project.id] ?? [])
    .filter((entry) => entry.type === "file")
      .map((entry) => ({ ...entry, projectId: project.id, projectName: project.name })))
    .sort((left, right) => String(right.modifiedAt ?? "").localeCompare(String(left.modifiedAt ?? "")))
    .slice(0, 8), [fileEntries, visibleProjects]);

  return <AppPageFrame variant="wide" className="workspace-overview-page">
    <div className="workspace-overview-toolbar">
      <div className="workspace-overview-toolbar-copy"><span>Workspace</span><strong>Project overview</strong></div>
      <div className="workspace-overview-toolbar-actions"><button type="button" className="workspace-refresh" onClick={() => void load()} disabled={loading}><RefreshCw size={14} className={loading ? "preview-spin" : ""} /> Refresh</button><Link className="preview-primary-action" to="/projects">Open project manager <ArrowRight size={15} aria-hidden="true" /></Link></div>
    </div>
    {error && <div className="preview-inline-error" role="alert"><CircleAlert size={15} aria-hidden="true" />{error}<button type="button" onClick={() => void load()}>Retry</button></div>}
    <section className="workspace-signals" aria-label="Workspace status"><div><span>projects</span><strong>{loading ? "—" : String(visibleProjects.length).padStart(2, "0")} <small>authorized</small></strong></div><div><span>active runtimes</span><strong>{loading ? "—" : String(runtimeCount).padStart(2, "0")} <small>reachable</small></strong></div><div><span>confirmed memory</span><strong>{memoryCount === undefined ? "—" : memoryCount} <small>{memoryCount === undefined ? "permission required" : "records"}</small></strong></div><div><span>system status</span><strong className={`preview-status-${workspaceState}`}>{workspaceState === "loading" ? "loading" : workspaceState} <small>{health?.version ?? "API"}</small></strong></div></section>

    <div className="workspace-management-grid">
      <section className="workspace-projects-panel" aria-label="Projects">
        <div className="workspace-section-head"><div><span>Projects</span><h1>Managed projects</h1></div><span>{visibleProjects.length} total</span></div>
        {visibleProjects.length ? <div className="workspace-project-list">{visibleProjects.map((project) => {
          const entries = fileEntries[project.id] ?? [];
          const files = entries.filter((entry) => entry.type === "file");
          const latest = files.slice().sort((left, right) => String(right.modifiedAt ?? "").localeCompare(String(left.modifiedAt ?? "")))[0];
          return <Link key={project.id} className="workspace-project-row" to="/projects"><span className="workspace-project-icon"><Folder size={16} aria-hidden="true" /></span><span className="workspace-project-copy"><strong>{project.name}</strong><small>{project.description || "No project description"}</small></span><span className="workspace-project-metric"><strong>{files.length}</strong><small>files</small></span><span className="workspace-project-updated"><strong>{filesLoading ? "Checking" : dateLabel(latest?.modifiedAt)}</strong><small>{latest?.path ?? (latest?.size === undefined ? "workspace" : bytesLabel(latest.size))}</small></span><ArrowRight size={15} aria-hidden="true" /></Link>;
        })}</div> : <div className="workspace-empty"><Folder size={18} aria-hidden="true" /><strong>No projects yet</strong><span>Create a project to start managing files and runtime links.</span><Link className="admin-button admin-button-primary" to="/projects?create=1">Create project</Link></div>}
      </section>

      <section className="workspace-activity-panel" aria-label="Project activity">
        <div className="workspace-section-head"><div><span>Project activity</span><h2>Recent file changes</h2></div><span>{fileActivity.length} shown</span></div>
        {filesLoading ? <div className="workspace-activity-empty">Checking project workspaces…</div> : fileActivity.length ? <div className="workspace-activity-list">{fileActivity.map((entry) => <div key={`${entry.projectId}:${entry.path ?? entry.name}`} className="workspace-activity-row"><span className="workspace-activity-icon"><File size={15} aria-hidden="true" /></span><span><strong>{entry.path ?? entry.name}</strong><small>{entry.projectName} · {dateLabel(entry.modifiedAt)}</small></span><code>{bytesLabel(entry.size) || "file"}</code></div>)}</div> : <div className="workspace-activity-empty"><File size={18} aria-hidden="true" /><span>No file changes found in the visible project workspaces.</span></div>}
      </section>
    </div>
  </AppPageFrame>;
}
