import { LazyKnowledgeMarkup as KnowledgeMarkup } from "../components/LazyKnowledgeMarkup";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BookOpen, CheckCircle2, ChevronLeft, ChevronRight, FileText, GitBranch, KeyRound, RefreshCw, ServerCog, ShieldAlert, Workflow } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../App";
import { Badge, cardClass, formatDate, inputClass, PageShell, StatePanel, StatusBadge } from "../components/KnowledgePrimitives";
import { ProviderSetupForm, type ProviderSetupDefaults } from "../components/ProviderSetupForm";
import { buildKnowledgeScope, buildWeknoraSearchBody, knowledgeItemScope, knowledgeItemMatchesScope, productEngineDocumentState, withKnowledgeScope } from "../knowledge/integrated-search";
import {createWikiNavigation} from "../knowledge/wiki-navigation";

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

function ProvidersPane({ isAdmin }: { isAdmin: boolean }) {
  const [providers, setProviders] = useState<any[]>();
  const [jobs, setJobs] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [engine, setEngine] = useState<any>();
  const [engineError, setEngineError] = useState("");
  const [engineBusy, setEngineBusy] = useState(false);
  const [engineSelection, setEngineSelection] = useState<Record<string,string>>({});
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<ProviderSetupDefaults>();
  const [formVersion, setFormVersion] = useState(0);
  const [rotating, setRotating] = useState(false);
  const [probe, setProbe] = useState<Record<string, any>>({});
  const [rotateId, setRotateId] = useState("");
  const [rotateRef, setRotateRef] = useState("");
  const load = () => {
    setError("");
    if (isAdmin) api.knowledgeEngine().then((value) => { setEngine(value); setEngineError(""); }).catch((err) => setEngineError(errText(err, "Unable to load engine status")));
    Promise.all([api.knowledgeManagedProviders(), api.knowledgeManagedProvidersReindex()])
      .then(([p, r]) => { setProviders(p.providers ?? []); setJobs(r.jobs ?? []); })
      .catch((err) => setError(errText(err, "Unable to load managed providers")));
  };
  useEffect(() => { load(); }, []);
  const run = async (task: () => Promise<any>, ok: string) => { setError(""); setNotice(""); try { await task(); setProbe({}); setNotice(ok); load(); } catch (err) { setError(errText(err, "Provider operation failed")); } };
  const test = async (id: string) => { setError(""); try { const { report } = await api.knowledgeManagedProviderTest(id); setProbe((current) => ({ ...current, [id]: report })); load(); } catch (err) { setError(errText(err, "Provider probe failed")); } };
  if (error && !providers) return <StatePanel state="error" message={error} onRetry={load} />;
  if (!providers) return <StatePanel state="loading" message="Loading managed providers…" />;
  return <div className="space-y-4">
    {isAdmin && <section className={cardClass} aria-label="Knowledge engine">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium text-gray-100">Knowledge engine</h3><StatusBadge value={engine?.phase ?? "loading"} /></div>
      <p className="mt-2 text-sm text-gray-400">Installed and started with Relay. Embeddings and Wiki generation use the managed providers below.</p>
      {engine && <p className="mt-2 text-xs text-gray-400">Version {engine.version ?? "not installed"} · Embedding {engine.embeddingProviderId ?? "not selected"} · Wiki {engine.wikiReady ? engine.wikiProviderId : "text model required"}</p>}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        {([["embedding","embeddingProviderId","Embedding"],["wiki_llm","wikiProviderId","Wiki generation"],["rerank","rerankProviderId","Rerank"]] as const).map(([kind,key,label]) => <label key={key} className="space-y-1 text-xs text-gray-400"><span className="block">{label}</span><select className={inputClass} value={engineSelection[key] ?? ""} onChange={(event) => setEngineSelection((value) => ({...value,[key]:event.target.value}))}><option value="">Use current or sole provider</option>{providers.filter((p) => p.kind===kind && p.status!=="disabled").map((p) => <option key={p.id} value={p.id}>{p.id} · {p.modelId}</option>)}</select></label>)}
        <button disabled={engineBusy || engine?.phase==="not_installed"} className={btnGhost} onClick={async () => {setEngineBusy(true);setEngineError("");try{setEngine(await api.knowledgeEngineInitialize(Object.fromEntries(Object.entries(engineSelection).filter(([,value]) => value))));}catch(err){setEngineError(errText(err,"Engine connection failed"));}finally{setEngineBusy(false);}}}>{engineBusy ? "Connecting…" : "Apply model connections"}</button>
      </div>
      {engine?.phase==="not_installed" && <p className="mt-3 text-sm text-amber-300">The Relay deployment has not installed the knowledge engine yet.</p>}
      <Err message={engineError} />
    </section>}
    <section className={cardClass}>
      <div className="flex items-center gap-2"><ServerCog size={16} className="text-indigo-300" /><h3 className="font-medium text-gray-100">Managed providers</h3></div>
      <p className="mt-1 text-xs text-gray-500">Tokens are encrypted on the server. Use the connection form below to select a model.</p>
      <div className="mt-3 divide-y divide-gray-800">
        {providers.length === 0 && <p className="py-3 text-sm text-gray-500">No remote providers configured.</p>}
        {providers.map((provider) => <div key={provider.id} className="py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-gray-200">{provider.id} · {provider.provider} · {provider.modelId}</p>
              <p className="text-xs text-gray-500">{provider.kind} · index v{provider.indexVersion} · {provider.tokenConfigured ? "token configured" : "no token configured"}{provider.dimensions ? ` · ${provider.dimensions}d` : ""}{provider.lastTestAt ? ` · tested ${formatDate(provider.lastTestAt)}` : ""}{provider.lastErrorCode ? ` · last error ${provider.lastErrorCode}` : ""}</p>
            </div>
            <div className="flex items-center gap-2">
              {provider.reindexRequired && <Badge tone="amber">reindex pending</Badge>}
              <StatusBadge value={provider.status} />
            </div>
          </div>
          {isAdmin && <div className="mt-2 flex flex-wrap items-center gap-2">
            <button className={btnGhost} onClick={() => test(provider.id)}>Test</button>
            <button className={btnGhost} onClick={() => { setEditing({ id: provider.id, kind: provider.kind, provider: provider.provider, baseUrl: provider.baseUrl, modelId: "" }); setFormVersion((n) => n + 1); }}>Edit configuration</button>
            <button className={btnGhost} onClick={() => { setRotateId(rotateId === provider.id ? "" : provider.id); setRotateRef(""); }}><KeyRound size={12} /> Replace token</button>
            <button className={btnDanger} disabled={!provider.tokenConfigured || rotating} onClick={() => { if (window.confirm("Clear the token and disable this provider?")) run(() => api.knowledgeProviderToken(provider.id, null), "Token cleared; provider disabled."); }}>Clear token</button>
            <button className={btnDanger} disabled={provider.status === "disabled"} onClick={() => { if (window.confirm(`Disable provider '${provider.id}'? This is audited.`)) run(() => api.knowledgeManagedProviderDisable(provider.id), "Provider disabled."); }}>Disable</button>
          </div>}
          {rotateId === provider.id && <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="space-y-1 text-sm text-gray-300"><span className="block">Replacement token</span><input type="password" autoComplete="new-password" disabled={rotating} className={`${inputClass} w-72`} value={rotateRef} onChange={(event) => setRotateRef(event.target.value)} /></label>
            <button className={btn} disabled={!rotateRef.trim() || rotating} onClick={() => run(async () => { setRotating(true); try { await api.knowledgeProviderToken(provider.id, rotateRef.trim()); setRotateId(""); setRotateRef(""); } finally { setRotating(false); } }, "Token tested and replaced.")}>{rotating ? "Testing…" : "Test and replace"}</button>
          </div>}
          {probe[provider.id] && <p className={`mt-2 text-xs ${probe[provider.id].ok ? "text-emerald-300" : "text-rose-300"}`}>Probe {probe[provider.id].ok ? `ok · ${probe[provider.id].latencyMs ?? "?"}ms · HTTP ${probe[provider.id].httpStatus ?? "?"}` : `failed · ${probe[provider.id].errorCode ?? "unknown"}`}</p>}
        </div>)}
      </div>
    </section>
    {isAdmin && <ProviderSetupForm key={formVersion} initial={editing} onCancel={() => { setEditing(undefined); setFormVersion((n) => n + 1); }} onSaved={(dimensions) => { setEditing(undefined); setFormVersion((n) => n + 1); setNotice("Provider tested and saved." + (dimensions ? " Detected " + dimensions + " dimensions." : "")); load(); }} />}
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
      const { session } = await api.knowledgeSession(insight.workSessionId);
      setSelected({ ...insight, sourceEnvironment: insight.sourceScope?.environment ?? session.environment, sessionUpdatedAt: session.updatedAt, currentSessionScope: { projectId: session.projectId, environment: session.environment, sampleManagerVersion: session.intent?.sampleManagerVersion, solution: session.intent?.solution, module: session.intent?.module } }); setHistory(detail.history ?? []);
      setEdit({ statement: insight.statement ?? "", kind: insight.kind ?? INSIGHT_KINDS[0] });
    } catch (err) { setError(errText(err, "Unable to load Candidate Insight")); }
  };
  const refresh = async (insight: any) => { setSelected({ ...insight, sourceEnvironment: insight.sourceScope?.environment ?? selected?.sourceEnvironment, sessionUpdatedAt: selected?.sessionUpdatedAt, currentSessionScope: selected?.currentSessionScope }); const detail = await api.knowledgeCandidateInsightHistory(insight.id); setHistory(detail.history ?? []); load(); };
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
          <div className="mt-3 flex flex-wrap gap-2">{(selected.evidenceRefs ?? []).map((id: string, index: number) => <Link key={id} className={btnGhost} to={withKnowledgeScope(`/knowledge/evidence?document=${encodeURIComponent(id)}`, { projectId: String(selected.projectId), environment: selected.sourceEnvironment })}>View evidence {index + 1}</Link>)}</div>
          {selected.promotion && <p className="mt-3 text-sm text-emerald-300">Promoted to {selected.promotion.target}{selected.promotion.targetId && <> · <Link className="underline" to={withKnowledgeScope(`/knowledge/confirmed-memory?memory=${encodeURIComponent(selected.promotion.targetId)}`, { projectId: String(selected.projectId), environment: selected.sourceEnvironment })}>Open Memory</Link></>}</p>}
        </div>
        <StatusBadge value={selected.status} />
      </div>
      {selected.scopeReviewRequired && <div className="mt-4 rounded-md border border-amber-900 bg-amber-950/20 p-3 text-sm text-amber-200">
        <p>This record needs a source scope review before it can be promoted or reused by default.</p>
        <p className="mt-2 text-xs">Current Session: Project {selected.currentSessionScope?.projectId} · Environment {selected.currentSessionScope?.environment ?? "unspecified"} · Version {selected.currentSessionScope?.sampleManagerVersion ?? "unspecified"} · Solution {selected.currentSessionScope?.solution ?? "unspecified"} · Module {selected.currentSessionScope?.module ?? "unspecified"}</p>
        {isAdmin && selected.status !== "rejected" && <div className="mt-3 flex flex-wrap gap-2"><ReasonAction label="Review current Session scope" onRun={async (reason) => { await refresh((await api.knowledgeCandidateInsightReviewScope(selected.id, reason, selected.sessionUpdatedAt)).insight); }} /><button className={btnGhost} onClick={() => openDetail(selected.id)}>Reload scope</button></div>}
        <p className="mt-2 text-xs">{selected.status === "rejected" ? "This Candidate was rejected. Compile and review a new Candidate to reuse the evidence." : "Reviewing restores any existing Case to this scope for retrieval. Its content, evidence and lifecycle remain unchanged."}</p>
      </div>}
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
        {selected.status === "accepted" && !selected.promotion && !selected.scopeReviewRequired && <div className="flex flex-wrap items-center gap-2">
          <select className={inputClass} value={promoteTarget} onChange={(event) => setPromoteTarget(event.target.value as "fact" | "decision" | "case" | "pattern")}><option value="fact">fact</option><option value="decision">decision</option><option value="case">case</option><option value="pattern">pattern</option></select>
          <input className={`${inputClass} w-56`} placeholder="Promotion title (optional)" value={promoteTitle} onChange={(event) => setPromoteTitle(event.target.value)} />
          <ReasonAction label="Promote" onRun={async (reason) => { const result = await api.knowledgeCandidateInsightPromote(selected.id, { target: promoteTarget, reason, title: promoteTitle.trim() || undefined }); await refresh({ ...selected, promotion: result.promotion }); }} />
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

function useProjectScope() {
  const [params, setParams] = useSearchParams();
  const [projects, setProjects] = useState<any[]>([]);
  const [scopeError, setScopeError] = useState("");
  const scope = buildKnowledgeScope({ projectId: params.get("projectId") ?? undefined, environment: params.get("environment") ?? undefined });
  useEffect(() => {
    let cancelled = false;
    api.listProjects().then((result) => {
      if (cancelled) return;
      const available = result.projects ?? [];
      setProjects(available);
      setParams((current) => {
        if (current.get("projectId")) return current;
        const stored = localStorage.getItem("knowledge.projectId");
        const selected = available.find((project: any) => String(project.id) === stored) ?? available[0];
        if (!selected) return current;
        const next = new URLSearchParams(current); next.set("projectId", String(selected.id)); return next;
      }, { replace: true });
    }).catch((err) => { if (!cancelled) setScopeError(errText(err, "Unable to load projects")); });
    return () => { cancelled = true; };
  }, []);
  const setScope = (key: "projectId" | "environment", value: string) => {
    if (key === "projectId" && value) localStorage.setItem("knowledge.projectId", value);
    setParams((current) => { const next = new URLSearchParams(current); value ? next.set(key, value) : next.delete(key); next.delete("wikiPage"); next.delete("wikiKey"); return next; }, { replace: true });
  };
  return { scope, projects, scopeError, setScope, environmentValue: params.get("environment") ?? "" };
}

function ScopeControls({ selection, allowAllProjects = false, environmentPlaceholder = "Default environment" }: { selection: ReturnType<typeof useProjectScope>; allowAllProjects?: boolean; environmentPlaceholder?: string }) {
  return <div className="mb-3 flex flex-wrap items-end gap-3">
    <label className="space-y-1 text-xs text-gray-400"><span className="block">Project</span><select className={inputClass} value={selection.scope.projectId ?? ""} onChange={(event) => selection.setScope("projectId", event.target.value)}>
      {allowAllProjects ? <option value="">All projects</option> : !selection.scope.projectId && <option value="">Select a project</option>}
      {selection.scope.projectId && !selection.projects.some((project) => String(project.id) === selection.scope.projectId) && <option value={selection.scope.projectId}>{selection.scope.projectId}</option>}
      {selection.projects.map((project) => <option key={project.id} value={String(project.id)}>{project.name}</option>)}
    </select></label>
    <label className="space-y-1 text-xs text-gray-400"><span className="block">Environment</span><input className={inputClass} placeholder={environmentPlaceholder} value={selection.environmentValue} onChange={(event) => selection.setScope("environment", event.target.value)} /></label>
    {selection.scopeError && <p className="text-xs text-rose-300">{selection.scopeError}</p>}
  </div>;
}

function WikiPane({ isAdmin }: { isAdmin: boolean }) {
  const selection = useProjectScope(); const { scope } = selection;
  const [params,setParams] = useSearchParams();
  const selectedPage=params.get("wikiPage"), selectedKey=params.get("wikiKey");
  const navigation=useRef(createWikiNavigation());
  const currentNavigation=navigation.current.capture(JSON.stringify([scope.projectId,scope.environment,selectedPage,selectedKey]));
  const listRequest = useRef(0);
  const [sources, setSources] = useState<any[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourceRefs, setSourceRefs] = useState<string[]>([]);
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
    const requestId = ++listRequest.current;
    if (!scope.projectId) { setResult({ items: [], total: 0 }); return; }
    setError("");
    api.knowledgeWikiPages({ ...scope, search: applied.search || undefined, status: applied.status || undefined, limit: PAGE_LIMIT, offset: nextOffset })
      .then((data) => { if (requestId === listRequest.current) setResult({ items: data.items ?? [], total: data.total ?? 0 }); })
      .catch((err) => { if (requestId !== listRequest.current) return; setResult({ items: [], total: 0 }); setError(errText(err, "Unable to load Wiki pages")); });
  };
  useEffect(() => { setOffset(0); setResult(undefined); setSourceRefs([]); setNotice(""); load(0); return () => { listRequest.current++; }; }, [applied, scope.projectId, scope.environment]);
  useEffect(() => {
    if (!showCreate || !scope.projectId) { setSources([]); return; }
    let cancelled = false;
    setSourcesLoading(true); setSources([]); setSourceRefs([]);
    const loadSources = async () => {
      const available: any[] = []; let offset = 0;
      while (!cancelled) {
        const result = await api.knowledgeWeknoraDocuments({ ...scope, status: "published", limit: 100, offset });
        const rows = result.documents ?? []; available.push(...rows);
        offset += rows.length;
        if (!rows.length || offset >= (result.page?.total ?? offset)) break;
      }
      if (!cancelled) setSources(available.filter((document) => knowledgeItemMatchesScope(document, scope) && productEngineDocumentState(document).verified && (!create.productVersion.trim() || String(document.product_version ?? document.productVersion ?? "") === create.productVersion.trim())));
    };
    loadSources().catch((err) => { if (!cancelled) setError(errText(err, "Unable to load published sources")); }).finally(() => { if (!cancelled) setSourcesLoading(false); });
    return () => { cancelled = true; };
  }, [showCreate, scope.projectId, scope.environment, create.productVersion]);
  const run = async (task: () => Promise<any>, ok: string) => {
    setError("");setNotice("");
    try {const data=await task();currentNavigation.commit(()=>{setNotice(ok);load();});return data;}
    catch(err){currentNavigation.commit(()=>setError(errText(err,"Wiki operation failed")));}
  };
  const openPage = (item: any) => setParams(current => {
    const next=new URLSearchParams(current); next.set("wikiPage",item.id); next.delete("wikiKey"); return next;
  });
  useEffect(() => {
    let cancelled=false;
    setPage(undefined); setRevisions([]); setError(""); setDiff("");
    if (!scope.projectId || (!selectedPage && !selectedKey)) return;
    const read = async () => {
      const {page:detail}=selectedKey ? await api.knowledgeWikiResolve(selectedKey,scope) : await api.knowledgeWikiPage(selectedPage!,scope);
      if (cancelled || !currentNavigation.isCurrent()) return;
      // Defense in depth; the Relay endpoint authorizes the target independently.
      if (!knowledgeItemMatchesScope(detail,scope) && (detail.projectId || detail.environment)) throw new Error("Wiki page is outside the selected scope");
      const revs=await api.knowledgeWikiRevisions(detail.id,scope);
      if (cancelled || !currentNavigation.isCurrent()) return;
      setPage(detail); setRevisions(revs.revisions ?? []);
      setEditBody({title:detail.title,body:detail.body});
      setDiffRange({from:String(Math.max(1,detail.currentRevision-1)),to:String(detail.currentRevision)});
    };
    read().catch(err => {if (!cancelled) currentNavigation.commit(()=>setError(errText(err,"Unable to load Wiki page")));});
    return () => {cancelled=true;};
  },[selectedPage,selectedKey,scope.projectId,scope.environment]);
  const refreshPage = async (updated: any) => {
    if (!currentNavigation.isCurrent()) return;
    const revs=await api.knowledgeWikiRevisions(updated.id,scope);
    currentNavigation.commit(()=>{setPage(updated);setEditBody({title:updated.title,body:updated.body});setRevisions(revs.revisions ?? []);load();});
  };
  return <div className="space-y-4">
    <section className={cardClass}>
      <ScopeControls selection={selection} />
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
        <label className="block space-y-1 text-xs text-gray-400"><span>Published source documents (select one or more)</span>
          <select multiple size={4} className={`${inputClass} h-auto w-full`} value={sourceRefs} disabled={sourcesLoading} onChange={(event) => setSourceRefs(Array.from(event.target.selectedOptions, (option) => option.value))}>
            {sources.map((source) => <option key={source.id} value={source.id}>{source.title}{source.product_version ?? source.productVersion ? ` · v${source.product_version ?? source.productVersion}` : ""}{source.environment ? ` · ${source.environment}` : ""}</option>)}
          </select>
          <span>{sourcesLoading ? "Loading verified published sources…" : sources.length ? "Hold Ctrl or Command to select multiple sources." : "No verified published documents in this scope. Publish a parsed Product document first."}</span>
        </label>
        <textarea className="min-h-24 w-full rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-200 outline-none focus:border-indigo-500" placeholder="Page body" value={create.body} onChange={(event) => setCreate({ ...create, body: event.target.value })} />
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${inputClass} w-72`} placeholder="Creation reason (required)" value={create.reason} onChange={(event) => setCreate({ ...create, reason: event.target.value })} />
          <button className={btn} disabled={!scope.projectId || sourcesLoading || !sourceRefs.length || !create.pageKey.trim() || !create.title.trim() || !create.body.trim() || !create.reason.trim()} onClick={() => run(async () => { const { page: created } = await api.knowledgeWikiCreate({ ...scope, sourceRefs, pageKey: create.pageKey.trim(), title: create.title.trim(), body: create.body, productVersion: create.productVersion.trim() || undefined, reason: create.reason.trim() }); currentNavigation.commit(()=>{setCreate(emptyCreate);setSourceRefs([]);setShowCreate(false);}); return created; }, "Wiki page created.")}>Create</button>
        </div>
      </div>}
      <Err message={error} />
      {notice && <p className="mt-3 rounded-md border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-300">{notice}</p>}
      {!result ? <StatePanel state="loading" message="Loading Wiki pages…" /> : <>
        <div className="mt-3 divide-y divide-gray-800">
          {result.items.length === 0 && <p className="py-3 text-sm text-gray-500">No Wiki pages match.</p>}
          {result.items.map((item) => <button key={item.id} onClick={() => openPage(item)} className="flex w-full flex-wrap items-center justify-between gap-3 py-2.5 text-left">
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
      <div className="mt-3 rounded-md border border-gray-800 bg-gray-950/60 p-4"><KnowledgeMarkup source={page.body} wikiScope={scope} wikiPageKey={page.pageKey} /></div>
      <div className="mt-4 border-t border-gray-800 pt-3">
        <h4 className="text-sm font-medium text-gray-200">Source documents</h4>
        <p className="mt-1 text-xs text-gray-500">Check the cited source before approving a Wiki statement.</p>
        {(page.citations ?? []).length === 0 && <p className="mt-2 text-xs text-amber-300">No verified Product source is linked.</p>}
        <ul className="mt-2 space-y-2">{(page.citations ?? []).map((citation: any) => <li key={citation.documentId} className="rounded-md border border-gray-800 p-3 text-xs text-gray-400">
          <Link className="font-medium text-indigo-300 underline" to={withKnowledgeScope(`/knowledge/product-docs?document=${encodeURIComponent(citation.documentId)}`, knowledgeItemScope(page, scope))}>{citation.title || "Open source document"}</Link>
          <p className="mt-1">Version {citation.productVersion ?? "unspecified"} · {(citation.chunkIds ?? []).length} source chunks</p>
          <p className="mt-1 break-all">{citation.sourceLocator}</p>
          <details className="mt-2"><summary className="cursor-pointer text-gray-500">Source verification</summary><p className="mt-1 break-all">SHA-256: {citation.sourceSha256 ?? "unavailable"}</p><p className="mt-1 break-all">Chunks: {(citation.chunkIds ?? []).join(", ")}</p></details>
        </li>)}</ul>
      </div>
      {page.status === "deprecated" && <p className="mt-4 text-sm text-amber-300">This Wiki page is deprecated. Its revisions and sources remain available.</p>}
      {isAdmin && page.status !== "deprecated" && <div className="mt-4 space-y-3 border-t border-gray-800 pt-3">
        <div className="grid gap-2 sm:grid-cols-[1fr] ">
          <input className={inputClass} value={editBody.title} onChange={(event) => setEditBody({ ...editBody, title: event.target.value })} placeholder="Title" />
          <textarea className="min-h-20 rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-200 outline-none focus:border-indigo-500" value={editBody.body} onChange={(event) => setEditBody({ ...editBody, body: event.target.value })} placeholder="Body" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ReasonAction label="Save edit" onRun={async (reason) => refreshPage((await api.knowledgeWikiEdit(page.id, { title: editBody.title, body: editBody.body, reason }, knowledgeItemScope(page, scope))).page)} />
          {page.status !== "published" && <ReasonAction label="Publish" onRun={async (reason) => refreshPage((await api.knowledgeWikiPublish(page.id, reason, knowledgeItemScope(page, scope))).page)} />}
          {page.status === "published" && <ReasonAction label="Deprecate" tone="danger" onRun={async (reason) => refreshPage((await api.knowledgeWikiDeprecate(page.id, reason, knowledgeItemScope(page, scope))).page)} />}
          <span className="inline-flex items-center gap-1.5">
            <input className={`${inputClass} w-24`} placeholder="Rev #" value={rollbackRev} onChange={(event) => setRollbackRev(event.target.value)} />
            <ReasonAction label="Rollback" tone="danger" onRun={async (reason) => { const revision = Number(rollbackRev); if (!Number.isInteger(revision) || revision < 1) throw new Error("Enter a valid revision number"); return refreshPage((await api.knowledgeWikiRollback(page.id, revision, reason, knowledgeItemScope(page, scope))).page); }} />
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
          <button className={btnGhost} onClick={() => run(async () => { const data = await api.knowledgeWikiDiff(page.id, Number(diffRange.from), Number(diffRange.to), scope); currentNavigation.commit(()=>setDiff(data.diff ?? "")); return data; }, "Diff computed.")}><GitBranch size={13} /> Diff revisions</button>
        </div>
        {diff && <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-gray-800 bg-gray-950/60 p-3 text-xs text-gray-300">{diff}</pre>}
      </div>
    </section>}
  </div>;
}

const WEKNORA_STATUSES = ["staged", "published", "deprecated", "failed"] as const;

function WeknoraPane({ isAdmin }: { isAdmin: boolean }) {
  const selection = useProjectScope(); const { scope } = selection;
  const listRequest = useRef(0);
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
  const load = (nextOffset = offset) => {
    const requestId = ++listRequest.current;
    if (!scope.projectId) { setData({ documents: [], page: { total: 0 } }); return; }
    setError("");
    api.knowledgeWeknoraDocuments({ ...scope, status: status || undefined, limit: PAGE_LIMIT, offset: nextOffset })
      .then((result) => { if (requestId === listRequest.current) setData({ documents: result.documents ?? [], page: result.page ?? { total: 0 } }); })
      .catch((err) => { if (requestId !== listRequest.current) return; setData({ documents: [], page: { total: 0 } }); setError(errText(err, "Unable to load Product engine documents")); });
  };
  useEffect(() => { setOffset(0); setData(undefined); setSearch(undefined); setNotice(""); load(0); return () => { listRequest.current++; }; }, [status, scope.projectId, scope.environment]);
  const run = async (task: () => Promise<any>, ok: string) => { setError(""); setNotice(""); try { await task(); setNotice(ok); load(); } catch (err) { setError(errText(err, "Product engine operation failed")); } };
  const runSearch = async () => {
    const requestId = listRequest.current;
    setSearching(true); setError(""); setSearch(undefined);
    try {
      if (!scope.projectId) throw new Error("Select a project before searching Product engine");
      const result = await api.knowledgeWeknoraSearch(buildWeknoraSearchBody(query, scope.projectId, scope.environment));
      if (requestId === listRequest.current) setSearch(result);
    } catch (err) { setError(errText(err, "Product engine search failed")); } finally { setSearching(false); }
  };
  return <div className="space-y-4">
    <section className={cardClass}>
      <ScopeControls selection={selection} />
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-medium text-gray-100">Product engine documents</h3>
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
        <button className={btn} disabled={!scope.projectId || !stage.title.trim() || !stage.content.trim()} onClick={() => run(async () => {
          const body: Record<string, unknown> = { ...scope, idempotencyKey: `weknora-stage:${Date.now()}:${stage.title.trim()}`, title: stage.title.trim(), content: stage.content };
          for (const key of ["productVersion", "solution", "module", "language"] as const) if (stage[key].trim()) body[key] = stage[key].trim();
          const result = await api.knowledgeWeknoraDocumentStage(body);
          const document = result.document?.document ?? result.document;
          if (!document || !productEngineDocumentState(document).verified) throw new Error("The document has not completed parsing and chunk verification.");
          setStage(emptyStage); setShowStage(false);
        }, "Document content verified.")}>Stage</button>
      </div>}
      <Err message={error} />
      {notice && <p className="mt-3 rounded-md border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-300">{notice}</p>}
      {!data ? <StatePanel state="loading" message="Loading Product engine documents…" /> : <>
        <div className="mt-3 divide-y divide-gray-800">
          {data.documents.length === 0 && <p className="py-3 text-sm text-gray-500">No Product engine documents in this filter.</p>}
          {data.documents.map((doc) => { const readiness = productEngineDocumentState(doc); return <div key={doc.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm text-gray-200">{doc.title}</p>
              <p className="text-xs text-gray-500">{doc.id} · {doc.product_version ?? "any version"}{doc.solution ? ` · ${doc.solution}` : ""}{doc.module ? ` · ${doc.module}` : ""} · attempts {doc.attempt_count}{doc.failure_code ? ` · ${doc.failure_code}` : ""} · {formatDate(doc.updated_at)}</p>
              <p className="mt-1 text-xs text-gray-500">Parse: {readiness.parseStatus ?? "unverified"} · {readiness.chunkCount} chunks{readiness.verified ? ` · verified ${formatDate(readiness.verifiedAt)}` : " · not ready for publication"}</p>
              {readiness.modelProvenance && <p className="text-xs text-gray-500">Embedding: {readiness.modelProvenance.providerId} / {readiness.modelProvenance.modelId} · {readiness.modelProvenance.dimensions} dimensions · index v{readiness.modelProvenance.indexVersion}</p>}
              {doc.failure_message && <p className="text-xs text-rose-300">{doc.failure_message}</p>}
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge value={doc.status} />
              {isAdmin && readiness.canPublish && <button className={btnGhost} onClick={() => run(() => api.knowledgeWeknoraDocumentPublish(doc.id), "Document published.")}>Publish</button>}
              {isAdmin && doc.status === "published" && <button className={btnDanger} onClick={() => { if (window.confirm("Deprecate this document? It leaves retrieval scope immediately.")) run(() => api.knowledgeWeknoraDocumentDeprecate(doc.id), "Document deprecated."); }}>Deprecate</button>}
            </div>
          </div>; })}
        </div>
        <Pager offset={offset} limit={PAGE_LIMIT} total={data.page.total} count={data.documents.length} onPage={(next) => { setOffset(next); load(next); }} />
      </>}
    </section>
    <section className={cardClass}>
      <h3 className="font-medium text-gray-100">Retrieval test</h3>
      <p className="mt-1 text-xs text-gray-500">Searches published Product documents in the selected project and environment; ACL-invisible documents are filtered out.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_140px_140px_140px_90px]">
        <input className={inputClass} placeholder="Query text" value={query.q} onChange={(event) => setQuery({ ...query, q: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" && query.q.trim()) runSearch(); }} />
        <input className={inputClass} placeholder="Version" value={query.productVersion} onChange={(event) => setQuery({ ...query, productVersion: event.target.value })} />
        <input className={inputClass} placeholder="Solution" value={query.solution} onChange={(event) => setQuery({ ...query, solution: event.target.value })} />
        <input className={inputClass} placeholder="Module" value={query.module} onChange={(event) => setQuery({ ...query, module: event.target.value })} />
        <input className={inputClass} placeholder="Limit" value={query.limit} onChange={(event) => setQuery({ ...query, limit: event.target.value })} />
      </div>
      <button className={`${btn} mt-2`} disabled={searching || !scope.projectId || !query.q.trim()} onClick={runSearch}>{searching ? <RefreshCw size={12} className="animate-spin" /> : null} Run search</button>
      {search && <div className="mt-3">
        <p className="text-xs text-gray-500">retrieval run {search.retrievalRunId}{search.degraded ? ` · degraded: ${typeof search.degraded === "object" ? JSON.stringify(search.degraded) : "yes"}` : ""}</p>
        <div className="mt-2 space-y-2">
          {(search.references ?? []).length === 0 && <p className="text-sm text-gray-500">No references returned.</p>}
          {(search.references ?? []).map((reference: any, index: number) => <div key={`${reference.documentId ?? index}-${index}`} className="rounded-md border border-gray-800 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link className="text-xs text-gray-300 hover:text-indigo-300" to={withKnowledgeScope(`/knowledge/product-docs?document=${encodeURIComponent(reference.documentId ?? "")}`, knowledgeItemScope(reference, scope))}>{reference.title ?? `Reference ${index + 1}`}</Link>
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
  const selection = useProjectScope();
  const [searchParams, setSearchParams] = useSearchParams();
  const jobId = searchParams.get("migrationJob") ?? "";
  const [job, setJob] = useState<any>();
  const [submitting, setSubmitting] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const [operationKey, setOperationKey] = useState(() => `migration-from-local:${crypto.randomUUID()}`);
  const emptyLocal = { parserVersion: "relay-normalizer-v1", productVersion: "", solution: "", module: "", limit: "", retry: false };
  const [provider, setProvider] = useState<string>();
  const [target, setTarget] = useState<"relay_local" | "weknora">("weknora");
  const [migrationId, setMigrationId] = useState("");
  const [migration, setMigration] = useState<any>();
  const [cleanup, setCleanup] = useState<any>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [local, setLocal] = useState(emptyLocal);
  const selectJob = (id: string) => setSearchParams(previous => { const next = new URLSearchParams(previous); if (id) next.set("migrationJob", id); else next.delete("migrationJob"); return next; });
  useEffect(() => {
    if (!isAdmin || !jobId) return;
    let cancelled = false; let loaded = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await api.knowledgeIngestJob(jobId);
        if (cancelled) return;
        if (data.job.kind !== "product_migration") throw new Error("This task is not a product migration");
        setError("");
        setJob(data.job);
        const id = data.job.result?.migrationId;
        if (id && (!loaded || !["queued", "running"].includes(data.job.status))) {
          setMigrationId(id);
          const detail = await api.knowledgeMigrations(id);
          if (cancelled) return;
          setMigration(detail.migration);
          setOperationKey(detail.migration.idempotencyKey);
          loaded = true;
        }
        if (["queued", "running"].includes(data.job.status)) timer = setTimeout(poll, 2000);
        else if (data.job.status === "failed") setError(data.job.error || "Migration failed. Retry explicitly after checking the report.");
        else setNotice("Migration staging completed. Review the report before publishing.");
      } catch (err) {
        if (!cancelled) { setError(errText(err, "Unable to read migration progress; retrying status query")); timer = setTimeout(poll, 5000); }
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [jobId, isAdmin, pollVersion]);
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
        <select className={inputClass} value={target} onChange={(event) => setTarget(event.target.value as "relay_local" | "weknora")}><option value="relay_local">relay_local</option><option value="weknora">Product engine</option></select>
        {target === "weknora" && <input className={`${inputClass} w-72`} placeholder="Published migration id (required)" value={migrationId} onChange={(event) => setMigrationId(event.target.value)} />}
        <button className={btn} disabled={target === "weknora" && !migrationId.trim()} onClick={async () => { await run(async () => { const result = await api.knowledgeSetProductProvider(target, target === "weknora" ? migrationId.trim() : undefined); setProvider(result.provider); return result; }, "Routing updated."); refreshRouting(); }}>Apply routing</button>
      </div>}
      <p className="mt-2 text-xs text-gray-500">Switching to the Product engine requires a published migration; switching back to relay_local is always allowed.</p>
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
          <button className={btn} disabled={migration.status !== "staged" || ["queued", "running"].includes(job?.status)} onClick={() => run(async () => { const data = await api.knowledgeMigrationPublish(migration.id); setMigration(data.migration); }, "Migration validated and published.")}>Validate & publish</button>
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
      <h3 className="mb-3 font-medium text-gray-100">Migrate local product documents (admin)</h3>
      <ScopeControls selection={selection} allowAllProjects environmentPlaceholder="All environments" />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input aria-label="Migration operation key" className={`${inputClass} w-96`} value={operationKey} onChange={event => setOperationKey(event.target.value)} />
        <button className={btnGhost} disabled={submitting || ["queued", "running"].includes(job?.status)} onClick={() => { selectJob(""); setJob(undefined); setOperationKey(`migration-from-local:${crypto.randomUUID()}`); setError(""); setNotice(""); }}>New operation</button>
      </div>
      {jobId && <div className="mt-2 text-xs text-gray-400">
        <p>{jobId} · {job?.status ?? "loading"}</p>
        <p>Processed {job?.result?.processed ?? 0} / {job?.result?.total ?? 0} · mapped {job?.result?.mapped ?? 0} · failed {job?.result?.failed ?? 0}</p>
        <p>This page URL restores task progress after reload. Publication is a separate action.</p>
      </div>}
      <div className="mt-3 grid gap-2 sm:grid-cols-5">
        <input className={inputClass} placeholder="Parser version" value={local.parserVersion} onChange={(event) => setLocal({ ...local, parserVersion: event.target.value })} />
        <input className={inputClass} placeholder="Product version" value={local.productVersion} onChange={(event) => setLocal({ ...local, productVersion: event.target.value })} />
        <input className={inputClass} placeholder="Solution" value={local.solution} onChange={(event) => setLocal({ ...local, solution: event.target.value })} />
        <input className={inputClass} placeholder="Module" value={local.module} onChange={(event) => setLocal({ ...local, module: event.target.value })} />
        <input className={inputClass} placeholder="Limit" value={local.limit} onChange={(event) => setLocal({ ...local, limit: event.target.value })} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {job?.status === "failed" && migration?.sourceManifest?.asyncRequest && <button className={btn} disabled={submitting} onClick={() => run(async () => {
          setSubmitting(true);
          try {
            const data = await api.knowledgeMigrationFromLocal({ ...migration.sourceManifest.asyncRequest, asynchronous: true, retry: true });
            setJob(data.job); setMigration(data.migration);
            selectJob(data.job!.id); setPollVersion(value => value + 1);
          } finally { setSubmitting(false); }
        }, "Migration retry queued.")}>Retry failed migration</button>}
        <button className={btn} disabled={submitting || !!jobId || !operationKey.trim() || !local.parserVersion.trim()} onClick={() => run(async () => {
          const body: Record<string, unknown> = { ...selection.scope, idempotencyKey: operationKey.trim(), parserVersion: local.parserVersion.trim(), asynchronous: true };
          for (const key of ["productVersion", "solution", "module"] as const) if (local[key].trim()) body[key] = local[key].trim();
          if (local.limit.trim()) body.limit = Number(local.limit);
          setSubmitting(true);
          try {
            const data = await api.knowledgeMigrationFromLocal(body);
            setMigration(data.migration); setMigrationId(data.migration.id); setJob(data.job); selectJob(data.job!.id);
          } finally { setSubmitting(false); }
        }, "Migration queued. Progress is saved after each document.")}>Create migration</button>
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
  ["weknora", "Product engine", GitBranch],
  ["migration", "Migration", GitBranch],
  ["gates", "Release gates", CheckCircle2],
] as const;

export default function KnowledgeIntegrated() {
  const { user } = useAuth();
  const isAdmin = Boolean(user?.isAdmin);
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "sessions";
  const setTab = (value: string) => setParams((current) => { const next = new URLSearchParams(current); next.set("tab", value); return next; });
  return <PageShell title="Integrated Knowledge" description="Relay owns sessions, ACL, review and publication while the Knowledge engine supplies Product retrieval and Wiki content. Provider credentials are encrypted and managed on the server." breadcrumbs={[{ label: "Knowledge", to: "/knowledge" }, { label: "Integrated" }]}>
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
