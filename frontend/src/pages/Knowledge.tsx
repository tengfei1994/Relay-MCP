import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, ChevronRight, Download, GitBranch, RefreshCw, Search, ThumbsDown, ThumbsUp } from "lucide-react";
import { api } from "../api/client";

type Project = { id: number; name: string; description?: string };
type SearchResult = { id: string; kind: string; title: string; summary: string; score?: number; lifecycle: string; versionMatch?: boolean; matchReasons?: string[]; applicability?: Record<string, string | undefined>; evidenceRefs?: string[]; scope?: { scopeType?: string; scopeKey?: string; visibility?: string }; card?: any; candidateType?: string; sampleManagerVersion?: string; solution?: string; module?: string; environment?: string; jobId?: string; deploymentId?: string; evidenceCount?: number; createdAt?: string };

const inputClass = "h-9 rounded-md border border-gray-800 bg-gray-900 px-3 text-sm text-gray-200 outline-none focus:border-indigo-500";

function confidenceLabel(value: unknown): string {
  const score = Number(value);
  if (!Number.isFinite(score)) return "Not scored";
  if (score < 0.4) return "Low · signal only";
  if (score < 0.7) return "Medium · needs validation";
  return "High · evidence-backed";
}

function nextStepFor(lifecycle: unknown): string {
  switch (String(lifecycle)) {
    case "reproduced": return "Verify the root-cause hypothesis against the linked Evidence, then promote to Verified.";
    case "verified": return "Confirm the reviewer conclusion and promote to Approved before broad reuse.";
    case "approved": return "This Knowledge is approved for reuse; keep monitoring feedback and Evidence freshness.";
    case "deprecated": return "This Knowledge is deprecated and should not be reused.";
    default: return "Inspect the linked Evidence and reproduce the observation in a controlled environment before accepting it.";
  }
}

export default function KnowledgePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | undefined>();
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState("");
  const [solution, setSolution] = useState("");
  const [moduleName, setModuleName] = useState("");
  const [environment, setEnvironment] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [candidates, setCandidates] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [status, setStatus] = useState<any | null>(null);
  const [impact, setImpact] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [cardDraft, setCardDraft] = useState<any | null>(null);

  useEffect(() => {
    api.listProjects().then((response) => {
      setProjects(response.projects);
      if (response.projects[0]) setProjectId(response.projects[0].id);
    }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load projects"));
  }, []);

  useEffect(() => {
    if (!projectId) return;
    api.knowledgeIndexStatus(projectId).then(setStatus).catch(() => setStatus(null));
    api.knowledgeCandidates(projectId).then((response) => setCandidates(response.candidates)).catch(() => setCandidates([]));
  }, [projectId]);

  const search = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!projectId || !query.trim()) return;
    setLoading(true); setError(""); setMessage("");
    try {
      const response = await api.knowledgeSearch({ projectId, q: query.trim(), sampleManagerVersion: version || undefined, solution: solution || undefined, module: moduleName || undefined, environment: environment || undefined, limit: 50 });
      setResults(response.results);
      if (response.degraded) setMessage("Search is running in degraded FTS mode; semantic provider is unavailable.");
    } catch (err) { setError(err instanceof Error ? err.message : "Knowledge search failed"); }
    finally { setLoading(false); }
  };

  const openResult = async (result: SearchResult) => {
    setSelected(result); setDetail(null); setImpact(null); setError("");
    try { const value = await api.knowledgeDocument(result.id, projectId); setDetail(value); setCardDraft(value.document.card ? { ...value.document.card, actionsText: (value.document.card.actions ?? []).join("\n"), verificationPlanText: (value.document.card.verificationPlan ?? []).join("\n") } : null); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to load document"); }
  };

  const saveCard = async () => {
    if (!selected || !cardDraft || !reviewReason.trim()) { setError("Enter a review reason before saving the Knowledge Card."); return; }
    setReviewBusy(true); setError("");
    try {
      const card = { summary: cardDraft.summary, problemStatement: cardDraft.problemStatement, hypothesis: cardDraft.hypothesis, applicability: cardDraft.applicability, actions: String(cardDraft.actionsText ?? "").split("\n").map((item) => item.trim()).filter(Boolean), verificationPlan: String(cardDraft.verificationPlanText ?? "").split("\n").map((item) => item.trim()).filter(Boolean), confidence: Number(cardDraft.confidence ?? 0) };
      await api.knowledgeReview({ action: "edit_card", documentId: selected.id, reason: reviewReason.trim(), card }, `ui-edit-card-${selected.id}-${Date.now()}`);
      setMessage("Knowledge Card edit recorded with before/after audit history."); setReviewReason(""); await openResult(selected);
    } catch (err) { setError(err instanceof Error ? err.message : "Knowledge Card update failed"); }
    finally { setReviewBusy(false); }
  };

  const review = async (action: "accept" | "reject" | "deprecate") => {
    if (!selected || !reviewReason.trim()) { setError("Enter a review reason before applying an action."); return; }
    setReviewBusy(true); setError("");
    try {
      await api.knowledgeReview({ action, documentId: selected.id, reason: reviewReason.trim() }, `ui-${action}-${selected.id}-${Date.now()}`);
      setMessage(`Review action '${action}' recorded.`);
      setReviewReason("");
      await openResult(selected);
      if (projectId) setStatus(await api.knowledgeIndexStatus(projectId));
      if (projectId) setCandidates((await api.knowledgeCandidates(projectId)).candidates);
    } catch (err) { setError(err instanceof Error ? err.message : "Review action failed"); }
    finally { setReviewBusy(false); }
  };

  const sendFeedback = async (helpful: boolean) => {
    if (!selected) return;
    try {
      await api.knowledgeFeedback({ documentId: selected.id, helpful, comment: feedbackComment.trim() || undefined }, `ui-feedback-${selected.id}-${Date.now()}`);
      setFeedbackComment(""); setMessage("Feedback recorded for this Knowledge result.");
    } catch (err) { setError(err instanceof Error ? err.message : "Feedback failed"); }
  };

  const loadImpact = async () => {
    if (!projectId || !selected) return;
    try { setImpact(await api.knowledgeImpact({ projectId, objectId: selected.id, maxDepth: 3, direction: "both" })); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to load impact graph"); }
  };

  const downloadEvidence = async (evidenceId: string) => {
    try {
      const session = await api.knowledgeEvidenceSession(evidenceId);
      const token = localStorage.getItem("token");
      const response = await fetch(api.knowledgeEvidenceContentUrl(evidenceId, session.sessionId), { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      if (!response.ok) throw new Error(`Evidence download failed (${response.status})`);
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = evidenceId; anchor.click(); URL.revokeObjectURL(url);
    } catch (err) { setError(err instanceof Error ? err.message : "Evidence download failed"); }
  };

  const selectedProject = useMemo(() => projects.find((project) => project.id === projectId), [projects, projectId]);

  return (
    <div className="min-h-full bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 bg-gray-950/95 px-8 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-indigo-300"><GitBranch size={20} /></div><div><h1 className="text-xl font-semibold">Knowledge Workbench</h1><p className="mt-1 text-sm text-gray-500">Search, verify, inspect evidence, and review candidates without changing production Skills.</p></div></div>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500"><span>{selectedProject?.name ?? "No project"}</span>{status && <span className={status.stale ? "text-amber-300" : "text-emerald-300"}>{status.stale ? "stale index" : "index ready"}</span>}</div>
        </div>
        <form onSubmit={search} className="mt-6 grid grid-cols-1 gap-3 xl:grid-cols-[180px_minmax(260px,1fr)_160px_160px_160px_160px_auto]">
          <select className={inputClass} value={projectId ?? ""} onChange={(event) => setProjectId(Number(event.target.value) || undefined)}><option value="">Project…</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
          <label className="relative"><Search size={15} className="pointer-events-none absolute left-3 top-3 text-gray-500" /><input className={`${inputClass} w-full pl-9`} placeholder="Search cases, patterns, playbooks, facts…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <input className={inputClass} placeholder="SM version" value={version} onChange={(event) => setVersion(event.target.value)} />
          <input className={inputClass} placeholder="Solution" value={solution} onChange={(event) => setSolution(event.target.value)} />
          <input className={inputClass} placeholder="Module" value={moduleName} onChange={(event) => setModuleName(event.target.value)} />
          <input className={inputClass} placeholder="Environment" value={environment} onChange={(event) => setEnvironment(event.target.value)} />
          <button className="flex h-9 items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50" disabled={loading || !projectId || !query.trim()}><Search size={15} />{loading ? "Searching…" : "Search"}</button>
        </form>
      </header>

      {error && <div className="mx-8 mt-5 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"><AlertCircle size={16} className="mt-0.5 shrink-0" />{error}</div>}
      {message && <div className="mx-8 mt-5 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">{message}</div>}

      <div className="grid min-h-[calc(100vh-245px)] min-w-0 grid-cols-1 lg:grid-cols-[minmax(280px,0.75fr)_minmax(0,1.45fr)_minmax(320px,0.85fr)]">
        <section className="min-w-0 border-r border-gray-800 px-6 py-5">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Results</h2><span className="text-xs text-gray-600">{results.length}</span></div>
          {results.length === 0 && candidates.length === 0 ? <div className="rounded-md border border-dashed border-gray-800 p-8 text-center text-sm text-gray-600">Run a search to see explainable, ACL-filtered results.</div> : <div className="space-y-2">
            {results.length === 0 && candidates.length > 0 && <div className="mb-3 rounded border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs text-sky-300">Candidate review queue · {candidates.length} pending</div>}
            {(results.length ? results : candidates).map((result) => <button key={result.id} onClick={() => openResult(result)} className={`w-full rounded-md border px-4 py-3 text-left transition ${selected?.id === result.id ? "border-indigo-500/50 bg-indigo-500/10" : "border-gray-800 bg-gray-900/40 hover:border-gray-700 hover:bg-gray-900"}`}><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-medium text-gray-200">{result.title}</span><span className="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400">{result.kind}{result.candidateType ? ` / ${result.candidateType}` : ""}</span><span className="rounded border border-emerald-500/30 px-1.5 py-0.5 text-[10px] text-emerald-300">{result.lifecycle}</span>{result.scope?.scopeType && <span className="rounded border border-sky-500/30 px-1.5 py-0.5 text-[10px] text-sky-300">{result.scope.scopeType}:{result.scope.scopeKey || "all"}</span>}</div><p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">{result.summary}</p>{result.kind === "candidate" && <p className="mt-2 text-[11px] text-gray-600">{[result.sampleManagerVersion, result.solution, result.module, result.environment, result.jobId ? `Job ${result.jobId}` : undefined, result.deploymentId ? `Deployment ${result.deploymentId}` : undefined, `${result.evidenceCount ?? 0} Evidence`, result.createdAt].filter(Boolean).join(" · ")}</p>}<p className="mt-2 text-[11px] text-gray-600">{results.length && result.score !== undefined ? `score ${result.score.toFixed(3)} · ${(result.matchReasons ?? []).join(" · ")}` : "Awaiting reviewer decision"}</p></div><ChevronRight size={15} className="mt-1 shrink-0 text-gray-700" /></div></button>)}
          </div>}
        </section>

        <section className="min-w-0 border-r border-gray-800 px-6 py-5">
          {!detail ? <div className="flex h-full items-center justify-center text-sm text-gray-600">Select a result to inspect its provenance and review history.</div> : <>
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[11px] uppercase tracking-wider text-indigo-400">{detail.document.kind}</p><h2 className="mt-2 text-lg font-semibold text-gray-100">{detail.document.title}</h2><p className="mt-1 text-xs text-gray-600">{detail.document.id} · {detail.document.lifecycle}</p></div><button onClick={() => selected && loadImpact()} className="flex items-center gap-2 rounded border border-gray-700 px-3 py-2 text-xs text-gray-300 hover:bg-gray-800"><GitBranch size={14} />Impact</button></div>
            {detail.document.card ? <div className="mt-6 space-y-5">
              <div className="rounded-md border border-indigo-500/30 bg-indigo-500/5 p-5"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-300">Structured Candidate Card</p><div className="flex flex-wrap gap-2 text-[10px]"><span className="rounded border border-indigo-400/30 px-2 py-0.5 text-indigo-200">{detail.document.card.inferenceStatus ?? "deterministic"}</span>{detail.document.card.confidence !== undefined && <span className="rounded border border-gray-700 px-2 py-0.5 text-gray-300">{confidenceLabel(detail.document.card.confidence)} · {Math.round(Number(detail.document.card.confidence) * 100)}%</span>}</div></div><p className="mt-3 text-sm font-medium leading-6 text-gray-100 break-words [overflow-wrap:anywhere]">{detail.document.card.summary}</p><p className="mt-2 text-xs leading-5 text-gray-500 break-words [overflow-wrap:anywhere]">{detail.document.card.problemStatement}</p><p className="mt-3 rounded border border-indigo-400/20 bg-gray-950/40 px-3 py-2 text-xs leading-5 text-indigo-100">What this means: this is a captured observation, not a verified fix. {nextStepFor(detail.document.lifecycle)}</p>{(detail.document.card.applicability || detail.document.card.tags?.length) && <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">{detail.document.card.applicability && <span className="max-w-full break-words rounded bg-gray-900/70 px-2 py-1 text-gray-400">Applies to: {detail.document.card.applicability}</span>}{detail.document.card.tags?.map((tag: string) => <span key={tag} className="rounded bg-indigo-500/10 px-2 py-1 text-indigo-200">#{tag}</span>)}</div>}</div>
              <div className="grid gap-4 md:grid-cols-2"><div className="min-w-0 rounded border border-gray-800 bg-gray-900/40 p-4"><p className="text-[11px] uppercase tracking-wider text-gray-500">Facts</p><div className="mt-3 space-y-2 text-xs text-gray-300">{detail.document.card.facts?.map((fact: any, index: number) => <p key={index} className="break-words leading-5 [overflow-wrap:anywhere]"><span className="text-gray-500">{fact.field}:</span> {String(fact.value)}</p>)}</div></div><div className="min-w-0 rounded border border-gray-800 bg-gray-900/40 p-4"><p className="text-[11px] uppercase tracking-wider text-gray-500">Symptoms</p>{detail.document.card.symptoms?.length ? <ul className="mt-3 list-disc space-y-2 pl-4 text-xs leading-5 text-gray-300">{detail.document.card.symptoms.map((item: string) => <li key={item} className="break-words [overflow-wrap:anywhere]">{item}</li>)}</ul> : <p className="mt-3 text-xs text-gray-600">No explicit symptoms.</p>}</div></div>
              <div className="rounded border border-amber-500/20 bg-amber-500/5 p-4"><p className="text-[11px] uppercase tracking-wider text-amber-300">Hypothesis · unconfirmed</p><p className="mt-2 break-words text-sm leading-6 text-amber-100 [overflow-wrap:anywhere]">{detail.document.card.hypothesis}</p></div>
              <div className="grid gap-4 md:grid-cols-2"><div className="min-w-0 rounded border border-gray-800 bg-gray-900/40 p-4"><p className="text-[11px] uppercase tracking-wider text-gray-500">Verification plan</p><ul className="mt-3 list-disc space-y-2 pl-4 text-xs leading-5 text-gray-300">{detail.document.card.verificationPlan?.map((item: string) => <li key={item} className="break-words [overflow-wrap:anywhere]">{item}</li>)}</ul></div><div className="min-w-0 rounded border border-gray-800 bg-gray-900/40 p-4"><p className="text-[11px] uppercase tracking-wider text-gray-500">Actions</p><ul className="mt-3 list-disc space-y-2 pl-4 text-xs leading-5 text-gray-300">{detail.document.card.actions?.map((item: string) => <li key={item} className="break-words [overflow-wrap:anywhere]">{item}</li>)}</ul></div></div>
              {detail.document.card.verification?.length ? <div className="rounded border border-sky-500/20 bg-sky-500/5 p-4"><p className="text-[11px] uppercase tracking-wider text-sky-300">Verification evidence / outcome</p><ul className="mt-3 list-disc space-y-2 pl-4 text-xs leading-5 text-sky-100">{detail.document.card.verification.map((item: string) => <li key={item} className="break-words [overflow-wrap:anywhere]">{item}</li>)}</ul></div> : null}
              {detail.document.card.verifiedConclusion ? <div className="rounded border border-emerald-500/20 bg-emerald-500/5 p-4"><p className="text-[11px] uppercase tracking-wider text-emerald-300">Verified conclusion</p><p className="mt-2 break-words text-sm leading-6 text-emerald-100 [overflow-wrap:anywhere]">{detail.document.card.verifiedConclusion}</p></div> : <div className="rounded border border-gray-800 p-3 text-xs text-gray-500">Verified conclusion: not established.</div>}
              <details className="rounded border border-gray-800 bg-gray-900/30 p-4"><summary className="cursor-pointer text-xs font-medium text-gray-400">Raw Event · immutable provenance</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs leading-5 text-gray-500">{detail.document.body}</pre></details>
            </div> : <div className="mt-6 rounded-md border border-gray-800 bg-gray-900/50 p-4"><p className="whitespace-pre-wrap text-sm leading-6 text-gray-300">{detail.document.body}</p></div>}
            <div className="mt-5 grid grid-cols-2 gap-3 text-xs">{[["Lifecycle", detail.document.lifecycle], ["Scope", detail.document.scope ? `${detail.document.scope.scopeType}:${detail.document.scope.scopeKey || "all"} · ${detail.document.scope.visibility}` : "project"], ["Version", detail.document.sampleManagerVersion ?? "general"], ["Solution / Module", [detail.document.solution, detail.document.module].filter(Boolean).join(" / ") || "general"], ["Environment", detail.document.environment ?? "general"], ["Source", detail.document.sourceLocator]].map(([label, value]) => <div key={label} className="rounded border border-gray-800 bg-gray-900/40 p-3"><p className="text-gray-600">{label}</p><p className="mt-1 break-all text-gray-300">{value}</p></div>)}</div>
            <details className="mt-6 rounded border border-gray-800 bg-gray-900/30 p-4"><summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-gray-500">Evidence · {detail.evidenceRefs?.length ?? 0} linked</summary>{detail.evidenceRefs?.length ? <div className="mt-3 max-h-72 space-y-2 overflow-auto pr-1">{detail.evidenceRefs.map((id: string) => <div key={id} className="flex min-w-0 items-center justify-between gap-2 rounded border border-gray-800 bg-gray-900/40 px-3 py-2"><code className="min-w-0 break-all text-xs text-gray-400">{id}</code><button onClick={() => downloadEvidence(id)} className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-indigo-300 hover:bg-indigo-500/10"><Download size={13} />Download</button></div>)}</div> : <p className="mt-3 text-xs text-gray-600">No Evidence linked.</p>}</details>
            <div className="mt-6"><p className="text-[11px] font-semibold uppercase tracking-wider text-gray-600">Review history</p>{detail.reviews?.length ? <div className="mt-2 space-y-2">{detail.reviews.map((review: any) => <div key={review.id} className="rounded border border-gray-800 bg-gray-900/40 p-3 text-xs"><div className="flex justify-between text-gray-400"><span>{review.action}</span><span>{review.created_at}</span></div><p className="mt-1 text-gray-500">{review.reason}</p></div>)}</div> : <p className="mt-2 text-xs text-gray-600">No review history yet.</p>}</div>
            <div className="mt-6 rounded border border-gray-800 bg-gray-900/40 p-4"><p className="text-[11px] font-semibold uppercase tracking-wider text-gray-600">Feedback</p><textarea value={feedbackComment} onChange={(event) => setFeedbackComment(event.target.value)} placeholder="Optional comment" className="mt-2 min-h-16 w-full rounded border border-gray-700 bg-gray-950 p-2 text-xs text-gray-200 outline-none focus:border-indigo-500" /><div className="mt-2 flex gap-2"><button onClick={() => sendFeedback(true)} className="flex items-center gap-1 rounded border border-emerald-500/30 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/10"><ThumbsUp size={13} />Helpful</button><button onClick={() => sendFeedback(false)} className="flex items-center gap-1 rounded border border-amber-500/30 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-500/10"><ThumbsDown size={13} />Not helpful</button></div></div>
          </>}
        </section>

        <aside className="min-w-0 px-6 py-5">
          <div className="rounded-md border border-gray-800 bg-gray-900/40 p-4"><div className="flex items-center justify-between"><h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Candidate review</h2><RefreshCw size={14} className="text-gray-600" /></div>{selected?.kind === "candidate" ? <><p className="mt-3 rounded border border-gray-800 bg-gray-950/40 px-3 py-2 text-xs leading-5 text-gray-500">Current state: <span className="text-gray-300">{detail?.document?.lifecycle ?? selected.lifecycle ?? "loading"}</span>. {nextStepFor(detail?.document?.lifecycle ?? selected.lifecycle)}</p><textarea value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder="Reason (required for audit)" className="mt-4 min-h-20 w-full max-w-full rounded border border-gray-700 bg-gray-950 p-3 text-sm text-gray-200 outline-none focus:border-indigo-500" />{cardDraft && <div className="mt-3 space-y-3"><input value={cardDraft.summary ?? ""} onChange={(event) => setCardDraft({ ...cardDraft, summary: event.target.value })} placeholder="Knowledge Card summary" className="h-9 w-full max-w-full rounded border border-gray-700 bg-gray-950 px-2 text-xs text-gray-200" /><textarea value={cardDraft.hypothesis ?? ""} onChange={(event) => setCardDraft({ ...cardDraft, hypothesis: event.target.value })} placeholder="Hypothesis (will remain unconfirmed)" className="min-h-16 w-full max-w-full rounded border border-gray-700 bg-gray-950 p-2 text-xs text-gray-200" /><textarea value={cardDraft.verificationPlanText ?? ""} onChange={(event) => setCardDraft({ ...cardDraft, verificationPlanText: event.target.value })} placeholder="Verification plan, one item per line" className="min-h-16 w-full max-w-full rounded border border-gray-700 bg-gray-950 p-2 text-xs text-gray-200" /><textarea value={cardDraft.actionsText ?? ""} onChange={(event) => setCardDraft({ ...cardDraft, actionsText: event.target.value })} placeholder="Actions, one item per line" className="min-h-16 w-full max-w-full rounded border border-gray-700 bg-gray-950 p-2 text-xs text-gray-200" /><button disabled={reviewBusy} onClick={saveCard} className="w-full rounded border border-indigo-500/40 px-2 py-2 text-xs text-indigo-300 hover:bg-indigo-500/10 disabled:opacity-50">Save structured card</button></div>}<div className="mt-3 grid grid-cols-3 gap-2"><button disabled={reviewBusy} onClick={() => review("accept")} className="flex items-center justify-center gap-1 rounded bg-emerald-600/80 px-2 py-2 text-xs hover:bg-emerald-600 disabled:opacity-50"><ThumbsUp size={13} />Accept</button><button disabled={reviewBusy} onClick={() => review("reject")} className="flex items-center justify-center gap-1 rounded bg-amber-600/80 px-2 py-2 text-xs hover:bg-amber-600 disabled:opacity-50"><ThumbsDown size={13} />Reject</button><button disabled={reviewBusy} onClick={() => review("deprecate")} className="flex items-center justify-center gap-1 rounded bg-gray-700 px-2 py-2 text-xs hover:bg-gray-600 disabled:opacity-50"><Check size={13} />Deprecate</button></div></> : <p className="mt-3 text-xs leading-5 text-gray-600">Select a candidate to apply an audited review action. Knowledge objects remain drafts until a reviewer promotes them.</p>}</div>
          <div className="mt-4 rounded-md border border-gray-800 bg-gray-900/40 p-4"><h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Impact / relations</h2>{impact ? <><p className="mt-3 text-xs text-gray-400">{impact.nodes?.length ?? 0} nodes · {impact.relations?.length ?? 0} relations</p><div className="mt-3 max-h-80 space-y-2 overflow-auto">{impact.relations?.map((relation: any) => <div key={relation.id} className="rounded border border-gray-800 p-2 text-xs"><p className="text-gray-300">{relation.from.title} → {relation.to.title}</p><p className="mt-1 text-gray-600">{relation.relationType} · {relation.verified ? "verified" : "unverified"}</p></div>)}</div></> : <p className="mt-3 text-xs leading-5 text-gray-600">Run Impact from a selected document to inspect source-backed Form, Task, Assembly, Menu, and Cache relationships.</p>}</div>
          <div className="mt-4 rounded-md border border-gray-800 bg-gray-900/40 p-4"><div className="flex items-center justify-between"><h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Index status</h2><button onClick={() => projectId && api.knowledgeReindex(projectId).then((value) => setMessage(`Reindexed ${value.documents ?? 0} documents and ${value.facts ?? 0} facts.`)).catch((err) => setError(err instanceof Error ? err.message : "Reindex failed"))} className="text-xs text-indigo-300 hover:text-indigo-200">Reindex</button></div>{status?.counts?.length ? <div className="mt-3 space-y-1">{status.counts.map((item: any) => <div key={`${item.kind}-${item.lifecycle}`} className="flex justify-between text-xs"><span className="text-gray-500">{item.kind} · {item.lifecycle}</span><span className="text-gray-300">{item.count}</span></div>)}</div> : <p className="mt-3 text-xs text-gray-600">No indexed documents for this project.</p>}</div>
        </aside>
      </div>
    </div>
  );
}
