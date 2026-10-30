import { LazyKnowledgeMarkup as KnowledgeMarkup } from "../components/LazyKnowledgeMarkup";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BookOpen, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, FileText, Folder, GitCompare, History, KeyRound, Network, Pencil, RefreshCw, ServerCog, ShieldAlert, Workflow } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../App";
import { Badge, cardClass, formatDate, inputClass, StatePanel, StatusBadge } from "../components/KnowledgePrimitives";
import { ConfirmDialog, Drawer, PageHeader } from "../components/ui";
import { ProviderSetupForm, type ProviderSetupDefaults } from "../components/ProviderSetupForm";
import { knowledgeItemScope, withKnowledgeScope, type KnowledgeScope } from "../knowledge/integrated-search";
import { buildWikiDirectoryTree, type WikiDirectoryNode, type WikiDirectoryPage } from "../knowledge/wiki-directory";
import "./wiki.css";
const btn = "ui-button ui-button-primary ui-button-sm";
const btnGhost = "ui-button ui-button-ghost ui-button-sm";
const btnDanger = "ui-button ui-button-danger ui-button-sm";
type JsonRecord = {
  [key: string]: unknown;
  version: string; latencyMs: number; httpStatus: number;
  id: string; projectId: string | number; environment: string; status: string; kind: "embedding" | "rerank" | "wiki_llm" | "candidate_llm" | string;
  intent: { objective: string; risk: string; sampleManagerVersion: string; solution: string; module: string };
  updatedAt: string; createdAt: string; summary: string; event_id: string; event_type: string; created_at: string; intent_step: string;
  provider: string; modelId: string; baseUrl: string; embeddingProviderId: string; wikiProviderId: string; rerankProviderId: string;
  phase: string; wikiReady: boolean; tokenConfigured: boolean; dimensions: number; indexVersion: number; lastTestAt: string; lastErrorCode: string; reindexRequired: boolean;
  job: JsonRecord; fromModelId: string; toModelId: string; errorCode: string;
  statement: string; confidence: number; workSessionId: string; sourceScope: { environment: string }; whyProposed: string; generatedBy: string; fallbackReason: string;
  evidenceRefs: string[]; promotion: { target: string; targetId: string }; scopeReviewRequired: boolean; sessionUpdatedAt: string;
  currentSessionScope: { projectId: string | number; environment: string; sampleManagerVersion: string; solution: string; module: string };
  reviewerId: string; action: string; reason: string;
  pageKey: string; title: string; body: string; productVersion: string; currentRevision: number; publishedAt: string; deprecatedAt: string;
  citations: JsonRecord[]; documentId: string; chunkIds: string[]; sourceLocator: string; sourceSha256: string;
  revision: number; authorId: string; changeReason: string;
  documents: JsonRecord[]; parseStatus: string; attempt_count: number; failure_code: string; updated_at: string; product_version: string; solution: string; module: string; failure_message: string;
  retrievalRunId: string; degraded: boolean | JsonRecord; references: JsonRecord[]; score: number; snippet: string;
  total: number; limit: number; offset: number; report: JsonRecord; generatedAt: string; totals: JsonRecord; note: string;
  providerId: string; verifiedAt: string; canPublish: boolean; chunkCount: number; verified: boolean;
  checks: Record<string, JsonRecord>; ready: boolean; checkedAt: string; failures: string[]; ok: boolean; findings: string[];
};

const text = (value: unknown, fallback = ""): string => typeof value === "string" ? value : value == null ? fallback : String(value);
const asRecord = (value: unknown): JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : ({} as JsonRecord);
const records = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.filter((entry): entry is JsonRecord => typeof entry === "object" && entry !== null && !Array.isArray(entry)) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map((entry) => text(entry)).filter(Boolean) : [];

function errText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function Err({ message }: { message: string }) {
  if (!message) return null;
  return <p className="mt-3 rounded-field border border-coral/40 bg-coral/10 p-3 text-sm text-coral">{message}</p>;
}

function Pager({ offset, limit, total, count, onPage }: { offset: number; limit: number; total?: number; count: number; onPage: (offset: number) => void }) {
  const hasPrev = offset > 0;
  const hasNext = total !== undefined ? offset + count < total : count >= limit;
  return <div className="mt-3 flex items-center justify-between text-xs text-muted">
    <span>{total !== undefined ? `${total} total — ` : ""}showing {count} from offset {offset}</span>
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
    {error && <span className="text-xs text-coral">{error}</span>}
  </span>;
}

function SessionsPane() {
  const [sessions, setSessions] = useState<JsonRecord[]>();
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState("");
  const [events, setEvents] = useState<JsonRecord[]>([]);
  const [eventsError, setEventsError] = useState("");
  const load = () => { setError(""); api.knowledgeSessions(100).then((result) => setSessions(records(result.sessions))).catch((err) => setError(errText(err, "Unable to load Work Sessions"))); };
  useEffect(() => { load(); }, []);
  const openSession = async (id: string) => {
    if (openId === id) { setOpenId(""); return; }
    setOpenId(id); setEvents([]); setEventsError("");
    try { setEvents(records((await api.knowledgeSessionEvents(id)).events)); } catch (err) { setEventsError(errText(err, "Unable to load session events")); }
  };
  if (error && !sessions) return <StatePanel state="error" message={error} onRetry={load} />;
  if (!sessions) return <StatePanel state="loading" message="Loading Work Sessions…" />;
  return <section className={cardClass}>
    <div className="flex items-center justify-between"><h3 className="font-medium text-fg">Work Sessions</h3><button onClick={load} className={btnGhost}><RefreshCw size={13} /> Refresh</button></div>
    <p className="mt-1 text-xs text-muted">Your ACL-visible sessions; expand one to see correlated events.</p>
    <div className="mt-3 divide-y divide-white/10">
      {sessions.length === 0 && <p className="py-3 text-sm text-muted">No Work Sessions yet.</p>}
      {sessions.map((session) => <div key={session.id} className="py-2.5">
        <button onClick={() => openSession(session.id)} className="flex w-full flex-wrap items-center justify-between gap-3 text-left">
          <div className="min-w-0">
            <p className="truncate text-sm text-fg">{session.intent?.objective || session.id}</p>
            <p className="text-xs text-muted">{session.id} — project {session.projectId}{session.environment ? ` — ${session.environment}` : ""} — {formatDate(session.updatedAt)}</p>
          </div>
          <span className="flex items-center gap-2"><Badge tone="purple">{session.intent?.risk ?? "risk n/a"}</Badge><StatusBadge value={session.status} /></span>
        </button>
        {openId === session.id && <div className="mt-2 rounded-field border border-white/10 bg-black/20 p-3">
          {eventsError ? <p className="text-xs text-coral">{eventsError}</p> : <>
            <p className="text-xs text-muted">{events.length} correlated event(s)</p>
            {session.summary && <p className="mt-1 text-xs text-subtle">{session.summary}</p>}
            <ul className="mt-2 space-y-1">{events.slice(-10).reverse().map((event) => <li key={event.event_id || event.id} className="flex flex-wrap items-center gap-2 text-xs text-subtle"><Badge tone="purple">{text(event.event_type)}</Badge><span className="text-muted">{formatDate(event.created_at)}</span>{event.intent_step && <span>{text(event.intent_step)}</span>}</li>)}</ul>
          </>}
        </div>}
      </div>)}
    </div>
  </section>;
}

function ProvidersPane({ isAdmin }: { isAdmin: boolean }) {
  const [providers, setProviders] = useState<JsonRecord[]>();
  const [jobs, setJobs] = useState<JsonRecord[]>([]);
  const [error, setError] = useState("");
  const [engine, setEngine] = useState<JsonRecord>();
  const [engineError, setEngineError] = useState("");
  const [engineBusy, setEngineBusy] = useState(false);
  const [engineSelection, setEngineSelection] = useState<Record<string,string>>({});
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<ProviderSetupDefaults>();
  const [formVersion, setFormVersion] = useState(0);
  const [rotating, setRotating] = useState(false);
  const [probe, setProbe] = useState<Record<string, JsonRecord>>({});
  const [rotateId, setRotateId] = useState("");
  const [rotateRef, setRotateRef] = useState("");
  const [confirmAction, setConfirmAction] = useState<{ id: string; kind: "clear" | "disable" | "delete" }>();
  const load = () => {
    setError("");
    if (isAdmin) api.knowledgeEngine().then((value) => { setEngine(asRecord(value)); setEngineError(""); }).catch((err) => setEngineError(errText(err, "Unable to load engine status")));
    Promise.all([api.knowledgeManagedProviders(), api.knowledgeManagedProvidersReindex()])
      .then(([p, r]) => { setProviders(records(p.providers)); setJobs(records(r.jobs)); })
      .catch((err) => setError(errText(err, "Unable to load managed providers")));
  };
  useEffect(() => { load(); }, []);
  const run = async <T,>(task: () => Promise<T>, ok: string) => { setError(""); setNotice(""); try { await task(); setProbe({}); setNotice(ok); load(); } catch (err) { setError(errText(err, "Provider operation failed")); } };
  const test = async (id: string) => { setError(""); try { const { report } = await api.knowledgeManagedProviderTest(id); setProbe((current) => ({ ...current, [id]: asRecord(report) })); load(); } catch (err) { setError(errText(err, "Provider probe failed")); } };
  if (error && !providers) return <StatePanel state="error" message={error} onRetry={load} />;
  if (!providers) return <StatePanel state="loading" message="Loading managed providers…" />;
  return <div className="space-y-4">
    {isAdmin && <section className={cardClass} aria-label="Knowledge engine">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium text-fg">Knowledge engine</h3><StatusBadge value={engine?.phase ?? "loading"} /></div>
      <p className="mt-2 text-sm text-subtle">Installed and started with Relay. Embeddings and Wiki generation use the managed providers below.</p>
      {engine && <p className="mt-2 text-xs text-subtle">Version {engine.version ?? "not installed"} — Embedding {engine.embeddingProviderId ?? "not selected"} — Wiki {engine.wikiReady ? engine.wikiProviderId : "text model required"}</p>}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        {([["embedding","embeddingProviderId","Embedding"],["wiki_llm","wikiProviderId","Wiki generation"],["rerank","rerankProviderId","Rerank"]] as const).map(([kind,key,label]) => <label key={key} className="space-y-1 text-xs text-subtle"><span className="block">{label}</span><select className={inputClass} value={engineSelection[key] ?? ""} onChange={(event) => setEngineSelection((value) => ({...value,[key]:event.target.value}))}><option value="">Use current or sole provider</option>{providers.filter((p) => p.kind===kind && p.status!=="disabled").map((p) => <option key={p.id} value={p.id}>{p.id} — {p.modelId}</option>)}</select></label>)}
        <button disabled={engineBusy || engine?.phase==="not_installed"} className={btnGhost} onClick={async () => {setEngineBusy(true);setEngineError("");try{setEngine(asRecord(await api.knowledgeEngineInitialize(Object.fromEntries(Object.entries(engineSelection).filter(([,value]) => value)))));}catch(err){setEngineError(errText(err,"Engine connection failed"));}finally{setEngineBusy(false);}}}>{engineBusy ? "Connecting…" : "Apply model connections"}</button>
      </div>
      {engine?.phase==="not_installed" && <p className="mt-3 text-sm text-sun">The Relay deployment has not installed the knowledge engine yet.</p>}
      <Err message={engineError} />
    </section>}
    <section className={cardClass}>
      <div className="flex items-center gap-2"><ServerCog size={16} className="text-iris" /><h3 className="font-medium text-fg">Managed providers</h3></div>
      <p className="mt-1 text-xs text-muted">Tokens are encrypted on the server. Use the connection form below to select a model.</p>
      <div className="mt-3 divide-y divide-white/10">
        {providers.length === 0 && <p className="py-3 text-sm text-muted">No remote providers configured.</p>}
        {providers.map((provider) => <div key={provider.id} className="py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-fg">{provider.id} — {provider.provider} — {provider.modelId}</p>
              <p className="text-xs text-muted">{provider.kind} — index v{provider.indexVersion} — {provider.tokenConfigured ? "token configured" : "no token configured"}{provider.dimensions ? ` — ${provider.dimensions}d` : ""}{provider.lastTestAt ? ` — tested ${formatDate(provider.lastTestAt)}` : ""}{provider.lastErrorCode ? ` — last error ${provider.lastErrorCode}` : ""}</p>
            </div>
            <div className="flex items-center gap-2">
              {provider.reindexRequired && <Badge tone="amber">reindex pending</Badge>}
              <StatusBadge value={provider.status} />
            </div>
          </div>
          {isAdmin && <div className="mt-2 flex flex-wrap items-center gap-2">
            <button className={btnGhost} onClick={() => test(provider.id)}>Test</button>
            <button className={btnGhost} onClick={() => { setEditing({ id: provider.id, kind: provider.kind as "embedding" | "rerank" | "wiki_llm" | "candidate_llm", provider: provider.provider, baseUrl: provider.baseUrl, modelId: "" }); setFormVersion((n) => n + 1); }}>Edit configuration</button>
            <button className={btnGhost} onClick={() => { setRotateId(rotateId === provider.id ? "" : provider.id); setRotateRef(""); }}><KeyRound size={12} /> Replace token</button>
            <button className={btnDanger} disabled={!provider.tokenConfigured || rotating} onClick={() => setConfirmAction({ id: provider.id, kind: "clear" })}>Clear token</button>
            <button className={btnDanger} disabled={provider.status === "disabled"} onClick={() => setConfirmAction({ id: provider.id, kind: "disable" })}>Disable</button>
            <button className={btnDanger} disabled={provider.status === "disabled"} onClick={() => setConfirmAction({ id: provider.id, kind: "delete" })}>Delete provider</button>
          </div>}
          {rotateId === provider.id && <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="space-y-1 text-sm text-fg"><span className="block">Replacement token</span><input type="password" autoComplete="new-password" disabled={rotating} className={`${inputClass} w-72`} value={rotateRef} onChange={(event) => setRotateRef(event.target.value)} /></label>
            <button className={btn} disabled={!rotateRef.trim() || rotating} onClick={() => run(async () => { setRotating(true); try { await api.knowledgeProviderToken(provider.id, rotateRef.trim()); setRotateId(""); setRotateRef(""); } finally { setRotating(false); } }, "Token tested and replaced.")}>{rotating ? "Testing…" : "Test and replace"}</button>
          </div>}
          {probe[provider.id] && <p className={`mt-2 text-xs ${probe[provider.id].ok ? "text-mint" : "text-coral"}`}>Probe {probe[provider.id].ok ? `ok — ${probe[provider.id].latencyMs ?? "?"}ms — HTTP ${probe[provider.id].httpStatus ?? "?"}` : `failed — ${probe[provider.id].errorCode ?? "unknown"}`}</p>}
        </div>)}
      </div>
    </section>
    {isAdmin && <ProviderSetupForm key={formVersion} initial={editing} onCancel={() => { setEditing(undefined); setFormVersion((n) => n + 1); }} onSaved={(dimensions: number | undefined) => { setEditing(undefined); setFormVersion((n) => n + 1); setNotice("Provider tested and saved." + (dimensions ? " Detected " + dimensions + " dimensions." : "")); load(); }} />}
    <section className={cardClass}>
      <h3 className="font-medium text-fg">Pending reindex</h3>
      <div className="mt-3 divide-y divide-white/10">
        {jobs.length === 0 && <p className="py-2 text-sm text-muted">No pending reindex jobs.</p>}
        {jobs.map((entry) => <div key={entry.job.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
          <div>
            <p className="text-sm text-fg">{text(entry.provider)}: {entry.job.fromModelId ?? "?"} → {entry.job.toModelId} (index v{entry.job.indexVersion})</p>
            <p className="text-xs text-muted">{entry.job.id} — {formatDate(entry.job.createdAt)}{entry.job.errorCode ? ` — ${entry.job.errorCode}` : ""}</p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge value={entry.job.status} />
            {isAdmin && entry.job.status !== "completed" && <button className={btnGhost} onClick={() => run(() => api.knowledgeManagedProviderReindexComplete(entry.job.id), "Reindex job completed.")}>Mark complete</button>}
          </div>
        </div>)}
      </div>
    </section>
    {notice && <p className="rounded-md border border-mint/40 bg-mint/10 p-3 text-sm text-mint">{notice}</p>}
    <Err message={providers ? error : ""} />
    <ConfirmDialog
      open={Boolean(confirmAction)}
      onClose={() => setConfirmAction(undefined)}
      title={confirmAction?.kind === "clear" ? "Clear provider token" : confirmAction?.kind === "delete" ? "Delete provider" : "Disable provider"}
      description={confirmAction?.kind === "delete" ? "This removes the provider configuration and encrypted token. Active engine bindings cannot be deleted." : "This action is recorded in the audit log."}
      confirmLabel={confirmAction?.kind === "clear" ? "Clear token" : confirmAction?.kind === "delete" ? "Delete provider" : "Disable provider"}
      tone="danger"
      requireReason
      onConfirm={async () => {
        if (!confirmAction) return;
        const action = confirmAction;
        setConfirmAction(undefined);
        const task = action.kind === "clear"
          ? () => api.knowledgeProviderToken(action.id, null)
          : action.kind === "delete"
            ? () => api.knowledgeManagedProviderDelete(action.id)
            : () => api.knowledgeManagedProviderDisable(action.id);
        const message = action.kind === "clear" ? "Token cleared; provider disabled." : action.kind === "delete" ? "Provider deleted." : "Provider disabled.";
        await run(async () => { await task(); }, message);
      }}
    />
  </div>;
}

const INSIGHT_STATUSES = ["draft", "accepted", "edited", "rejected"] as const;
const INSIGHT_KINDS = ["fact", "decision", "case", "pattern"] as const;
const PAGE_LIMIT = 20;

function CandidatesPane({ isAdmin }: { isAdmin: boolean }) {
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [insights, setInsights] = useState<JsonRecord[]>();
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<JsonRecord>();
  const [history, setHistory] = useState<JsonRecord[]>([]);
  const [edit, setEdit] = useState<{ statement: string; kind: string }>({ statement: "", kind: "" });
  const [promoteTarget, setPromoteTarget] = useState<"fact" | "decision" | "case" | "pattern">("fact");
  const [promoteTitle, setPromoteTitle] = useState("");
  const load = (nextOffset = offset) => {
    setError("");
    api.knowledgeCandidateInsights(undefined, { status: status || undefined, limit: PAGE_LIMIT, offset: nextOffset })
      .then((result) => setInsights(records(result.insights)))
      .catch((err) => { setInsights([]); setError(errText(err, "Unable to load Candidate Insights")); });
  };
  useEffect(() => { setOffset(0); setSelected(undefined); load(0); }, [status]);
  const openDetail = async (id: string) => {
    setError("");
    try {
      const [insightResult, detail] = await Promise.all([api.knowledgeCandidateInsight(id), api.knowledgeCandidateInsightHistory(id)]);
      const insight = asRecord(insightResult.insight);
      const session = asRecord((await api.knowledgeSession(insight.workSessionId)).session);
      setSelected({ ...insight, sourceEnvironment: insight.sourceScope?.environment ?? session.environment, sessionUpdatedAt: session.updatedAt, currentSessionScope: { projectId: session.projectId, environment: session.environment, sampleManagerVersion: session.intent?.sampleManagerVersion, solution: session.intent?.solution, module: session.intent?.module } }); setHistory(records(detail.history));
      setEdit({ statement: insight.statement ?? "", kind: insight.kind ?? INSIGHT_KINDS[0] });
    } catch (err) { setError(errText(err, "Unable to load Candidate Insight")); }
  };
  const refresh = async (insight: JsonRecord) => { setSelected({ ...insight, sourceEnvironment: text(insight.sourceScope?.environment ?? selected?.sourceEnvironment), sessionUpdatedAt: text(selected?.sessionUpdatedAt), currentSessionScope: selected?.currentSessionScope ?? { projectId: insight.projectId, environment: text(insight.environment), sampleManagerVersion: "", solution: "", module: "" } }); const detail = await api.knowledgeCandidateInsightHistory(insight.id); setHistory(records(detail.history)); load(); };
  return <div className="space-y-4">
    <section className={cardClass}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-medium text-fg">Candidate drafts</h3>
        <select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All statuses</option>
          {INSIGHT_STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <button className={btnGhost} onClick={() => load()}><RefreshCw size={13} /> Refresh</button>
      </div>
      <Err message={error} />
      {!insights ? <StatePanel state="loading" message="Loading Candidate Insights…" /> : <>
        <div className="mt-3 divide-y divide-white/10">
          {insights.length === 0 && <p className="py-3 text-sm text-muted">No Candidate Insights in this scope.</p>}
          {insights.map((insight) => <button key={insight.id} onClick={() => openDetail(insight.id)} className="flex w-full flex-wrap items-center justify-between gap-3 py-2.5 text-left">
            <div className="min-w-0">
              <p className="truncate text-sm text-fg">{insight.statement}</p>
              <p className="text-xs text-muted">{insight.id} — session {insight.workSessionId} — {formatDate(insight.updatedAt)}{insight.confidence != null ? ` — confidence ${Number(insight.confidence).toFixed(2)}` : ""}</p>
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
          <h3 className="font-medium text-fg">{selected.id}</h3>
          <p className="mt-1 text-sm leading-6 text-fg">{selected.statement}</p>
          {selected.whyProposed && <p className="mt-1 text-xs text-muted">Why proposed: {selected.whyProposed}</p>}
          <p className="mt-2 text-xs text-muted">generated by {selected.generatedBy}{selected.fallbackReason ? ` — fallback: ${selected.fallbackReason}` : ""} — evidence refs: {(selected.evidenceRefs ?? []).length}</p>
          <div className="mt-3 flex flex-wrap gap-2">{(selected.evidenceRefs ?? []).map((id: string, index: number) => <Link key={id} className={btnGhost} to={withKnowledgeScope(`/knowledge/evidence?document=${encodeURIComponent(id)}`, { projectId: String(selected.projectId), environment: text(selected.sourceEnvironment) })}>View evidence {index + 1}</Link>)}</div>
          {selected.promotion && <p className="mt-3 text-sm text-mint">Promoted to {selected.promotion.target}{selected.promotion.targetId && <> — <Link className="underline" to={withKnowledgeScope(`/knowledge/confirmed-memory?memory=${encodeURIComponent(selected.promotion.targetId)}`, { projectId: String(selected.projectId), environment: text(selected.sourceEnvironment) })}>Open Memory</Link></>}</p>}
        </div>
        <StatusBadge value={selected.status} />
      </div>
      {selected.scopeReviewRequired && <div className="mt-4 rounded-md border border-sun/40 bg-sun/10 p-3 text-sm text-sun">
        <p>This record needs a source scope review before it can be promoted or reused by default.</p>
        <p className="mt-2 text-xs">Current Session: Project {selected.currentSessionScope?.projectId} — Environment {selected.currentSessionScope?.environment ?? "unspecified"} — Version {selected.currentSessionScope?.sampleManagerVersion ?? "unspecified"} — Solution {selected.currentSessionScope?.solution ?? "unspecified"} — Module {selected.currentSessionScope?.module ?? "unspecified"}</p>
        {isAdmin && selected.status !== "rejected" && <div className="mt-3 flex flex-wrap gap-2"><ReasonAction label="Review current Session scope" onRun={async (reason) => { await refresh(asRecord((await api.knowledgeCandidateInsightReviewScope(selected.id, reason, selected.sessionUpdatedAt)).insight)); }} /><button className={btnGhost} onClick={() => openDetail(selected.id)}>Reload scope</button></div>}
        <p className="mt-2 text-xs">{selected.status === "rejected" ? "This Candidate was rejected. Compile and review a new Candidate to reuse the evidence." : "Reviewing restores any existing Case to this scope for retrieval. Its content, evidence and lifecycle remain unchanged."}</p>
      </div>}
      {isAdmin && <div className="mt-4 space-y-3 border-t border-white/10 pt-3">
        {(selected.status === "draft" || selected.status === "edited") && <>
          <div className="grid gap-2 sm:grid-cols-[1fr_180px]">
            <textarea className="min-h-16 rounded-md border border-white/10 bg-[var(--field)] px-3 py-2 text-sm text-fg outline-none focus:border-mint" value={edit.statement} onChange={(event) => setEdit({ ...edit, statement: event.target.value })} placeholder="Edited statement" />
            <select className={inputClass} value={edit.kind} onChange={(event) => setEdit({ ...edit, kind: event.target.value })}>{INSIGHT_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ReasonAction label="Save edit" onRun={async (reason) => refresh(asRecord((await api.knowledgeCandidateInsightEdit(selected.id, { statement: edit.statement, kind: edit.kind }, reason)).insight))} />
            <ReasonAction label="Confirm" onRun={async (reason) => refresh(asRecord((await api.knowledgeCandidateInsightConfirm(selected.id, reason)).insight))} />
            <ReasonAction label="Reject" tone="danger" onRun={async (reason) => refresh(asRecord((await api.knowledgeCandidateInsightReject(selected.id, reason)).insight))} />
          </div>
        </>}
        {selected.status === "accepted" && !selected.promotion && !selected.scopeReviewRequired && <div className="flex flex-wrap items-center gap-2">
          <select className={inputClass} value={promoteTarget} onChange={(event) => setPromoteTarget(event.target.value as "fact" | "decision" | "case" | "pattern")}><option value="fact">fact</option><option value="decision">decision</option><option value="case">case</option><option value="pattern">pattern</option></select>
          <input className={`${inputClass} w-56`} placeholder="Promotion title (optional)" value={promoteTitle} onChange={(event) => setPromoteTitle(event.target.value)} />
          <ReasonAction label="Promote" onRun={async (reason) => { const result = await api.knowledgeCandidateInsightPromote(selected.id, { target: promoteTarget, reason, title: promoteTitle.trim() || undefined }); const promotion = asRecord(result.promotion); await refresh({ ...selected, promotion: { target: text(promotion.target), targetId: text(promotion.targetId) } }); }} />
        </div>}
      </div>}
      <div className="mt-4 border-t border-white/10 pt-3">
        <p className="text-xs  text-muted">Review history</p>
        <ul className="mt-2 space-y-1.5">
          {history.length === 0 && <li className="text-xs text-muted">No review actions yet.</li>}
          {history.map((record) => <li key={record.id} className="text-xs text-subtle"><Badge tone={record.action === "reject" ? "rose" : record.action === "confirm" || record.action === "promote" ? "green" : "gray"}>{record.action}</Badge> <span className="ml-1 text-muted">{formatDate(record.createdAt)} — reviewer {record.reviewerId}</span> — {record.reason}</li>)}
        </ul>
      </div>
    </section>}
  </div>;
}

const WIKI_STATUSES = ["draft", "published", "deprecated"] as const;

function useKnowledgeScope(): KnowledgeScope {
  return {};
}

function slugHeading(value: string) {
  return value.replace(/[`*_~]/g, "").trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
}

function markdownHeadings(source: string) {
  return source.split(/\r?\n/).flatMap((line) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    return match ? [{ level: match[1].length, title: match[2].replace(/#+\s*$/, "").trim(), id: slugHeading(match[2]) }] : [];
  });
}

function wikiSections(page: JsonRecord) {
  const sections = [...records(page.sections), ...records(page.differences).map((difference) => ({ ...difference, kind: "difference" }))];
  return sections.map((section) => ({
    ...section,
    title: text(section.title, text(asRecord(section).key, "Section")),
    kind: text(section.kind, "common") as "common" | "version" | "difference",
    productVersion: text(section.productVersion),
    citations: records(section.citations),
  }));
}

function WikiSectionSources({ citations, scope }: { citations: JsonRecord[]; scope: KnowledgeScope }) {
  const uniqueCitations = [...new Map(citations.map((citation) => {
    const key = [text(citation.documentId), text(citation.externalDocumentId), text(citation.sourceLocator), text(citation.title), text(citation.productVersion)].join("\u0000");
    return [key, citation] as const;
  })).values()];
  if (!uniqueCitations.length) return <p className="mt-2 text-xs text-sun">No source citation is attached to this section.</p>;
  return <ul className="mt-3 grid gap-2 sm:grid-cols-2">
    {uniqueCitations.map((citation, index) => {
      const id = text(citation.documentId);
      return <li key={`${id}-${text(citation.sourceLocator)}-${index}`} className="border-l-2 border-iris/60 pl-3 text-xs text-subtle">
        {id ? <Link className="font-medium text-iris underline underline-offset-2" to={withKnowledgeScope(`/knowledge/product-docs?document=${encodeURIComponent(id)}`, scope)}>{text(citation.title, "Open source document")}</Link> : <span className="font-medium text-fg">{text(citation.title, "Source document")}</span>}
        <p className="mt-1">{citation.productVersion ? `Version ${text(citation.productVersion)}` : "Version unspecified"}{citation.sourceLocator ? ` · ${text(citation.sourceLocator)}` : ""}</p>
        {Array.isArray(citation.chunkIds) && citation.chunkIds.length > 0 && <p className="mt-1 text-muted">{citation.chunkIds.length} source chunk{citation.chunkIds.length === 1 ? "" : "s"}</p>}
      </li>;
    })}
  </ul>;
}

function wikiPageLabel(page: WikiDirectoryPage): string {
  return text(page.title, text(page.pageKey, text(page.id, "Untitled topic")));
}

function wikiDirectoryLabels(page: WikiDirectoryPage): string[] {
  const raw = text(page.directoryPath);
  const labels = raw.split(/[\\/]+/).map((part) => part.trim()).filter(Boolean);
  if (labels.length > 0) {
    return labels[labels.length - 1].toLocaleLowerCase() === wikiPageLabel(page).toLocaleLowerCase() ? labels.slice(0, -1) : labels;
  }
  return [text(page.solution), text(page.module)].filter((label) => label && label.toLocaleLowerCase() !== "unassigned");
}

function mergeWikiRows(rows: JsonRecord[]): JsonRecord[] {
  const grouped = new Map<string, JsonRecord>();
  rows.forEach((item) => {
    const key = text(item.topicGroupId, text(item.pageKey, item.id));
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { ...item, supportedVersions: strings(item.supportedVersions) });
      return;
    }
    const versions = [...new Set([...strings(current.supportedVersions), ...strings(item.supportedVersions), text(item.productVersion)])].filter(Boolean);
    grouped.set(key, {
      ...current,
      supportedVersions: versions,
      sectionCount: Number(current.sectionCount ?? 0) + Number(item.sectionCount ?? 0),
      sourceCount: Number(current.sourceCount ?? 0) + Number(item.sourceCount ?? 0),
    });
  });
  return [...grouped.values()];
}

function wikiPageId(page: WikiDirectoryPage): string {
  return text(page.id, text(page.pageKey, wikiPageLabel(page)));
}

function isWikiPageSelected(page: WikiDirectoryPage, selectedId?: string): boolean {
  return Boolean(selectedId) && (wikiPageId(page) === selectedId || text(page.pageKey) === selectedId);
}

function WikiDirectoryNodeView({ node, depth, collapsed, selectedId, onToggle, onOpen }: { node: WikiDirectoryNode; depth: number; collapsed: Set<string>; selectedId?: string; onToggle: (key: string) => void; onOpen: (page: WikiDirectoryPage) => void }) {
  const isCollapsed = collapsed.has(node.key);
  return <div>
    <button type="button" aria-label={`${node.path.join(" / ")} · ${node.count} topic${node.count === 1 ? "" : "s"}`} aria-expanded={!isCollapsed} onClick={() => onToggle(node.key)} className="wiki-tree-folder focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint" style={{ paddingLeft: `${12 + depth * 16}px`, paddingRight: 12 }} title={node.path.join(" / ")}>
      {isCollapsed ? <ChevronRight size={15} className="shrink-0 text-muted" /> : <ChevronDown size={15} className="shrink-0 text-muted" />}
      <Folder size={15} className="shrink-0 text-iris" />
      <span className="wiki-tree-label">{node.label}</span>
      <span className="wiki-tree-count">{node.count}</span>
    </button>
    {!isCollapsed && <div>
      {node.children.map((child) => <WikiDirectoryNodeView key={child.key} node={child} depth={depth + 1} collapsed={collapsed} selectedId={selectedId} onToggle={onToggle} onOpen={onOpen} />)}
      {node.pages.map((page) => {
        const selected = isWikiPageSelected(page, selectedId);
        const context = text(page.directoryContext);
        return <button type="button" key={wikiPageId(page)} aria-current={selected ? "page" : undefined} onClick={() => onOpen(page)} className={`wiki-tree-page focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint ${selected ? "wiki-tree-page-selected" : ""}`} style={{ paddingLeft: `${28 + (depth + 1) * 16}px`, paddingRight: 12 }} title={context ? `${wikiPageLabel(page)} · ${context}` : wikiPageLabel(page)}>
          <FileText size={14} className="shrink-0 self-start text-mint/80" />
          <span className="wiki-tree-page-copy"><span className="wiki-tree-label">{wikiPageLabel(page)}</span>{context && <span className="wiki-tree-context">{context}</span>}</span>
          <span className="wiki-tree-status">{text(page.status, "draft")}</span>
        </button>;
      })}
    </div>}
  </div>;
}

function WikiDirectoryTreeView({ items, collapsed, selectedId, onToggle, onOpen }: { items: JsonRecord[]; collapsed: Set<string>; selectedId?: string; onToggle: (key: string) => void; onOpen: (page: WikiDirectoryPage) => void }) {
  const tree = buildWikiDirectoryTree(items);
  return <div className="wiki-directory-tree">
    {tree.nodes.map((node) => <WikiDirectoryNodeView key={node.key} node={node} depth={0} collapsed={collapsed} selectedId={selectedId} onToggle={onToggle} onOpen={onOpen} />)}
    {tree.pages.map((page) => {
      const selected = isWikiPageSelected(page, selectedId);
      const context = text(page.directoryContext);
      return <button type="button" key={wikiPageId(page)} aria-current={selected ? "page" : undefined} onClick={() => onOpen(page)} className={`wiki-tree-page focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint ${selected ? "wiki-tree-page-selected" : ""}`} style={{ paddingLeft: 12, paddingRight: 12 }} title={context ? `${wikiPageLabel(page)} · ${context}` : wikiPageLabel(page)}>
        <FileText size={14} className="shrink-0 self-start text-mint/80" />
        <span className="wiki-tree-page-copy"><span className="wiki-tree-label">{wikiPageLabel(page)}</span>{context && <span className="wiki-tree-context">{context}</span>}</span>
        <span className="wiki-tree-status">{text(page.status, "draft")}</span>
      </button>;
    })}
    {tree.nodes.length === 0 && tree.pages.length === 0 && <p className="wiki-directory-empty">No directory entries match these filters.</p>}
  </div>;
}

function WikiDetail({ page, scope, isAdmin, onRefresh }: { page: JsonRecord; scope: KnowledgeScope; isAdmin: boolean; onRefresh: (updated: JsonRecord) => Promise<void> }) {
  const sections = wikiSections(page);
  const pageCitations = records(page.citations);
  const hasSectionCitations = sections.some((section) => section.citations.length > 0);
  const directoryLabels = wikiDirectoryLabels(page);
  const versions = [...new Set([...strings(page.supportedVersions), ...sections.filter((section) => section.kind === "version" && section.productVersion).map((section) => section.productVersion)])];
  const [version, setVersion] = useState("");
  const [view, setView] = useState<"all" | "common" | "differences">("all");
  const [editBody, setEditBody] = useState({ title: text(page.title), body: text(page.body) });
  const [editOpen, setEditOpen] = useState(false);
  const [revisions, setRevisions] = useState<JsonRecord[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [revisionDiffMode, setRevisionDiffMode] = useState<"incremental" | "cumulative" | "snapshot">("incremental");
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const selectedVersion = version;
  const pageRevision = Number(page.currentRevision);
  const currentRevision = Number.isFinite(pageRevision) && pageRevision > 0 ? pageRevision : Math.max(0, ...revisions.map((revision) => Number(revision.revision) || 0));
  useEffect(() => {
    let active = true;
    setVersion("");
    setEditBody({ title: text(page.title), body: text(page.body) });
    setEditOpen(false);
    setDiff("");
    setError("");
    setSelectedRevision(currentRevision || null);
    api.knowledgeWikiRevisions(text(page.id), scope).then((result) => {
      if (active) setRevisions(records(result.revisions));
    }).catch((err) => { if (active) setError(errText(err, "Unable to load revision history")); });
    return () => { active = false; };
  }, [page.id, page.currentRevision, scope.projectId, scope.environment]);
  useEffect(() => {
    let active = true;
    const selected = selectedRevision ?? currentRevision;
    if (!historyOpen || revisionDiffMode === "snapshot" || selected < 1 || currentRevision < 1) {
      setDiff("");
      setDiffLoading(false);
      return () => { active = false; };
    }
    const fromRevision = revisionDiffMode === "cumulative" ? selected : selected - 1;
    const toRevision = revisionDiffMode === "cumulative" ? currentRevision : selected;
    if (fromRevision < 1 || toRevision <= fromRevision) {
      setDiff("");
      setDiffLoading(false);
      return () => { active = false; };
    }
    setDiffLoading(true);
    api.knowledgeWikiDiff(text(page.id), fromRevision, toRevision, scope).then((result) => {
      if (active) setDiff(text(result.diff));
    }).catch((err) => {
      if (active) setError(errText(err, "Unable to compute revision diff"));
    }).finally(() => {
      if (active) setDiffLoading(false);
    });
    return () => { active = false; };
  }, [historyOpen, selectedRevision, revisionDiffMode, currentRevision, page.id, scope.projectId, scope.environment]);
  const run = async (task: () => Promise<JsonRecord>, ok: string): Promise<boolean> => {
    setError(""); setNotice("");
    try { await onRefresh(await task()); setNotice(ok); return true; } catch (err) { setError(errText(err, "Wiki operation failed")); return false; }
  };
  const visible = sections.filter((section) => {
    if (view === "common") return section.kind === "common";
    if (view === "differences") return section.kind === "difference";
    return section.kind === "common" || section.kind === "difference" || section.kind === "version" && (!selectedVersion || section.productVersion === selectedVersion);
  });
  const headings = visible.length > 0 ? visible.flatMap((section) => markdownHeadings(section.body)) : markdownHeadings(text(page.body));
  const revisionRows = [...revisions];
  if (currentRevision > 0 && !revisionRows.some((revision) => Number(revision.revision) === currentRevision)) {
    revisionRows.push(asRecord({ id: `current-${text(page.id)}`, revision: currentRevision, title: page.title, body: page.body, changeReason: "Current page", createdAt: page.updatedAt }));
  }
  revisionRows.sort((left, right) => Number(right.revision) - Number(left.revision));
  const selectedRevisionRow = revisionRows.find((revision) => Number(revision.revision) === selectedRevision);
  const selectedRevisionBody = selectedRevision === currentRevision ? text(page.body) : text(selectedRevisionRow?.body);
  const openHistory = () => {
    setSelectedRevision(currentRevision || Number(revisionRows[0]?.revision) || null);
    setRevisionDiffMode("incremental");
    setHistoryOpen(true);
  };
  return <section className="wiki-detail-card overflow-hidden" aria-labelledby="wiki-detail-title">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="wiki-reader-kicker">{text(page.solution, "Knowledge")} / {text(page.module, "General")}</p>
        <h2 id="wiki-detail-title" className="mt-1 text-xl font-semibold text-fg">{text(page.title, text(page.pageKey, "Wiki page"))}</h2>
        <p className="mt-1 text-xs text-muted">{text(page.pageKey)} · page revision r{currentRevision || "—"} · {text(page.generationStatus, text(page.status, "unknown"))}</p>
        {directoryLabels.length > 0 && <div className="wiki-detail-path" aria-label="Knowledge graph path">
          <Network size={13} aria-hidden="true" />
          {directoryLabels.map((label, index) => <span key={`${label}-${index}`} className="contents"><span className="wiki-detail-path-segment">{label}</span>{index < directoryLabels.length - 1 && <span className="wiki-detail-path-separator" aria-hidden="true">/</span>}</span>)}
        </div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {isAdmin && page.status !== "deprecated" && <button className={btnGhost} aria-expanded={editOpen} aria-controls="wiki-edit-panel" onClick={() => setEditOpen(true)}><Pencil size={13} /> Edit</button>}
        <button className={btnGhost} onClick={openHistory}><History size={13} /> Page history</button>
        <StatusBadge value={text(page.status, "draft")} />
      </div>
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-2 border-b border-white/10 pb-3">
      <button className={view === "all" ? btn : btnGhost} onClick={() => setView("all")}>All sections</button>
      <button className={view === "common" ? btn : btnGhost} onClick={() => setView("common")}>Common</button>
      <button className={view === "differences" ? btn : btnGhost} onClick={() => setView("differences")}>Differences</button>
      {versions.length > 0 && <label className="ml-auto flex items-center gap-2 text-xs text-muted"><span>Product version</span><select className={inputClass} value={selectedVersion} onChange={(event) => setVersion(event.target.value)}><option value="">All versions</option>{versions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>}
    </div>
    <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_13rem]">
      <div className="wiki-article-column min-w-0">
        {visible.length > 0 ? <div className="space-y-8">{visible.map((section, index) => {
          const sectionHeadings = markdownHeadings(section.body);
          return <article key={text(section.id, `${section.kind}-${index}`)} id={`wiki-section-${text(section.id, `${section.kind}-${index}`)}`} className="scroll-mt-6">
            <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold text-fg">{section.title}</h3>{section.kind === "version" && <Badge tone="blue">{section.productVersion}</Badge>}{section.kind === "difference" && <Badge tone="amber">Difference</Badge>}</div>
            <div className="mt-2"><KnowledgeMarkup source={section.body} wikiScope={scope} wikiPageKey={text(page.pageKey)} /></div>
            <WikiSectionSources citations={section.citations} scope={knowledgeItemScope(page, scope)} />
            {sectionHeadings.length > 0 && <div className="sr-only">{sectionHeadings.length} headings</div>}
          </article>;
        })}</div> : <div className="rounded-md border border-white/10 p-4 text-sm text-muted">No sections are available for this view. Showing the rendered page body instead.</div>}
        {visible.length === 0 && <div className="mt-4 rounded-md border border-white/10 bg-black/20 p-4"><KnowledgeMarkup source={text(page.body)} wikiScope={scope} wikiPageKey={text(page.pageKey)} /></div>}
      </div>
      <aside className="wiki-reader-aside lg:sticky lg:top-5 lg:self-start" aria-label="On this page">
        <p className="text-xs font-medium text-muted">On this page</p>
        {headings.length > 0 ? <nav className="mt-2 space-y-1 border-l border-white/10 pl-3">{headings.map((heading, index) => <a key={`${heading.id}-${index}`} href={`#knowledge-content-${heading.id}`} className="block text-xs text-subtle hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint" style={{ paddingLeft: `${Math.max(0, heading.level - 1) * 8}px` }}>{heading.title}</a>)}</nav> : <p className="mt-2 text-xs text-muted">No headings in this view.</p>}
      </aside>
    </div>
    {!hasSectionCitations && pageCitations.length > 0 && <div className="mt-6 border-t border-white/10 pt-4">
      <h3 className="text-sm font-medium text-fg">Page sources</h3>
      <WikiSectionSources citations={pageCitations} scope={knowledgeItemScope(page, scope)} />
    </div>}
    {notice && <p className="mt-4 rounded-md border border-mint/40 bg-mint/10 p-3 text-sm text-mint">{notice}</p>}
    <Err message={error} />
    {editOpen && isAdmin && page.status !== "deprecated" && <div id="wiki-edit-panel" className="wiki-edit-panel mt-5" aria-label="Edit Wiki page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="text-sm font-medium text-fg">Edit Wiki page</h3><p className="mt-1 text-xs text-muted">Changes require an audited reason. The reader remains unchanged until you save.</p></div>
        <button className={btnGhost} onClick={() => setEditOpen(false)}>Cancel</button>
      </div>
      <div className="mt-4 space-y-3">
        <input aria-label="Wiki page title" className={`${inputClass} w-full`} value={editBody.title} onChange={(event) => setEditBody({ ...editBody, title: event.target.value })} placeholder="Title" />
        <textarea aria-label="Wiki page body" className="min-h-28 w-full rounded-md border border-white/10 bg-[var(--field)] px-3 py-2 text-sm text-fg outline-none focus:border-mint" value={editBody.body} onChange={(event) => setEditBody({ ...editBody, body: event.target.value })} placeholder="Body" />
        <div className="flex flex-wrap items-center gap-2">
          <ReasonAction label="Save edit" onRun={async (reason) => { if (await run(async () => asRecord((await api.knowledgeWikiEdit(text(page.id), { title: editBody.title, body: editBody.body, reason }, knowledgeItemScope(page, scope))).page), "Wiki page saved.")) setEditOpen(false); }} />
          {page.status !== "published" && <ReasonAction label="Publish" onRun={async (reason) => { await run(async () => asRecord((await api.knowledgeWikiPublish(text(page.id), reason, knowledgeItemScope(page, scope))).page), "Wiki page published."); }} />}
          {page.status === "published" && <ReasonAction label="Deprecate" tone="danger" onRun={async (reason) => { await run(async () => asRecord((await api.knowledgeWikiDeprecate(text(page.id), reason, knowledgeItemScope(page, scope))).page), "Wiki page deprecated."); }} />}
        </div>
      </div>
    </div>}
    <Drawer open={historyOpen} onClose={() => setHistoryOpen(false)} title={`Page history · ${text(page.title, text(page.pageKey, "Wiki page"))}`} description="Each edit appends a revision. Rollback creates a new revision; it never rewrites history.">
      <div className="grid gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <aside className="min-w-0">
          <p className="text-xs font-medium text-muted">Revisions</p>
          <div className="mt-2 space-y-1">
            {revisionRows.map((revision) => {
              const number = Number(revision.revision);
              const current = number === currentRevision;
              return <button type="button" key={text(revision.id, `revision-${number}`)} onClick={() => { setSelectedRevision(number); setRevisionDiffMode("incremental"); }} className={`w-full rounded-md border p-2.5 text-left ${selectedRevision === number ? "border-mint/60 bg-mint/10" : "border-white/10 hover:border-white/20"}`}>
                <div className="flex items-center justify-between gap-2"><span className="font-mono text-xs text-fg">r{number}</span>{current && <Badge tone="mint">Current</Badge>}</div>
                <p className="mt-1 truncate text-[11px] text-muted">{text(revision.changeReason, current ? "Current page" : "Revision")}</p>
                <p className="mt-1 text-[11px] text-subtle">{formatDate(revision.createdAt)}</p>
              </button>;
            })}
            {revisionRows.length === 0 && <p className="text-xs text-muted">No revision records are available.</p>}
          </div>
        </aside>
        <section className="min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-3">
            <div><p className="font-mono text-xs text-iris">r{selectedRevision ?? "—"}{selectedRevision === currentRevision ? " · current" : ""}</p><p className="mt-1 text-xs text-muted">{text(selectedRevisionRow?.changeReason, "Select a revision to inspect")}</p></div>
            <div className="flex flex-wrap gap-1.5">
              <button className={revisionDiffMode === "incremental" ? btn : btnGhost} onClick={() => setRevisionDiffMode("incremental")}><GitCompare size={12} /> Change</button>
              <button className={revisionDiffMode === "cumulative" ? btn : btnGhost} onClick={() => setRevisionDiffMode("cumulative")}>Compare to current</button>
              <button className={revisionDiffMode === "snapshot" ? btn : btnGhost} onClick={() => setRevisionDiffMode("snapshot")}>Snapshot</button>
            </div>
          </div>
          <div className="mt-4">
            {revisionDiffMode === "snapshot" ? <div className="rounded-md border border-white/10 p-3"><KnowledgeMarkup source={selectedRevisionBody} wikiScope={scope} wikiPageKey={text(page.pageKey)} /></div>
              : diffLoading ? <p className="text-sm text-muted">Loading revision diff…</p>
                : selectedRevision === 1 ? <p className="rounded-md border border-white/10 bg-black/10 p-3 text-sm text-muted">This is the initial revision; there is no earlier snapshot to compare.</p>
                  : diff ? <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-white/10 bg-black/20 p-3 font-mono text-xs leading-5 text-fg">{diff}</pre>
                    : <p className="rounded-md border border-white/10 bg-black/10 p-3 text-sm text-muted">No content changes are available for this comparison.</p>}
          </div>
          {isAdmin && selectedRevision !== null && selectedRevision < currentRevision && page.status !== "deprecated" && <div className="mt-5 border-t border-white/10 pt-4"><ReasonAction label={`Rollback to r${selectedRevision}`} tone="danger" onRun={async (reason) => { await run(async () => { const updated = asRecord((await api.knowledgeWikiRollback(text(page.id), selectedRevision, reason, knowledgeItemScope(page, scope))).page); setHistoryOpen(false); return updated; }, `Wiki page rolled back to r${selectedRevision}.`); }} /></div>}
        </section>
      </div>
    </Drawer>
  </section>;
}

function directoryItems(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.flatMap(directoryItems);
  const source = asRecord(value);
  const collection = source.items ?? source.pages ?? source.nodes ?? source.directory ?? source.groups;
  if (Array.isArray(collection)) {
    return collection.flatMap((item) => {
      const children = records(item.children ?? item.modules ?? item.topics ?? item.items);
      if (children.length) return children.flatMap(directoryItems);
      const page = asRecord(item.page);
      return Object.keys(page).length ? [page] : [item];
    });
  }
  return Object.keys(source).length > 0 ? [source] : [];
}

export function WikiPane({ isAdmin }: { isAdmin: boolean }) {
  const scope = useKnowledgeScope();
  const [params, setParams] = useSearchParams();
  const selectedPage = params.get("wikiPage");
  const selectedKey = params.get("wikiKey");
  const [searchInput, setSearchInput] = useState("");
  const [filters, setFilters] = useState({ search: "", status: "", version: "" });
  const [result, setResult] = useState<JsonRecord[]>();
  const [directoryTotal, setDirectoryTotal] = useState(0);
  const [directoryOffset, setDirectoryOffset] = useState(0);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [collapsedDirectoryPaths, setCollapsedDirectoryPaths] = useState<Set<string>>(new Set());
  const [page, setPage] = useState<JsonRecord>();
  const [generation, setGeneration] = useState<JsonRecord>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [sources, setSources] = useState<JsonRecord[]>([]);
  const [sourceRefs, setSourceRefs] = useState<string[]>([]);
  const [create, setCreate] = useState({ pageKey: "", title: "", body: "", productVersion: "", reason: "" });
  const requestId = useRef(0);
  const loadDirectoryPage = async (append = false) => {
    const id = ++requestId.current;
    const offset = append ? directoryOffset : 0;
    setError("");
    setDirectoryBusy(true);
    if (!append) {
      setResult(undefined);
      setDirectoryOffset(0);
      setCollapsedDirectoryPaths(new Set());
    }
    const paramsForList = { ...scope, search: filters.search.trim() || undefined, status: filters.status || undefined, productVersion: filters.version || undefined, limit: 200, offset };
    try {
      let rows: JsonRecord[] = [];
      let total = 0;
      try {
        const directoryResponse = await api.knowledgeWikiDirectory(paramsForList);
        const directoryRecord = asRecord(directoryResponse);
        rows = directoryItems(directoryResponse);
        total = Number(directoryRecord.total ?? rows.length);
      } catch {
        const fallback = await api.knowledgeWikiPages(paramsForList);
        const fallbackRecord = asRecord(fallback);
        rows = records(fallbackRecord.items ?? fallbackRecord.pages);
        total = Number(fallbackRecord.total ?? rows.length);
      }
      if (id !== requestId.current) return;
      setResult((current) => mergeWikiRows(append ? [...(current ?? []), ...rows] : rows));
      setDirectoryTotal(Number.isFinite(total) ? total : rows.length);
      setDirectoryOffset(offset + rows.length);
      if (!append && !filters.search.trim()) api.knowledgeWikiGeneration(scope).then((value) => setGeneration(asRecord(value))).catch(() => { /* directory remains usable when progress is unavailable */ });
    } catch (err) {
      if (id === requestId.current) setError(errText(err, "Unable to load Wiki directory"));
    } finally {
      if (id === requestId.current) setDirectoryBusy(false);
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => setFilters((current) => current.search === searchInput ? current : { ...current, search: searchInput }), 260);
    return () => window.clearTimeout(timer);
  }, [searchInput]);
  useEffect(() => { void loadDirectoryPage(false); }, [scope.projectId, scope.environment, filters.search, filters.status, filters.version]);
  useEffect(() => {
    let cancelled = false;
    if (!selectedPage && !selectedKey) { setPage(undefined); return; }
    setError("");
    setPage(undefined);
    (async () => {
      try {
        const data = selectedKey ? await api.knowledgeWikiResolve(selectedKey, scope) : await api.knowledgeWikiPage(selectedPage!, scope);
        const detail = asRecord(data.page);
        if (!cancelled) setPage(detail);
      } catch (err) {
        if (!cancelled) setError(errText(err, "Unable to load Wiki page"));
      }
    })();
    return () => { cancelled = true; };
  }, [selectedPage, selectedKey, scope.projectId, scope.environment]);
  useEffect(() => {
    if (!showCreate) return;
    api.productDocumentsList({ ...scope, status: "published", limit: 100, offset: 0 }).then((data) => setSources(records(data.documents))).catch((err) => setError(errText(err, "Unable to load published sources")));
  }, [showCreate, scope.projectId, scope.environment]);
  const openPage = (item: WikiDirectoryPage) => setParams((current) => { const next = new URLSearchParams(current); const id = text(item.id); const key = text(item.pageKey); if (id) { next.set("wikiPage", id); next.delete("wikiKey"); } else if (key) { next.set("wikiKey", key); next.delete("wikiPage"); } return next; });
  const closePage = () => setParams((current) => { const next = new URLSearchParams(current); next.delete("wikiPage"); next.delete("wikiKey"); return next; });
  const startGeneration = async () => {
    setError("");
    setNotice("");
    try {
      const response = asRecord(await api.knowledgeWikiGenerationStart({ ...scope, retryFailed: true }));
      setNotice(`Queued ${Number(response.queued ?? 0)} of ${Number(response.total ?? 0)} Wiki topics.`);
      await loadDirectoryPage(false);
    } catch (err) {
      setError(errText(err, "Unable to start Wiki generation"));
    }
  };
  const toggleDirectoryPath = (key: string) => setCollapsedDirectoryPaths((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const generationStates = records(generation?.states);
  const activeGeneration = generationStates.filter((state) => ["queued", "running"].includes(text(state.status))).length;
  const failedGeneration = generationStates.filter((state) => text(state.status) === "failed").length;
  return <div className="wiki-workspace">
    <section className="wiki-directory-panel" aria-label="Wiki directory">
      <header className="wiki-directory-header">
        <div className="wiki-directory-meta">
          <span className="wiki-directory-count">{result?.length ?? 0} topics</span>
          {directoryTotal > (result?.length ?? 0) && <span>{directoryTotal} directory entries</span>}
          <span className="wiki-directory-hint">Graph paths</span>
        </div>
        <div className="wiki-directory-actions">
          <button aria-label="Refresh Wiki directory" title="Refresh Wiki directory" className={btnGhost} disabled={directoryBusy} onClick={() => void loadDirectoryPage(false)}><RefreshCw size={13} className={directoryBusy ? "animate-spin" : ""} /></button>
          {isAdmin && <button aria-label="Generate all Wiki topics" title="Generate all Wiki topics" className={btnGhost} onClick={() => void startGeneration()}><Workflow size={13} /></button>}
          {isAdmin && <button className={btn} onClick={() => setShowCreate(!showCreate)}>New page</button>}
        </div>
      </header>
      <div className="wiki-directory-controls">
        <input aria-label="Search Wiki" aria-busy={directoryBusy} className={`${inputClass} wiki-directory-search`} placeholder="Search Wiki pages…" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
        <div className="wiki-directory-filter-row">
          <select aria-label="Filter by status" className={inputClass} value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">All statuses</option>{WIKI_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select>
          <select aria-label="Filter by version" className={inputClass} value={filters.version} onChange={(event) => setFilters({ ...filters, version: event.target.value })}><option value="">All versions</option>{[...new Set((result ?? []).flatMap((item) => [...strings(item.supportedVersions), text(item.productVersion)].filter(Boolean)))].map((version) => <option key={version} value={version}>{version}</option>)}</select>
        </div>
        <div className="wiki-directory-status"><FileText size={12} aria-hidden="true" /><span><strong>{result?.length ?? 0}</strong> visible topics{directoryOffset < directoryTotal ? ` · ${Math.max(0, directoryTotal - directoryOffset)} more available` : ""}</span></div>
      </div>
      {generation && (activeGeneration > 0 || failedGeneration > 0) && <div className="wiki-directory-progress">
        <div className="flex items-center gap-2"><Workflow size={13} className={activeGeneration > 0 ? "text-iris" : "text-coral"} /><span>{activeGeneration > 0 ? `${activeGeneration} topic generation job${activeGeneration === 1 ? "" : "s"} in progress.` : `${failedGeneration} topic generation${failedGeneration === 1 ? "" : "s"} failed.`}</span></div>
        <button className={`${btnGhost} mt-2`} disabled={directoryBusy} onClick={() => void loadDirectoryPage(false)}>Refresh progress</button>
      </div>}
      {showCreate && isAdmin && <div className="wiki-directory-create">
        <div className="grid gap-2 sm:grid-cols-3"><input className={inputClass} placeholder="pageKey (stable identity)" value={create.pageKey} onChange={(event) => setCreate({ ...create, pageKey: event.target.value })} /><input className={inputClass} placeholder="Title" value={create.title} onChange={(event) => setCreate({ ...create, title: event.target.value })} /><input className={inputClass} placeholder="Product version (optional)" value={create.productVersion} onChange={(event) => setCreate({ ...create, productVersion: event.target.value })} /></div>
        <label className="block space-y-1 text-xs text-subtle"><span>Published source documents</span><select multiple size={4} className={`${inputClass} h-auto w-full`} value={sourceRefs} onChange={(event) => setSourceRefs(Array.from(event.target.selectedOptions, (option) => option.value))}>{sources.map((source) => <option key={source.id} value={text(source.id)}>{text(source.title)}{source.productVersion ? ` — v${source.productVersion}` : ""}</option>)}</select></label>
        <textarea className="min-h-24 w-full rounded-md border border-white/10 bg-[var(--field)] px-3 py-2 text-sm text-fg outline-none focus:border-mint" placeholder="Page body" value={create.body} onChange={(event) => setCreate({ ...create, body: event.target.value })} />
        <div className="flex flex-wrap items-center gap-2"><input className={inputClass} placeholder="Audit reason (required)" value={create.reason} onChange={(event) => setCreate({ ...create, reason: event.target.value })} /><button className={btn} disabled={!sourceRefs.length || !create.pageKey.trim() || !create.title.trim() || !create.body.trim() || !create.reason.trim()} onClick={async () => { try { const data = await api.knowledgeWikiCreate({ ...scope, sourceRefs, pageKey: create.pageKey.trim(), title: create.title.trim(), body: create.body, productVersion: create.productVersion.trim() || undefined, reason: create.reason.trim() }); setNotice("Wiki page created."); setShowCreate(false); setCreate({ pageKey: "", title: "", body: "", productVersion: "", reason: "" }); setSourceRefs([]); await loadDirectoryPage(false); openPage(asRecord(data.page)); } catch (err) { setError(errText(err, "Unable to create Wiki page")); } }}>Create</button></div>
      </div>}
      {error && !result && <StatePanel state="error" message={error} onRetry={() => void loadDirectoryPage(false)} />}
      {error && result && <Err message={error} />}
      {notice && <p className="mx-3 mb-2 rounded-md border border-mint/40 bg-mint/10 p-3 text-sm text-mint">{notice}</p>}
      <div className="wiki-directory-scroll">
        {!result ? <StatePanel state="loading" message="Loading Wiki directory…" /> : result.length === 0 ? <p className="wiki-directory-empty">No Wiki topics match these filters.</p> : <div className="space-y-3">
          <WikiDirectoryTreeView items={result} collapsed={collapsedDirectoryPaths} selectedId={selectedPage ?? selectedKey ?? (page ? wikiPageId(page) : undefined)} onToggle={toggleDirectoryPath} onOpen={openPage} />
          {directoryOffset < directoryTotal && <div className="flex justify-center pt-2"><button className={btnGhost} disabled={directoryBusy} onClick={() => void loadDirectoryPage(true)}>{directoryBusy ? "Loading topics…" : `Load more topics (${Math.max(0, directoryTotal - directoryOffset)} remaining)`}</button></div>}
        </div>}
      </div>
    </section>
    <main className="wiki-reading-panel">
      {page ? <><button className={`${btnGhost} wiki-mobile-back`} onClick={closePage}>← Back to directory</button><WikiDetail page={page} scope={scope} isAdmin={isAdmin} onRefresh={async (updated) => { setPage(updated); await loadDirectoryPage(false); }} /></> : <div className="wiki-reader-empty">
        <div className="wiki-reader-empty-inner">
          <div className="wiki-reader-empty-icon"><Network size={22} aria-hidden="true" /></div>
          <p className="wiki-reader-kicker">Source-linked reading</p>
          <h2>Select a Wiki topic</h2>
          <p>Choose a page from the directory. The reader stays beside the tree so you can move between related topics without losing your place.</p>
        </div>
      </div>}
    </main>
  </div>;
}
function GatesPane() {
  const [gates, setGates] = useState<JsonRecord>();
  const [error, setError] = useState("");
  const load = () => { setError(""); api.knowledgeReleaseGates().then((value) => setGates(asRecord(value))).catch((err) => setError(errText(err, "Unable to load release gates"))); };
  useEffect(() => { load(); }, []);
  if (error && !gates) return <StatePanel state="error" message={error} onRetry={load} />;
  if (!gates) return <StatePanel state="loading" message="Running release gates…" />;
  const checks = Object.entries(gates.checks ?? {}) as Array<[string, JsonRecord]>;
  return <div className="space-y-4">
    <section className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><CheckCircle2 size={16} className={gates.ready ? "text-mint" : "text-coral"} /><h3 className="font-medium text-fg">Release gates</h3></div>
        <div className="flex items-center gap-2"><StatusBadge value={gates.ready ? "ready" : "blocked"} /><button className={btnGhost} onClick={load}><RefreshCw size={13} /> Re-run</button></div>
      </div>
      <p className="mt-1 text-xs text-muted">Checked at {formatDate(gates.checkedAt)}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {checks.map(([name, check]) => <div key={name} className="rounded-md border border-white/10 p-3">
          <div className="flex items-center justify-between gap-2"><span className="text-xs text-fg">{name}</span><StatusBadge value={check?.ok ? "ok" : "failed"} /></div>
          <p className="mt-1 text-[11px] text-muted">{Object.entries(check ?? {}).filter(([key]) => key !== "ok" && key !== "findings").map(([key, value]) => `${key}: ${String(value)}`).join(" — ") || "no details"}</p>
          {Array.isArray(check?.findings) && check.findings.length > 0 && <ul className="mt-1 list-disc pl-4 text-[11px] text-coral">{check.findings.map((finding: string) => <li key={finding}>{finding}</li>)}</ul>}
        </div>)}
      </div>
    </section>
    {!gates.ready && <section className="rounded-lg border border-coral/40 bg-coral/10 p-4 text-sm text-coral">
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
  ["gates", "Release gates", CheckCircle2],
] as const;

export default function KnowledgeIntegrated() {
  const { user } = useAuth();
  const isAdmin = Boolean(user?.isAdmin);
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get("tab");
  const tab = TABS.some(([key]) => key === requestedTab) ? requestedTab! : "sessions";
  const setTab = (value: string) => setParams((current) => { const next = new URLSearchParams(current); next.set("tab", value); return next; });
  return <div className="mx-auto max-w-[1280px] px-5 py-8 sm:px-8">
    <PageHeader title="Control plane" description="Sessions, providers, review and publication for Relay knowledge." />
    <nav className="mb-5 flex flex-wrap gap-2" aria-label="Control plane sections">
      {TABS.map(([key, label, Icon]) => <button key={key} onClick={() => setTab(key)} className={`inline-flex items-center gap-1.5 rounded-ctl px-3 py-2 text-sm ${tab === key ? "bg-mint text-ink" : "border border-white/10 text-muted hover:border-white/20"}`}><Icon size={14} /> {label}</button>)}
    </nav>
    {tab === "sessions" && <SessionsPane />}
    {tab === "providers" && <ProvidersPane isAdmin={isAdmin} />}
    {tab === "candidates" && <CandidatesPane isAdmin={isAdmin} />}
    {tab === "wiki" && <WikiPane isAdmin={isAdmin} />}
    {tab === "gates" && <GatesPane />}
  </div>;
}
