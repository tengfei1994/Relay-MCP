import { useState, type FormEvent } from "react";
import { useAuth } from "../App";
import { api } from "../api/client";
import { Button, Field, Input, PageHeader } from "../components/ui";
import { AppPageFrame } from "../components/shell/AppPageFrame";

export default function AccountPage() {
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setMessage("");
    if (password !== confirmation) { setError("The new passwords do not match."); return; }
    if (!user) return;
    setBusy(true);
    try {
      await api.changePassword(user.id, password, currentPassword);
      setCurrentPassword(""); setPassword(""); setConfirmation("");
      setMessage("Password updated.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update your password."); }
    finally { setBusy(false); }
  };
  return <AppPageFrame><div className="mx-auto max-w-[760px]">
    <PageHeader title="Account" description="Manage your sign-in details and password." />
    <section className="glass mb-6 p-6"><h2 className="font-display text-xl">Profile</h2><dl className="mt-4 grid gap-4 sm:grid-cols-2"><div><dt className="text-sm text-muted">Username</dt><dd className="mt-1 text-fg">{user?.username}</dd></div><div><dt className="text-sm text-muted">Role</dt><dd className="mt-1 text-fg">{user?.isAdmin ? "Administrator" : "User"}</dd></div></dl><p className="mt-4 text-sm text-muted">Contact an administrator to change your username or access.</p></section>
    <section className="glass p-6"><h2 className="font-display text-xl">Change password</h2><form onSubmit={submit} className="mt-4 grid max-w-md gap-4"><Field label="Current password"><Input required type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></Field><Field label="New password"><Input required minLength={6} type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></Field><Field label="Confirm new password"><Input required minLength={6} type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></Field>{error && <p role="alert" className="text-sm text-coral">{error}</p>}{message && <p role="status" className="text-sm text-mint">{message}</p>}<div><Button type="submit" disabled={busy} variant="primary">{busy ? "Saving…" : "Update password"}</Button></div></form></section>
  </div></AppPageFrame>;
}
