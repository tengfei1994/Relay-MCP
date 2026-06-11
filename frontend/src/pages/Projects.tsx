import { useState, useEffect } from "react";
import { Plus, Folder, Trash2, ChevronRight, File } from "lucide-react";
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

  useEffect(() => {
    api.listProjects().then((r) => setProjects(r.projects));
  }, []);

  const openProject = async (project: any) => {
    setSelected(project);
    setCurrentPath("");
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

  return (
    <div className="flex h-full">
      {/* Project list */}
      <div className="w-64 border-r border-gray-800 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-medium text-gray-300">Projects</h2>
          <button
            onClick={() => setShowCreate(true)}
            className="text-gray-400 hover:text-indigo-400 transition-colors"
          >
            <Plus size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {projects.map((p) => (
            <div
              key={p.id}
              onClick={() => openProject(p)}
              className={`group flex items-center justify-between px-3 py-2 rounded-md cursor-pointer text-sm transition-colors ${
                selected?.id === p.id
                  ? "bg-indigo-600 text-white"
                  : "text-gray-400 hover:bg-gray-800"
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Folder size={14} className="shrink-0" />
                <span className="truncate">{p.name}</span>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); deleteProject(p.id); }}
                className="hidden group-hover:block text-gray-500 hover:text-red-400"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {projects.length === 0 && (
            <p className="text-xs text-gray-600 px-3 py-2">No projects yet</p>
          )}
        </div>

        {/* Create form */}
        {showCreate && (
          <div className="border-t border-gray-800 p-3">
            <form onSubmit={createProject} className="space-y-2">
              <input
                autoFocus
                placeholder="Name (a-z, 0-9, -_)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <input
                placeholder="Description (optional)"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex gap-2">
                <button type="submit" className="flex-1 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded">
                  Create
                </button>
                <button type="button" onClick={() => setShowCreate(false)} className="flex-1 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* File browser */}
      <div className="flex-1 flex flex-col">
        {selected ? (
          <>
            {/* Path breadcrumb */}
            <div className="flex items-center gap-1 px-4 py-3 border-b border-gray-800 text-xs text-gray-500">
              <button onClick={() => openProject(selected)} className="hover:text-gray-300">
                {selected.name}
              </button>
              {currentPath.split("/").filter(Boolean).map((part, i, arr) => (
                <span key={i} className="flex items-center gap-1">
                  <ChevronRight size={11} />
                  <span className={i === arr.length - 1 ? "text-gray-300" : ""}>{part}</span>
                </span>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {currentPath && (
                <button
                  onClick={goUp}
                  className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-500 mb-1"
                >
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
              {files.length === 0 && (
                <p className="text-xs text-gray-600 px-3">Empty directory</p>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            Select a project to browse files
          </div>
        )}
      </div>
    </div>
  );
}
