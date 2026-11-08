import { useEffect, useMemo, useState } from "react";
import { Activity as ActivityIcon, CheckCircle2, CircleDot, Clock3, RotateCw } from "lucide-react";
import { api } from "../api/client";
import { useProjectScope } from "../context/ProjectScope";
import { AppPageFrame } from "../components/shell/AppPageFrame";
import { EmptyState, ErrorState, Skeleton, StatusPill } from "../components/ui";
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
const statusTone = (status: string) => status === "completed" ? "completed" : ["abandoned"].includes(status) ? "abandoned" : "active";

export default function ActivityPage() {
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
    <AppPageFrame variant="wide">
      <div className="activity-page">
        <div className="activity-toolbar">
          <div className="activity-toolbar-copy">
            <span className="activity-kicker">Workspace activity</span>
            <p className="runtime-page-summary">{visibleSessions.length} runs · {projectLabel}</p>
          </div>
          <div className="activity-filters" role="group" aria-label="Activity filter">
            {["all", "active", "completed"].map((value) => <button key={value} type="button" onClick={() => setFilter(value as typeof filter)} className={filter === value ? "active" : ""}>{value === "all" ? "All runs" : value === "active" ? "Active" : "Completed"}</button>)}
          </div>
        </div>

        {error && <ErrorState className="mb-4" message={error} />}
        <div className="activity-layout">
          <section className="activity-panel" aria-label="Run history">
            <div className="activity-panel-head"><div><span className="activity-panel-kicker">Run history</span><h1>Recent activity</h1></div><span className="activity-count">{scopedSessions.length.toString().padStart(2, "0")} total</span></div>
            {loading ? <div className="activity-skeleton"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div> : !visibleSessions.length ? <EmptyState title="No activity yet" description="Work Sessions for this project will appear here when a run is opened." /> : <div className="activity-list">{visibleSessions.map((session) => {
              const intent = record(session.intent);
              const objective = text(intent.objective, "Untitled work session");
              return <button key={session.id} type="button" className={`activity-row${selected?.id === session.id ? " selected" : ""}`} onClick={() => setSelectedId(session.id)}><span className={`activity-row-mark ${statusTone(session.status)}`} aria-hidden="true">{session.status === "completed" ? <CheckCircle2 size={14} /> : session.status === "abandoned" ? <CircleDot size={14} /> : <ActivityIcon size={14} />}</span><span className="activity-row-copy"><strong>{objective}</strong><span>{[text(intent.phase, "phase unknown"), session.environment, session.status].filter(Boolean).join(" · ")}</span></span><time>{formatDate(session.updatedAt)}</time></button>;
            })}</div>}
          </section>

          <aside className="activity-panel activity-detail" aria-label="Selected activity">
            {selected ? <><div className="activity-panel-head"><div><span className="activity-panel-kicker">Selected run</span><h2>{text(record(selected.intent).objective, "Untitled work session")}</h2></div><StatusPill status={selected.status} /></div><p className="activity-detail-summary">{selected.summary ?? text(record(selected.intent).desiredOutcome, "No summary recorded.")}</p><dl className="activity-detail-grid"><div><dt>Project</dt><dd>{projectLabel}</dd></div><div><dt>Environment</dt><dd>{selected.environment ?? "Default"}</dd></div><div><dt>Phase</dt><dd>{text(record(selected.intent).phase)}</dd></div><div><dt>Risk</dt><dd>{text(record(selected.intent).risk)}</dd></div><div><dt>Opened</dt><dd>{formatDate(selected.createdAt)}</dd></div><div><dt>Updated</dt><dd>{formatDate(selected.updatedAt)}</dd></div></dl><div className="activity-detail-section"><span className="activity-panel-kicker">Actions</span><p>{Array.isArray(record(selected.intent).actions) ? (record(selected.intent).actions as unknown[]).map(String).join(" → ") : "—"}</p></div><div className="activity-detail-section"><span className="activity-panel-kicker">Acceptance</span>{Object.keys(selected.acceptanceResults).length ? <ul>{Object.entries(selected.acceptanceResults).map(([key, value]) => <li key={key}><span>{key}</span><strong>{String(value)}</strong></li>)}</ul> : <p>No acceptance results recorded.</p>}</div></> : <div className="activity-detail-empty"><Clock3 size={18} /><p>Select a run to inspect its scope and result.</p></div>}
          </aside>
        </div>
      </div>
    </AppPageFrame>
  );
}
