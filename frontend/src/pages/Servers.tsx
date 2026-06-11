import { useState, useEffect } from "react";
import { Plus, Server, CheckCircle, XCircle, Clock, Copy, Trash2, Key, Pencil } from "lucide-react";
import { api } from "../api/client";

const STATUS_ICON: Record<string, JSX.Element> = {
  connected: <CheckCircle size={13} className="text-green-400" />,
  failed: <XCircle size={13} className="text-red-400" />,
  pending: <Clock size={13} className="text-yellow-400" />,
};

export default function ServersPage() {
  const [servers, setServers] = useState<any[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newServer, setNewServer] = useState({ name: "", host: "", port: "22", sshUser: "root" });
  const [addedKey, setAddedKey] = useState<{ id: number; key: string; instructions: string } | null>(null);
  const [pushPassword, setPushPassword] = useState("");
  const [pushLoading, setPushLoading] = useState(false);
  const [editServer, setEditServer] = useState<any | null>(null);
  const [editForm, setEditForm] = useState({ name: "", host: "", port: "22", sshUser: "" });
  const [error, setError] = useState("");

  useEffect(() => {
    api.listServers().then((r) => setServers(r.servers));
  }, []);

  const addServer = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const r = await api.addServer({
        name: newServer.name,
        host: newServer.host,
        port: Number(newServer.port),
        sshUser: newServer.sshUser,
      });
      setServers((s) => [...s, r.server]);
      setAddedKey({ id: r.server.id, key: r.publicKey, instructions: r.instructions });
      setShowAdd(false);
      setNewServer({ name: "", host: "", port: "22", sshUser: "root" });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const openEdit = (s: any) => {
    setEditServer(s);
    setEditForm({ name: s.name, host: s.host, port: String(s.port ?? 22), sshUser: s.sshUser });
    setError("");
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const r = await api.updateServer(editServer.id, {
        name: editForm.name,
        host: editForm.host,
        port: Number(editForm.port),
        sshUser: editForm.sshUser,
      });
      setServers((s) => s.map((sv) => sv.id === editServer.id ? r.server : sv));
      setEditServer(null);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const testServer = async (id: number) => {
    const r = await api.testServer(id);
    setServers((s) =>
      s.map((sv) => sv.id === id ? { ...sv, status: r.ok ? "connected" : "failed" } : sv)
    );
  };

  const pushKey = async () => {
    if (!addedKey) return;
    setPushLoading(true);
    try {
      const r = await api.pushKey(addedKey.id, pushPassword);
      if (r.ok) {
        await testServer(addedKey.id);
        setAddedKey(null);
        setPushPassword("");
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPushLoading(false);
    }
  };

  const deleteServer = async (id: number) => {
    if (!confirm("Delete this server?")) return;
    await api.deleteServer(id);
    setServers((s) => s.filter((sv) => sv.id !== id));
  };

  const inputCls = "w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500";

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-gray-100">Servers</h2>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-md transition-colors"
        >
          <Plus size={14} />
          Add Server
        </button>
      </div>

      <div className="space-y-3">
        {servers.map((s) => (
          <div key={s.id} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
            <div className="flex items-center gap-3">
              <Server size={16} className="text-gray-500" />
              <div>
                <p className="text-sm font-medium text-gray-200">{s.name}</p>
                <p className="text-xs text-gray-500">{s.sshUser}@{s.host}:{s.port}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 text-xs text-gray-500">
                {STATUS_ICON[s.status] ?? STATUS_ICON.pending}
                {s.status}
              </div>
              <button
                onClick={() => testServer(s.id)}
                className="text-xs text-indigo-400 hover:text-indigo-300 px-2 py-1 border border-gray-700 rounded"
              >
                Test
              </button>
              <button
                onClick={() => openEdit(s)}
                className="text-gray-500 hover:text-indigo-400"
                title="Edit"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => deleteServer(s.id)}
                className="text-gray-600 hover:text-red-400"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
        {servers.length === 0 && (
          <p className="text-sm text-gray-600">No servers added yet.</p>
        )}
      </div>

      {/* Add server modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md">
            <h3 className="text-base font-semibold text-gray-100 mb-4">Add Server</h3>
            <form onSubmit={addServer} className="space-y-3">
              {[
                { label: "Name", key: "name", placeholder: "my-prod-server" },
                { label: "Host", key: "host", placeholder: "192.168.1.100" },
                { label: "Port", key: "port", placeholder: "22" },
                { label: "SSH User", key: "sshUser", placeholder: "root" },
              ].map(({ label, key, placeholder }) => (
                <div key={key}>
                  <label className="block text-xs text-gray-400 mb-1">{label}</label>
                  <input
                    value={(newServer as any)[key]}
                    onChange={(e) => setNewServer((s) => ({ ...s, [key]: e.target.value }))}
                    placeholder={placeholder}
                    className={inputCls}
                  />
                </div>
              ))}
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex gap-2 pt-1">
                <button type="submit" className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-md">
                  Generate SSH Key & Add
                </button>
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-md">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit server modal */}
      {editServer && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md">
            <h3 className="text-base font-semibold text-gray-100 mb-4">Edit Server</h3>
            <form onSubmit={saveEdit} className="space-y-3">
              {[
                { label: "Name", key: "name" },
                { label: "Host", key: "host" },
                { label: "Port", key: "port" },
                { label: "SSH User", key: "sshUser" },
              ].map(({ label, key }) => (
                <div key={key}>
                  <label className="block text-xs text-gray-400 mb-1">{label}</label>
                  <input
                    value={(editForm as any)[key]}
                    onChange={(e) => setEditForm((f) => ({ ...f, [key]: e.target.value }))}
                    className={inputCls}
                  />
                </div>
              ))}
              {error && <p className="text-xs text-red-400">{error}</p>}
              <p className="text-xs text-yellow-500">Changing host/user will reset status to pending.</p>
              <div className="flex gap-2 pt-1">
                <button type="submit" className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-md">
                  Save
                </button>
                <button type="button" onClick={() => { setEditServer(null); setError(""); }} className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-md">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Public key display + push */}
      {addedKey && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg">
            <div className="flex items-center gap-2 mb-3">
              <Key size={16} className="text-indigo-400" />
              <h3 className="text-base font-semibold text-gray-100">SSH Key Generated</h3>
            </div>
            <p className="text-xs text-gray-400 mb-2">Public key — add to server's <code className="text-indigo-300">~/.ssh/authorized_keys</code>:</p>
            <div className="relative">
              <pre className="bg-gray-800 rounded p-3 text-xs text-green-300 break-all whitespace-pre-wrap mb-3">
                {addedKey.key}
              </pre>
              <button
                onClick={() => navigator.clipboard.writeText(addedKey.key)}
                className="absolute top-2 right-2 text-gray-500 hover:text-gray-300"
              >
                <Copy size={13} />
              </button>
            </div>
            <div className="border-t border-gray-700 pt-3 mt-1">
              <p className="text-xs text-gray-400 mb-2">Or auto-push via password (one-time):</p>
              <div className="flex gap-2">
                <input
                  type="password"
                  placeholder="SSH password"
                  value={pushPassword}
                  onChange={(e) => setPushPassword(e.target.value)}
                  className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <button
                  onClick={pushKey}
                  disabled={pushLoading || !pushPassword}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm rounded"
                >
                  {pushLoading ? "Pushing…" : "Push Key"}
                </button>
              </div>
            </div>
            {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
            <button
              onClick={() => { setAddedKey(null); setPushPassword(""); setError(""); }}
              className="mt-4 w-full py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-md"
            >
              Done (I'll add the key manually)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
