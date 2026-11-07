import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { BookOpen, KeyRound, Shield, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../App";
import { AppPageFrame } from "../components/shell/AppPageFrame";
import { Button, ConfirmDialog, Dialog, EmptyState, Field, Input, StatusPill, useToast } from "../components/ui";

type UserRecord = { id: number; username: string; isAdmin: boolean; knowledgeEnabled?: boolean; accountStatus?: string; reviewedBy?: number; reviewedAt?: string; reviewReason?: string | null; createdAt?: string };
type UserForm = { username: string; password: string; isAdmin: boolean; knowledgeEnabled: boolean };
const emptyUser: UserForm = { username: "", password: "", isAdmin: false, knowledgeEnabled: false };
const inputClass = "w-full rounded-[10px] border border-white/10 bg-white/[.04] px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus:border-mint";
function messageOf(reason: unknown) { return reason instanceof Error ? reason.message : "The request could not be completed."; }

export default function UsersPage() {
  const { user: me } = useAuth();
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
  const [error, setError] = useState("");
  const [pwdError, setPwdError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<UserRecord | null>(null);

  useEffect(() => {
    api.listUsers().then((result) => setUsers(result.users as UserRecord[])).catch((reason: unknown) => setError(messageOf(reason)));
  }, []);

  const createUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const result = await api.createUser(newUser.username, newUser.password, newUser.isAdmin, newUser.knowledgeEnabled);
      setUsers((current) => [...current, result.user as UserRecord]);
      setNewUser(emptyUser);
      toast.success("User created.");
    } catch (reason: unknown) { setError(messageOf(reason)); }
  };

  const deleteUser = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteUser(deleteTarget.id);
      setUsers((current) => current.filter((user) => user.id !== deleteTarget.id));
      setDeleteTarget(null);
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
      await api.toggleKnowledge(user.id, user.knowledgeEnabled === false);
      setUsers((current) => current.map((item) => item.id === user.id ? { ...item, knowledgeEnabled: user.knowledgeEnabled === false } : item));
      toast.success(user.knowledgeEnabled === false ? "Product Knowledge and general Memory enabled." : "Product Knowledge and general Memory disabled.");
    } catch (reason: unknown) { setError(messageOf(reason)); }
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
    if (!reviewTarget) return;
    try {
      const result = await api.setUserStatus(reviewTarget.id, reviewAction, reviewReason);
      setUsers((current) => current.map((item) => item.id === reviewTarget.id ? { ...item, accountStatus: result.status, reviewedAt: result.reviewedAt, reviewedBy: result.reviewedBy, reviewReason: result.reviewReason } : item));
      setReviewTarget(null);
      toast.success("Account status updated.");
    } catch (reason: unknown) { setReviewError(messageOf(reason)); }
  };
  const location = useLocation();
  const mode = location.pathname === "/users/requests" ? "requests" : location.pathname === "/users/permissions" ? "permissions" : "accounts";
  const visibleUsers = mode === "requests" ? users.filter((item) => item.accountStatus !== "active") : users;

  return (
    <AppPageFrame variant="wide">
      <div className="mx-auto max-w-[1100px]">
        {mode === "accounts" && <div className="mb-4 flex justify-end"><Button onClick={() => { setError(""); setShowCreate(true); }} variant="primary"><UserPlus size={15} /> Add user</Button></div>}
        <nav className="shell-page-tabs mb-8" aria-label="Administrator sections">
          <NavLink to="/users" end className={({ isActive }) => `shell-page-tab${isActive ? " active" : ""}`}>Users</NavLink>
          <NavLink to="/users/requests" className={({ isActive }) => `shell-page-tab${isActive ? " active" : ""}`}>Access requests</NavLink>
          <NavLink to="/users/permissions" className={({ isActive }) => `shell-page-tab${isActive ? " active" : ""}`}>Knowledge permissions</NavLink>
        </nav>
        {error && <div className="mb-5 rounded-[10px] border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-coral" role="alert">{error}</div>}
        <div className="glass divide-y divide-white/[.09]">
          {visibleUsers.map((user) => <div key={user.id} className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-5">
            <div className="flex min-w-0 items-center gap-3">
              {user.isAdmin ? <ShieldCheck size={18} className="shrink-0 text-mint" /> : <Shield size={18} className="shrink-0 text-muted" />}
              <div className="min-w-0">
                <p className="truncate font-medium text-fg">{user.username}{user.id === me?.id && <span className="ml-2 text-xs text-muted">(you)</span>}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-muted"><StatusPill status={user.accountStatus ?? "active"} /><StatusPill status={user.isAdmin ? "admin" : "user"} /><StatusPill status={user.knowledgeEnabled === false ? "product Knowledge and general Memory off" : "product Knowledge and general Memory on"} /><span>Joined {user.createdAt?.slice(0, 10) ?? "-"}</span></div>
                {user.reviewedAt && <p className="mt-1 text-xs text-muted">Reviewed {user.reviewedAt.slice(0, 10)} by user {user.reviewedBy}{user.reviewReason ? ` · ${user.reviewReason}` : ""}</p>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {mode !== "permissions" && user.accountStatus === "pending" && <><Button onClick={() => openReview(user, "active")} variant="primary">Approve</Button><Button onClick={() => openReview(user, "rejected")} variant="ghost">Reject</Button></>}
              {mode !== "permissions" && user.id !== me?.id && user.accountStatus === "active" && <Button onClick={() => openReview(user, "disabled")} variant="ghost">Disable</Button>}
              {mode !== "permissions" && ["disabled", "rejected"].includes(user.accountStatus ?? "") && <Button onClick={() => openReview(user, "active")} variant="ghost">Enable account</Button>}
              {mode === "accounts" && <Button onClick={() => { setPwdTarget(user); setNewPwd(""); setCurrentPwd(""); setPwdError(""); }} variant="ghost" aria-label={`Change password for ${user.username}`}><KeyRound size={15} /></Button>}
              {mode !== "requests" && user.id !== me?.id && <Button onClick={() => void toggleAdmin(user)} variant="ghost">{user.isAdmin ? "Revoke admin" : "Make admin"}</Button>}
              {mode !== "requests" && <Button onClick={() => void toggleKnowledge(user)} variant="ghost"><BookOpen size={15} /> {user.knowledgeEnabled === false ? "Enable Knowledge" : "Disable Knowledge"}</Button>}
              {mode === "accounts" && user.id !== me?.id && <Button onClick={() => setDeleteTarget(user)} variant="ghost" aria-label={`Delete ${user.username}`}><Trash2 size={15} /></Button>}
            </div>
          </div>)}
          {visibleUsers.length === 0 && <EmptyState title={mode === "requests" ? "No access requests" : "No users found"} description={mode === "requests" ? "Pending, rejected and disabled accounts will appear here for review." : "Add a user to manage access to Relay."} />}
        </div>

        <Dialog open={showCreate} onClose={() => setShowCreate(false)} title="Add user"><form onSubmit={createUser} className="space-y-4"><Field label="Username"><Input required value={newUser.username} onChange={(event) => setNewUser((current) => ({ ...current, username: event.target.value }))} /></Field><Field label="Password"><Input required type="password" value={newUser.password} onChange={(event) => setNewUser((current) => ({ ...current, password: event.target.value }))} /></Field><label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={newUser.isAdmin} onChange={(event) => setNewUser((current) => ({ ...current, isAdmin: event.target.checked }))} /> Grant admin privileges</label><label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={newUser.knowledgeEnabled} onChange={(event) => setNewUser((current) => ({ ...current, knowledgeEnabled: event.target.checked }))} /> Allow product Knowledge and general Memory</label><p className="text-sm text-muted">Project Memory follows the user's project access separately. Administrators also need this permission to read product content and general Memory.</p>{error && <p className="text-sm text-coral" role="alert">{error}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button><Button type="submit" variant="primary">Create user</Button></div></form></Dialog>
        <Dialog open={Boolean(pwdTarget)} onClose={() => setPwdTarget(null)} title="Change password" description={pwdTarget?.username}><form onSubmit={changePassword} className="space-y-4">{pwdTarget?.id === me?.id && <Field label="Current password"><Input required type="password" value={currentPwd} onChange={(event) => setCurrentPwd(event.target.value)} autoComplete="current-password" /></Field>}<Field label="New password"><Input required minLength={6} type="password" value={newPwd} onChange={(event) => setNewPwd((event.target as HTMLInputElement).value)} autoComplete="new-password" /></Field>{pwdError && <p className="text-sm text-coral" role="alert">{pwdError}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setPwdTarget(null)}>Cancel</Button><Button type="submit" variant="primary">Save password</Button></div></form></Dialog>
        <Dialog open={Boolean(reviewTarget)} onClose={() => setReviewTarget(null)} title={reviewAction === "rejected" ? "Reject request" : reviewAction === "disabled" ? "Disable account" : "Approve or enable account"} description={reviewTarget?.username}><form onSubmit={submitReview} className="space-y-4"><p className="text-sm text-muted">{reviewAction === "active" ? "Product Knowledge and general Memory remain controlled by their separate permission." : "Access to protected resources stops on the next request."}</p><Field label="Reason (optional)"><Input value={reviewReason} maxLength={500} onChange={(event) => setReviewReason((event.target as HTMLInputElement).value)} /></Field>{reviewError && <p role="alert" className="text-sm text-coral">{reviewError}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setReviewTarget(null)}>Cancel</Button><Button type="submit" variant="primary">{reviewAction === "rejected" ? "Reject" : reviewAction === "disabled" ? "Disable" : "Approve"}</Button></div></form></Dialog>
        <ConfirmDialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="Delete user" description="Delete this user? All their projects and servers will be deleted." confirmLabel="Delete user" tone="danger" onConfirm={deleteUser} />
      </div>
    </AppPageFrame>
  );
}
