import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { BookOpen, KeyRound, UserPlus } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../App";
import { AppPageFrame } from "../components/shell/AppPageFrame";
import { Button, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, Select, Skeleton, StatusPill, useToast } from "../components/ui";
import "./users.css";

type UserRecord = { id: number; username: string; isAdmin: boolean; knowledgeEnabled?: boolean; accountStatus?: string; reviewedBy?: number; reviewedAt?: string; reviewReason?: string | null; createdAt?: string };
type UserForm = { username: string; password: string; isAdmin: boolean; knowledgeEnabled: boolean };
const emptyUser: UserForm = { username: "", password: "", isAdmin: false, knowledgeEnabled: false };
function dateLabel(value?: string) {
  return value ? new Date(value).toLocaleDateString() : "Unavailable";
}
function messageOf(reason: unknown) { return reason instanceof Error ? reason.message : "The request could not be completed."; }

export default function UsersPage({ embedded: embeddedProp = false }: { embedded?: boolean }) {
  const { user: me } = useAuth();
  const location = useLocation();
  const [query, setQuery] = useSearchParams();
  const embedded = embeddedProp || (location.pathname === "/admin" && query.get("view") === "users");
  const toast = useToast();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newUser, setNewUser] = useState<UserForm>(emptyUser);
  const [pwdTarget, setPwdTarget] = useState<UserRecord | null>(null);
  const [newPwd, setNewPwd] = useState("");
  const [currentPwd, setCurrentPwd] = useState("");
  const [reviewTarget, setReviewTarget] = useState<UserRecord | null>(null);
  const [reviewAction, setReviewAction] = useState<"active" | "rejected" | "disabled">("active");
  const [reviewReason, setReviewReason] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const reviewLock = useRef(false);
  const [error, setError] = useState("");
  const [pwdError, setPwdError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<UserRecord | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [permissionChange, setPermissionChange] = useState<"admin" | "knowledge">();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    api.listUsers()
      .then((result) => { if (active) setUsers(result.users as UserRecord[]); })
      .catch((reason: unknown) => { if (active) setLoadError(messageOf(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadAttempt]);

  function showDetails(id?: number) {
    const next = new URLSearchParams(query);
    if (id === undefined) next.delete("user");
    else next.set("user", String(id));
    setQuery(next, { replace: id === undefined || query.has("user") });
  }

  const createUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const result = await api.createUser(newUser.username, newUser.password, newUser.isAdmin, newUser.knowledgeEnabled);
      setUsers((current) => [...current, result.user as UserRecord]);
      setNewUser(emptyUser);
      setShowCreate(false);
      toast.success("User created.");
    } catch (reason: unknown) { setError(messageOf(reason)); }
  };

  const deleteUser = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteUser(deleteTarget.id);
      setUsers((current) => current.filter((user) => user.id !== deleteTarget.id));
      setDeleteTarget(null);
      showDetails();
      toast.success("User deleted.");
    } catch (reason: unknown) {
      throw new Error(messageOf(reason));
    }
  };

  const toggleAdmin = async (user: UserRecord) => {
    try {
      await api.toggleAdmin(user.id, !user.isAdmin);
      setUsers((current) => current.map((item) => item.id === user.id ? { ...item, isAdmin: !item.isAdmin } : item));
      toast.success(user.isAdmin ? "Admin access revoked." : "Admin access granted.");
    } catch (reason: unknown) { setError(messageOf(reason)); }
  };
  const toggleKnowledge = async (user: UserRecord) => {
    try {
      await api.toggleKnowledge(user.id, !user.knowledgeEnabled);
      setUsers((current) => current.map((item) => item.id === user.id ? { ...item, knowledgeEnabled: !user.knowledgeEnabled } : item));
      toast.success(!user.knowledgeEnabled ? "Product Knowledge and general Memory enabled." : "Product Knowledge and general Memory disabled.");
    } catch (reason: unknown) { throw new Error(messageOf(reason)); }
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pwdTarget) return;
    setPwdError("");
    try {
      await api.changePassword(pwdTarget.id, newPwd, currentPwd || undefined);
      setPwdTarget(null);
      setNewPwd("");
      setCurrentPwd("");
      toast.success("Password changed.");
    } catch (reason: unknown) { setPwdError(messageOf(reason)); }
  };

  const openReview = (target: UserRecord, action: "active" | "rejected" | "disabled") => {
    setReviewTarget(target); setReviewAction(action); setReviewReason(""); setReviewError("");
  };
  const submitReview = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!reviewTarget || reviewLock.current) return;
    reviewLock.current = true;
    setReviewBusy(true);
    setReviewError("");
    try {
      const result = await api.setUserStatus(reviewTarget.id, reviewAction, reviewReason);
      setUsers((current) => current.map((item) => item.id === reviewTarget.id ? { ...item, accountStatus: result.status, reviewedAt: result.reviewedAt, reviewedBy: result.reviewedBy, reviewReason: result.reviewReason } : item));
      setReviewTarget(null);
      toast.success("Account status updated.");
    } catch (reason: unknown) { setReviewError(messageOf(reason)); }
    finally { reviewLock.current = false; setReviewBusy(false); }
  };
  const mode = embedded
    ? query.get("section") === "requests" ? "requests" : query.get("section") === "permissions" ? "permissions" : "accounts"
    : location.pathname === "/users/requests" ? "requests" : location.pathname === "/users/permissions" ? "permissions" : "accounts";
  useEffect(() => { setStatusFilter(""); }, [mode]);
  const usersPath = embedded ? "/admin?view=users" : "/users";
  const requestsPath = embedded ? "/admin?view=users&section=requests" : "/users/requests";
  const permissionsPath = embedded ? "/admin?view=users&section=permissions" : "/users/permissions";
  const visibleUsers = users.filter((account) => {
    const status = account.accountStatus ?? "active";
    return (mode !== "requests" || status !== "active")
      && (!statusFilter || status === statusFilter)
      && account.username.toLowerCase().includes(search.trim().toLowerCase());
  });
  const selected = users.find((account) => String(account.id) === query.get("user"));
  const permissionLabel = permissionChange === "admin" ? selected?.isAdmin ? "Revoke admin" : "Make admin" : selected?.knowledgeEnabled ? "Disable Knowledge" : "Enable Knowledge";
  const showAccount = Boolean(query.has("user") && !loading && !loadError && !pwdTarget && !reviewTarget && !deleteTarget && !permissionChange);
  const columns = [
    { key: "username", header: "Username", render: (account: UserRecord) => <strong className="break-all">{account.username}{account.id === me?.id && <span className="ml-2 text-xs font-normal text-muted">(you)</span>}</strong> },
    { key: "status", header: "Status", render: (account: UserRecord) => <StatusPill status={account.accountStatus ?? "active"} /> },
    { key: "role", header: "Role", className: "users-secondary-field", render: (account: UserRecord) => account.isAdmin ? "Administrator" : "User" },
    { key: "knowledge", header: "Knowledge", className: "users-secondary-field", render: (account: UserRecord) => account.knowledgeEnabled ? "Enabled" : "Disabled" },
    { key: "details", header: "", render: (account: UserRecord) => <Button type="button" variant="ghost" onClick={() => showDetails(account.id)} aria-label={"View details for " + account.username}>Details</Button> },
  ];

  const content = (
      <div className="mx-auto max-w-[1100px] px-3 sm:px-0">
        <div className="users-page-toolbar">
          <div className="users-page-title"><strong>{mode === "requests" ? "Access requests" : mode === "permissions" ? "Knowledge permissions" : "Users"}</strong></div>
          <div className="users-page-actions">
            <nav className={`shell-page-tabs ${embedded ? "admin-tabs" : "admin-mobile-tabs"}`} aria-label="Administrator sections">
              <Link to={usersPath} className={`shell-page-tab${mode === "accounts" ? " active" : ""}`} aria-current={mode === "accounts" ? "page" : undefined}>Users</Link>
              <Link to={requestsPath} className={`shell-page-tab${mode === "requests" ? " active" : ""}`} aria-current={mode === "requests" ? "page" : undefined}>Access requests</Link>
              <Link to={permissionsPath} className={`shell-page-tab${mode === "permissions" ? " active" : ""}`} aria-current={mode === "permissions" ? "page" : undefined}>Knowledge permissions</Link>
            </nav>
            {mode === "accounts" && <Button onClick={() => { setError(""); setShowCreate(true); }} variant="primary"><UserPlus size={15} /> Add user</Button>}
          </div>
        </div>
        {error && <div className="mb-5 rounded-[10px] border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-coral" role="alert">{error}</div>}
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Field label="Search users" className="min-w-0 flex-1"><Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
          <Field label="Account status"><Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">All statuses</option>
            {mode !== "requests" && <option value="active">Active</option>}
            <option value="pending">Pending</option><option value="rejected">Rejected</option><option value="disabled">Disabled</option>
          </Select></Field>
          {(search || statusFilter) && <Button type="button" variant="ghost" onClick={() => { setSearch(""); setStatusFilter(""); }}>Clear filters</Button>}
        </div>
        {loadError ? <ErrorState message={loadError} onRetry={() => setLoadAttempt((value) => value + 1)} />
          : loading ? <Skeleton className="h-24 w-full" aria-label="Loading users" role="status" />
            : visibleUsers.length ? <DataTable className="users-account-table" rows={visibleUsers} columns={columns} rowKey={(account) => String(account.id)} selectedRowKey={query.get("user") ?? undefined} />
              : <EmptyState title={search || statusFilter ? "No users match these filters" : mode === "requests" ? "No access requests" : "No users found"} description={search || statusFilter ? "Clear a filter to see more accounts." : undefined} />}
        <Dialog open={showAccount} onClose={() => showDetails()} title={selected?.username ?? "Account unavailable"}>
          {selected ? <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2"><StatusPill status={selected.accountStatus ?? "active"} /><StatusPill status={selected.isAdmin ? "admin" : "user"} /></div>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div><dt className="text-muted">Account ID</dt><dd>#{selected.id}</dd></div>
              <div><dt className="text-muted">Joined</dt><dd>{dateLabel(selected.createdAt)}</dd></div>
              <div><dt className="text-muted">Product Knowledge and general Memory</dt><dd>{selected.knowledgeEnabled ? "Enabled" : "Disabled"}</dd></div>
              {selected.reviewedAt && <div><dt className="text-muted">Last reviewed</dt><dd>{dateLabel(selected.reviewedAt)}{selected.reviewedBy && " · " + (users.find((account) => account.id === selected.reviewedBy)?.username ?? "#" + selected.reviewedBy)}</dd></div>}
              {selected.reviewReason && <div className="col-span-2"><dt className="text-muted">Review reason</dt><dd className="break-words">{selected.reviewReason}</dd></div>}
            </dl>
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              {mode !== "permissions" && selected.accountStatus === "pending" && <><Button type="button" variant="primary" onClick={() => openReview(selected, "active")}>Approve</Button><Button type="button" variant="ghost" onClick={() => openReview(selected, "rejected")}>Reject</Button></>}
              {mode !== "permissions" && selected.id !== me?.id && (selected.accountStatus ?? "active") === "active" && <Button type="button" variant="ghost" onClick={() => openReview(selected, "disabled")}>Disable account</Button>}
              {mode !== "permissions" && ["rejected", "disabled"].includes(selected.accountStatus ?? "") && <Button type="button" variant="ghost" onClick={() => openReview(selected, "active")}>Enable account</Button>}
              {mode === "accounts" && <Button type="button" variant="ghost" onClick={() => { setPwdTarget(selected); setNewPwd(""); setCurrentPwd(""); setPwdError(""); }}><KeyRound size={15} />Change password</Button>}
              {mode === "accounts" && selected.id !== me?.id && <><Button type="button" variant="ghost" onClick={() => setPermissionChange("admin")}>{selected.isAdmin ? "Revoke admin" : "Make admin"}</Button><Button type="button" variant="ghost" onClick={() => setDeleteTarget(selected)}>Delete user</Button></>}
              {mode === "permissions" && <Button type="button" variant="ghost" onClick={() => setPermissionChange("knowledge")}><BookOpen size={15} />{selected.knowledgeEnabled ? "Disable Knowledge" : "Enable Knowledge"}</Button>}
            </div>
          </div> : <p>This account could not be found.</p>}
        </Dialog>
        <ConfirmDialog open={Boolean(selected && permissionChange)} onClose={() => setPermissionChange(undefined)}
          title={permissionLabel} description={selected?.username}
          confirmLabel={permissionLabel} onConfirm={async () => {
            if (!selected) return;
            if (permissionChange === "admin") await toggleAdmin(selected);
            else if (permissionChange === "knowledge") await toggleKnowledge(selected);
          }} />

        <Dialog open={showCreate} onClose={() => setShowCreate(false)} title="Add user"><form onSubmit={createUser} className="space-y-4"><Field label="Username"><Input required value={newUser.username} onChange={(event) => setNewUser((current) => ({ ...current, username: event.target.value }))} /></Field><Field label="Password"><Input required type="password" value={newUser.password} onChange={(event) => setNewUser((current) => ({ ...current, password: event.target.value }))} /></Field><label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={newUser.isAdmin} onChange={(event) => setNewUser((current) => ({ ...current, isAdmin: event.target.checked }))} /> Grant admin privileges</label><label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={newUser.knowledgeEnabled} onChange={(event) => setNewUser((current) => ({ ...current, knowledgeEnabled: event.target.checked }))} /> Allow product Knowledge and general Memory</label><p className="text-sm text-muted">Project Memory follows the user's project access separately. Administrators also need this permission to read product content and general Memory.</p>{error && <p className="text-sm text-coral" role="alert">{error}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button><Button type="submit" variant="primary">Create user</Button></div></form></Dialog>
        <Dialog open={Boolean(pwdTarget)} onClose={() => setPwdTarget(null)} title="Change password" description={pwdTarget?.username}><form onSubmit={changePassword} className="space-y-4">{pwdTarget?.id === me?.id && <Field label="Current password"><Input required type="password" value={currentPwd} onChange={(event) => setCurrentPwd(event.target.value)} autoComplete="current-password" /></Field>}<Field label="New password"><Input required minLength={6} type="password" value={newPwd} onChange={(event) => setNewPwd((event.target as HTMLInputElement).value)} autoComplete="new-password" /></Field>{pwdError && <p className="text-sm text-coral" role="alert">{pwdError}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setPwdTarget(null)}>Cancel</Button><Button type="submit" variant="primary">Save password</Button></div></form></Dialog>
        <Dialog open={Boolean(reviewTarget)} busy={reviewBusy} onClose={() => setReviewTarget(null)} title={reviewAction === "rejected" ? "Reject request" : reviewAction === "disabled" ? "Disable account" : "Approve or enable account"} description={reviewTarget?.username}><form onSubmit={submitReview} className="space-y-4"><p className="text-sm text-muted">{reviewAction === "active" ? "Product Knowledge and general Memory remain controlled by their separate permission." : "Access to protected resources stops on the next request."}</p><Field label="Reason (optional)"><Input value={reviewReason} maxLength={500} onChange={(event) => setReviewReason((event.target as HTMLInputElement).value)} /></Field>{reviewError && <p role="alert" className="text-sm text-coral">{reviewError}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setReviewTarget(null)} disabled={reviewBusy}>Cancel</Button><Button type="submit" variant="primary" loading={reviewBusy}>{reviewAction === "rejected" ? "Reject" : reviewAction === "disabled" ? "Disable" : "Approve"}</Button></div></form></Dialog>
        <ConfirmDialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="Delete user" description={deleteTarget ? "Delete " + deleteTarget.username + "? All their projects and servers will be deleted." : ""} confirmLabel="Delete user" tone="danger" onConfirm={deleteUser} />
      </div>
  );
  return embedded ? content : <AppPageFrame variant="wide">{content}</AppPageFrame>;
}
