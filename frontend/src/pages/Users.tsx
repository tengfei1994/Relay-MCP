import { useState, useEffect } from "react";
import { UserPlus, Trash2, ShieldCheck, Shield, KeyRound } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../App";

export default function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newUser, setNewUser] = useState({ username: "", password: "", isAdmin: false });
  const [pwdTarget, setPwdTarget] = useState<any | null>(null);
  const [newPwd, setNewPwd] = useState("");
  const [error, setError] = useState("");
  const [pwdError, setPwdError] = useState("");

  useEffect(() => {
    api.listUsers().then((r) => setUsers(r.users));
  }, []);

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const r = await api.createUser(newUser.username, newUser.password, newUser.isAdmin);
      setUsers((u) => [...u, r.user]);
      setShowCreate(false);
      setNewUser({ username: "", password: "", isAdmin: false });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const deleteUser = async (id: number) => {
    if (!confirm("Delete this user? All their projects and servers will be deleted.")) return;
    await api.deleteUser(id);
    setUsers((u) => u.filter((usr) => usr.id !== id));
  };

  const toggleAdmin = async (user: any) => {
    await api.toggleAdmin(user.id, !user.isAdmin);
    setUsers((u) => u.map((usr) => usr.id === user.id ? { ...usr, isAdmin: !usr.isAdmin } : usr));
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwdError("");
    try {
      await api.changePassword(pwdTarget.id, newPwd);
      setPwdTarget(null);
      setNewPwd("");
    } catch (err: any) {
      setPwdError(err.message);
    }
  };

  const inputCls = "w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500";

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-gray-100">User Management</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-md"
        >
          <UserPlus size={14} />
          Add User
        </button>
      </div>

      <div className="space-y-3">
        {users.map((u) => (
          <div key={u.id} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
            <div className="flex items-center gap-3">
              {u.isAdmin
                ? <ShieldCheck size={16} className="text-indigo-400" />
                : <Shield size={16} className="text-gray-600" />
              }
              <div>
                <p className="text-sm font-medium text-gray-200">
                  {u.username}
                  {u.id === me?.id && <span className="ml-2 text-xs text-gray-500">(you)</span>}
                </p>
                <p className="text-xs text-gray-500">{u.isAdmin ? "Admin" : "User"} · joined {u.createdAt?.slice(0, 10)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setPwdTarget(u); setNewPwd(""); setPwdError(""); }}
                className="text-gray-500 hover:text-indigo-400"
                title="Change password"
              >
                <KeyRound size={14} />
              </button>
              {u.id !== me?.id && (
                <>
                  <button
                    onClick={() => toggleAdmin(u)}
                    className={`text-xs px-2 py-1 border rounded ${u.isAdmin ? "border-indigo-700 text-indigo-400 hover:border-gray-700 hover:text-gray-400" : "border-gray-700 text-gray-400 hover:border-indigo-700 hover:text-indigo-400"}`}
                    title={u.isAdmin ? "Revoke admin" : "Grant admin"}
                  >
                    {u.isAdmin ? "Revoke admin" : "Make admin"}
                  </button>
                  <button onClick={() => deleteUser(u.id)} className="text-gray-600 hover:text-red-400">
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Create user modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-sm">
            <h3 className="text-base font-semibold text-gray-100 mb-4">Add User</h3>
            <form onSubmit={createUser} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Username</label>
                <input value={newUser.username} onChange={(e) => setNewUser((u) => ({ ...u, username: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Password</label>
                <input type="password" value={newUser.password} onChange={(e) => setNewUser((u) => ({ ...u, password: e.target.value }))} className={inputCls} />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newUser.isAdmin}
                  onChange={(e) => setNewUser((u) => ({ ...u, isAdmin: e.target.checked }))}
                  className="rounded"
                />
                Grant admin privileges
              </label>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex gap-2 pt-1">
                <button type="submit" className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-md">Create</button>
                <button type="button" onClick={() => setShowCreate(false)} className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-md">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Change password modal */}
      {pwdTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-sm">
            <h3 className="text-base font-semibold text-gray-100 mb-4">Change Password — {pwdTarget.username}</h3>
            <form onSubmit={changePassword} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">New Password</label>
                <input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} className={inputCls} autoFocus />
              </div>
              {pwdError && <p className="text-xs text-red-400">{pwdError}</p>}
              <div className="flex gap-2 pt-1">
                <button type="submit" className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-md">Save</button>
                <button type="button" onClick={() => setPwdTarget(null)} className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-md">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
