import { useEffect, useState } from "react";
import { KeyRound, Shield, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../App";
import { Button, ConfirmDialog, Dialog, EmptyState, Field, Input, StatusPill, useToast } from "../components/ui";

type UserRecord = { id: number; username: string; isAdmin: boolean; createdAt?: string };
type UserForm = { username: string; password: string; isAdmin: boolean };
const emptyUser: UserForm = { username: "", password: "", isAdmin: false };
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
      const result = await api.createUser(newUser.username, newUser.password, newUser.isAdmin);
      setUsers((current) => [...current, result.user as UserRecord]);
      setShowCreate(false);
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

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pwdTarget) return;
    setPwdError("");
    try {
      await api.changePassword(pwdTarget.id, newPwd);
      setPwdTarget(null);
      setNewPwd("");
      toast.success("Password changed.");
    } catch (reason: unknown) { setPwdError(messageOf(reason)); }
  };

  return (
    <div className="mx-auto max-w-[1000px] px-5 py-8 sm:px-8">
      <header className="mb-7 flex flex-wrap items-end justify-between gap-5"><div><h1 className="font-display text-[30px] font-semibold leading-tight tracking-[-.02em] text-fg">Users</h1><p className="mt-2 text-sm text-muted">Manage accounts, administrator access and passwords.</p></div><Button onClick={() => { setError(""); setShowCreate(true); }} variant="primary"><UserPlus size={15} /> Add user</Button></header>
      {error && <div className="mb-5 rounded-[10px] border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-coral" role="alert">{error}</div>}
      <div className="glass divide-y divide-white/[.09]">
        {users.map((user) => <div key={user.id} className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-5"><div className="flex min-w-0 items-center gap-3">{user.isAdmin ? <ShieldCheck size={18} className="shrink-0 text-mint" /> : <Shield size={18} className="shrink-0 text-muted" />}<div className="min-w-0"><p className="truncate font-medium text-fg">{user.username}{user.id === me?.id && <span className="ml-2 text-xs text-muted">(you)</span>}</p><div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-muted"><StatusPill status={user.isAdmin ? "admin" : "user"} /><span>Joined {user.createdAt?.slice(0, 10) ?? "-"}</span></div></div></div><div className="flex items-center gap-1"><Button onClick={() => { setPwdTarget(user); setNewPwd(""); setPwdError(""); }} variant="ghost" aria-label={`Change password for ${user.username}`}><KeyRound size={15} /></Button>{user.id !== me?.id && <><Button onClick={() => void toggleAdmin(user)} variant="ghost">{user.isAdmin ? "Revoke admin" : "Make admin"}</Button><Button onClick={() => setDeleteTarget(user)} variant="ghost" aria-label={`Delete ${user.username}`}><Trash2 size={15} /></Button></>}</div></div>)}
        {users.length === 0 && <EmptyState title="No users found" description="Add a user to manage access to Relay." />}
      </div>

      <Dialog open={showCreate} onClose={() => setShowCreate(false)} title="Add user"><form onSubmit={createUser} className="space-y-4"><Field label="Username"><Input required value={newUser.username} onChange={(event) => setNewUser((current) => ({ ...current, username: event.target.value }))} /></Field><Field label="Password"><Input required type="password" value={newUser.password} onChange={(event) => setNewUser((current) => ({ ...current, password: event.target.value }))} /></Field><label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={newUser.isAdmin} onChange={(event) => setNewUser((current) => ({ ...current, isAdmin: event.target.checked }))} /> Grant admin privileges</label>{error && <p className="text-sm text-coral" role="alert">{error}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button><Button type="submit" variant="primary">Create user</Button></div></form></Dialog>
      <Dialog open={Boolean(pwdTarget)} onClose={() => setPwdTarget(null)} title="Change password" description={pwdTarget?.username}><form onSubmit={changePassword} className="space-y-4"><Field label="New password"><Input required type="password" value={newPwd} onChange={(event) => setNewPwd(event.target.value)} autoFocus /></Field>{pwdError && <p className="text-sm text-coral" role="alert">{pwdError}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setPwdTarget(null)}>Cancel</Button><Button type="submit" variant="primary">Save password</Button></div></form></Dialog>
      <ConfirmDialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="Delete user" description="Delete this user? All their projects and servers will be deleted." confirmLabel="Delete user" tone="danger" onConfirm={deleteUser} />
    </div>
  );
}
