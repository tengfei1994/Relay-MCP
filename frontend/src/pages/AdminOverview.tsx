import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CircleAlert, CircleCheck, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { AppPageFrame } from "../components/shell/AppPageFrame";
import "./console-overview.css";
import { useAuth } from "../App";

type UserRow = { id: number; username: string; accountStatus?: string; isAdmin?: boolean; knowledgeEnabled?: boolean };
function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function text(value: unknown, fallback = "—"): string { return typeof value === "string" && value.trim() ? value : fallback; }
function usersFrom(value: unknown): UserRow[] { return Array.isArray(value) ? value.flatMap((item) => { const row = record(item); return typeof row.id === "number" && typeof row.username === "string" ? [{ id: row.id, username: row.username, accountStatus: typeof row.accountStatus === "string" ? row.accountStatus : undefined, isAdmin: row.isAdmin === true, knowledgeEnabled: row.knowledgeEnabled === true }] : []; }) : []; }

export default function AdminOverview() {
  const { user } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [pendingCandidates, setPendingCandidates] = useState(0);
  const [pendingSubmissions, setPendingSubmissions] = useState(0);
  const [pendingClassification, setPendingClassification] = useState(0);
  const [providerCount, setProviderCount] = useState<number>();
  const [health, setHealth] = useState<{ ok?: boolean; version?: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true); setError("");
    const [userResult, candidatesResult, submissionsResult, classificationResult, providerResult, healthResult] = await Promise.allSettled([
      api.listUsers(), user?.knowledgeEnabled ? api.legacyCandidatesForReview(0) : Promise.resolve(undefined), user?.knowledgeEnabled ? api.memorySubmissions(0) : Promise.resolve(undefined), user?.knowledgeEnabled ? api.productClassificationReport(0) : Promise.resolve(undefined), api.knowledgeManagedProviders(), api.health(),
    ]);
    if (userResult.status === "fulfilled") setUsers(usersFrom(userResult.value.users)); else setError("Account data is unavailable. Try again.");
    if (candidatesResult.status === "fulfilled" && candidatesResult.value) setPendingCandidates(Array.isArray(candidatesResult.value.candidates) ? candidatesResult.value.candidates.length : 0);
    if (submissionsResult.status === "fulfilled" && submissionsResult.value) setPendingSubmissions(Array.isArray(submissionsResult.value.submissions) ? submissionsResult.value.submissions.length : 0);
    if (classificationResult.status === "fulfilled" && classificationResult.value) setPendingClassification(Number(record(classificationResult.value.totals).pending ?? 0));
    if (providerResult.status === "fulfilled") setProviderCount(Array.isArray(providerResult.value.providers) ? providerResult.value.providers.length : 0);
    if (healthResult.status === "fulfilled") setHealth(healthResult.value);
    setLoading(false);
  };
  useEffect(() => { void load(); }, [user?.knowledgeEnabled]);
  useEffect(() => { const previous = document.title; document.title = "Relay MCP — Administrator overview"; return () => { document.title = previous; }; }, []);

  const pendingAccounts = users.filter((user) => user.accountStatus !== "active").length;
  const activeAccounts = users.filter((user) => user.accountStatus === "active").length;
  const knowledgeQueue = pendingCandidates + pendingSubmissions + pendingClassification;
  const runtimeState = health?.ok === false ? "attention" : loading ? "loading" : "nominal";
  const queueDescription = useMemo(() => [pendingCandidates ? `${pendingCandidates} candidate${pendingCandidates === 1 ? "" : "s"}` : "", pendingSubmissions ? `${pendingSubmissions} submission${pendingSubmissions === 1 ? "" : "s"}` : "", pendingClassification ? `${pendingClassification} classification${pendingClassification === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || "No Knowledge review items reported", [pendingCandidates, pendingClassification, pendingSubmissions]);

  return <AppPageFrame variant="standard" className="admin-overview-page">
    <div className="preview-page-trail"><span>Relay console</span><span>/</span><strong>Administrator overview</strong></div>
    <header className="preview-page-heading"><div><h1>Keep the boundary clear.</h1><p>Review who enters Relay, which context becomes reusable and where the system is operating before it reaches a user.</p></div><Link className="preview-primary-action" to="/users/requests">Review {pendingAccounts || "access"} requests <ArrowRight size={15} aria-hidden="true" /></Link></header>
    {error && <div className="preview-inline-error" role="alert"><CircleAlert size={15} aria-hidden="true" />{error}<button type="button" onClick={() => void load()}>Retry</button></div>}
    <section className="admin-signals" aria-label="Control plane status"><div><span>pending requests</span><strong className="admin-signal-amber">{loading ? "—" : String(pendingAccounts).padStart(2, "0")} <small>need review</small></strong></div><div><span>active accounts</span><strong>{loading ? "—" : activeAccounts} <small>enabled</small></strong></div><div><span>Knowledge queue</span><strong className="admin-signal-amber">{loading ? "—" : String(knowledgeQueue).padStart(2, "0")} <small>items</small></strong></div><div><span>runtime posture</span><strong className={`preview-status-${runtimeState}`}>{runtimeState === "loading" ? "loading" : runtimeState === "attention" ? "attention" : "nominal"} <small>{providerCount === undefined ? "API" : `${providerCount} providers`}</small></strong></div></section>
    <div className="admin-overview-grid"><section className="preview-panel"><div className="preview-panel-head"><div><span className="preview-panel-kicker admin-kicker">Operations</span><h2>Access is a decision.</h2><p>Review requests and manage account state on their own pages.</p></div><Link className="preview-panel-action" to="/users/requests">Open requests <ArrowRight size={13} aria-hidden="true" /></Link></div><div className="admin-access-body"><h3>{pendingAccounts ? `${pendingAccounts} request${pendingAccounts === 1 ? " is" : "s are"} waiting.` : "No access requests are waiting."}</h3><p>Approve or reject an account, then review its separate Product Knowledge and project permissions.</p><div className="admin-action-row"><Link className="preview-quiet-button preview-quiet-primary" to="/users/requests">Review access requests</Link><Link className="preview-quiet-button" to="/users">Open users</Link></div></div></section><aside className="preview-panel"><div className="preview-panel-head"><div><span className="preview-panel-kicker admin-kicker">Knowledge / trace</span><h2>Keep reuse accountable.</h2><p>Human review and administrator decisions stay on separate pages.</p></div></div><div className="admin-status-list"><Link to="/knowledge/memory"><span><strong>Knowledge review</strong><small>{queueDescription}</small></span><span className={knowledgeQueue ? "preview-status-dot warn" : "preview-status-dot"}>{knowledgeQueue ? "open" : "ready"}</span></Link><Link to="/knowledge/integrated/gates"><span><strong>Release gates</strong><small>Provider and publication readiness</small></span><span className={health?.ok === false ? "preview-status-dot warn" : "preview-status-dot"}>{health?.ok === false ? "attention" : "ready"}</span></Link><Link to="/users"><span><strong>Account policy</strong><small>{activeAccounts} active account{activeAccounts === 1 ? "" : "s"} · {users.filter((user) => user.isAdmin).length} administrator{users.filter((user) => user.isAdmin).length === 1 ? "" : "s"}</small></span><CircleCheck size={15} aria-hidden="true" /></Link></div></aside></div>
    <div className="admin-lower-grid"><section className="preview-panel"><div className="preview-panel-head"><div><span className="preview-panel-kicker admin-kicker">Knowledge queue</span><h2>Review before reuse.</h2><p>Candidate Insights, Memory submissions and Product classification stay scoped until an explicit decision.</p></div><RefreshCw size={15} className={loading ? "preview-spin" : ""} aria-hidden="true" /></div><div className="admin-queue-grid"><div><strong>{pendingCandidates}</strong><span>candidate insights</span></div><div><strong>{pendingSubmissions}</strong><span>memory submissions</span></div><div><strong>{pendingClassification}</strong><span>classifications</span></div></div></section><section className="preview-panel"><div className="preview-panel-head"><div><span className="preview-panel-kicker admin-kicker">Next decision</span><h2>Open the right review surface.</h2><p>Approval changes state; it does not silently grant Knowledge or project access.</p></div></div><div className="admin-action-row"><Link className="preview-quiet-button preview-quiet-primary" to="/knowledge/memory">Open Knowledge review</Link><Link className="preview-quiet-button" to="/users/permissions">Review permissions</Link></div></section></div>
  </AppPageFrame>;
}
