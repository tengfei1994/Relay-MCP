import { useEffect, useState } from "react";
import { ArrowRight, CircleAlert, FolderPlus, KeyRound, RefreshCw } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { useRelayHealth } from "../context/RelayHealth";
import { AppPageFrame } from "../components/shell/AppPageFrame";
import "./console-overview.css";
import { useAuth } from "../App";
import UsersPage from "./Users";
import TokensPage from "./Tokens";

type UserRow = { id: number; username: string; accountStatus?: string; isAdmin?: boolean; knowledgeEnabled?: boolean };
function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function usersFrom(value: unknown): UserRow[] { return Array.isArray(value) ? value.flatMap((item) => { const row = record(item); return typeof row.id === "number" && typeof row.username === "string" ? [{ id: row.id, username: row.username, accountStatus: typeof row.accountStatus === "string" ? row.accountStatus : undefined, isAdmin: row.isAdmin === true, knowledgeEnabled: row.knowledgeEnabled === true }] : []; }) : []; }

export default function AdminOverview() {
  const { user } = useAuth();
  const location = useLocation();
  const adminView = new URLSearchParams(location.search).get("view") ?? "overview";
  const showOverview = adminView !== "users" && adminView !== "tokens";
  const [users, setUsers] = useState<UserRow[]>([]);
  const [pendingCandidates, setPendingCandidates] = useState(0);
  const [pendingSubmissions, setPendingSubmissions] = useState(0);
  const [pendingClassification, setPendingClassification] = useState(0);
  const [providerCount, setProviderCount] = useState<number>();
  const health = useRelayHealth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true); setError("");
    const [userResult, candidatesResult, submissionsResult, classificationResult, providerResult] = await Promise.allSettled([
      api.listUsers(), user?.knowledgeEnabled ? api.legacyCandidatesForReview(0) : Promise.resolve(undefined), user?.knowledgeEnabled ? api.memorySubmissions(0, "pending", 1) : Promise.resolve(undefined), user?.knowledgeEnabled ? api.productClassificationReport(0) : Promise.resolve(undefined), api.knowledgeManagedProviders(),
    ]);
    if (userResult.status === "fulfilled") setUsers(usersFrom(userResult.value.users)); else setError("Account data is unavailable. Try again.");
    if (candidatesResult.status === "fulfilled" && candidatesResult.value) setPendingCandidates(Array.isArray(candidatesResult.value.candidates) ? candidatesResult.value.candidates.length : 0);
    if (submissionsResult.status === "fulfilled" && submissionsResult.value) setPendingSubmissions(submissionsResult.value.page?.total ?? 0);
    if (classificationResult.status === "fulfilled" && classificationResult.value) setPendingClassification(Number(record(classificationResult.value.totals).pending ?? 0));
    if (providerResult.status === "fulfilled") setProviderCount(Array.isArray(providerResult.value.providers) ? providerResult.value.providers.length : 0);
    setLoading(false);
  };

  useEffect(() => { if (showOverview) void load(); }, [showOverview, user?.knowledgeEnabled]);
  useEffect(() => { const previous = document.title; document.title = adminView === "users" ? "Relay MCP — User administration" : adminView === "tokens" ? "Relay MCP — Token management" : "Relay MCP — Administrator overview"; return () => { document.title = previous; }; }, [adminView]);
  const pendingAccounts = users.filter((item) => item.accountStatus === "pending").length;
  const activeAccounts = users.filter((item) => (item.accountStatus ?? "active") === "active").length;
  const knowledgeQueue = pendingCandidates + pendingSubmissions + pendingClassification;
  const runtimeState = health === "healthy" ? "Healthy" : health === "offline" ? "Offline" : health === "degraded" ? "Degraded" : "Checking";

  if (adminView === "users") return <UsersPage embedded />;
  if (adminView === "tokens") return <TokensPage embedded />;

  return <AppPageFrame variant="standard" className="admin-overview-page">
    <header className="admin-header">
      <div><h1>Admin</h1><span>Instance management</span></div>
      <div className="admin-header-actions">
        <Link className="admin-button admin-button-primary" to="/projects?create=1"><FolderPlus size={15} aria-hidden="true" />New project</Link>
        <Link className="admin-button" to="/admin?view=tokens&create=1"><KeyRound size={15} aria-hidden="true" />Create token</Link>
        <Link className="admin-button" to="/workspace">Workspace <ArrowRight size={15} aria-hidden="true" /></Link>
      </div>
    </header>

    {error && <div className="admin-error" role="alert"><CircleAlert size={15} aria-hidden="true" />{error}<button type="button" onClick={() => void load()}>Retry</button></div>}

    <section className="admin-status-strip" aria-label="System status">
      <div><span>System</span><strong className={runtimeState === "Healthy" ? "is-good" : health === "degraded" || health === "offline" ? "is-warn" : ""}>{runtimeState}</strong></div>
      <div><span>Users</span><strong>{loading ? "-" : users.length}</strong><small>{activeAccounts} active</small></div>
      <div><span>Access requests</span><strong>{loading ? "-" : pendingAccounts}</strong><small>waiting</small></div>
      <div><span>Knowledge review</span><strong>{loading ? "-" : knowledgeQueue}</strong><small>{providerCount === undefined ? "status unavailable" : providerCount + " providers"}</small></div>
    </section>

    <section className="admin-workbench" aria-label="People workbench">
      <div className="admin-workbench-toolbar">
        <div><h2>People</h2><span>{loading ? "Loading accounts..." : users.length + " accounts"}</span></div>
        <div className="admin-workbench-actions"><Link to="/admin?view=users&section=requests" className="admin-inline-action">Review requests{pendingAccounts ? " (" + pendingAccounts + ")" : ""}</Link><button className="admin-icon-button" type="button" onClick={() => void load()} aria-label="Refresh administrator data"><RefreshCw size={15} className={loading ? "admin-spin" : ""} aria-hidden="true" /></button></div>
      </div>
      <div className="admin-people-list">
        <div className="admin-list-head"><span>User</span><span>Role</span><span>Knowledge</span><span>Status</span></div>
        {users.length ? users.map((item) => (
          <Link key={item.id} to={"/admin?view=users&user=" + item.id} className="admin-person-row">
            <span><strong>{item.username}</strong></span><span>{item.isAdmin ? "Admin" : "User"}</span>
            <span>{item.knowledgeEnabled ? "On" : "Off"}</span><span className={item.accountStatus === "active" ? "is-good" : "is-warn"}>{item.accountStatus || "pending"}</span>
          </Link>
        )) : <div className="admin-list-empty">{loading ? "Loading accounts..." : "No users found."}</div>}
      </div>
    </section>
  </AppPageFrame>;
}
