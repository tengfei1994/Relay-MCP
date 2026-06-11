import { useState, useEffect } from "react";
import { Plus, Folder, Trash2, ChevronRight, File, Server, Link2, Unlink, Settings } from "lucide-react";
import { api } from "../api/client";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [files, setFiles] = useState<any[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [error, setError] = useState("");

  // Server association
  const [showServers, setShowServers] = useState(false);
  const [linkedServers, setLinkedServers] = useState<any[]>([]);
  const [allServers, setAllServers] = useState<any[]>([]);
  const [linkForm, setLinkForm] = useState({ serverId: "", remotePath: "", environment: "production" });
  const [linkError, setLinkError] = useState("");

  useEffect(() => {
    api.listProjects().then((r) => setProjects(r.projects));
    api.listServers().then((r) => setAllServers(r.servers));
  }, []);

  const openProject = async (project: any) => {
    setSelected(project);
    setCurrentPath("");
    setShowServers(false);
    const r = await api.listFiles(project.id, "");
    setFiles(r.entries);
  };

  const openDir = async (name: string) => {
    const newPath = currentPath ? `${currentPath}/${name}` : name;
    setCurrentPath(newPath);
    const r = await api.listFiles(selected.id, newPath);
    setFiles(r.entries);
  };

  const goUp = async () => {
    const parts = currentPath.split("/");
    parts.pop();
    const newPath = parts.join("/");
    setCurrentPath(newPath);
    const r = await api.listFiles(selected.id, newPath);
    setFiles(r.entries);
  };

  const createProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const r = await api.createProject(newName, newDesc);
      setProjects((p) => [...p, r.project]);
      setShowCreate(false);
      setNewName("");
      setNewDesc("");
    } catch (err: any) {
      setError(err.message);
    }
  };

  const deleteProject = async (id: number) => {
    if (!confirm("Delete this project?")) return;
    await api.deleteProject(id);
    setProjects((p) => p.filter((proj) => proj.id !== id));
    if (selected?.id === id) setSelected(null);
  };

  const openServerPanel = async (project: any) => {
    setSelected(project);
    setShowServers(true);
    setLinkError("");
    setLinkForm({ serverId: "", remotePath: "", environment: "production" });
    const r = await api.listProjectServers(project.id);
    setLinkedServers(r.servers);
  };

  const linkServer = async (e: React.FormEvent) => {
    e.preventDefault();
    setLinkError("");
    if (!linkForm.serverId || !linkForm.remotePath) {
      setLinkError("Select a server and enter remote path");
      return;
    }
    try {
      await api.linkServer(selected.id, Number(linkForm.serverId), linkForm.remotePath, linkForm.environment);
      const r = await api.listProjectServers(selected.id);
      setLinkedServers(r.servers);
      setLinkForm({ serverId: "", remotePath: "", environment: "production" });
    } catch (err: any) {
      setLinkError(err.message);
    }
  };

  const unlinkServer = async (linkId: number) => {
    await api.unlinkServer(selected.id, linkId);
    setLinkedServers((s) => s.filter((l) => l.id !== linkId));
  };

  const inputCls = "w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500";

  return (
    <div className="flex h-full">
      {/* Project list */}
      <div className="w-64 border-r border-gray-800 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-medium text-gray-300">Projects</h2>
          <button onClick={() => setShowCreate(true)} className="text-gray-400 hover:text-indigo-400 transition-colors">
            <Plus size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {projects.map((p) => (
            <div
              key={p.id}
              onClick={() => openProject(p)}
              className={`group flex items-center justify-between px-3 py-2 rounded-md cursor-pointer text-sm transition-colors ${
                selected?.id === p.id && !showServers
                  ? "bg-indigo-600 text-white"
                  : "text-gray-400 hover:bg-gray-800"
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Folder size={14} className="shrink-0" />
                <span className="truncate">{p.name}</span>
              </div>
              <div className="hidden group-hover:flex items-center gap-1">
                <button
                  onClick={(e) => { e.stopPropagation(); openServerPanel(p); }}
                  className="text-gray-500 hover:text-indigo-400"
                  title="Manage servers"
                >
                  <Settings size={13} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteProject(p.id); }}
                  className="text-gray-500 hover:text-red-400"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
          {projects.length === 0 && (
            <p className="text-xs text-gray-600 px-3 py-2">No projects yet</p>
          )}
        </div>

        {showCreate && (
          <div className="border-t border-gray-800 p-3">
            <form onSubmit={createProject} className="space-y-2">
              <input autoFocus placeholder="Name (a-z, 0-9, -_)" value={newName}
                onChange={(e) => setNewName(e.target.value)} className={inputCls} />
              <input placeholder="Description (optional)" value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)} className={inputCls} />
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex gap-2">
                <button type="submit" className="flex-1 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded">Create</button>
                <button type="button" onClick={() => setShowCreate(false)} className="flex-1 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded">Cancel</button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* Main panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            Select a project to browse files
          </div>
        ) : showServers ? (
          /* Server association panel */
          <div className="flex-1 overflow-y-auto p-6 max-w-2xl">
            <div className="flex items-center gap-2 mb-6">
              <Server size={16} className="text-indigo-400" />
              <h3 className="text-base font-semibold text-gray-100">Servers — {selected.name}</h3>
              <button onClick={() => setShowServers(false)} className="ml-auto text-xs text-gray-500 hover:text-gray-300">
                ← Back to files
              </button>
            </div>

            {/* Linked servers */}
            <div className="space-y-2 mb-6">
              {linkedServers.length === 0 && (
                <p className="text-xs text-gray-600">No servers linked yet.</p>
              )}
              {linkedServers.map((l) => (
                <div key={l.id} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Link2 size={14} className="text-indigo-400" />
                    <div>
                      <p className="text-sm font-medium text-gray-200">{l.serverName}</p>
                      <p className="text-xs text-gray-500">{l.serverSshUser}@{l.serverHost}:{l.serverPort} · env: {l.environment}</p>
                      <p className="text-xs text-gray-600">path: {l.remotePath}</p>
                    </div>
                  </div>
                  <button onClick={() => unlinkServer(l.id)} className="text-gray-600 hover:text-red-400" title="Unlink">
                    <Unlink size={14} />
                  </button>
                </div>
              ))}
            </div>

            {/* Link form */}
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <h4 className="text-xs font-medium text-gray-400 mb-3">Link a Server</h4>
              <form onSubmit={linkServer} className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Server</label>
                  <select
                    value={linkForm.serverId}
                    onChange={(e) => setLinkForm((f) => ({ ...f, serverId: e.target.value }))}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="">Select server…</option>
                    {allServers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name} ({s.host})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Remote Path</label>
                  <input
                    placeholder="/opt/myapp"
                    value={linkForm.remotePath}
                    onChange={(e) => setLinkForm((f) => ({ ...f, remotePath: e.target.value }))}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Environment</label>
                  <input
                    placeholder="production"
                    value={linkForm.environment}
                    onChange={(e) => setLinkForm((f) => ({ ...f, environment: e.target.value }))}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                {linkError && <p className="text-xs text-red-400">{linkError}</p>}
                <button type="submit" className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-md">
                  Link Server
                </button>
              </form>
            </div>
          </div>
        ) : (
          /* File browser */
          <>
            <div className="flex items-center gap-1 px-4 py-3 border-b border-gray-800 text-xs text-gray-500">
              <button onClick={() => openProject(selected)} className="hover:text-gray-300">{selected.name}</button>
              {currentPath.split("/").filter(Boolean).map((part, i, arr) => (
                <span key={i} className="flex items-center gap-1">
                  <ChevronRight size={11} />
                  <span className={i === arr.length - 1 ? "text-gray-300" : ""}>{part}</span>
                </span>
              ))}
              <button onClick={() => openServerPanel(selected)} className="ml-auto flex items-center gap-1 text-gray-600 hover:text-indigo-400" title="Manage servers">
                <Server size={12} /> Servers
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {currentPath && (
                <button onClick={goUp} className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-500 mb-1">
                  ..
                </button>
              )}
              {files.map((f) => (
                <div
                  key={f.name}
                  onClick={() => f.type === "directory" && openDir(f.name)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-colors ${
                    f.type === "directory"
                      ? "cursor-pointer hover:bg-gray-800 text-gray-300"
                      : "text-gray-500 cursor-default"
                  }`}
                >
                  {f.type === "directory" ? (
                    <Folder size={14} className="text-indigo-400 shrink-0" />
                  ) : (
                    <File size={14} className="shrink-0" />
                  )}
                  <span>{f.name}</span>
                  {f.type === "file" && (
                    <span className="ml-auto text-xs text-gray-600">
                      {f.size ? `${(f.size / 1024).toFixed(1)}KB` : ""}
                    </span>
                  )}
                </div>
              ))}
              {files.length === 0 && <p className="text-xs text-gray-600 px-3">Empty directory</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
