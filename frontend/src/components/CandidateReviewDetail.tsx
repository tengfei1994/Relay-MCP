import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { Badge, cardClass, formatDate } from "./KnowledgePrimitives";

type Narrative = {
  title: string; summary: string; assessment: string; recommendation: string;
  facts: string[]; unknowns: string[]; nextSteps: string[];
  sourceSignals: Array<{ source: string; text: string }>;
  environment?: string; occurredAt?: string;
  businessContext?: { businessPurpose: string; affectedProcess: string; businessImpact: string; technicalComponentPurpose: string; confidence: string };
};
const fallback: Narrative = {
  title: "This candidate needs a readable execution summary", summary: "This record does not yet explain what happened. Review the source and add details.",
  assessment: "insufficient", recommendation: "Insufficient information; defer review.",
  facts: [], unknowns: ["The source event has not been interpreted."], nextSteps: ["Review the original record and add the missing details."], sourceSignals: [],
};
const paragraph = "break-words text-sm leading-7 text-muted [overflow-wrap:anywhere]";
const field = "w-full rounded-field border border-line bg-[var(--field)] p-3 text-sm text-fg outline-none focus:border-mint focus:ring-2 focus:ring-mint/20";
const actionLabels: Record<string, string> = { reproduced: "Reproduced", verified: "Verified", approved: "Approved", deprecated: "Rejected or deactivated", "edit.card": "Edited details" };
function BusinessContext({ context }: { context?: Narrative["businessContext"] }) {
  if (!context) return <p className="text-sm text-muted">Business context has not been recorded. Add the purpose, affected process and business impact during review.</p>;
  const rows = [["Business purpose", context.businessPurpose], ["Affected process", context.affectedProcess], ["Business impact", context.businessImpact], ["Technical component purpose", context.technicalComponentPurpose]];
  return <div className="grid gap-3 sm:grid-cols-2">{rows.map(([label, value]) => <div key={label} className="glass min-w-0 rounded-field border border-line p-3"><p className="text-xs font-medium text-muted">{label}</p><p className="mt-2 break-words text-sm leading-6 text-fg">{value}</p></div>)}<p className="text-xs text-muted sm:col-span-2">Context: {context.confidence === "provided" ? "provided by the source" : context.confidence === "inferred" ? "inferred from technical signals" : "not available"}. Confirm it against the evidence.</p></div>;
}
type ReviewEntry = { id: string; action: string; created_at?: string; reason?: string; before_json?: unknown; after_json?: unknown };
type CandidateCard = { summary?: unknown; problemStatement?: unknown; actions?: unknown; businessContext?: Narrative["businessContext"]; confidence?: unknown };
type CandidateDocument = { id: string; card?: CandidateCard; narrative?: Narrative; lifecycle?: string; projectNameSnapshot?: string; environment?: string; createdAt?: string; eventId?: unknown; jobId?: unknown; deploymentId?: unknown; sourceLocator?: unknown; sourceSha256?: unknown; body?: unknown };
function printable(value: unknown): string {
  if (value === null || value === undefined) return "Not recorded";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value !== "object") return "Not recorded";
  try {
    return JSON.stringify(value, null, 2) ?? "Not recorded";
  } catch {
    return "Not recorded";
  }
}
type EvidenceInfo = { sourceKind?: string; mimeType?: string; createdAt?: string };
function isEvidenceInfo(value: unknown): value is EvidenceInfo { return typeof value === "object" && value !== null; }
function EvidenceItem({ id, index }: { id: string; index: number }) {
  const [info, setInfo] = useState<EvidenceInfo>(); const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.knowledgeEvidence(id).then((r) => { if (active && isEvidenceInfo(r.evidence)) setInfo(r.evidence); }).catch(() => { if (active) setError("Unable to load evidence details."); });
    return () => { active = false; };
  }, [id]);
  const kind = info?.sourceKind === "log" ? "Execution log" : info?.sourceKind === "test" ? "Verification result" : info?.sourceKind === "manifest" ? "Execution manifest" : "Original record";
  return <Link to={"/knowledge/evidence?document=" + encodeURIComponent(id)} className="glass block rounded-field border border-line p-3 transition-colors hover:border-mint">
    <p className="text-sm text-mint">Evidence {index + 1} / {kind}: View</p>
    <p className="mt-1 text-xs text-muted">{error || (info ? (info.mimeType ?? "File") + " / " + formatDate(info.createdAt) : "Loading source details…")}</p>
  </Link>;
}

export function CandidateReviewDetail({ document, evidenceRefs, reviews, onBack, onReview, refresh, evidenceEditor }: {
  document: CandidateDocument; evidenceRefs: string[]; reviews: ReviewEntry[]; onBack: () => void;
  onReview: (action: string, reason: string, payload?: Record<string, unknown>) => Promise<void>;
  refresh: () => Promise<void>; evidenceEditor: ReactNode;
}) {
  const card = document.card ?? {}; const narrative: Narrative = document.narrative ?? fallback;
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const [evidencePage, setEvidencePage] = useState(0); const [edit, setEdit] = useState(false);
  const [summary, setSummary] = useState(String(card.summary ?? ""));
  const [problem, setProblem] = useState(String(card.problemStatement ?? ""));
  const [actions, setActions] = useState((Array.isArray(card.actions) ? card.actions : []).join("\n"));
  const [businessPurpose, setBusinessPurpose] = useState(String(card.businessContext?.businessPurpose ?? narrative.businessContext?.businessPurpose ?? ""));
  const [affectedProcess, setAffectedProcess] = useState(String(card.businessContext?.affectedProcess ?? narrative.businessContext?.affectedProcess ?? ""));
  const [businessImpact, setBusinessImpact] = useState(String(card.businessContext?.businessImpact ?? narrative.businessContext?.businessImpact ?? ""));
  const [technicalPurpose, setTechnicalPurpose] = useState(String(card.businessContext?.technicalComponentPurpose ?? narrative.businessContext?.technicalComponentPurpose ?? ""));
  const [success, setSuccess] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const lifecycle: string = document.lifecycle ?? "draft";
  const draft = lifecycle === "draft";
  const perform = async (action: string) => {
    if (!reason.trim()) { setError("Enter a reason for this decision or edit."); return; }
    setBusy(action); setError(""); setSuccess("");
    try {
      const patch = action === "edit_card" ? { card: { summary, problemStatement: problem, actions: actions.split(/\r?\n/).filter(Boolean), businessContext: { businessPurpose, affectedProcess, businessImpact, technicalComponentPurpose: technicalPurpose, confidence: "provided" } } } : undefined;
      await onReview(action, reason.trim(), patch);
      await refresh(); setReason(""); setEdit(false);
      setSuccess(action === "accept" ? "Reproduction confirmed and Case created." : action === "edit_card" ? "Details saved; earlier versions remain in the review history." : "Decision recorded.");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to save. Try again."); }
    finally { setBusy(""); }
  };
  const hasEdit = reviews.some((r) => r.action === "edit.card");
  const pages = Math.max(1, Math.ceil(evidenceRefs.length / 5));
  const tone = narrative.assessment === "routine" ? "blue" : "amber";
  return <div className="space-y-5" lang="en">
    <button onClick={onBack} className="text-sm text-muted transition-colors hover:text-fg">Back to candidates</button>
    <section className={cardClass + " p-5 sm:p-6"}>
      <div className="flex flex-wrap items-center gap-2"><Badge tone="purple">Knowledge candidate</Badge><Badge>{draft ? "Awaiting review" : lifecycle === "deprecated" ? "Rejected / inactive" : lifecycle === "reproduced" ? "Reproduced" : lifecycle}</Badge><Badge tone={tone}>{narrative.assessment === "signal" ? "Signal needs review" : narrative.assessment === "routine" ? "Routine execution" : "More evidence needed"}</Badge></div>
      <h2 className="mt-4 break-words text-xl font-semibold text-fg sm:text-2xl">{narrative.title}</h2>
      <p className={"mt-3 max-w-4xl " + paragraph}>{narrative.summary}</p>
      <p className="mt-4 text-xs text-muted">{document.projectNameSnapshot || "Current project"} / {narrative.environment || document.environment || "Environment not recorded"} / Occurred {formatDate(narrative.occurredAt || document.createdAt)}</p>
    </section>

    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-5">
        <section className={cardClass}>
          <h3 className="font-medium text-fg">Business context</h3>
          <div className="mt-3"><BusinessContext context={narrative.businessContext} /></div>
        </section>
        <section className={cardClass}>
          <h3 className="font-medium text-fg">What the record tells us</h3>
          <ul className="mt-3 list-disc space-y-2 pl-5">{narrative.facts.map((item, i) => <li key={i} className={paragraph}>{item}</li>)}</ul>
          <h3 className="mt-5 border-t border-line pt-4 font-medium text-fg">What remains unknown</h3>
          <ul className="mt-3 list-disc space-y-2 pl-5">{narrative.unknowns.map((item, i) => <li key={i} className={paragraph}>{item}</li>)}</ul>
        </section>
        {hasEdit && <section className={cardClass}><h3 className="font-medium text-fg">Reviewer additions</h3><p className={"mt-3 whitespace-pre-wrap " + paragraph}>{printable(card.summary)}</p><p className={"mt-2 whitespace-pre-wrap " + paragraph}>{printable(card.problemStatement)}</p></section>}
        <section className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium text-fg">Review evidence</h3><span className="text-xs text-muted">{evidenceRefs.length} linked evidence items</span></div>
          <p className="mt-2 text-xs leading-5 text-muted">The count shows linked records; it does not mean the conclusion has been verified.</p>
          <div className="mt-3 space-y-2">{evidenceRefs.slice(evidencePage * 5, evidencePage * 5 + 5).map((id, i) => <EvidenceItem key={id} id={id} index={evidencePage * 5 + i} />)}</div>
          {!evidenceRefs.length && <p className={"mt-3 " + paragraph}>No evidence is linked. Add a source before continuing.</p>}
          {pages > 1 && <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted"><button disabled={!evidencePage} className="disabled:opacity-40" onClick={() => setEvidencePage((p) => p - 1)}>Previous</button><span>Page {evidencePage + 1} / {pages}</span><button disabled={evidencePage >= pages - 1} className="disabled:opacity-40" onClick={() => setEvidencePage((p) => p + 1)}>Next</button></div>}
        </section>
      </div>
      <section className={cardClass + " min-w-0 border-mint/40 bg-mint/10"}>
        <h3 className="font-medium text-mint">Recommended action</h3>
        <p className={"mt-3 " + paragraph}>{narrative.recommendation}</p>
        <ol className="mt-3 list-decimal space-y-2 pl-5">{narrative.nextSteps.map((step, i) => <li key={i} className={paragraph}>{step}</li>)}</ol>
        <div className="mt-5 border-t border-line pt-4">
          <p className="text-xs leading-6 text-muted">Confirming reproduction creates a Case marked as reproduced. The root cause and fix still need verification. Rejecting deactivates the candidate and preserves its review history.</p>
          {draft && <label className="mt-4 flex items-start gap-2 text-sm leading-6 text-fg"><input type="checkbox" className="mt-1.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I have reviewed the evidence and confirmed the issue can be reproduced.</label>}
          <label className="mt-4 block text-sm text-fg" htmlFor="candidate-review-reason">Reason for decision or edit</label>
          <textarea id="candidate-review-reason" className={field + " mt-2 min-h-24"} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Describe the confirmed facts or explain why this is not being accepted." />
          <div className="mt-3 flex flex-wrap gap-2">
            {draft && <button disabled={!!busy || !confirmed || !evidenceRefs.length} onClick={() => perform("accept")} className="rounded-ctl bg-mint px-3 py-2 text-sm text-ink disabled:opacity-40">Confirm reproduction and create Case</button>}
            {draft && <button disabled={!!busy} onClick={() => perform("reject")} className="rounded-ctl border border-coral/40 bg-coral/10 px-3 py-2 text-sm text-coral disabled:opacity-40">Reject candidate</button>}
            <button disabled={!!busy} onClick={() => setEdit(!edit)} className="rounded-ctl border border-line px-3 py-2 text-sm text-muted transition-colors hover:bg-white/[.06] hover:text-fg">{edit ? "Cancel editing" : "Add or edit details"}</button>
            {!draft && lifecycle !== "deprecated" && <button disabled={!!busy} onClick={() => perform("deprecate")} className="rounded-ctl border border-line px-3 py-2 text-sm text-muted transition-colors hover:bg-white/[.06] hover:text-fg">Deactivate candidate</button>}
          </div>
          {lifecycle === "reproduced" && <Link to={"/knowledge/cases?document=" + encodeURIComponent("case-" + document.id)} className="mt-3 block text-sm text-mint">View Case</Link>}
          {busy && <p className="mt-3 text-sm text-muted">Saving…</p>}{error && <p role="alert" className="mt-3 text-sm text-coral">{error}</p>}{success && <p role="status" className="mt-3 text-sm text-mint">{success}</p>}
        </div>
      </section>
    </div>
    {edit && <section className={cardClass}><h3 className="font-medium text-fg">Add details and recommendations</h3><label className="mt-3 block text-sm text-muted">Summary<textarea className={field + " mt-1 min-h-20"} value={summary} onChange={(e) => setSummary(e.target.value)} /></label><label className="mt-3 block text-sm text-muted">Problem description<textarea className={field + " mt-1 min-h-24"} value={problem} onChange={(e) => setProblem(e.target.value)} /></label><div className="mt-4 border-t border-line pt-4"><p className="text-sm font-medium text-fg">Business context (retained with the Case)</p><label className="mt-3 block text-sm text-muted">Business purpose<textarea className={field + " mt-1 min-h-20"} value={businessPurpose} onChange={(e) => setBusinessPurpose(e.target.value)} /></label><label className="mt-3 block text-sm text-muted">Affected process<textarea className={field + " mt-1 min-h-20"} value={affectedProcess} onChange={(e) => setAffectedProcess(e.target.value)} /></label><label className="mt-3 block text-sm text-muted">Business impact<textarea className={field + " mt-1 min-h-20"} value={businessImpact} onChange={(e) => setBusinessImpact(e.target.value)} /></label><label className="mt-3 block text-sm text-muted">Technical component purpose<textarea className={field + " mt-1 min-h-20"} value={technicalPurpose} onChange={(e) => setTechnicalPurpose(e.target.value)} /></label></div><label className="mt-3 block text-sm text-muted">Recommended actions (one per line)<textarea className={field + " mt-1 min-h-20"} value={actions} onChange={(e) => setActions(e.target.value)} /></label><button disabled={!!busy} className="mt-3 rounded-ctl bg-mint px-3 py-2 text-sm text-ink disabled:opacity-40" onClick={() => perform("edit_card")}>Save details</button></section>}

    <details className={cardClass}><summary className="cursor-pointer text-sm font-medium text-fg">Technical details and original fields</summary>
      <p className="mt-3 text-xs text-muted">The description above is derived from the original event. The source signals and original card remain available here for review.</p>
      {narrative.sourceSignals.map((signal, i) => <div key={i} className="mt-3"><p className="text-xs text-muted">{signal.source}</p><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-field border border-line bg-[var(--field)] p-3 text-xs text-muted">{signal.text}</pre></div>)}
      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">{Object.entries({ "Event": document.eventId, "Job": document.jobId, "Deployment": document.deploymentId, "Source": document.sourceLocator, "File checksum": document.sourceSha256, "Confidence": card.confidence }).map(([key, value]) => <div key={key} className="min-w-0"><dt className="text-muted">{key}</dt><dd className="mt-1 break-all text-muted">{String(value ?? "Not recorded")}</dd></div>)}</dl>
      <details className="mt-4"><summary className="cursor-pointer text-sm text-muted">Original candidate card (assumptions, verification plan and source facts)</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">{printable(card)}</pre></details>
      <details className="mt-3"><summary className="cursor-pointer text-sm text-muted">Original event</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">{printable(document.body)}</pre></details>
      <div className="mt-4">{evidenceEditor}</div>
    </details>
    <details className={cardClass}><summary className="cursor-pointer text-sm font-medium text-fg">Review history ({reviews.length})</summary><div className="mt-3 space-y-2">{reviews.length ? reviews.map((r) => <details key={r.id} className="glass rounded-field border border-line p-3"><summary className="cursor-pointer text-sm text-fg">{actionLabels[r.action] ?? r.action} / {formatDate(r.created_at)}<span className="ml-2 text-muted">{r.reason}</span></summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">{printable({ before: r.before_json, after: r.after_json })}</pre></details>) : <p className="text-sm text-muted">No manual review history.</p>}</div></details>
  </div>;
}
