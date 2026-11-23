import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../App";
import { PageTabs } from "../components/shell/PageTabs";
import { StandardPage } from "../components/knowledge/KnowledgeFrame";
import { Badge, Button, DataTable, Drawer, EmptyState, ErrorState, Input, Select, StatusPill } from "../components/ui";

type MemoryTab = "workspace" | "sessions" | "evidence" | "observations" | "candidate-insights" | "confirmed-memory" | "memory-submissions";
type JsonRecord = Record<string, unknown>;
const TABS: readonly MemoryTab[] = ["workspace", "sessions", "evidence", "observations", "candidate-insights", "confirmed-memory", "memory-submissions"];
const TYPES = ["Fact", "Decision", "Case", "Pattern"] as const;
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null;
const text = (value: unknown, fallback = "") => typeof value === "string" || typeof value === "number" ? String(value) : fallback;
const listFrom = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.filter(isRecord) : [];
type MemoryPayloadKey = "memories" | "insights" | "sessions" | "evidence" | "observations" | "submissions";
const listFromPayload = (value: unknown, key: MemoryPayloadKey): JsonRecord[] => {
  if (!isRecord(value)) return [];
  return listFrom(value[key]);
};

type WorkspaceStats = { sessions?: number | string; evidence?: number; candidates?: number; confirmed?: number };
const countPayload = (value: unknown, key: MemoryPayloadKey): number | undefined => {
  if (!isRecord(value)) return undefined;
  const page = isRecord(value.page) ? value.page : undefined;
  if (page?.total !== undefined) {
    const total = Number(page.total);
    return Number.isFinite(total) ? total : undefined;
  }
  return Array.isArray(value[key]) ? value[key].length : undefined;
};

const titleOf = (row: JsonRecord) => text(row.title ?? row.displayTitle ?? row.statement ?? row.summary ?? row.id, "Untitled record");
const summaryOf = (row: JsonRecord) => text(row.statement ?? row.displaySummary ?? row.summary ?? row.objective, "No summary available");
const labelOf = (tab: MemoryTab) => tab === "workspace" ? "Memory workspace" : tab === "candidate-insights" ? "Historical candidate insights" : tab === "confirmed-memory" ? "Confirmed memory" : tab === "memory-submissions" ? "Memory submissions" : tab[0].toUpperCase() + tab.slice(1);
const dateOf = (value: unknown) => {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};

function MemoryWorkspace({ stats, loading, isAdmin }: { stats: WorkspaceStats; loading: boolean; isAdmin: boolean }) {
  const statItems = [
    ["Sessions", stats.sessions ?? "—", "/knowledge/sessions"],
    ["Evidence", stats.evidence ?? "—", "/knowledge/evidence"],
    ["Candidates waiting review", isAdmin ? stats.candidates ?? "—" : "—", "/knowledge/candidate-insights"],
    ["Confirmed", stats.confirmed ?? "—", "/knowledge/confirmed-memory"],
  ] as const;
  return <div className="knowledge-memory-workspace" aria-busy={loading}>
    <header className="knowledge-memory-hero">
      <div>
        <p className="knowledge-memory-kicker">Memory</p>
        <h1>Keep what the work taught you.</h1>
        <p>Memory separates captured sessions from evidence, candidate insights and confirmed experience. Project and general scope are kept explicit.</p>
      </div>
      <Link className="ui-button ui-button-primary" to="/knowledge/sessions">Open sessions</Link>
    </header>
    <div className="knowledge-memory-stats" aria-label="Memory totals">
      {statItems.map(([label, value, to]) => <Link key={label} to={to} className="knowledge-memory-stat"><span>{label}</span><strong>{loading && value === "—" ? "…" : value}</strong></Link>)}
    </div>
    <div className="knowledge-memory-sections">
      <section className="knowledge-memory-section"><div><p className="knowledge-memory-section-label">Confirmed memory</p><h2>Approved experience ready to use</h2><p>Reviewed records are searchable only in their declared project or general scope.</p></div><Link to="/knowledge/confirmed-memory" className="knowledge-memory-link">Review confirmed memory</Link></section>
      <section className="knowledge-memory-section"><div><p className="knowledge-memory-section-label">Candidate insights</p><h2>Work waiting for a decision</h2><p>Observations can become candidates, but they stay drafts until a reviewer confirms them.</p></div><Link to="/knowledge/candidate-insights" className="knowledge-memory-link">Open candidate queue</Link></section>
      <section className="knowledge-memory-section"><div><p className="knowledge-memory-section-label">Sessions and evidence</p><h2>Trace the source before it becomes knowledge</h2><p>Start with a session, inspect its evidence, then follow the review history.</p></div><div className="knowledge-memory-links"><Link to="/knowledge/sessions" className="knowledge-memory-link">Sessions</Link><Link to="/knowledge/evidence" className="knowledge-memory-link">Evidence</Link><Link to="/knowledge/memory-submissions" className="knowledge-memory-link">Submissions</Link></div></section>
    </div>
  </div>;
}

async function downloadReviewEvidence(kind: "memory-submissions" | "candidate-insights" | "legacy-candidates", id: string, evidenceId: string) {
  const token=localStorage.getItem("token");
  const response=await fetch(`/api/knowledge/${kind}/${encodeURIComponent(id)}/evidence/${encodeURIComponent(evidenceId)}`,{headers:token ? {Authorization:`Bearer ${token}`} : {}});
  if (!response.ok) throw new Error("Evidence is unavailable for this review.");
  const url=URL.createObjectURL(await response.blob()), link=document.createElement("a");
  link.href=url; link.download=evidenceId; link.click(); window.setTimeout(() => URL.revokeObjectURL(url),1000);
}

function LegacyCandidateDrawer({row,onClose,onReviewed}:{row:JsonRecord;onClose:()=>void;onReviewed:()=>void}) {
  const [title,setTitle]=useState(text(row.title)); const [statement,setStatement]=useState(text(row.statement).slice(0,8000));
  const [scope,setScope]=useState<"project"|"general">(row.projectId ? "project" : "general");
  const [memoryType,setMemoryType]=useState<"Fact"|"Decision"|"Case"|"Pattern">("Case");
  const [selected,setSelected]=useState<string[]>([]); const [reason,setReason]=useState(""); const [error,setError]=useState(""); const [busy,setBusy]=useState(false);
  const refs=Array.isArray(row.evidenceRefs) ? row.evidenceRefs.map(String) : [];
  const act=async (action:"approve"|"reject"|"needs_info") => {if(!reason.trim()) {setError("Enter a review reason.");return;} setBusy(true);setError("");try {await api.legacyCandidateReview(text(row.id),{action,reason,...(action==="approve" ? {scope,title,statement,memoryType,evidenceRefs:selected} : {})});onReviewed();}catch(err){setError(err instanceof Error ? err.message : "Review failed");}finally{setBusy(false);}};
  return <Drawer open presentation="responsive" title="Review historical candidate" onClose={onClose}><div className="space-y-5"><div className="flex flex-wrap gap-2"><StatusPill status={row.status} /><Badge tone="iris">Project {text(row.projectId,"none")}</Badge><Badge>{text(row.candidateType)}</Badge></div><p className="text-sm text-muted">This is historical, automatically captured material. Review and rewrite it into a concise experience before approval; remove unrelated output and credentials.</p><section><h3 className="font-semibold">Evidence</h3>{refs.length ? <ul className="mt-2 space-y-2">{refs.map(ref=><li key={ref} className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(ref)} onChange={event=>setSelected(current=>event.target.checked ? [...current,ref] : current.filter(item=>item!==ref))} />Attach <code>{ref}</code></label><Button variant="ghost" onClick={()=>void downloadReviewEvidence("legacy-candidates",text(row.id),ref).catch(err=>setError(err instanceof Error ? err.message : "Unable to read evidence"))}>Download</Button></li>)}</ul> : <p className="mt-2 text-sm text-muted">No external evidence attached.</p>}</section>{["approve","reject"].includes(text(row.status)) ? <p className="text-sm text-muted">Review: {text(row.status)} · {text(row.reviewReason)}{row.memoryId ? ` · Memory ${text(row.memoryId)}` : ""}</p> : <><label className="block text-sm">Final scope<Select className="mt-1" value={scope} onChange={event=>setScope(event.target.value as typeof scope)}>{row.projectId && <option value="project">Source project</option>}<option value="general">General</option></Select></label>{scope==="general" && row.projectId && <p className="text-sm text-muted">General Memory is visible across projects. Remove private details before approval.</p>}<label className="block text-sm">Memory type<Select className="mt-1" value={memoryType} onChange={event=>setMemoryType(event.target.value as typeof memoryType)}>{TYPES.map(type=><option key={type}>{type}</option>)}</Select></label><label className="block text-sm">Reviewed title<Input className="mt-1" value={title} onChange={event=>setTitle(event.target.value)} /></label><label className="block text-sm">Reviewed experience<textarea className="ui-control mt-1 min-h-32" value={statement} onChange={event=>setStatement(event.target.value)} /></label><label className="block text-sm">Decision reason<textarea className="ui-control mt-1 min-h-20" value={reason} onChange={event=>setReason(event.target.value)} /></label><div className="flex flex-wrap gap-2"><Button variant="primary" disabled={busy || !title.trim() || !statement.trim()} onClick={()=>void act("approve")}>Approve as Memory</Button><Button variant="ghost" disabled={busy} onClick={()=>void act("needs_info")}>Request information</Button><Button variant="ghost" disabled={busy} onClick={()=>void act("reject")}>Reject</Button></div></>}{error && <p className="text-sm text-coral" role="alert">{error}</p>}</div></Drawer>;
}

function RecordDrawer({ row, tab, onClose }: { row: JsonRecord; tab: MemoryTab; onClose: () => void }) {
  const evidence = Array.isArray(row.evidenceRefs) ? row.evidenceRefs : [];
  const audit = row.audit ?? row.reviewReason;
  const impact = row.impact ?? row.impactSummary ?? row.affectedRecords;
  const review = row.review ?? row.reviewStatus ?? row.reviewReason;
  const metadata: Array<[string, unknown]> = [
    ["Type", row.type ?? row.memoryType ?? row.kind],
    ["Scope", row.memoryScope ?? (isRecord(row.scope) ? `${text(row.scope.scopeType)}:${text(row.scope.scopeKey)}` : row.projectId)],
    ["Source", isRecord(row.source) ? row.source.locator : row.sourceLocator],
    ["Reviewed", row.reviewedAt ?? row.confirmedAt ?? row.updatedAt],
    ["Confirmed by", row.confirmedBy ?? row.reviewerId],
  ];
  return (
    <Drawer open presentation="responsive" title={titleOf(row)} onClose={onClose}>
      <div className="space-y-8">
        <section>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge tone="iris">{labelOf(tab)}</Badge>
            <StatusPill status={row.status ?? row.lifecycle ?? "confirmed"} />
            <code className="text-xs text-muted">{text(row.id, "unknown")}</code>
          </div>
          {tab === "confirmed-memory" && <p className="mb-3 text-sm text-muted">Searchable in the confirmed scope shown below.</p>}
          <h3 className="mb-3 font-display text-lg font-semibold">Summary</h3>
          <dl className="grid gap-3 sm:grid-cols-2">
            {metadata.map(([name, value]) => <div key={name}><dt className="text-sm text-muted">{name}</dt><dd className="mt-1 break-words text-sm">{text(value, "—")}</dd></div>)}
          </dl>
          <p className="mt-5 whitespace-pre-wrap text-[15px] leading-6 text-muted">{summaryOf(row)}</p>
        </section>
        <section>
          <h3 className="mb-3 font-display text-lg font-semibold">Evidence</h3>
          {evidence.length ? <ul className="divide-y divide-white/10">{evidence.map((item, index) => <li key={`${text(item)}-${index}`} className="flex items-center justify-between gap-3 py-3"><code className="break-all text-xs text-muted">{text(item)}</code><Badge tone="mint">Linked</Badge></li>)}</ul> : <p className="text-sm text-muted">No external evidence attached or visible.</p>}
          {isRecord(row.source) && Array.isArray(row.source.sourceRefs) && row.source.sourceRefs.length > 0 && <><p className="mt-3 text-sm text-muted">Submitter-provided references; independent verification is not implied.</p><ul className="mt-2 space-y-1">{row.source.sourceRefs.map((ref,index)=><li key={index} className="break-all text-sm text-muted">{text(ref)}</li>)}</ul></>}
        </section>
        <section>
          <h3 className="mb-3 font-display text-lg font-semibold">History</h3>
          {audit ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-6 text-muted">{typeof audit === "string" ? audit : JSON.stringify(audit, null, 2)}</pre> : <p className="text-sm text-muted">No review history yet.</p>}
        </section>
        <section>
          <h3 className="mb-3 font-display text-lg font-semibold">Impact</h3>
          {impact ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-sm leading-6 text-muted">{typeof impact === "string" ? impact : JSON.stringify(impact, null, 2)}</pre> : <p className="text-sm text-muted">No impact relationships are recorded.</p>}
        </section>
        <section>
          <h3 className="mb-3 font-display text-lg font-semibold">Review</h3>
          {review ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-sm leading-6 text-muted">{typeof review === "string" ? review : JSON.stringify(review, null, 2)}</pre> : <p className="text-sm text-muted">No review decision is recorded.</p>}
        </section>
      </div>
    </Drawer>
  );
}

function SubmissionDrawer({ row, isAdmin, onClose, onReviewed }: { row: JsonRecord; isAdmin: boolean; onClose: () => void; onReviewed: () => void }) {
  const [scope, setScope] = useState<"project" | "general">(row.requestedScope === "project" ? "project" : "general");
  const [title, setTitle] = useState(text(row.title));
  const [statement, setStatement] = useState(text(row.statement));
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const evidence = Array.isArray(row.evidenceRefs) ? row.evidenceRefs : [];
  const downloadEvidence = async (id: string) => {
    try { await downloadReviewEvidence("memory-submissions",text(row.id),id); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to read evidence."); }
  };
  const review = async (action: "approve" | "reject" | "needs_info") => {
    if (!reason.trim()) { setError("Enter a reason for the decision."); return; }
    setBusy(true); setError("");
    try { await api.memorySubmissionReview(text(row.id), { action, reason, ...(action === "approve" ? { scope, title, statement } : {}) }); onReviewed(); }
    catch (err) { setError(err instanceof Error ? err.message : "Review could not be saved."); } finally { setBusy(false); }
  };
  return <Drawer open presentation="responsive" title={titleOf(row)} onClose={onClose}><div className="space-y-5">
    <div className="flex flex-wrap gap-2"><StatusPill status={row.status} /><Badge tone="iris">{text(row.requestedScope)} request</Badge><span className="text-sm text-muted">Submitted {dateOf(row.createdAt)}</span></div>
    <dl className="grid gap-3 sm:grid-cols-2">{[["Project", row.projectId], ["Type", row.memoryType], ["Task or goal", row.objective], ["Outcome", row.outcome], ["Applicability", row.applicability], ["Unknowns", Array.isArray(row.unknowns) ? row.unknowns.join("; ") : row.unknowns], ["Reviewed by", row.reviewerId], ["Reviewed at", row.reviewedAt], ["Review reason", row.reviewReason]].map(([label,value]) => <div key={text(label)}><dt className="text-sm text-muted">{text(label)}</dt><dd className="mt-1 whitespace-pre-wrap text-sm">{text(value, "—")}</dd></div>)}</dl>
    <section><h3 className="font-semibold">Evidence</h3>{evidence.length ? <ul className="mt-2 space-y-1 text-sm text-muted">{evidence.map((item,index) => <li key={index} className="flex flex-wrap items-center gap-2"><code>{text(item)}</code>{isAdmin && <Button variant="ghost" onClick={() => void downloadEvidence(text(item))}>Download for review</Button>}</li>)}</ul> : <p className="mt-2 text-sm text-muted">No external evidence attached. The statement is the submitter's account, not independent verification.</p>}</section>
    {Array.isArray(row.sourceRefs) && row.sourceRefs.length > 0 && <section><h3 className="font-semibold">Submitter-provided references</h3><p className="mt-1 text-sm text-muted">These references are provided by the submitter and are not independent verification.</p><ul className="mt-2 space-y-1">{row.sourceRefs.map((ref,index)=><li key={index} className="break-all text-sm text-muted">{text(ref)}</li>)}</ul></section>}
    {isAdmin && ["pending", "needs_info"].includes(text(row.status)) ? <section className="space-y-4 border-t border-white/10 pt-5"><h3 className="font-semibold">Review decision</h3><label className="block text-sm">Final scope<Select className="mt-1" value={scope} onChange={event => setScope(event.target.value as "project" | "general")}><option value="general">General Memory</option>{row.projectId ? <option value="project">Project {text(row.projectId)}</option> : null}</Select></label>{scope === "general" && row.projectId ? <p className="text-sm text-muted">General Memory is visible across projects. Remove private project details before approval.</p> : null}<label className="block text-sm">Title<Input className="mt-1" value={title} onChange={event => setTitle(event.target.value)} /></label><label className="block text-sm">Reviewed experience<textarea className="ui-control mt-1 min-h-32" value={statement} onChange={event => setStatement(event.target.value)} /></label><label className="block text-sm">Decision reason<textarea className="ui-control mt-1 min-h-20" value={reason} onChange={event => setReason(event.target.value)} /></label>{error && <p role="alert" className="text-sm text-coral">{error}</p>}<div className="flex flex-wrap gap-2"><Button variant="primary" disabled={busy || !title.trim() || !statement.trim()} onClick={() => void review("approve")}>Approve</Button><Button variant="ghost" disabled={busy} onClick={() => void review("needs_info")}>Request information</Button><Button variant="ghost" disabled={busy} onClick={() => void review("reject")}>Reject</Button></div></section> : <section><h3 className="font-semibold">Submitted experience</h3><p className="mt-2 whitespace-pre-wrap text-sm text-muted">{text(row.statement)}</p>{row.status === "needs_info" && <p className="mt-2 text-sm text-muted">Submit an updated candidate with a new idempotency key after addressing the review reason.</p>}</section>}
  </div></Drawer>;
}

function HistoricalInsightDrawer({ row, onClose, onReviewed }: {row:JsonRecord;onClose:()=>void;onReviewed:()=>void}) {
  const [insight,setInsight]=useState(row);
  const [session,setSession]=useState<JsonRecord>({});
  const [history,setHistory]=useState<JsonRecord[]>([]);
  const [statement,setStatement]=useState(text(row.statement));
  const dirty = statement !== text(insight.statement);
  const [reason,setReason]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const id=text(row.id);
  const load=async () => { const [detail,audit]=await Promise.all([api.knowledgeCandidateInsight(id),api.knowledgeCandidateInsightHistory(id)]); if(isRecord(detail.insight)) {setInsight(detail.insight);setStatement(text(detail.insight.statement));} setSession(isRecord(detail.sourceSession) ? detail.sourceSession : {}); setHistory(listFrom(audit.history)); };
  useEffect(() => { void load().catch(err => setError(err instanceof Error ? err.message : "Unable to load candidate")); },[id]);
  const act=async (action:"edit"|"confirm"|"reject"|"promote"|"scope") => {
    if (busy || (dirty && (action === "confirm" || action === "promote"))) return;
    if(!reason.trim()) {setError("Enter a reason for the review action.");return;}
    setBusy(true);setError("");
    try {
      if(action==="edit") await api.knowledgeCandidateInsightEdit(id,{statement},reason);
      if(action==="confirm") await api.knowledgeCandidateInsightConfirm(id,reason);
      if(action==="reject") await api.knowledgeCandidateInsightReject(id,reason);
      if(action==="scope") await api.knowledgeCandidateInsightReviewScope(id,reason,text(session.updatedAt));
      if(action==="promote") {const target=text(insight.kind);if(!["fact","decision","case","pattern"].includes(target)) throw new Error("This legacy candidate kind cannot become Memory."); await api.knowledgeCandidateInsightPromote(id,{target:target as "fact"|"decision"|"case"|"pattern",reason});}
      setReason("");await load();onReviewed();
    } catch(err) {setError(err instanceof Error ? err.message : "Review failed");} finally {setBusy(false);}
  };
  const refs=Array.isArray(insight.evidenceRefs) ? insight.evidenceRefs : [];
  return <Drawer open presentation="responsive" title="Review historical candidate" onClose={onClose} busy={busy}><div className="space-y-5"><div className="flex flex-wrap gap-2"><StatusPill status={insight.status} /><Badge tone="iris">Project {text(insight.projectId)}</Badge><Badge>{text(insight.kind)}</Badge></div><p className="whitespace-pre-wrap text-sm text-muted">{text(insight.whyProposed,"No explanation recorded.")}</p><section><h3 className="font-semibold">Evidence</h3>{refs.length ? <ul className="mt-2 space-y-1">{refs.map((ref,index)=><li key={index} className="flex flex-wrap items-center gap-2"><code className="text-xs">{text(ref)}</code><Button variant="ghost" onClick={() => void downloadReviewEvidence("candidate-insights",id,text(ref)).catch(err => setError(err instanceof Error ? err.message : "Unable to read evidence"))}>Download for review</Button></li>)}</ul> : <p className="mt-2 text-sm text-muted">No external evidence attached.</p>}</section><section><h3 className="font-semibold">Review history</h3>{history.length ? <ul className="mt-2 space-y-2 text-sm text-muted">{history.map((item,index)=><li key={index}>{text(item.action)} · {text(item.reason)} · {dateOf(item.createdAt)}</li>)}</ul> : <p className="mt-2 text-sm text-muted">No review recorded.</p>}</section><label className="block text-sm">Statement<textarea className="ui-control mt-1 min-h-32" disabled={busy} value={statement} onChange={event=>setStatement(event.target.value)} /></label>{dirty && <p role="status" className="text-sm text-sun">Save the revised statement before confirming or promoting this candidate.</p>}<label className="block text-sm">Review reason<textarea className="ui-control mt-1 min-h-20" disabled={busy} value={reason} onChange={event=>setReason(event.target.value)} /></label>{error && <p className="text-sm text-coral" role="alert">{error}</p>}<div className="flex flex-wrap gap-2">{["draft","edited"].includes(text(insight.status)) && <><Button variant="ghost" disabled={busy || !dirty || !statement.trim()} onClick={()=>void act("edit")}>Save edit</Button><Button variant="primary" disabled={busy || dirty} onClick={()=>void act("confirm")}>Confirm candidate</Button><Button variant="ghost" disabled={busy} onClick={()=>void act("reject")}>Reject</Button></>}{Boolean(insight.scopeReviewRequired) && <Button variant="ghost" disabled={busy || !session.updatedAt} onClick={()=>void act("scope")}>Review source scope</Button>}{insight.status==="accepted" && !insight.promotion && <Button variant="primary" disabled={busy || dirty || Boolean(insight.scopeReviewRequired)} onClick={()=>void act("promote")}>Promote to project Memory</Button>}</div>{Boolean(insight.promotion) && <p className="text-sm text-muted">This candidate has been promoted.</p>}</div></Drawer>;
}

function LegacyScopeQueue() {
  const [rows, setRows] = useState<JsonRecord[]>([]);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<JsonRecord>();
  const [title, setTitle] = useState(""); const [statement, setStatement] = useState(""); const [reason, setReason] = useState("");
  const [scope, setScope] = useState<"project" | "general">("project");
  const load = () => api.legacyMemoryScopeQueue(offset).then(result => { setRows(listFrom(result.memories)); setError(""); }).catch(err => setError(err instanceof Error ? err.message : "Unable to load historical Memory"));
  useEffect(() => { void load(); }, [offset]);
  const save = async () => { if (!selected || !reason.trim()) return; try { await api.legacyMemoryScopeReview(text(selected.id),{scope,reason,title,statement}); setSelected(undefined); await load(); } catch(err) { setError(err instanceof Error ? err.message : "Scope review failed"); } };
  return <section className="mb-8 space-y-3"><div><h2 className="text-lg font-semibold">Historical Memory needing scope review</h2><p className="mt-1 text-sm text-muted">Earlier global or organization records are withheld from search until their sharing scope is reviewed.</p></div>{error && <ErrorState message={error} onRetry={() => void load()} />}{rows.length ? <div className="space-y-2">{rows.map(row => <button key={text(row.id)} className="ui-glass block w-full p-4 text-left" onClick={() => { setSelected(row); setTitle(text(row.title)); setStatement(text(row.statement)); setReason(""); setScope(row.sourceProjectId ? "project" : "general"); }}><strong>{titleOf(row)}</strong><span className="mt-1 block text-sm text-muted">Source project: {text(row.sourceProjectId,"none")}</span></button>)}</div> : <p className="text-sm text-muted">No historical Memory is awaiting scope review on this page.</p>}{(offset>0 || rows.length===50) && <div className="flex items-center gap-2"><Button variant="ghost" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>Previous</Button><span className="text-sm text-muted">Page {offset/50+1}</span><Button variant="ghost" disabled={rows.length<50} onClick={()=>setOffset(offset+50)}>Next</Button></div>}{selected && <Drawer open title="Review historical Memory" onClose={() => setSelected(undefined)}><div className="space-y-4"><p className="text-sm text-muted">Select who may read this record and remove private details before choosing general access. The original record is retained in review history.</p><label className="block text-sm">Scope<Select className="mt-1" value={scope} onChange={event => setScope(event.target.value as typeof scope)}>{selected.sourceProjectId && <option value="project">Source project</option>}<option value="general">General</option></Select></label><label className="block text-sm">Title<Input className="mt-1" value={title} onChange={event => setTitle(event.target.value)} /></label><label className="block text-sm">Statement<textarea className="ui-control mt-1 min-h-32" value={statement} onChange={event => setStatement(event.target.value)} /></label><label className="block text-sm">Review reason<textarea className="ui-control mt-1 min-h-20" value={reason} onChange={event => setReason(event.target.value)} /></label><Button variant="primary" disabled={!reason.trim() || !title.trim() || !statement.trim()} onClick={() => void save()}>Save scope review</Button></div></Drawer>}</section>;
}

export default function KnowledgeMemory() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();

  const routeTab = (TABS.find((item) => item !== "workspace" && location.pathname.endsWith(`/${item}`)) ?? "workspace") as MemoryTab;
  const [tab, setTab] = useState<MemoryTab>(routeTab);
  const [type, setType] = useState("");
  const [scope, setScope] = useState<"project" | "general" | "both">(params.get("projectId") ? "both" : "general");
  const [projectId, setProjectId] = useState(params.get("projectId") ?? "");
  const [projects, setProjects] = useState<Array<{ id: number; name: string }>>([]);
  const [offset, setOffset] = useState(0);
  const reviewSource = params.get("source");
  const reviewStatus = params.get("status");
  const reviewProjectId = params.get("projectId") ?? undefined;
  const [queueOffset,setQueueOffset] = useState(0);
  const [queueHasMore,setQueueHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [generalAccess, setGeneralAccess] = useState("");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [rows, setRows] = useState<JsonRecord[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [workspaceStats, setWorkspaceStats] = useState<WorkspaceStats>({});
  const [reloadCount, setReloadCount] = useState(0);
  const selectedId = params.get("id");
  const selected = useMemo(() => rows.find((row) => text(row.id) === selectedId), [rows, selectedId]);

  useEffect(() => { void api.listProjects().then(result => setProjects(result.projects as Array<{ id:number; name:string }>)).catch(() => setProjects([])); }, []);
  useEffect(() => { setTab(routeTab); }, [routeTab]);
  useEffect(() => { setQueueOffset(0); }, [reviewSource, reviewStatus, reviewProjectId]);
  const serverQuery = tab === "confirmed-memory" ? query : "";
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    if (tab === "workspace") {
      void Promise.allSettled([
        api.knowledgeSessions(50),
        api.knowledgeEvidenceList(undefined, { limit: 1 }),
        user?.isAdmin ? api.knowledgeCandidateInsights(undefined, { limit: 1 }) : Promise.resolve(undefined),
        api.knowledgeConfirmedMemories(undefined, { scope: "general", limit: 1 }),
      ]).then(([sessions, evidence, candidates, confirmed]) => {
        if (!active) return;
        const sessionsValue = sessions.status === "fulfilled" ? sessions.value : undefined;
        const sessionsCount = countPayload(sessionsValue, "sessions");
        const candidateValue = candidates.status === "fulfilled" ? candidates.value : undefined;
        setWorkspaceStats({
          sessions: sessionsCount !== undefined ? (sessionsCount === 50 ? "50+" : sessionsCount) : undefined,
          evidence: countPayload(evidence.status === "fulfilled" ? evidence.value : undefined, "evidence"),
          candidates: countPayload(candidateValue, "insights"),
          confirmed: countPayload(confirmed.status === "fulfilled" ? confirmed.value : undefined, "memories"),
        });
        setRows([]);
      }).catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Unable to load Memory workspace");
      }).finally(() => { if (active) setLoading(false); });
      return () => { active = false; };
    }
    let task: Promise<unknown>;
    if (tab === "confirmed-memory") {
      if (scope !== "general" && !projectId) { setRows([]); setTotal(0); setLoading(false); return () => { active = false; }; }
      task = api.knowledgeConfirmedMemories(scope === "general" ? undefined : projectId, { type, scope, q: serverQuery, limit: 50, offset });
    } else if (tab === "memory-submissions") {
      if (reviewSource === "submissions") {
        task = api.memorySubmissions(queueOffset, reviewStatus === "pending" ? "pending" : undefined)
          .then((result) => ({ submissions: result.submissions, hasMore: result.page ? queueOffset + 50 < result.page.total : result.submissions.length === 50 }));
      } else if (reviewSource === "insights") {
        task = user?.isAdmin ? api.knowledgeCandidateInsights(reviewProjectId, { status: reviewStatus === "edited" ? "edited" : "draft", limit: 50, offset: queueOffset })
          .then(({ insights }) => ({ submissions: insights.filter(isRecord).map((item) => ({ ...item, reviewKind: "legacy" })), hasMore: insights.length === 50 }))
          : Promise.resolve({ submissions: [], hasMore: false });
      } else {
        task = Promise.all([
          api.memorySubmissions(queueOffset),
          user?.isAdmin ? api.knowledgeCandidateInsights(undefined, { limit: 50, offset: queueOffset }) : Promise.resolve({ insights: [] }),
          user?.isAdmin ? api.legacyCandidatesForReview(queueOffset) : Promise.resolve({ candidates: [] }),
        ]).then(([submissions, history, candidates]) => ({
          submissions: [...submissions.submissions, ...history.insights.filter(isRecord).map((item) => ({ ...item, reviewKind: "legacy" })), ...candidates.candidates.filter(isRecord).map((item) => ({ ...item, reviewKind: "legacy-candidate" }))],
          hasMore: [submissions.submissions, history.insights, candidates.candidates].some((items) => items.length === 50),
        }));
      }
    } else if (tab === "candidate-insights") {
      task = api.knowledgeCandidateInsights();
    } else if (tab === "sessions") {
      task = api.knowledgeSessions();
    } else if (tab === "evidence") {
      task = api.knowledgeEvidenceList();
    } else {
      task = api.knowledgeObservations();
    }
    task.then((result: unknown) => {
      if (!active) return;
      const key: MemoryPayloadKey = tab === "confirmed-memory"
        ? "memories"
        : tab === "memory-submissions" ? "submissions" : tab === "candidate-insights"
          ? "insights"
          : tab;
      setRows(listFromPayload(result, key));
      if (tab === "confirmed-memory" && isRecord(result)) { const page = isRecord(result.page) ? result.page : {}; setTotal(Number(page.total ?? 0)); setGeneralAccess(text(result.generalAccess)); }
      if (tab === "memory-submissions" && isRecord(result)) setQueueHasMore(Boolean(result.hasMore));
    }).catch((reason: unknown) => {
      if (!active) return;
      setRows([]);
      setError(reason instanceof Error ? reason.message : "Unable to load Memory workspace");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [tab, type, scope, projectId, offset, queueOffset, serverQuery, reviewSource, reviewStatus, reviewProjectId, reloadCount, user?.isAdmin]);

  const open = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("id", id);
    setParams(next, { replace: false });
  };
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete("id");
    navigate(`${location.pathname}${next.toString() ? `?${next}` : ""}`, { replace: true });
  };
  const applyQuery = (value: string) => {
    setQuery(value);
    if (tab === "confirmed-memory") setOffset(0);
    const next = new URLSearchParams(params);
    value ? next.set("q", value) : next.delete("q");
    setParams(next, { replace: true });
  };
  const visibleRows = tab === "confirmed-memory" ? rows : rows.filter((row) => !query.trim() || `${titleOf(row)} ${summaryOf(row)}`.toLowerCase().includes(query.trim().toLowerCase()));
  const title = labelOf(tab);
  const columns = [
    { key: "record", header: "Record", render: (row: JsonRecord) => <div className="min-w-0"><strong className="block truncate font-medium">{titleOf(row)}</strong><span className="mt-1 block line-clamp-2 text-sm text-muted">{summaryOf(row)}</span></div> },
    { key: "status", header: "Status", render: (row: JsonRecord) => <StatusPill status={row.status ?? row.lifecycle ?? "confirmed"} /> },
    { key: "scope", header: "Scope", render: (row: JsonRecord) => <span className="text-sm text-muted">{text(row.memoryScope ?? row.requestedScope ?? row.projectId, "—")}</span> },
    { key: "updated", header: "Updated", render: (row: JsonRecord) => <span className="text-sm text-muted">{dateOf(row.updatedAt ?? row.confirmedAt ?? row.createdAt)}</span> },
  ];

  if (tab === "workspace") return <StandardPage className="knowledge-memory-page"><PageTabs section="memory" className="knowledge-local-tabs mb-6" /><MemoryWorkspace stats={workspaceStats} loading={loading} isAdmin={Boolean(user?.isAdmin)} /></StandardPage>;

  return (
    <StandardPage>
      <PageTabs section="memory" className="knowledge-local-tabs mb-6" />
      {tab === "memory-submissions" && reviewSource && <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{reviewSource === "insights" ? (reviewStatus === "edited" ? "Edited candidate insights" : "Draft candidate insights") : "Pending Memory submissions"}{reviewProjectId && " / " + (projects.find((project) => String(project.id) === reviewProjectId)?.name ?? "Project " + reviewProjectId)}</p>
        <Link className="text-mint underline" to="/knowledge/memory-submissions">All review sources</Link>
      </div>}
      {tab === "memory-submissions" && !reviewSource && Boolean(user?.isAdmin) && <><LegacyScopeQueue /><p className="mb-5 text-sm text-muted">Historical <Link className="underline" to="/knowledge/candidate-insights">candidate insights</Link> and <Link className="underline" to="/knowledge/candidates">candidates</Link> remain available for review.</p></>}
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <label className="relative min-w-0 basis-64 flex-1">
          <span className="sr-only">Search {title}</span>
          <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-3 text-muted" />
          <Input className="pl-9" placeholder={`Search ${title.toLowerCase()}`} value={query} onChange={(event) => applyQuery(event.target.value)} />
        </label>
        {tab === "confirmed-memory" && <label className="min-w-[190px]"><span className="sr-only">Memory type</span><Select value={type} onChange={(event) => setType(event.target.value)}><option value="">All confirmed memory</option>{TYPES.map((item) => <option key={item} value={item}>{item}</option>)}</Select></label>}
        {tab === "confirmed-memory" && <><label><span className="sr-only">Memory scope</span><Select value={scope} onChange={event => { setScope(event.target.value as typeof scope); setOffset(0); }}><option value="general">General</option><option value="project">Project</option><option value="both">Project and general</option></Select></label>{scope !== "general" && <label><span className="sr-only">Project</span><Select value={projectId} onChange={event => { setProjectId(event.target.value); setOffset(0); }}><option value="">Select a project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</Select></label>}</>}
        <span className="text-sm text-muted">{tab === "confirmed-memory" ? total : visibleRows.length} results</span>
      </div>
      {generalAccess === "denied" && tab === "confirmed-memory" && scope === "both" && <p className="mb-4 text-sm text-muted">General Memory is unavailable; showing the selected project's results.</p>}
      {error && <ErrorState className="mb-4" message={error} onRetry={() => setReloadCount((count) => count + 1)} />}
      <div className="ui-detail-layout"><div className="min-w-0">
      {loading ? <div className="ui-glass p-6 text-sm text-muted" role="status">Loading {title.toLowerCase()}…</div> : !visibleRows.length ? <EmptyState title={`No ${title.toLowerCase()} records`} description="Try another filter or capture more knowledge." /> : <DataTable columns={columns} rows={visibleRows} rowKey={(row) => text(row.id)} selectedRowKey={selectedId ?? undefined} onRowClick={(row) => open(text(row.id))} />}
      {tab === "confirmed-memory" && <div className="mt-4 flex items-center justify-end gap-3"><Button variant="ghost" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button><span className="text-sm text-muted">{total ? `${offset + 1}–${Math.min(total, offset + 50)} of ${total}` : "0 results"}</span><Button variant="ghost" disabled={loading || offset + 50 >= total} onClick={() => setOffset(offset + 50)}>Next</Button></div>}
      {tab === "memory-submissions" && <div className="mt-4 flex flex-wrap items-center justify-end gap-3"><span className="text-sm text-muted">Search filters the loaded page · Page {queueOffset/50+1}</span><Button variant="ghost" disabled={loading || queueOffset===0} onClick={()=>setQueueOffset(Math.max(0,queueOffset-50))}>Previous</Button><Button variant="ghost" disabled={loading || !queueHasMore} onClick={()=>setQueueOffset(queueOffset+50)}>Next</Button></div>}
      </div>
      {selected && (tab === "memory-submissions" ? (selected.reviewKind === "legacy" ? <HistoricalInsightDrawer key={text(selected.id)} row={selected} onClose={close} onReviewed={() => setReloadCount(count => count + 1)} /> : selected.reviewKind === "legacy-candidate" ? <LegacyCandidateDrawer key={text(selected.id)} row={selected} onClose={close} onReviewed={() => { close(); setReloadCount(count => count + 1); }} /> : <SubmissionDrawer key={text(selected.id)} row={selected} isAdmin={Boolean(user?.isAdmin)} onClose={close} onReviewed={() => { close(); setReloadCount(count => count + 1); }} />) : <RecordDrawer row={selected} tab={tab} onClose={close} />)}
      </div>
    </StandardPage>
  );
}
