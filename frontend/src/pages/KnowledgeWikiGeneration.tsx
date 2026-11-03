import { useEffect, useMemo, useState } from "react";
import { Pause, Play, RefreshCw, Workflow } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { Badge, formatDate, StatePanel, StatusBadge } from "../components/KnowledgePrimitives";
import { PageHeader } from "../components/ui";
import { PageTabs } from "../components/shell/PageTabs";
import { StandardPage } from "../components/knowledge/KnowledgeFrame";

type RecordValue = Record<string, unknown>;

const text = (value: unknown, fallback = ""): string => typeof value === "string" ? value : value == null ? fallback : String(value);
const records = (value: unknown): RecordValue[] => Array.isArray(value) ? value.filter((item): item is RecordValue => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
const numberValue = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

const JOB_LIMIT = 20;
const TOPIC_LIMIT = 25;

function scopeFromParams(params: URLSearchParams): Record<string, string> {
  const scope: Record<string, string> = {};
  const projectId = params.get("projectId")?.trim();
  const environment = params.get("environment")?.trim();
  if (projectId) scope.projectId = projectId;
  if (environment) scope.environment = environment;
  return scope;
}

export default function KnowledgeWikiGeneration() {
  const [params] = useSearchParams();
  const scope = useMemo(() => scopeFromParams(params), [params]);
  const [generation, setGeneration] = useState<RecordValue>();
  const [busy, setBusy] = useState(false);
  const [controlBusy, setControlBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [jobOffset, setJobOffset] = useState(0);
  const [topicOffset, setTopicOffset] = useState(0);

  const load = async (nextJobOffset = jobOffset, nextTopicOffset = topicOffset) => {
    setError("");
    try { setGeneration((await api.knowledgeWikiGeneration({ ...scope, limit: JOB_LIMIT, offset: nextJobOffset, topicLimit: TOPIC_LIMIT, topicOffset: nextTopicOffset })) as RecordValue); }
    catch (err) { setError(errorText(err, "Unable to load Wiki generation jobs")); }
  };

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const value = (await api.knowledgeWikiGeneration({ ...scope, limit: JOB_LIMIT, offset: jobOffset, topicLimit: TOPIC_LIMIT, topicOffset })) as RecordValue;
        if (cancelled) return;
        setGeneration(value);
        const summary = value.summary && typeof value.summary === "object" ? value.summary as RecordValue : {};
        const active = numberValue(summary.inProgress) > 0 || numberValue(summary.paused) > 0 || records(value.jobs).some((job) => ["queued", "running"].includes(text(job.status)) || text(job.controlState) === "pause_requested");
        if (active) timer = window.setTimeout(() => void poll(), 2_500);
      } catch (err) {
        if (!cancelled) { setError(errorText(err, "Unable to refresh Wiki generation jobs")); timer = window.setTimeout(() => void poll(), 5_000); }
      }
    };
    void poll();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [scope.projectId, scope.environment, jobOffset, topicOffset]);

  const jobs = records(generation?.jobs);
  const summary = generation?.summary && typeof generation.summary === "object" ? generation.summary as RecordValue : {};
  const jobsPage = generation?.jobsPage && typeof generation.jobsPage === "object" ? generation.jobsPage as RecordValue : {};
  const topicsPage = generation?.topicsPage && typeof generation.topicsPage === "object" ? generation.topicsPage as RecordValue : {};
  const topics = records(generation?.topics);
  const activeJobs = jobs.filter((job) => (["queued", "running"].includes(text(job.status)) && text(job.controlState) !== "paused") || text(job.controlState) === "pause_requested");
  const pausedJobs = jobs.filter((job) => text(job.controlState) === "paused");
  const failedJobs = jobs.filter((job) => text(job.status) === "failed");
  const visibleJobs = jobs.filter((job) => ["queued", "running", "failed"].includes(text(job.status)) || ["paused", "pause_requested"].includes(text(job.controlState)));
  const jobTotal = numberValue(jobsPage.total, jobs.length), topicTotal = numberValue(topicsPage.total, topics.length);
  const jobFrom = jobTotal ? jobOffset + 1 : 0, jobTo = Math.min(jobOffset + jobs.length, jobTotal);
  const topicFrom = topicTotal ? topicOffset + 1 : 0, topicTo = Math.min(topicOffset + topics.length, topicTotal);

  const start = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = (await api.knowledgeWikiGenerationStart({ ...scope, retryFailed: true })) as RecordValue;
      const queued = numberValue(response.queued), total = numberValue(response.total), skipped = numberValue(response.skipped, Math.max(0, total - queued)), generated = numberValue(response.generated);
      setNotice(`Queued ${queued.toLocaleString()} of ${total.toLocaleString()} Wiki topics. ${skipped.toLocaleString()} skipped${generated ? `; ${generated.toLocaleString()} already generated` : ""}.`);
      await load();
    } catch (err) { setError(errorText(err, "Unable to start Wiki generation")); }
    finally { setBusy(false); }
  };

  const control = async (job: RecordValue) => {
    const id = text(job.id), state = text(job.controlState, "active");
    const action = state === "paused" ? "resume" : "pause";
    if (!id || controlBusy[id] || (state !== "active" && state !== "paused")) return;
    setControlBusy((current) => ({ ...current, [id]: true })); setError("");
    try { await api.knowledgeWikiGenerationControl(id, action); await load(); }
    catch (err) { setError(errorText(err, `Unable to ${action} Wiki generation`)); }
    finally { setControlBusy((current) => ({ ...current, [id]: false })); }
  };

  if (error && !generation) return <StandardPage className="knowledge-operations-page"><PageHeader title="Wiki generation" description="Run and control topic-level Wiki generation jobs." tabs={<PageTabs section="operations" />} /><StatePanel state="error" message={error} onRetry={() => void load()} /></StandardPage>;
  if (!generation) return <StandardPage className="knowledge-operations-page"><PageHeader title="Wiki generation" description="Run and control topic-level Wiki generation jobs." tabs={<PageTabs section="operations" />} /><StatePanel state="loading" message="Loading Wiki generation jobs…" /></StandardPage>;

  return <StandardPage className="knowledge-operations-page">
    <PageHeader title="Wiki generation" description="Run, monitor, pause, and resume topic-level Wiki generation without mixing it into the Wiki reading surface." tabs={<PageTabs section="operations" />} actions={<div className="flex flex-wrap gap-2"><button type="button" className="ui-button ui-button-ghost ui-button-sm" onClick={() => void load()}><RefreshCw size={14} /> Refresh</button><button type="button" className="ui-button ui-button-primary ui-button-sm" disabled={busy} onClick={() => void start()}><Workflow size={14} /> {busy ? "Queueing…" : "Generate topics"}</button></div>} />
    {error && <p role="alert" className="mb-5 rounded-field border border-coral/40 bg-coral/10 p-3 text-sm text-coral">{error}</p>}
    {notice && <p className="mb-5 rounded-field border border-mint/40 bg-mint/10 p-3 text-sm text-mint">{notice}</p>}
    <section className="glass grid grid-cols-2 divide-x divide-y divide-white/10 md:grid-cols-4 md:divide-y-0" aria-label="Wiki generation summary">
      {[{ label: "In progress", value: numberValue(summary.inProgress, activeJobs.length) }, { label: "Paused", value: numberValue(summary.paused, pausedJobs.length) }, { label: "Generated topics", value: numberValue(summary.generated) }, { label: "Topics total", value: numberValue(summary.total, topicTotal) }].map((item) => <div key={item.label} className="min-w-0 px-5 py-4"><p className="text-[13px] text-muted">{item.label}</p><p className="mt-2 font-display text-2xl font-semibold text-fg">{item.value.toLocaleString()}</p></div>)}
    </section>
    <section className="glass mt-6 p-5" aria-label="Wiki generation jobs">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="font-display text-[22px] font-semibold text-fg">Generation jobs</h2><p className="mt-1 max-w-[70ch] text-sm text-muted">Automatic jobs are created after Product Document imports. Manual runs queue only topics that are not complete or explicitly being retried. An active job covers its topic IDs, so a duplicate click is blocked safely.</p></div><StatusBadge value={activeJobs.length ? "running" : pausedJobs.length ? "paused" : failedJobs.length ? "attention" : "ready"} /></div>
      {visibleJobs.length === 0 ? <p className="mt-6 rounded-field border border-line bg-[var(--field)] p-5 text-sm text-muted">No active or recent Wiki generation jobs.</p> : <div className="mt-5 space-y-3">{visibleJobs.map((job, index) => {
        const id = text(job.id), status = text(job.status, "unknown"), controlState = text(job.controlState, "active"), percent = Math.max(0, Math.min(100, Number(job.percent ?? 0) || 0));
        const paused = controlState === "paused", pauseRequested = controlState === "pause_requested", manual = text(job.triggerKind) === "manual";
        const canControl = ["queued", "running"].includes(status) && (paused || controlState === "active");
        const label = manual ? "Manual generation" : "Automatic generation";
        const shortId = id ? `Job …${id.slice(-8)}` : `Job ${index + 1}`;
        return <article key={id || index} className="rounded-field border border-line bg-[var(--field)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2"><Badge tone={manual ? "purple" : "blue"}>{manual ? "Manual" : "Automatic"}</Badge><span className="font-medium text-fg">{label}</span><span className="truncate font-mono text-xs text-muted" title={id}>{shortId}</span></div><span className="font-mono text-sm text-fg">{percent}%</span></div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label={`Wiki generation ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div className="h-full rounded-full bg-iris transition-[width] duration-300" style={{ width: `${percent}%` }} /></div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted"><span>{Number(job.processed ?? 0).toLocaleString()} / {Number(job.total ?? 0).toLocaleString()} topics · {Number(job.generated ?? 0).toLocaleString()} generated · {Number(job.failures ?? 0).toLocaleString()} failed · {status} · updated {formatDate(text(job.updatedAt))}</span>{canControl && <button type="button" className="ui-button ui-button-ghost ui-button-sm" disabled={Boolean(id && controlBusy[id])} onClick={() => void control(job)}>{paused ? <Play size={13} /> : <Pause size={13} />}{id && controlBusy[id] ? "Saving…" : paused ? "Resume" : "Pause"}</button>}</div>
          {pauseRequested && <p className="mt-2 text-xs text-sun">Pause requested; the current topic batch will finish first.</p>}
        </article>;
      })}</div>}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-xs text-muted"><span>{jobFrom.toLocaleString()}–{jobTo.toLocaleString()} of {jobTotal.toLocaleString()} jobs</span><div className="flex gap-2"><button type="button" className="ui-button ui-button-ghost ui-button-sm" disabled={jobOffset <= 0} onClick={() => { const next = Math.max(0, jobOffset - JOB_LIMIT); setJobOffset(next); void load(next, topicOffset); }}>Previous</button><button type="button" className="ui-button ui-button-ghost ui-button-sm" disabled={jobOffset + jobs.length >= jobTotal} onClick={() => { const next = jobOffset + JOB_LIMIT; setJobOffset(next); void load(next, topicOffset); }}>Next</button></div></div>
    </section>
    <section className="glass mt-6 min-w-0 p-5" aria-label="Wiki topic generation markers">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="font-display text-[22px] font-semibold text-fg">Topic generation markers</h2><p className="mt-1 max-w-[75ch] text-sm text-muted">Every canonical topic has a durable marker. Completed topics are skipped on the next run; queued, running, and paused topics remain attached to their active job.</p></div><Badge tone="blue">{topicTotal.toLocaleString()} topics</Badge></div>
      {topics.length === 0 ? <p className="mt-6 rounded-field border border-line bg-[var(--field)] p-5 text-sm text-muted">No canonical topics are available in this scope.</p> : <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="border-b border-line text-xs uppercase tracking-[0.12em] text-muted"><tr><th className="px-3 py-3">Topic</th><th className="px-3 py-3">Classification</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Attempts</th><th className="px-3 py-3">Updated</th></tr></thead><tbody className="divide-y divide-line">{topics.map((topic) => { const status = text(topic.generationStatus, "not_started"); return <tr key={text(topic.topicGroupId)}><td className="max-w-[360px] px-3 py-3"><div className="truncate font-medium text-fg" title={text(topic.title)}>{text(topic.title, text(topic.topicGroupId))}</div><div className="mt-1 break-all font-mono text-[11px] text-muted">{text(topic.topicGroupId)}</div>{text(topic.generatedPageId) && <div className="mt-1 text-xs text-muted">Page {text(topic.generatedPageId).slice(-10)}</div>}</td><td className="px-3 py-3 text-muted">{[text(topic.solution), text(topic.module)].filter(Boolean).join(" / ") || "Unassigned"}</td><td className="px-3 py-3"><StatusBadge value={status} />{text(topic.jobId) && <div className="mt-1 break-all font-mono text-[11px] text-muted">Job {text(topic.jobId).slice(-8)}</div>}</td><td className="px-3 py-3 text-muted">{numberValue(topic.attemptCount).toLocaleString()}</td><td className="px-3 py-3 whitespace-nowrap text-muted">{formatDate(text(topic.updatedAt))}</td></tr>; })}</tbody></table></div>}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-xs text-muted"><span>{topicFrom.toLocaleString()}–{topicTo.toLocaleString()} of {topicTotal.toLocaleString()} topics</span><div className="flex gap-2"><button type="button" className="ui-button ui-button-ghost ui-button-sm" disabled={topicOffset <= 0} onClick={() => { const next = Math.max(0, topicOffset - TOPIC_LIMIT); setTopicOffset(next); void load(jobOffset, next); }}>Previous</button><button type="button" className="ui-button ui-button-ghost ui-button-sm" disabled={topicOffset + topics.length >= topicTotal} onClick={() => { const next = topicOffset + TOPIC_LIMIT; setTopicOffset(next); void load(jobOffset, next); }}>Next</button></div></div>
    </section>
  </StandardPage>;
}
