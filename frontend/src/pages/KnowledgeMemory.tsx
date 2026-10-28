import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { Badge, cardClass, formatDate, inputClass, PageShell, ScopeBanner, StatePanel, StatusBadge } from "../components/KnowledgePrimitives";

const TABS = ["sessions", "evidence", "observations", "candidate-insights", "confirmed-memory"] as const;
const TYPES = ["Fact", "Decision", "Case", "Pattern"] as const;

export default function KnowledgeMemory() {
  const location = useLocation();
  const routeTab = (TABS.find((item) => location.pathname.endsWith(`/${item}`)) ?? "confirmed-memory") as (typeof TABS)[number];
  const [tab, setTab] = useState<(typeof TABS)[number]>(routeTab);
  const [projectId, setProjectId] = useState("");
  const [projects, setProjects] = useState<any[]>([]);
  const [type, setType] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => { setTab(routeTab); }, [routeTab]);
  useEffect(() => { api.listProjects().then((result) => { setProjects(result.projects ?? []); const first = result.projects?.[0]; if (first) setProjectId(String(first.id)); }).catch((err) => setError(String(err))); }, []);
  useEffect(() => {
    if (!projectId) return;
    setLoading(true); setError(""); setSelected(undefined);
    const task = tab === "confirmed-memory" ? api.knowledgeConfirmedMemories(projectId, type ? { type } : {}) : tab === "candidate-insights" ? api.knowledgeCandidateInsights(projectId) : tab === "sessions" ? api.knowledgeSessions() : tab === "evidence" ? api.knowledgeEvidenceList(Number(projectId)) : api.knowledgeObservations(Number(projectId));
    task.then((result: any) => setRows(result.memories ?? result.insights ?? result.sessions ?? result.evidence ?? result.observations ?? [])).catch((err) => setError(err instanceof Error ? err.message : "Unable to load Memory workspace")).finally(() => setLoading(false));
  }, [projectId, tab, type]);
  const title = tab === "confirmed-memory" ? "Confirmed Memory" : tab === "candidate-insights" ? "Candidate Insights" : tab[0].toUpperCase() + tab.slice(1);
  const selectedEvidence = useMemo(() => selected?.evidenceRefs ?? [], [selected]);
  return <PageShell title="Memory" description="Sessions, source Evidence, Observations, Candidate Insights and typed Confirmed Memory live in separate views. Approved Playbooks are managed as operations." breadcrumbs={[{ label: "Knowledge", to: "/knowledge" }, { label: "Memory" }]}>
    <ScopeBanner project={projects.find((item) => String(item.id) === projectId)?.name} scope="memory" acl="owner / granted reviewers" />
    <div className="mb-4 flex flex-wrap items-center gap-2"><select className={inputClass} value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>{tab === "confirmed-memory" && <select className={inputClass} value={type} onChange={(event) => setType(event.target.value)}><option value="">All Confirmed Memory</option>{TYPES.map((item) => <option key={item} value={item}>{item}</option>)}</select>}</div>
    <div className="mb-5 flex flex-wrap gap-2" aria-label="Memory sections">{TABS.map((item) => <button key={item} onClick={() => setTab(item)} className={`rounded-md px-3 py-2 text-xs ${tab === item ? "bg-indigo-600 text-white" : "border border-gray-700 text-gray-300 hover:bg-gray-800"}`}>{item === "candidate-insights" ? "Candidate Insights" : item === "confirmed-memory" ? "Confirmed Memory" : item[0].toUpperCase() + item.slice(1)}</button>)}<Link to="/knowledge/playbooks" className="rounded-md border border-amber-800/70 px-3 py-2 text-xs text-amber-300">Approved Operations</Link></div>
    {error && <p className="mb-4 rounded-md border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-300">{error}</p>}
    {loading ? <StatePanel state="loading" message={`Loading ${title}…`} /> : !rows.length ? <StatePanel state="empty" message={`No ${title} records are available in this project.`} /> : <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]"><div className="space-y-3">{rows.map((row) => <button key={row.id} onClick={() => setSelected(row)} className={`block w-full rounded-xl border p-4 text-left ${selected?.id === row.id ? "border-indigo-600 bg-indigo-950/20" : "border-gray-800 bg-gray-900/70 hover:border-indigo-700/70"}`}><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium text-gray-200">{row.title ?? row.displayTitle ?? row.statement ?? row.summary ?? row.id}</span><StatusBadge value={row.status ?? row.lifecycle ?? "confirmed"} /></div><p className="mt-2 line-clamp-3 text-sm leading-6 text-gray-400">{row.statement ?? row.displaySummary ?? row.summary ?? row.objective ?? "No summary available"}</p>{row.type && <div className="mt-2"><Badge tone="blue">{row.type}</Badge></div>}</button>)}</div>{selected && <section className={cardClass}><div className="flex items-center justify-between gap-2"><h3 className="font-medium text-gray-100">{selected.title ?? selected.id}</h3><StatusBadge value={selected.status ?? selected.lifecycle ?? "confirmed"} /></div><div className="mt-3 grid gap-2 sm:grid-cols-2"><Meta label="Type" value={selected.type ?? selected.kind ?? "—"} /><Meta label="Evidence" value={selectedEvidence.length ? selectedEvidence.join(", ") : "—"} /><Meta label="Scope" value={selected.scope ? `${selected.scope.scopeType}:${selected.scope.scopeKey}` : selected.projectId ?? projectId} /><Meta label="Source" value={selected.source?.locator ?? selected.sourceLocator ?? "—"} /><Meta label="Confirmed by" value={selected.confirmedBy ?? selected.reviewedBy ?? "—"} /><Meta label="Confirmed at" value={selected.confirmedAt ?? selected.reviewedAt ?? selected.updatedAt ?? "—"} /></div><div className="mt-4 rounded-lg border border-gray-800 bg-gray-950/40 p-3"><p className="text-xs font-medium text-gray-300">Audit</p><p className="mt-2 whitespace-pre-wrap text-sm text-gray-400">{selected.audit ? JSON.stringify(selected.audit, null, 2) : selected.reviewReason ?? "No audit detail returned."}</p></div></section>}</div>}
  </PageShell>;
}

function Meta({ label, value }: { label: string; value: unknown }) { return <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-3"><p className="text-[11px] uppercase tracking-wide text-gray-600">{label}</p><p className="mt-1 break-words text-sm text-gray-300">{String(value ?? "—")}</p><p className="mt-1 text-[11px] text-gray-600">{formatDate(value)}</p></div>; }
