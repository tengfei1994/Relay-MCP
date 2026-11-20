import { useEffect, useMemo, useRef, useState } from "react";
import { Activity as ActivityIcon, CheckCircle2, CircleDot, Clock3, File, RotateCw } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import JobsPage from "./Jobs";
import { api } from "../api/client";
import { useProjectScope } from "../context/ProjectScope";
import { AppPageFrame } from "../components/shell/AppPageFrame";
import { Button, EmptyState, ErrorState, Skeleton, StatusPill } from "../components/ui";
import "./activity.css";

type JsonRecord = Record<string, unknown>;
type ActivitySession = {
  id: string;
  projectId: string;
  environment?: string;
  status: string;
  intent: JsonRecord;
  summary?: string;
  unknowns: string[];
  acceptanceResults: Record<string, boolean | string>;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
};
type ProjectFileActivity = { projectId: number; projectName: string; name: string; path?: string; size?: number; modifiedAt?: string };

const record = (value: unknown): JsonRecord => typeof value === "object" && value !== null ? value as JsonRecord : {};
const text = (value: unknown, fallback = "—") => typeof value === "string" && value.trim() ? value : fallback;
const list = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.filter((item): item is JsonRecord => typeof item === "object" && item !== null) : [];
const sessionFrom = (value: unknown): ActivitySession | null => {
  const row = record(value);
  if (typeof row.id !== "string" || typeof row.projectId !== "string" || typeof row.status !== "string") return null;
  return {
    id: row.id,
    projectId: row.projectId,
    environment: typeof row.environment === "string" ? row.environment : undefined,
    status: row.status,
    intent: record(row.intent),
    summary: typeof row.summary === "string" ? row.summary : undefined,
    unknowns: Array.isArray(row.unknowns) ? row.unknowns.map(String) : [],
    acceptanceResults: record(row.acceptanceResults) as Record<string, boolean | string>,
    createdAt: text(row.createdAt, ""),
    updatedAt: text(row.updatedAt, ""),
    closedAt: typeof row.closedAt === "string" ? row.closedAt : undefined,
  };
};
const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};
const formatBytes = (value?: number) => {
  if (value === undefined) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};
const statusTone = (status: string) => status === "completed" ? "completed" : ["abandoned"].includes(status) ? "abandoned" : "active";
const directoryLimit = 24;
const directoryConcurrency = 4;
type FileScan = { files: ProjectFileActivity[]; failures: string[]; truncated: boolean; succeeded: number };

async function scanDirectories(project: { id: number; name: string }, roots: string[], discover: boolean, signal: AbortSignal): Promise<FileScan> {
  const queue = roots.map((path) => ({ path, depth: 0 }));
  const result: FileScan = { files: [], failures: [], truncated: false, succeeded: 0 };
  let scanned = 0;
  while (queue.length && scanned < directoryLimit && !signal.aborted) {
    const batch = queue.splice(0, Math.min(directoryConcurrency, directoryLimit - scanned));
    scanned += batch.length;
    await Promise.all(batch.map(async ({ path, depth }) => {
      try {
        const response = await api.listFiles(project.id, path, signal);
        if (signal.aborted) return;
        result.succeeded += 1;
        for (const entry of list(response.entries)) {
          if (typeof entry.name !== "string") continue;
          const child = path ? path + "/" + entry.name : entry.name;
          if (entry.type === "directory" && discover) {
            if (depth < 2 && queue.length + scanned < directoryLimit) queue.push({ path: child, depth: depth + 1 });
            else result.truncated = true;
          } else if (entry.type === "file") {
            result.files.push({ projectId: project.id, projectName: project.name, name: entry.name, path: child,
              size: typeof entry.size === "number" ? entry.size : undefined, modifiedAt: text(entry.modifiedAt, "") });
          }
        }
      } catch { if (!signal.aborted) result.failures.push(path); }
    }));
  }
  return result;
}

function RecentFileActivity({ project }: { project?: { id: number; name: string } }) {
  const [snapshot, setSnapshot] = useState<FileScan>();
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);
  async function load(retry = false) {
    if (!project || loading) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const result = await scanDirectories(project, retry ? snapshot?.failures ?? [""] : [""], !retry || snapshot?.succeeded === 0, controller.signal);
      if (!controller.signal.aborted) setSnapshot(retry && snapshot ? {
        files: [...snapshot.files, ...result.files], succeeded: snapshot.succeeded + result.succeeded,
        truncated: snapshot.truncated || result.truncated, failures: result.failures,
      } : result);
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }
  const rows = (snapshot?.files ?? []).slice().sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? "")).slice(0, 12);
  return <section className="activity-panel activity-files-panel" aria-label="Recent project file changes">
    <div className="activity-panel-head"><h2>Recent file changes</h2><Button variant="ghost" onClick={() => void load()} loading={loading} disabled={!project}>{snapshot ? "Refresh files" : "Load files"}</Button></div>
    {loading && !snapshot && <p className="activity-file-empty" role="status">Reading project directories...</p>}
    {!snapshot && !loading && <p className="activity-file-empty">{project ? "Read recent file changes for " + project.name + "." : "Select a project to load file activity."}</p>}
    {snapshot && snapshot.failures.length > 0 && <div className="activity-file-empty" role="alert">
      <p>{snapshot.succeeded ? "Some directories could not be read." : "File activity could not be loaded."}</p>
      <Button variant="ghost" disabled={loading} onClick={() => void load(true)}>Retry unread directories</Button>
    </div>}
    {snapshot?.truncated && <p className="activity-file-empty">This scan covers up to {directoryLimit} directories and two levels below the project root.</p>}
    {snapshot?.succeeded && !rows.length ? <p className="activity-file-empty">No files were found in the directories read.</p> : null}
    <div className="activity-file-list">{rows.map((entry) => (
      <div key={entry.path} className="activity-file-row"><span className="activity-file-icon"><File size={15} aria-hidden="true" /></span>
        <span><strong>{entry.path}</strong><small>{entry.modifiedAt ? formatDate(entry.modifiedAt) : "Modified time unavailable"}</small></span>
        <code>{formatBytes(entry.size) || "file"}</code></div>
    ))}</div>
  </section>;
}

export default function ActivityPage() {
  const [query] = useSearchParams();
  const history = query.get("view") === "history";
  return (
    <AppPageFrame variant="wide">
      <nav className="shell-page-tabs mb-4" aria-label="Activity view">
        <Link to="/activity" className={`shell-page-tab${history ? "" : " active"}`} aria-current={!history ? "page" : undefined}>Jobs</Link>
        <Link to="/activity?view=history" className={`shell-page-tab${history ? " active" : ""}`} aria-current={history ? "page" : undefined}>Sessions &amp; files</Link>
      </nav>
      {history ? <ActivityHistory /> : <JobsPage embedded />}
    </AppPageFrame>
  );
}

function ActivityHistory() {
  const { selectedProject, loading: projectLoading } = useProjectScope();
  const [sessions, setSessions] = useState<ActivitySession[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [filter, setFilter] = useState<"all" | "active" | "completed">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.knowledgeSessions(100)
      .then((result) => {
        if (!active) return;
        setSessions(list(result.sessions).map(sessionFrom).filter((item): item is ActivitySession => Boolean(item)));
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load activity"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const scopedSessions = useMemo(() => sessions.filter((session) => !selectedProject || session.projectId === String(selectedProject.id)), [selectedProject, sessions]);
  const visibleSessions = useMemo(() => scopedSessions.filter((session) => filter === "all" || (filter === "completed" ? session.status === "completed" : session.status !== "completed" && session.status !== "abandoned")), [filter, scopedSessions]);
  const selected = visibleSessions.find((session) => session.id === selectedId) ?? visibleSessions[0];
  const projectLabel = selectedProject?.name ?? (projectLoading ? "Loading project…" : "All projects");

  useEffect(() => {
    if (!selected || visibleSessions.some((session) => session.id === selectedId)) return;
    setSelectedId(visibleSessions[0]?.id);
  }, [selected, selectedId, visibleSessions]);

  return (
      <div className="activity-page">
        <div className="activity-toolbar">
          <div className="activity-toolbar-copy">
            <span className="activity-kicker">Workspace activity</span>
            <p className="runtime-page-summary">{visibleSessions.length} work sessions · {projectLabel}</p>
          </div>
          <div className="activity-filters" role="group" aria-label="Activity filter">
            {["all", "active", "completed"].map((value) => <button key={value} type="button" onClick={() => setFilter(value as typeof filter)} className={filter === value ? "active" : ""}>{value === "all" ? "All sessions" : value === "active" ? "Active" : "Completed"}</button>)}
          </div>
        </div>

        {error && <ErrorState className="mb-4" message={error} />}
        <div className="activity-layout">
          <section className="activity-panel" aria-label="Work session history">
            <div className="activity-panel-head"><div><h1>Work sessions</h1></div><span className="activity-count">{scopedSessions.length.toString().padStart(2, "0")} total</span></div>
            {loading ? <div className="activity-skeleton"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div> : !visibleSessions.length ? <EmptyState title="No activity yet" description="Work Sessions for this project will appear here when a run is opened." /> : <div className="activity-list">{visibleSessions.map((session) => {
              const intent = record(session.intent);
              const objective = text(intent.objective, "Untitled work session");
              return <button key={session.id} type="button" className={`activity-row${selected?.id === session.id ? " selected" : ""}`} onClick={() => setSelectedId(session.id)}><span className={`activity-row-mark ${statusTone(session.status)}`} aria-hidden="true">{session.status === "completed" ? <CheckCircle2 size={14} /> : session.status === "abandoned" ? <CircleDot size={14} /> : <ActivityIcon size={14} />}</span><span className="activity-row-copy"><strong>{objective}</strong><span>{[text(intent.phase, "phase unknown"), session.environment, session.status].filter(Boolean).join(" · ")}</span></span><time>{formatDate(session.updatedAt)}</time></button>;
            })}</div>}
          </section>

          <aside className="activity-panel activity-detail" aria-label="Selected activity">
            {selected ? <><div className="activity-panel-head"><div><span className="activity-panel-kicker">Selected session</span><h2>{text(record(selected.intent).objective, "Untitled work session")}</h2></div><StatusPill status={selected.status} /></div><p className="activity-detail-summary">{selected.summary ?? text(record(selected.intent).desiredOutcome, "No summary recorded.")}</p><dl className="activity-detail-grid"><div><dt>Project</dt><dd>{projectLabel}</dd></div><div><dt>Environment</dt><dd>{selected.environment ?? "Default"}</dd></div><div><dt>Phase</dt><dd>{text(record(selected.intent).phase)}</dd></div><div><dt>Risk</dt><dd>{text(record(selected.intent).risk)}</dd></div><div><dt>Opened</dt><dd>{formatDate(selected.createdAt)}</dd></div><div><dt>Updated</dt><dd>{formatDate(selected.updatedAt)}</dd></div></dl><div className="activity-detail-section"><span className="activity-panel-kicker">Actions</span><p>{Array.isArray(record(selected.intent).actions) ? (record(selected.intent).actions as unknown[]).map(String).join(" → ") : "—"}</p></div><div className="activity-detail-section"><span className="activity-panel-kicker">Acceptance</span>{Object.keys(selected.acceptanceResults).length ? <ul>{Object.entries(selected.acceptanceResults).map(([key, value]) => <li key={key}><span>{key}</span><strong>{String(value)}</strong></li>)}</ul> : <p>No acceptance results recorded.</p>}</div></> : <div className="activity-detail-empty"><Clock3 size={18} /><p>Select a session to inspect its scope and result.</p></div>}
          </aside>
        </div>
        <RecentFileActivity key={selectedProject?.id} project={selectedProject} />
      </div>
  );
}
