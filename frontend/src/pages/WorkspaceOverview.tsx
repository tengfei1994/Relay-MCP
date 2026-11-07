import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, CircleAlert, CircleDot, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useProjectScope } from "../context/ProjectScope";
import { AppPageFrame } from "../components/shell/AppPageFrame";
import { useAuth } from "../App";
import "./console-overview.css";

type Project = { id: number; name: string; description?: string };
type Server = { id: number; name: string; status?: string; connectionMode?: string };
type Health = { ok?: boolean; version?: string; commit?: string };

function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function text(value: unknown, fallback = "—"): string { return typeof value === "string" && value.trim() ? value : fallback; }
function number(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function projectsFrom(value: unknown): Project[] { return Array.isArray(value) ? value.flatMap((item) => { const row = record(item); return typeof row.id === "number" && typeof row.name === "string" ? [{ id: row.id, name: row.name, description: typeof row.description === "string" ? row.description : undefined }] : []; }) : []; }
function serversFrom(value: unknown): Server[] { return Array.isArray(value) ? value.flatMap((item) => { const row = record(item); return typeof row.id === "number" && typeof row.name === "string" ? [{ id: row.id, name: row.name, status: typeof row.status === "string" ? row.status : undefined, connectionMode: typeof row.connectionMode === "string" ? row.connectionMode : undefined }] : []; }) : []; }

export default function WorkspaceOverview() {
  const { projects: scopedProjects, selectedProject } = useProjectScope();
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [health, setHealth] = useState<Health>();
  const [memoryCount, setMemoryCount] = useState<number>();
  const [route, setRoute] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true); setError("");
    const [projectResult, serverResult, healthResult, memoryResult] = await Promise.allSettled([
      api.listProjects(), api.listServers(), api.health(), user?.knowledgeEnabled ? api.knowledgeConfirmedMemories(undefined, { limit: 1, offset: 0 }) : Promise.resolve(undefined),
    ]);
    if (projectResult.status === "fulfilled") setProjects(projectsFrom(projectResult.value.projects)); else setError("Projects are unavailable. Try again.");
    if (serverResult.status === "fulfilled") setServers(serversFrom(serverResult.value.servers));
    if (healthResult.status === "fulfilled") setHealth(healthResult.value);
    if (memoryResult.status === "fulfilled") setMemoryCount(number(record(memoryResult.value).page && record(memoryResult.value).page.total, 0)); else setMemoryCount(undefined);
    setLoading(false);
  };
  useEffect(() => { void load(); }, [user?.knowledgeEnabled]);

  const visibleProjects = projects.length ? projects : scopedProjects as Project[];
  const selectedName = selectedProject?.name ?? visibleProjects[0]?.name ?? "No project selected";
  const runtimeCount = servers.filter((server) => !server.status || !/disabled|failed|offline/i.test(server.status)).length;
  const routeLabels = ["intent / plan", "context / selected", "runtime / ready", "feedback / review"];
  const currentRoute = routeLabels[route];
  const currentProject = visibleProjects.find((project) => project.name === selectedName) ?? visibleProjects[0];
  const workspaceState = useMemo(() => loading ? "loading" : error ? "attention" : health?.ok === false ? "degraded" : "nominal", [error, health?.ok, loading]);

  return <AppPageFrame variant="standard" className="workspace-overview-page">
    <div className="preview-page-trail"><span>Relay console</span><span>/</span><strong>Workspace overview</strong></div>
    <header className="preview-page-heading"><div><h1>Your work, with context.</h1><p>A quiet view of the projects, runtimes and reviewed experience available to this connection.</p></div><Link className="preview-primary-action" to="/projects">Open projects <ArrowRight size={15} aria-hidden="true" /></Link></header>
    {error && <div className="preview-inline-error" role="alert"><CircleAlert size={15} aria-hidden="true" />{error}<button type="button" onClick={() => void load()}>Retry</button></div>}
    <section className="workspace-signals" aria-label="Workspace status"><div><span>projects</span><strong>{loading ? "—" : String(visibleProjects.length).padStart(2, "0")} <small>authorized</small></strong></div><div><span>active runtimes</span><strong>{loading ? "—" : String(runtimeCount).padStart(2, "0")} <small>reachable</small></strong></div><div><span>confirmed memory</span><strong>{memoryCount === undefined ? "—" : memoryCount} <small>{memoryCount === undefined ? "permission required" : "records"}</small></strong></div><div><span>system status</span><strong className={`preview-status-${workspaceState}`}>{workspaceState === "loading" ? "loading" : workspaceState === "attention" ? "attention" : workspaceState === "degraded" ? "degraded" : "nominal"} <small>{health?.version ?? "API"}</small></strong></div></section>
    <div className="workspace-overview-grid"><section className="workspace-route-panel"><div className="preview-panel-head"><div><span className="preview-panel-kicker">Current route</span><h2>{selectedName} / {currentRoute.split(" /")[0]}</h2><p>{currentProject?.description || "Select a project to keep files, environments and reviewed context together."}</p></div><button type="button" className="preview-panel-action" onClick={() => setRoute((value) => (value + 1) % 4)}>Cycle route <RefreshCw size={13} aria-hidden="true" /></button></div><div className="workspace-route-canvas" data-route={route} aria-label={`Relay route state: ${currentRoute}`} role="img"><div className="workspace-route-line workspace-route-line-a" /><div className="workspace-route-line workspace-route-line-b" /><div className="workspace-route-line workspace-route-line-c" /><div className="workspace-route-node workspace-route-agent"><span>local agent</span><strong>MCP client</strong><small>{route === 0 ? "intent / plan" : "request / scoped"}</small></div><div className="workspace-route-node workspace-route-context"><span>context</span><strong>Knowledge</strong><small>{memoryCount === undefined ? "permission aware" : `${memoryCount} confirmed`}</small></div><div className="workspace-route-core"><strong>Relay</strong><small>MCP / route</small></div><div className="workspace-route-node workspace-route-runtime"><span>target runtime</span><strong>{runtimeCount ? `${runtimeCount} connected` : "No runtime"}</strong><small>{runtimeCount ? "agent / reachable" : "configure a server"}</small></div><div className="workspace-route-node workspace-route-memory"><span>reviewed output</span><strong>Memory</strong><small>{route === 3 ? "review → confirmed" : "scope / protected"}</small></div></div><div className="workspace-route-meta"><span>route state <code>{currentRoute}</code></span><span>scope <code>{selectedName}</code></span><span>status <code>{workspaceState}</code></span></div></section>
      <section className="workspace-trace-panel"><div className="preview-panel-head"><div><span className="preview-panel-kicker">Run trace</span><h2>What moved</h2><p>The context boundary for this run.</p></div></div><div className="workspace-trace-list"><div className="workspace-trace-step"><span className="workspace-trace-mark"><Check size={12} /></span><div><strong>Resolve the scope</strong><span>{selectedName}</span></div><small>{selectedProject ? "ready" : "choose"}</small></div><div className="workspace-trace-step"><span className="workspace-trace-mark"><Check size={12} /></span><div><strong>Check Relay API</strong><span>{health?.ok ? "health endpoint responded" : "health status unavailable"}</span></div><small>{health?.ok ? "ready" : "unknown"}</small></div><div className="workspace-trace-step is-live"><span className="workspace-trace-mark"><CircleDot size={11} /></span><div><strong>Use the available runtime</strong><span>{runtimeCount ? `${runtimeCount} runtime${runtimeCount === 1 ? "" : "s"} available` : "No runtime is connected yet"}</span></div><small>{runtimeCount ? "ready" : "next"}</small></div><div className="workspace-trace-step"><span className="workspace-trace-mark">4</span><div><strong>Return with proof</strong><span>Evidence and Memory stay behind their review boundary.</span></div><small>next</small></div></div></section></div>
    <div className="workspace-lower-grid"><section className="preview-panel"><div className="preview-panel-head"><div><span className="preview-panel-kicker">Console map</span><h2>Manage the surfaces behind this route.</h2><p>Runtime and catalog functions stay on their own pages.</p></div></div><div className="preview-link-list"><Link to="/servers"><span className="preview-link-number">01</span><span><strong>Servers</strong><small>Hosts, SSH or Agent setup, connection tests</small></span><ArrowRight size={14} aria-hidden="true" /></Link><Link to="/instances"><span className="preview-link-number">02</span><span><strong>Instances</strong><small>Discover and maintain SampleManager paths and services</small></span><ArrowRight size={14} aria-hidden="true" /></Link><Link to="/tools"><span className="preview-link-number">03</span><span><strong>Tools</strong><small>Catalog access, execution locality and inspectors</small></span><ArrowRight size={14} aria-hidden="true" /></Link></div></section><section className="preview-panel"><div className="preview-panel-head"><div><span className="preview-panel-kicker">Context and access</span><h2>Follow the permission boundary.</h2><p>Knowledge, credentials and account controls remain explicit.</p></div></div><div className="preview-link-list"><Link to="/knowledge"><span className="preview-link-number">K</span><span><strong>Knowledge</strong><small>Product docs, Solutions, Wiki and operations</small></span><ArrowRight size={14} aria-hidden="true" /></Link><Link to="/knowledge/memory"><span className="preview-link-number">M</span><span><strong>Memory</strong><small>Sessions, Evidence, candidates and confirmed records</small></span><ArrowRight size={14} aria-hidden="true" /></Link><Link to="/tokens"><span className="preview-link-number">T</span><span><strong>Tokens</strong><small>MCP scopes and Relay Agent credentials</small></span><ArrowRight size={14} aria-hidden="true" /></Link></div></section></div>
  </AppPageFrame>;
}
