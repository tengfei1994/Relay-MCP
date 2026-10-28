import { useEffect, useState } from "react";
import { BookOpen, CheckCircle2, ChevronLeft, ChevronRight, FileText, GitBranch, KeyRound, RefreshCw, ServerCog, ShieldAlert, Workflow } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../App";
import { Badge, cardClass, formatDate, inputClass, PageShell, StatePanel, StatusBadge } from "../components/KnowledgePrimitives";
import { buildWeknoraSearchBody } from "../knowledge/integrated-search";

const btn = "inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50";
const btnGhost = "inline-flex items-center gap-1.5 rounded-md border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50";
const btnDanger = "inline-flex items-center gap-1.5 rounded-md border border-rose-900 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-950/40 disabled:opacity-50";

function errText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function Err({ message }: { message: string }) {
  if (!message) return null;
  return <p className="mt-3 rounded-md border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-300">{message}</p>;
}

function Pager({ offset, limit, total, count, onPage }: { offset: number; limit: number; total?: number; count: number; onPage: (offset: number) => void }) {
  const hasPrev = offset > 0;
  const hasNext = total !== undefined ? offset + count < total : count >= limit;
  return <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
    <span>{total !== undefined ? `${total} total · ` : ""}showing {count} from offset {offset}</span>
    <div className="flex gap-2">
      <button disabled={!hasPrev} onClick={() => onPage(Math.max(0, offset - limit))} className={btnGhost}><ChevronLeft size={13} /> Prev</button>
      <button disabled={!hasNext} onClick={() => onPage(offset + limit)} className={btnGhost}>Next <ChevronRight size={13} /></button>
    </div>
  </div>;
}

/** Reviewed mutations always carry a mandatory, audited reason. */
function ReasonAction({ label, onRun, tone = "primary", placeholder = "Reason (required, audited)" }: { label: string; onRun: (reason: string) => Promise<void>; tone?: "primary" | "danger"; placeholder?: string }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <span className="inline-flex flex-wrap items-center gap-1.5">
    <input className={`${inputClass} w-52`} value={reason} placeholder={placeholder} onChange={(event) => setReason(event.target.value)} />
    <button disabled={busy || !reason.trim()} className={tone === "danger" ? btnDanger : btn} onClick={async () => { setBusy(true); setError(""); try { await onRun(reason.trim()); setReason(""); } catch (err) { setError(errText(err, "Action failed")); } finally { setBusy(false); } }}>{busy ? <RefreshCw size={12} className="animate-spin" /> : null}{label}</button>
    {error && <span className="text-xs text-rose-300">{error}</span>}
  </span>;
}

function SessionsPane() {
  const [sessions, setSessions] = useState<any[]>();
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState("");
  const [events, setEvents] = useState<any[]>([]);
  const [eventsError, setEventsError] = useState("");
  const load = () => { setError(""); api.knowledgeSessions(100).then((result) => setSessions(result.sessions ?? [])).catch((err) => setError(errText(err, "Unable to load Work Sessions"))); };
  useEffect(() => { load(); }, []);
  const openSession = async (id: string) => {
    if (openId === id) { setOpenId(""); return; }
    setOpenId(id); setEvents([]); setEventsError("");
    try { setEvents((await api.knowledgeSessionEvents(id)).events ?? []); } catch (err) { setEventsError(errText(err, "Unable to load session events")); }
  };
  if (error && !sessions) return <StatePanel state="error" message={error} onRetry={load} />;
  if (!sessions) return <StatePanel state="loading" message="Loading Work Sessions…" />;
  return <section className={cardClass}>
    <div className="flex items-center justify-between"><h3 className="font-medium text-gray-100">Work Sessions</h3><button onClick={load} className={btnGhost}><RefreshCw size={13} /> Refresh</button></div>
    <p className="mt-1 text-xs text-gray-500">Your ACL-visible sessions; expand one to see correlated events.</p>
    <div className="mt-3 divide-y divide-gray-800">
      {sessions.length === 0 && <p className="py-3 text-sm text-gray-500">No Work Sessions yet.</p>}
      {sessions.map((session) => <div key={session.id} className="py-2.5">
        <button onClick={() => openSession(session.id)} className="flex w-full flex-wrap items-center justify-between gap-3 text-left">
          <div className="min-w-0">
            <p className="truncate text-sm text-gray-200">{session.intent?.objective || session.id}</p>
            <p className="text-xs text-gray-500">{session.id} · project {session.projectId}{session.environment ? ` · ${session.environment}` : ""} · {formatDate(session.updatedAt)}</p>
          </div>
          <span className="flex items-center gap-2"><Badge tone="purple">{session.intent?.risk ?? "risk n/a"}</Badge><StatusBadge value={session.status} /></span>
        </button>
        {openId === session.id && <div className="mt-2 rounded-md border border-gray-800 bg-gray-950/50 p-3">
          {eventsError ? <p className="text-xs text-rose-300">{eventsError}</p> : <>
            <p className="text-xs text-gray-500">{events.length} correlated event(s)</p>
            {session.summary && <p className="mt-1 text-xs text-gray-400">{session.summary}</p>}
            <ul className="mt-2 space-y-1">{events.slice(-10).reverse().map((event) => <li key={event.event_id ?? event.id} className="flex flex-wrap items-center gap-2 text-xs text-gray-400"><Badge tone="blue">{String(event.event_type)}</Badge><span className="text-gray-600">{formatDate(event.created_at)}</span>{event.intent_step && <span>{String(event.intent_step)}</span>}</li>)}</ul>
          </>}
        </div>}
      </div>)}
    </div>
  </section>;
}

const PROVIDER_KINDS = ["embedding", "rerank", "wiki_llm", "candidate_llm"] as const;

function ProvidersPane({ isAdmin }: { isAdmin: boolean }) {
  const emptyForm = { id: "", kind: "embedding" as string, provider: "", baseUrl: "", modelId: "", dimensions: "", secretRef: "" };
  const [providers, setProviders] = useState<any[]>();
  const [jobs, setJobs] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<Record<string, any>>({});
  const [rotateId, setRotateId] = useState("");
  const [rotateRef, setRotateRef] = useState("");
  const load = () => {
    setError("");
    Promise.all([api.knowledgeManagedProviders(), api.knowledgeManagedProvidersReindex()])
      .then(([p, r]) => { setProviders(p.providers ?? []); setJobs(r.jobs ?? []); })
      .catch((err) => setError(errText(err, "Unable to load managed providers")));
  };
  useEffect(() => { load(); }, []);
  const run = async (task: () => Promise<any>, ok: string) => { setError(""); setNotice(""); try { await task(); setNotice(ok); load(); } catch (err) { setError(errText(err, "Provider operation failed")); } };
  const save = () => run(async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { kind: form.kind, provider: form.provider.trim(), modelId: form.modelId.trim() };
      if (form.baseUrl.trim()) body.baseUrl = form.baseUrl.trim();
      if (form.dimensions.trim()) body.dimensions = Number(form.dimensions);
      if (form.secretRef.trim()) body.secretRef = form.secretRef.trim();
      await api.knowledgeManagedProviderUpsert(form.id.trim(), body);
      setForm(emptyForm);
    } finally { setSaving(false); }
  }, "Provider configuration saved.");
  const test = async (id: string) => { setError(""); try { const { report } = await api.knowledgeManagedProviderTest(id); setProbe((current) => ({ ...current, [id]: report })); load(); } catch (err) { setError(errText(err, "Provider probe failed")); } };
  if (error && !providers) return <StatePanel state="error" message={error} onRetry={load} />;
  if (!providers) return <StatePanel state="loading" message="Loading managed providers…" />;
  return <div className="space-y-4">
    <section className={cardClass}>
      <div className="flex items-center gap-2"><ServerCog size={16} className="text-indigo-300" /><h3 className="font-medium text-gray-100">Managed providers</h3></div>
      <p className="mt-1 text-xs text-gray-500">Credentials are secret references only — never paste a raw token.</p>
      <div className="mt-3 divide-y divide-gray-800">
        {providers.length === 0 && <p className="py-3 text-sm text-gray-500">No remote providers configured.</p>}
        {providers.map((provider) => <div key={provider.id} className="py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-gray-200">{provider.id} · {provider.provider} · {provider.modelId}</p>
              <p className="text-xs text-gray-500">{provider.kind} · index v{provider.indexVersion} · {provider.tokenConfigured ? "secretRef configured" : "no secret reference"}{provider.dimensions ? ` · ${provider.dimensions}d` : ""}{provider.lastTestAt ? ` · tested ${formatDate(provider.lastTestAt)}` : ""}{provider.lastErrorCode ? ` · last error ${provider.lastErrorCode}` : ""}</p>
            </div>
            <div className="flex items-center gap-2">
              {provider.reindexRequired && <Badge tone="amber">reindex pending</Badge>}
              <StatusBadge value={provider.status} />
            </div>
          </div>
          {isAdmin && <div className="mt-2 flex flex-wrap items-center gap-2">
            <button className={btnGhost} onClick={() => test(provider.id)}>Test</button>
            <button className={btnGhost} onClick={() => { setRotateId(rotateId === provider.id ? "" : provider.id); setRotateRef(""); }}><KeyRound size={12} /> Rotate secret</button>
            <button className={btnDanger} disabled={provider.status === "disabled"} onClick={() => { if (window.confirm(`Disable provider '${provider.id}'? This is audited.`)) run(() => api.knowledgeManagedProviderDisable(provider.id), "Provider disabled."); }}>Disable</button>
          </div>}
          {rotateId === provider.id && <div className="mt-2 flex flex-wrap items-center gap-2">
            <input className={`${inputClass} w-72`} placeholder="New secret reference (e.g. vault://knowledge/provider-key)" value={rotateRef} onChange={(event) => setRotateRef(event.target.value)} />
            <button className={btn} disabled={!rotateRef.trim()} onClick={() => run(async () => { await api.knowledgeManagedProviderRotate(provider.id, rotateRef.trim()); setRotateId(""); }, "Secret reference rotated.")}>Apply rotation</button>
          </div>}
          {probe[provider.id] && <p className={`mt-2 text-xs ${probe[provider.id].ok ? "text-emerald-300" : "text-rose-300"}`}>Probe {probe[provider.id].ok ? `ok · ${probe[provider.id].latencyMs ?? "?"}ms · HTTP ${probe[provider.id].httpStatus ?? "?"}` : `failed · ${probe[provider.id].errorCode ?? "unknown"}`}</p>}
        </div>)}
      </div>
    </section>
    {isAdmin && <section className={cardClass}>
      <h3 className="font-medium text-gray-100">Configure provider (admin)</h3>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <input className={inputClass} placeholder="Provider id" value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} />
        <select className={inputClass} value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>{PROVIDER_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select>
        <input className={inputClass} placeholder="Provider name (e.g. openai)" value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value })} />
        <input className={inputClass} placeholder="Model id" value={form.modelId} onChange={(event) => setForm({ ...form, modelId: event.target.value })} />
        <input className={inputClass} placeholder="Base URL (optional)" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
        <input className={inputClass} placeholder="Dimensions (embedding)" value={form.dimensions} onChange={(event) => setForm({ ...form, dimensions: event.target.value })} />
        <input className={`${inputClass} sm:col-span-2`} placeholder="secretRef only — raw tokens are rejected" value={form.secretRef} onChange={(event) => setForm({ ...form, secretRef: event.target.value })} />
      </div>
      <button disabled={saving || !form.id.trim() || !form.provider.trim() || !form.modelId.trim()} onClick={save} className={`${btn} mt-3`}>{saving ? <RefreshCw size={12} className="animate-spin" /> : null} Save configuration</button>
    </section>}
    <section className={cardClass}>
      <h3 className="font-medium text-gray-100">Pending reindex</h3>
      <div className="mt-3 divide-y divide-gray-800">
        {jobs.length === 0 && <p className="py-2 text-sm text-gray-500">No pending reindex jobs.</p>}
        {jobs.map((entry) => <div key={entry.job.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
          <div>
            <p className="text-sm text-gray-200">{entry.provider.id}: {entry.job.fromModelId ?? "?"} → {entry.job.toModelId} (index v{entry.job.indexVersion})</p>
            <p className="text-xs text-gray-500">{entry.job.id} · {formatDate(entry.job.createdAt)}{entry.job.errorCode ? ` · ${entry.job.errorCode}` : ""}</p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge value={entry.job.status} />
            {isAdmin && entry.job.status !== "completed" && <button className={btnGhost} onClick={() => run(() => api.knowledgeManagedProviderReindexComplete(entry.job.id), "Reindex job completed.")}>Mark complete</button>}
          </div>
        </div>)}
      </div>
    </section>
    {notice && <p className="rounded-md border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-300">{notice}</p>}
    <Err message={providers ? error : ""} />
  </div>;
}

const INSIGHT_STATUSES = ["draft", "accepted", "edited", "rejected"] as const;
const INSIGHT_KINDS = ["fact", "decision", "case", "pattern"] as const;
const PAGE_LIMIT = 20;

function CandidatesPane({ isAdmin }: { isAdmin: boolean }) {
  const [projects, setProjects] = useState<any[]>([]);
  const [projectId, setProjectId] = useState<number>();
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [insights, setInsights] = useState<any[]>();
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<any>();
  const [history, setHistory] = useState<any[]>([]);
  const [edit, setEdit] = useState<{ statement: string; kind: string }>({ statement: "", kind: "" });
  const [promoteTarget, setPromoteTarget] = useState<"fact" | "decision" | "case" | "pattern">("fact");
  const [promoteTitle, setPromoteTitle] = useState("");
  useEffect(() => { api.listProjects().then((result) => { setProjects(result.projects ?? []); const stored = Number(localStorage.getItem("knowledge.projectId")); setProjectId(result.projects?.find((project: any) => project.id === stored)?.id ?? result.projects?.[0]?.id); }).catch((err) => setError(errText(err, "Unable to load projects"))); }, []);
  const load = (nextOffset = offset) => {
    if (projectId === undefined) return;
    setError("");
    api.knowledgeCandidateInsights(projectId, { status: status || undefined, limit: PAGE_LIMIT, offset: nextOffset })
      .then((result) => setInsights(result.insights ?? []))
      .catch((err) => { setInsights([]); setError(errText(err, "Unable to load Candidate Insights")); });
  };
  useEffect(() => { setOffset(0); setSelected(undefined); load(0); }, [projectId, status]);
  const openDetail = async (id: string) => {
    setError("");
    try {
      const [{ insight }, detail] = await Promise.all([api.knowledgeCandidateInsight(id), api.knowledgeCandidateInsightHistory(id)]);
      setSelected(insight); setHistory(detail.history ?? []);
      setEdit({ statement: insight.statement ?? "", kind: insight.kind ?? INSIGHT_KINDS[0] });
    } catch (err) { setError(errText(err, "Unable to load Candidate Insight")); }
  };
  const refresh = async (insight: any) => { setSelected(insight); const detail = await api.knowledgeCandidateInsightHistory(insight.id); setHistory(detail.history ?? []); load(); };
  return <div className="space-y-4">
    <section className={cardClass}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-medium text-gray-100">Candidate drafts</h3>
        <select className={inputClass} value={projectId ?? ""} onChange={(event) => { const id = Number(event.target.value); setProjectId(id); localStorage.setItem("knowledge.projectId", String(id)); }}>
          {projects.length === 0 && <option value="">No projects</option>}
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All statuses</option>
          {INSIGHT_STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <button className={btnGhost} onClick={() => load()}><RefreshCw size={13} /> Refresh</button>
      </div>
      <Err message={error} />
      {!insights ? <StatePanel state="loading" message="Loading Candidate Insights…" /> : <>
        <div className="mt-3 divide-y divide-gray-800">
          {insights.length === 0 && <p className="py-3 text-sm text-gray-500">No Candidate Insights in this scope.</p>}
          {insights.map((insight) => <button key={insight.id} onClick={() => openDetail(insight.id)} className="flex w-full flex-wrap items-center justify-between gap-3 py-2.5 text-left">
            <div className="min-w-0">
              <p className="truncate text-sm text-gray-200">{insight.statement}</p>
              <p className="text-xs text-gray-500">{insight.id} · session {insight.workSessionId} · {formatDate(insight.updatedAt)}{insight.confidence != null ? ` · confidence ${Number(insight.confidence).toFixed(2)}` : ""}</p>
            </div>
            <span className="flex items-center gap-2"><Badge tone="blue">{insight.kind}</Badge><StatusBadge value={insight.status} /></span>
          </button>)}
        </div>
        <Pager offset={offset} limit={PAGE_LIMIT} count={insights.length} onPage={(next) => { setOffset(next); load(next); }} />
      </>}
    </section>
    {selected && <section className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-gray-100">{selected.id}</h3>
          <p className="mt-1 text-sm leading-6 text-gray-300">{selected.statement}</p>
          {selected.whyProposed && <p className="mt-1 text-xs text-gray-500">Why proposed: {selected.whyProposed}</p>}
          <p className="mt-2 text-xs text-gray-500">generated by {selected.generatedBy}{selected.fallbackReason ? ` · fallback: ${selected.fallbackReason}` : ""} · evidence refs: {(selected.evidenceRefs ?? []).length}</p>
        </div>
        <StatusBadge value={selected.status} />
      </div>
      {isAdmin && <div className="mt-4 space-y-3 border-t border-gray-800 pt-3">
        {(selected.status === "draft" || selected.status === "edited") && <>
          <div className="grid gap-2 sm:grid-cols-[1fr_180px]">
            <textarea className="min-h-16 rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-200 outline-none focus:border-indigo-500" value={edit.statement} onChange={(event) => setEdit({ ...edit, statement: event.target.value })} placeholder="Edited statement" />
            <select className={inputClass} value={edit.kind} onChange={(event) => setEdit({ ...edit, kind: event.target.value })}>{INSIGHT_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ReasonAction label="Save edit" onRun={async (reason) => refresh((await api.knowledgeCandidateInsightEdit(selected.id, { statement: edit.statement, kind: edit.kind }, reason)).insight)} />
            <ReasonAction label="Confirm" onRun={async (reason) => refresh((await api.knowledgeCandidateInsightConfirm(selected.id, reason)).insight)} />
            <ReasonAction label="Reject" tone="danger" onRun={async (reason) => refresh((await api.knowledgeCandidateInsightReject(selected.id, reason)).insight)} />
          </div>
        </>}
        {selected.status === "accepted" && <div className="flex flex-wrap items-center gap-2">
          <select className={inputClass} value={promoteTarget} onChange={(event) => setPromoteTarget(event.target.value as "fact" | "decision" | "case" | "pattern")}><option value="fact">fact</option><option value="decision">decision</option><option value="case">case</option><option value="pattern">pattern</option></select>
          <input className={`${inputClass} w-56`} placeholder="Promotion title (optional)" value={promoteTitle} onChange={(event) => setPromoteTitle(event.target.value)} />
          <ReasonAction label="Promote" onRun={async (reason) => { const result = await api.knowledgeCandidateInsightPromote(selected.id, { target: promoteTarget, reason, title: promoteTitle.trim() || undefined }); setSelected({ ...selected, promotion: result.promotion }); }} />
        </div>}
      </div>}
      <div className="mt-4 border-t border-gray-800 pt-3">
        <p className="text-xs uppercase tracking-wide text-gray-600">Review history</p>
        <ul className="mt-2 space-y-1.5">
          {history.length === 0 && <li className="text-xs text-gray-500">No review actions yet.</li>}
          {history.map((record) => <li key={record.id} className="text-xs text-gray-400"><Badge tone={record.action === "reject" ? "rose" : record.action === "confirm" || record.action === "promote" ? "green" : "gray"}>{record.action}</Badge> <span className="ml-1 text-gray-500">{formatDate(record.createdAt)} · reviewer {record.reviewerId}</span> — {record.reason}</li>)}
        </ul>
      </div>
    </section>}
  </div>;
}

const WIKI_STATUSES = ["draft", "published", "deprecated"] as const;

function WikiPane({ isAdmin }: { isAdmin: boolean }) {
  const emptyCreate = { pageKey: "", title: "", body: "", productVersion: "", reason: "" };
  const [filters, setFilters] = useState({ search: "", status: "" });
  const [applied, setApplied] = useState(filters);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{ items: any[]; total: number }>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [create, setCreate] = useState(emptyCreate);
  const [showCreate, setShowCreate] = useState(false);
  const [page, setPage] = useState<any>();
  const [revisions, setRevisions] = useState<any[]>([]);
  const [diffRange, setDiffRange] = useState({ from: "", to: "" });
  const [diff, setDiff] = useState("");
  const [editBody, setEditBody] = useState<{ title: string; body: string }>({ title: "", body: "" });
  const [rollbackRev, setRollbackRev] = useState("");
  const load = (nextOffset = offset) => {
    setError("");
    api.knowledgeWikiPages({ search: applied.search || undefined, status: applied.status || undefined, limit: PAGE_LIMIT, offset: nextOffset })
      .then((data) => setResult({ items: data.items ?? [], total: data.total ?? 0 }))
      .catch((err) => { setResult({ items: [], total: 0 }); setError(errText(err, "Unable to load Wiki pages")); });
  };
  useEffect(() => { setOffset(0); load(0); }, [applied]);
  const run = async (task: () => Promise<any>, ok: string) => { setError(""); setNotice(""); try { const data = await task(); setNotice(ok); load(); return data; } catch (err) { setError(errText(err, "Wiki operation failed")); } };
  const openPage = async (id: string) => {
    setError(""); setDiff("");
    try {
      const [{ page: detail }, revs] = await Promise.all([api.knowledgeWikiPage(id), api.knowledgeWikiRevisions(id)]);
      setPage(detail); setRevisions(revs.revisions ?? []);
      setEditBody({ title: detail.title, body: detail.body });
      setDiffRange({ from: String(Math.max(1, detail.currentRevision - 1)), to: String(detail.currentRevision) });
    } catch (err) { setError(errText(err, "Unable to load Wiki page")); }
  };
  const refreshPage = async (updated: any) => { setPage(updated); setEditBody({ title: updated.title, body: updated.body }); const revs = await api.knowledgeWikiRevisions(updated.id); setRevisions(revs.revisions ?? []); load(); };
  return <div className="space-y-4">
    <section className={cardClass}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-medium text-gray-100">Wiki pages</h3>
        <input className={`${inputClass} w-64`} placeholder="Search title or body…" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") setApplied(filters); }} />
        <select className={inputClass} value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
          <option value="">All statuses</option>
          {WIKI_STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <button className={btnGhost} onClick={() => setApplied(filters)}>Search</button>
        {isAdmin && <button className={btn} onClick={() => setShowCreate(!showCreate)}>New page</button>}
      </div>
      {showCreate && isAdmin && <div className="mt-3 space-y-2 rounded-md border border-gray-800 bg-gray-950/50 p-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <input className={inputClass} placeholder="pageKey (stable identity)" value={create.pageKey} onChange={(event) => setCreate({ ...create, pageKey: event.target.value })} />
          <input className={inputClass} placeholder="Title" value={create.title} onChange={(event) => setCreate({ ...create, title: event.target.value })} />
          <input className={inputClass} placeholder="Product version (optional)" value={create.productVersion} onChange={(event) => setCreate({ ...create, productVersion: event.target.value })} />
        </div>
        <textarea className="min-h-24 w-full rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-200 outline-none focus:border-indigo-500" placeholder="Page body" value={create.body} onChange={(event) => setCreate({ ...create, body: event.target.value })} />
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${inputClass} w-72`} placeholder="Creation reason (required)" value={create.reason} onChange={(event) => setCreate({ ...create, reason: event.target.value })} />
          <button className={btn} disabled={!create.pageKey.trim() || !create.title.trim() || !create.body.trim() || !create.reason.trim()} onClick={() => run(async () => { const { page: created } = await api.knowledgeWikiCreate({ pageKey: create.pageKey.trim(), title: create.title.trim(), body: create.body, productVersion: create.productVersion.trim() || undefined, reason: create.reason.trim() }); setCreate(emptyCreate); setShowCreate(false); return created; }, "Wiki page created.")}>Create</button>
        </div>
      </div>}
      <Err message={error} />
      {notice && <p className="mt-3 rounded-md border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-300">{notice}</p>}
      {!result ? <StatePanel state="loading" message="Loading Wiki pages…" /> : <>
        <div className="mt-3 divide-y divide-gray-800">
          {result.items.length === 0 && <p className="py-3 text-sm text-gray-500">No Wiki pages match.</p>}
          {result.items.map((item) => <button key={item.id} onClick={() => openPage(item.id)} className="flex w-full flex-wrap items-center justify-between gap-3 py-2.5 text-left">
            <div className="min-w-0">
              <p className="truncate text-sm text-gray-200">{item.title}</p>
              <p className="text-xs text-gray-500">{item.pageKey} · rev {item.currentRevision}{item.productVersion ? ` · ${item.productVersion}` : ""} · {formatDate(item.updatedAt)}</p>
            </div>
            <StatusBadge value={item.status} />
          </button>)}
        </div>
        <Pager offset={offset} limit={PAGE_LIMIT} total={result.total} count={result.items.length} onPage={(next) => { setOffset(next); load(next); }} />
      </>}
    </section>
    {page && <section className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-gray-100">{page.title}</h3>
          <p className="text-xs text-gray-500">{page.pageKey} · revision {page.currentRevision} · created {formatDate(page.createdAt)}{page.publishedAt ? ` · published ${formatDate(page.publishedAt)}` : ""}{page.deprecatedAt ? ` · deprecated ${formatDate(page.deprecatedAt)}` : ""}</p>
        </div>
        <StatusBadge value={page.status} />
      </div>
      <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-gray-800 bg-gray-950/60 p-3 text-xs text-gray-300">{page.body}</pre>
      {isAdmin && <div className="mt-4 space-y-3 border-t border-gray-800 pt-3">
        <div className="grid gap-2 sm:grid-cols-[1fr] ">
          <input className={inputClass} value={editBody.title} onChange={(event) => setEditBody({ ...editBody, title: event.target.value })} placeholder="Title" />
          <textarea className="min-h-20 rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-200 outline-none focus:border-indigo-500" value={editBody.body} onChange={(event) => setEditBody({ ...editBody, body: event.target.value })} placeholder="Body" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ReasonAction label="Save edit" onRun={async (reason) => refreshPage((await api.knowledgeWikiEdit(page.id, { title: editBody.title, body: editBody.body, reason })).page)} />
          {page.status !== "published" && <ReasonAction label="Publish" onRun={async (reason) => refreshPage((await api.knowledgeWikiPublish(page.id, reason)).page)} />}
          {page.status === "published" && <ReasonAction label="Deprecate" tone="danger" onRun={async (reason) => refreshPage((await api.knowledgeWikiDeprecate(page.id, reason)).page)} />}
          <span className="inline-flex items-center gap-1.5">
            <input className={`${inputClass} w-24`} placeholder="Rev #" value={rollbackRev} onChange={(event) => setRollbackRev(event.target.value)} />
            <ReasonAction label="Rollback" tone="danger" onRun={async (reason) => { const revision = Number(rollbackRev); if (!Number.isInteger(revision) || revision < 1) throw new Error("Enter a valid revision number"); return refreshPage((await api.knowledgeWikiRollback(page.id, revision, reason)).page); }} />
          </span>
        </div>
      </div>}
      <div className="mt-4 border-t border-gray-800 pt-3">
        <p className="text-xs uppercase tracking-wide text-gray-600">Revisions (append-only)</p>
        <ul className="mt-2 space-y-1.5">
          {revisions.map((revision) => <li key={revision.id} className="text-xs text-gray-400"><Badge tone="purple">r{revision.revision}</Badge> <span className="ml-1 text-gray-500">{formatDate(revision.createdAt)} · author {revision.authorId}</span> — {revision.changeReason}</li>)}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input className={`${inputClass} w-24`} value={diffRange.from} onChange={(event) => setDiffRange({ ...diffRange, from: event.target.value })} placeholder="From" />
          <input className={`${inputClass} w-24`} value={diffRange.to} onChange={(event) => setDiffRange({ ...diffRange, to: event.target.value })} placeholder="To" />
          <button className={btnGhost} onClick={() => run(async () => { const data = await api.knowledgeWikiDiff(page.id, Number(diffRange.from), Number(diffRange.to)); setDiff(data.diff ?? ""); return data; }, "Diff computed.")}><GitBranch size={13} /> Diff revisions</button>
        </div>
        {diff && <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-gray-800 bg-gray-950/60 p-3 text-xs text-gray-300">{diff}</pre>}
      </div>
    </section>}
  </div>;
}

const WEKNORA_STATUSES = ["staged", "published", "deprecated", "failed"] as const;

function WeknoraPane({ isAdmin }: { isAdmin: boolean }) {
  const emptyStage = { title: "", content: "", productVersion: "", solution: "", module: "", language: "" };
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ documents: any[]; page: { total: number } }>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState({ q: "", productVersion: "", solution: "", module: "", limit: "10" });
  const [search, setSearch] = useState<any>();
  const [searching, setSearching] = useState(false);
  const [stage, setStage] = useState(emptyStage);
  const [showStage, setShowStage] = useState(false);
  const [projects, setProjects] = useState<any[]>([]);
  const [projectScope, setProjectScope] = useState("");
  const load = (nextOffset = offset) => {
    setError("");
    api.knowledgeWeknoraDocuments({ status: status || undefined, limit: PAGE_LIMIT, offset: nextOffset })
      .then((result) => setData({ documents: result.documents ?? [], page: result.page ?? { total: 0 } }))
      .catch((err) => { setData({ documents: [], page: { total: 0 } }); setError(errText(err, "Unable to load WeKnora documents")); });
  };
  useEffect(() => { setOffset(0); load(0); }, [status]);
  useEffect(() => { api.listProjects().then((result) => { const available = result.projects ?? []; setProjects(available); const stored = Number(localStorage.getItem("knowledge.projectId")); const selected = available.find((project: any) => project.id === stored) ?? available[0]; setProjectScope(selected ? String(selected.id) : ""); }).catch((err) => setError(errText(err, "Unable to load projects"))); }, []);
  const run = async (task: () => Promise<any>, ok: string) => { setError(""); setNotice(""); try { await task(); setNotice(ok); load(); } catch (err) { setError(errText(err, "WeKnora operation failed")); } };
  const runSearch = async () => {
    setSearching(true); setError(""); setSearch(undefined);
    try {
      if (!projectScope) throw new Error("Select a project before searching WeKnora");
      setSearch(await api.knowledgeWeknoraSearch(buildWeknoraSearchBody(query, projectScope)));
    } catch (err) { setError(errText(err, "WeKnora search failed")); } finally { setSearching(false); }
  };
  return <div className="space-y-4">
    <section className={cardClass}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-medium text-gray-100">WeKnora documents</h3>
        <select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All statuses</option>
          {WEKNORA_STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <button className={btnGhost} onClick={() => load()}><RefreshCw size={13} /> Refresh</button>
        {isAdmin && <button className={btn} onClick={() => setShowStage(!showStage)}>Stage document</button>}
      </div>
      {showStage && isAdmin && <div className="mt-3 space-y-2 rounded-md border border-gray-800 bg-gray-950/50 p-3">
        <div className="grid gap-2 sm:grid-cols-4">
          <input className={inputClass} placeholder="Title" value={stage.title} onChange={(event) => setStage({ ...stage, title: event.target.value })} />
          <input className={inputClass} placeholder="Product version" value={stage.productVersion} onChange={(event) => setStage({ ...stage, productVersion: event.target.value })} />
          <input className={inputClass} placeholder="Solution" value={stage.solution} onChange={(event) => setStage({ ...stage, solution: event.target.value })} />
          <input className={inputClass} placeholder="Module" value={stage.module} onChange={(event) => setStage({ ...stage, module: event.target.value })} />
        </div>
        <textarea className="min-h-20 w-full rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-200 outline-none focus:border-indigo-500" placeholder="Document content" value={stage.content} onChange={(event) => setStage({ ...stage, content: event.target.value })} />
        <button className={btn} disabled={!stage.title.trim() || !stage.content.trim()} onClick={() => run(async () => {
          const body: Record<string, unknown> = { idempotencyKey: `weknora-stage:${Date.now()}:${stage.title.trim()}`, title: stage.title.trim(), content: stage.content };
          for (const key of ["productVersion", "solution", "module", "language"] as const) if (stage[key].trim()) body[key] = stage[key].trim();
          await api.knowledgeWeknoraDocumentStage(body); setStage(emptyStage); setShowStage(false);
        }, "Document staged (deduplicated on identical content).")}>Stage</button>
      </div>}
      <Err message={error} />
      {notice && <p className="mt-3 rounded-md border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-300">{notice}</p>}
      {!data ? <StatePanel state="loading" message="Loading WeKnora documents…" /> : <>
        <div className="mt-3 divide-y divide-gray-800">
          {data.documents.length === 0 && <p className="py-3 text-sm text-gray-500">No WeKnora documents in this filter.</p>}
          {data.documents.map((doc) => <div key={doc.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm text-gray-200">{doc.title}</p>
              <p className="text-xs text-gray-500">{doc.id} · {doc.product_version ?? "any version"}{doc.solution ? ` · ${doc.solution}` : ""}{doc.module ? ` · ${doc.module}` : ""} · attempts {doc.attempt_count}{doc.failure_code ? ` · ${doc.failure_code}` : ""} · {formatDate(doc.updated_at)}</p>
              {doc.failure_message && <p className="text-xs text-rose-300">{doc.failure_message}</p>}
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge value={doc.status} />
              {isAdmin && (doc.status === "staged" || doc.status === "failed") && <button className={btnGhost} onClick={() => run(() => api.knowledgeWeknoraDocumentPublish(doc.id), "Document published.")}>Publish</button>}
              {isAdmin && doc.status === "published" && <button className={btnDanger} onClick={() => { if (window.confirm("Deprecate this document? It leaves retrieval scope immediately.")) run(() => api.knowledgeWeknoraDocumentDeprecate(doc.id), "Document deprecated."); }}>Deprecate</button>}
            </div>
          </div>)}
        </div>
        <Pager offset={offset} limit={PAGE_LIMIT} total={data.page.total} count={data.documents.length} onPage={(next) => { setOffset(next); load(next); }} />
      </>}
    </section>
    <section className={cardClass}>
      <h3 className="font-medium text-gray-100">Retrieval test</h3>
      <p className="mt-1 text-xs text-gray-500">Queries the WeKnora side over published documents only; ACL-invisible documents are filtered out.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[180px_1fr_140px_140px_140px_90px]">
        <select aria-label="Search project" className={inputClass} value={projectScope} onChange={(event) => { setProjectScope(event.target.value); const project = projects.find((entry) => String(entry.id) === event.target.value); if (project) localStorage.setItem("knowledge.projectId", String(project.id)); }}>
          {projects.length === 0 && <option value="">No projects</option>}
          {projects.map((project) => <option key={project.id} value={String(project.id)}>{project.name}</option>)}
        </select>
        <input className={inputClass} placeholder="Query text" value={query.q} onChange={(event) => setQuery({ ...query, q: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" && query.q.trim()) runSearch(); }} />
        <input className={inputClass} placeholder="Version" value={query.productVersion} onChange={(event) => setQuery({ ...query, productVersion: event.target.value })} />
        <input className={inputClass} placeholder="Solution" value={query.solution} onChange={(event) => setQuery({ ...query, solution: event.target.value })} />
        <input className={inputClass} placeholder="Module" value={query.module} onChange={(event) => setQuery({ ...query, module: event.target.value })} />
        <input className={inputClass} placeholder="Limit" value={query.limit} onChange={(event) => setQuery({ ...query, limit: event.target.value })} />
      </div>
      <button className={`${btn} mt-2`} disabled={searching || !query.q.trim()} onClick={runSearch}>{searching ? <RefreshCw size={12} className="animate-spin" /> : null} Run search</button>
      {search && <div className="mt-3">
        <p className="text-xs text-gray-500">retrieval run {search.retrievalRunId}{search.degraded ? ` · degraded: ${typeof search.degraded === "object" ? JSON.stringify(search.degraded) : "yes"}` : ""}</p>
        <div className="mt-2 space-y-2">
          {(search.references ?? []).length === 0 && <p className="text-sm text-gray-500">No references returned.</p>}
          {(search.references ?? []).map((reference: any, index: number) => <div key={`${reference.documentId ?? index}-${index}`} className="rounded-md border border-gray-800 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-gray-300">{reference.title ?? reference.documentId ?? `reference ${index + 1}`}</span>
              {reference.score !== undefined && <Badge tone="blue">score {Number(reference.score).toFixed(3)}</Badge>}
            </div>
            {reference.snippet && <p className="mt-1 text-xs text-gray-500">{reference.snippet}</p>}
          </div>)}
        </div>
      </div>}
    </section>
  </div>;
}

function MigrationPane({ isAdmin }: { isAdmin: boolean }) {
  const emptyLocal = { parserVersion: "relay-normalizer-v1", productVersion: "", solution: "", module: "", limit: "", retry: false };
  const [provider, setProvider] = useState<string>();
  const [target, setTarget] = useState<"relay_local" | "weknora">("weknora");
  const [migrationId, setMigrationId] = useState("");
  const [migration, setMigration] = useState<any>();
  const [cleanup, setCleanup] = useState<any>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [local, setLocal] = useState(emptyLocal);
  useEffect(() => { api.knowledgeProductProvider().then((result) => setProvider(result.provider)).catch((err) => setError(errText(err, "Unable to load product provider routing"))); }, []);
  const run = async (task: () => Promise<any>, ok: string) => { setError(""); setNotice(""); try { const data = await task(); setNotice(ok); return data; } catch (err) { setError(errText(err, "Migration operation failed")); } };
  const loadMigration = async (id: string) => { setCleanup(undefined); const data = await run(() => api.knowledgeMigrations(id.trim()), "Migration loaded."); if (data?.migration) setMigration(data.migration); };
  const refreshRouting = () => api.knowledgeProductProvider().then((result) => setProvider(result.provider)).catch(() => undefined);
  return <div className="space-y-4">
    <section className={cardClass}>
      <div className="flex items-center gap-2"><GitBranch size={16} className="text-indigo-300" /><h3 className="font-medium text-gray-100">Product provider routing</h3></div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-gray-500">Active provider</span>
        {provider === undefined ? <span className="text-gray-500">loading…</span> : <StatusBadge value={provider} />}
      </div>
      {isAdmin && <div className="mt-3 flex flex-wrap items-center gap-2">
        <select className={inputClass} value={target} onChange={(event) => setTarget(event.target.value as "relay_local" | "weknora")}><option value="relay_local">relay_local</option><option value="weknora">weknora</option></select>
        {target === "weknora" && <input className={`${inputClass} w-72`} placeholder="Published migration id (required)" value={migrationId} onChange={(event) => setMigrationId(event.target.value)} />}
        <button className={btn} disabled={target === "weknora" && !migrationId.trim()} onClick={async () => { await run(async () => { const result = await api.knowledgeSetProductProvider(target, target === "weknora" ? migrationId.trim() : undefined); setProvider(result.provider); return result; }, "Routing updated."); refreshRouting(); }}>Apply routing</button>
      </div>}
      <p className="mt-2 text-xs text-gray-500">Switching to WeKnora requires a published migration; switching back to relay_local is always allowed.</p>
    </section>
    <section className={cardClass}>
      <h3 className="font-medium text-gray-100">Migration lookup</h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input className={`${inputClass} w-96`} placeholder="migration-…" value={migrationId} onChange={(event) => setMigrationId(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && migrationId.trim()) loadMigration(migrationId); }} />
        <button className={btnGhost} disabled={!migrationId.trim()} onClick={() => loadMigration(migrationId)}>Load</button>
      </div>
      {migration && <div className="mt-3">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-gray-200">{migration.id} · {migration.kind}</p>
          <StatusBadge value={migration.status} />
        </div>
        <p className="mt-1 text-xs text-gray-500">created {formatDate(migration.createdAt)}{migration.publishedAt ? ` · published ${formatDate(migration.publishedAt)}` : ""}{migration.rolledBackAt ? ` · rolled back ${formatDate(migration.rolledBackAt)}` : ""}{migration.rollbackReason ? ` · reason: ${migration.rollbackReason}` : ""}</p>
        {Object.keys(migration.report ?? {}).length > 0 && <details className="mt-2"><summary className="cursor-pointer text-xs text-gray-500">Report</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-gray-800 bg-gray-950/60 p-3 text-xs text-gray-300">{JSON.stringify(migration.report, null, 2)}</pre></details>}
        {isAdmin && <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className={btn} disabled={migration.status !== "staged"} onClick={() => run(async () => { const data = await api.knowledgeMigrationPublish(migration.id); setMigration(data.migration); }, "Migration validated and published.")}>Validate & publish</button>
          <ReasonAction label="Rollback" tone="danger" onRun={async (reason) => { const data = await api.knowledgeMigrationRollback(migration.id, reason); setMigration(data.migration); }} />
          <button className={btnGhost} onClick={() => run(async () => { setCleanup(await api.knowledgeMigrationCleanup(migration.id)); }, "Cleanup dry-run computed.")}>Cleanup dry-run</button>
        </div>}
        {cleanup && <div className="mt-3 rounded-md border border-gray-800 bg-gray-950/50 p-3 text-xs text-gray-400">
          <p className="text-gray-300">Cleanup dry-run · {formatDate(cleanup.generatedAt)}</p>
          <p className="mt-1">failed {cleanup.totals?.failed ?? 0} · deprecated {cleanup.totals?.deprecated ?? 0} · pending external {cleanup.totals?.pendingExternal ?? 0} · would delete {cleanup.totals?.wouldDelete ?? 0}{cleanup.totals?.truncated ? " (truncated)" : ""}</p>
          {cleanup.note && <p className="mt-1 text-gray-500">{cleanup.note}</p>}
        </div>}
      </div>}
    </section>
    {isAdmin && <section className={cardClass}>
      <h3 className="font-medium text-gray-100">Migrate local product documents (admin)</h3>
      <div className="mt-3 grid gap-2 sm:grid-cols-5">
        <input className={inputClass} placeholder="Parser version" value={local.parserVersion} onChange={(event) => setLocal({ ...local, parserVersion: event.target.value })} />
        <input className={inputClass} placeholder="Product version" value={local.productVersion} onChange={(event) => setLocal({ ...local, productVersion: event.target.value })} />
        <input className={inputClass} placeholder="Solution" value={local.solution} onChange={(event) => setLocal({ ...local, solution: event.target.value })} />
        <input className={inputClass} placeholder="Module" value={local.module} onChange={(event) => setLocal({ ...local, module: event.target.value })} />
        <input className={inputClass} placeholder="Limit" value={local.limit} onChange={(event) => setLocal({ ...local, limit: event.target.value })} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-gray-400"><input type="checkbox" checked={local.retry} onChange={(event) => setLocal({ ...local, retry: event.target.checked })} /> Retry failed documents</label>
        <button className={btn} disabled={!local.parserVersion.trim()} onClick={() => run(async () => {
          const body: Record<string, unknown> = { idempotencyKey: `migration-from-local:${Date.now()}`, parserVersion: local.parserVersion.trim(), retry: local.retry };
          for (const key of ["productVersion", "solution", "module"] as const) if (local[key].trim()) body[key] = local[key].trim();
          if (local.limit.trim()) body.limit = Number(local.limit);
          const data = await api.knowledgeMigrationFromLocal(body);
          setMigration(data.migration); setMigrationId(data.migration.id);
        }, "Migration created from local documents.")}>Create migration</button>
      </div>
    </section>}
    <Err message={error} />
    {notice && <p className="rounded-md border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-300">{notice}</p>}
  </div>;
}

function GatesPane() {
  const [gates, setGates] = useState<any>();
  const [error, setError] = useState("");
  const load = () => { setError(""); api.knowledgeReleaseGates().then(setGates).catch((err) => setError(errText(err, "Unable to load release gates"))); };
  useEffect(() => { load(); }, []);
  if (error && !gates) return <StatePanel state="error" message={error} onRetry={load} />;
  if (!gates) return <StatePanel state="loading" message="Running release gates…" />;
  const checks = Object.entries(gates.checks ?? {}) as Array<[string, any]>;
  return <div className="space-y-4">
    <section className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><CheckCircle2 size={16} className={gates.ready ? "text-emerald-300" : "text-rose-300"} /><h3 className="font-medium text-gray-100">Release gates</h3></div>
        <div className="flex items-center gap-2"><StatusBadge value={gates.ready ? "ready" : "blocked"} /><button className={btnGhost} onClick={load}><RefreshCw size={13} /> Re-run</button></div>
      </div>
      <p className="mt-1 text-xs text-gray-500">Checked at {formatDate(gates.checkedAt)}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {checks.map(([name, check]) => <div key={name} className="rounded-md border border-gray-800 p-3">
          <div className="flex items-center justify-between gap-2"><span className="text-xs text-gray-300">{name}</span><StatusBadge value={check?.ok ? "ok" : "failed"} /></div>
          <p className="mt-1 text-[11px] text-gray-500">{Object.entries(check ?? {}).filter(([key]) => key !== "ok" && key !== "findings").map(([key, value]) => `${key}: ${String(value)}`).join(" · ") || "no details"}</p>
          {Array.isArray(check?.findings) && check.findings.length > 0 && <ul className="mt-1 list-disc pl-4 text-[11px] text-rose-300">{check.findings.map((finding: string) => <li key={finding}>{finding}</li>)}</ul>}
        </div>)}
      </div>
    </section>
    {!gates.ready && <section className="rounded-lg border border-rose-900/60 bg-rose-950/20 p-4 text-sm text-rose-200">
      <div className="flex items-center gap-2"><ShieldAlert size={15} /><p className="font-medium">Findings</p></div>
      <ul className="mt-2 list-disc pl-5">{(gates.failures ?? []).map((failure: string) => <li key={failure}>{failure}</li>)}</ul>
    </section>}
  </div>;
}

const TABS = [
  ["sessions", "Sessions", Workflow],
  ["providers", "Providers", ServerCog],
  ["candidates", "Candidates", FileText],
  ["wiki", "Wiki", BookOpen],
  ["weknora", "WeKnora", GitBranch],
  ["migration", "Migration", GitBranch],
  ["gates", "Release gates", CheckCircle2],
] as const;

export default function KnowledgeIntegrated() {
  const { user } = useAuth();
  const isAdmin = Boolean(user?.isAdmin);
  const [tab, setTab] = useState<string>("sessions");
  return <PageShell title="Integrated Knowledge" description="Relay owns sessions, ACL, review and publication while WeKnora supplies Product Knowledge retrieval. Secrets are secretRef references only." breadcrumbs={[{ label: "Knowledge", to: "/knowledge" }, { label: "Integrated" }]}>
    <div className="mb-5 flex flex-wrap gap-2">
      {TABS.map(([key, label, Icon]) => <button key={key} onClick={() => setTab(key)} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs ${tab === key ? "bg-indigo-600 text-white" : "border border-gray-700 text-gray-300 hover:bg-gray-800"}`}><Icon size={13} /> {label}</button>)}
    </div>
    {tab === "sessions" && <SessionsPane />}
    {tab === "providers" && <ProvidersPane isAdmin={isAdmin} />}
    {tab === "candidates" && <CandidatesPane isAdmin={isAdmin} />}
    {tab === "wiki" && <WikiPane isAdmin={isAdmin} />}
    {tab === "weknora" && <WeknoraPane isAdmin={isAdmin} />}
    {tab === "migration" && <MigrationPane isAdmin={isAdmin} />}
    {tab === "gates" && <GatesPane />}
  </PageShell>;
}
