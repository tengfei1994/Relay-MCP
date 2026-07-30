import { useEffect, useState } from "react";
import { Boxes, Database, RefreshCw, Server, Trash2, Wrench, Check, AlertTriangle, Pencil } from "lucide-react";
import { api } from "../api/client";

function runtimeLabel(value: string) {
  if (value === "framework") return ".NET Framework";
  if (value === "dotnet") return ".NET";
  return "Unknown";
}

export default function InstancesPage() {
  const [servers, setServers] = useState<any[]>([]);
  const [serverId, setServerId] = useState("");
  const [instances, setInstances] = useState<any[]>([]);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [editing, setEditing] = useState<any | null>(null);
  const [editForm, setEditForm] = useState<any | null>(null);
  const [rootHint, setRootHint] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.listServers().then((result) => {
      setServers(result.servers);
      const firstWindows = result.servers.find((server) => server.os === "windows");
      if (firstWindows) setServerId(String(firstWindows.id));
    });
  }, []);

  useEffect(() => {
    if (!serverId) {
      setInstances([]);
      return;
    }
    api.listInstances(Number(serverId)).then((result) => setInstances(result.instances));
    setCandidates([]);
  }, [serverId]);

  const scan = async () => {
    setError("");
    setScanning(true);
    try {
      const result = await api.discoverInstances(
        Number(serverId),
        rootHint.trim() ? [rootHint.trim()] : []
      );
      setCandidates(result.instances);
      if (result.instances.length === 0) setError("No SampleManager instances were detected.");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  };

  const importCandidate = async (candidate: any) => {
    setSaving(candidate.rootPath);
    setError("");
    try {
      await api.saveInstance(Number(serverId), candidate);
      const result = await api.listInstances(Number(serverId));
      setInstances(result.instances);
      setCandidates((items) => items.filter((item) => item.rootPath !== candidate.rootPath));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(null);
    }
  };

  const remove = async (instance: any) => {
    if (!confirm(`Delete LIMS instance '${instance.name}' from Relay configuration?`)) return;
    await api.deleteInstance(instance.id);
    setInstances((items) => items.filter((item) => item.id !== instance.id));
  };

  const openEdit = (instance: any) => {
    setEditing(instance);
    setEditForm({
      ...instance,
      serviceNames: instance.services?.map((service: any) => service.name).join("\n") ?? "",
      buildKind: instance.buildProfile?.kind ?? "unknown",
      buildPath: instance.buildProfile?.selectedPath ?? "",
      targetFramework: instance.buildProfile?.targetFramework ?? "",
    });
    setError("");
  };

  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const serviceNames = String(editForm.serviceNames ?? "").split(/\r?\n|,/)
        .map((value) => value.trim()).filter(Boolean);
      const services = serviceNames.map((name) => {
        const existing = editForm.services?.find((service: any) => service.name === name);
        return existing ?? { name, displayName: "", state: "", startMode: "", pathName: "" };
      });
      const payload = {
        ...editForm,
        services,
        buildProfile: {
          ...(editForm.buildProfile ?? {}),
          kind: editForm.buildKind,
          selectedPath: editForm.buildPath || undefined,
          targetFramework: editForm.targetFramework || undefined,
          candidates: editForm.buildProfile?.candidates ?? [],
        },
      };
      const result = await api.updateInstance(editing.id, payload);
      setInstances((items) => items.map((item) => item.id === editing.id ? result.instance : item));
      setEditing(null);
      setEditForm(null);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const inputCls = "px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500";

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">LIMS Instances</h2>
          <p className="text-xs text-gray-500 mt-1">Instance paths, services, database targets and build profiles.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={serverId} onChange={(event) => setServerId(event.target.value)} className={inputCls}>
            <option value="">Select Windows server</option>
            {servers.filter((server) => server.os === "windows").map((server) => (
              <option key={server.id} value={server.id}>{server.name}</option>
            ))}
          </select>
          <input
            value={rootHint}
            onChange={(event) => setRootHint(event.target.value)}
            placeholder="Optional custom instance root"
            className={`${inputCls} w-64`}
          />
          <button
            onClick={scan}
            disabled={!serverId || scanning}
            className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm rounded-md"
          >
            <RefreshCw size={14} className={scanning ? "animate-spin" : ""} />
            {scanning ? "Scanning" : "Scan"}
          </button>
        </div>
      </div>

      {error && <div className="mb-4 px-3 py-2 border border-red-900 bg-red-950/40 text-red-300 text-xs rounded-md">{error}</div>}

      {candidates.length > 0 && (
        <section className="mb-7">
          <h3 className="text-xs font-medium uppercase text-gray-500 mb-2">Discovered candidates</h3>
          <div className="border border-gray-800 divide-y divide-gray-800 rounded-lg overflow-hidden">
            {candidates.map((candidate) => (
              <div key={candidate.rootPath} className="bg-gray-900 px-4 py-3 flex items-start gap-4">
                <Boxes size={17} className="text-yellow-400 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-100">{candidate.name}</span>
                    <span className="text-xs text-gray-500">{candidate.version || "version unknown"}</span>
                    <span className="text-xs text-indigo-400">{runtimeLabel(candidate.runtimeKind)}</span>
                    <span className="text-xs text-gray-600">{candidate.confidence}% confidence</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1 truncate">{candidate.rootPath}</p>
                  <p className="text-xs text-gray-600 mt-1">
                    {candidate.services?.length ?? 0} services · database {candidate.databaseName ? `${candidate.databaseHost || "?"}\\${candidate.databaseName}` : "not detected"} · builder {candidate.buildProfile?.kind || "unknown"}
                  </p>
                  {candidate.databaseConfigSource && (
                    <p className="text-xs text-gray-600 mt-1 truncate" title={candidate.databaseConfigSource}>
                      Connection evidence: {candidate.databaseConfigSource}
                    </p>
                  )}
                  {candidate.databaseProbe?.status === "verified" && (
                    <p className="text-xs text-green-500 mt-1">
                      Schema verified: {candidate.databaseProbe.tableCount} tables · {candidate.databaseProbe.sampleManagerTableCount ?? 0} SampleManager core tables
                    </p>
                  )}
                  {(candidate.warnings?.length ?? 0) > 0 && (
                    <div className="flex items-start gap-1 mt-2 text-xs text-yellow-500">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      <span>{candidate.warnings.join(" · ")}</span>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => importCandidate(candidate)}
                  disabled={saving === candidate.rootPath}
                  className="flex items-center gap-1 px-2.5 py-1.5 border border-gray-700 hover:border-indigo-500 text-indigo-300 text-xs rounded-md disabled:opacity-40"
                >
                  <Check size={13} />
                  Import
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="text-xs font-medium uppercase text-gray-500 mb-2">Confirmed instances</h3>
        <div className="border border-gray-800 divide-y divide-gray-800 rounded-lg overflow-hidden">
          {instances.map((instance) => (
            <div key={instance.id} className="bg-gray-900 px-4 py-4">
              <div className="flex items-start gap-4">
                <Boxes size={17} className="text-indigo-400 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-100">{instance.name}</span>
                    <span className="text-xs text-gray-500">{instance.version || "version unknown"}</span>
                    <span className="text-xs text-indigo-400">{runtimeLabel(instance.runtimeKind)}</span>
                    <span className={`text-xs ${instance.status === "ready" ? "text-green-400" : "text-yellow-400"}`}>{instance.status}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{instance.rootPath}</p>
                  <div className="grid grid-cols-3 gap-4 mt-3">
                    <div className="flex items-start gap-2">
                      <Server size={13} className="text-gray-600 mt-0.5" />
                      <div>
                        <p className="text-xs text-gray-400">Services</p>
                        <p className="text-xs text-gray-600">{instance.services?.map((service: any) => service.name).join(", ") || "None configured"}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Database size={13} className="text-gray-600 mt-0.5" />
                      <div>
                        <p className="text-xs text-gray-400">{instance.databaseName || "Database not configured"}</p>
                        <p className="text-xs text-gray-600">{instance.databaseHost || instance.databaseAuthType}</p>
                        {instance.databaseConfigSource && (
                          <p className="text-xs text-gray-700 truncate max-w-64" title={instance.databaseConfigSource}>
                            {instance.databaseConfigSource}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Wrench size={13} className="text-gray-600 mt-0.5" />
                      <div>
                        <p className="text-xs text-gray-400">{instance.buildProfile?.kind || "Builder unknown"}</p>
                        <p className="text-xs text-gray-600 truncate max-w-64">{instance.buildProfile?.selectedPath || "No tool selected"}</p>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => openEdit(instance)} className="text-gray-600 hover:text-indigo-400" title="Edit instance">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => remove(instance)} className="text-gray-600 hover:text-red-400" title="Delete instance">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
          {instances.length === 0 && (
            <div className="bg-gray-900 px-4 py-8 text-center text-sm text-gray-600">
              Select a Windows server and scan for SampleManager instances.
            </div>
          )}
        </div>
      </section>

      {editing && editForm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-full overflow-y-auto">
            <div className="px-5 py-4 border-b border-gray-800">
              <h3 className="text-sm font-semibold text-gray-100">Edit LIMS Instance</h3>
              <p className="text-xs text-gray-500 mt-1">{editing.name} on {servers.find((server) => server.id === editing.serverId)?.name}</p>
            </div>
            <form onSubmit={saveEdit} className="p-5 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <label className="text-xs text-gray-500">
                  Name
                  <input value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} className={`${inputCls} w-full mt-1`} />
                </label>
                <label className="text-xs text-gray-500">
                  Version
                  <input value={editForm.version} onChange={(event) => setEditForm({ ...editForm, version: event.target.value })} className={`${inputCls} w-full mt-1`} />
                </label>
                <label className="text-xs text-gray-500">
                  Runtime
                  <select value={editForm.runtimeKind} onChange={(event) => setEditForm({ ...editForm, runtimeKind: event.target.value })} className={`${inputCls} w-full mt-1`}>
                    <option value="framework">.NET Framework</option>
                    <option value="dotnet">.NET</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </label>
              </div>

              {[
                ["Root path", "rootPath"],
                ["Exe path", "exePath"],
                ["Forms path", "formsPath"],
                ["FormsBin path", "formsBinPath"],
                ["SolutionAssemblies path", "solutionAssembliesPath"],
                ["Log path", "logfilePath"],
                ["Data path", "dataPath"],
              ].map(([label, key]) => (
                <label key={key} className="block text-xs text-gray-500">
                  {label}
                  <input value={editForm[key] ?? ""} onChange={(event) => setEditForm({ ...editForm, [key]: event.target.value })} className={`${inputCls} w-full mt-1`} />
                </label>
              ))}

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-gray-500">
                  Database server
                  <input value={editForm.databaseHost ?? ""} onChange={(event) => setEditForm({ ...editForm, databaseHost: event.target.value })} className={`${inputCls} w-full mt-1`} />
                </label>
                <label className="text-xs text-gray-500">
                  Database name
                  <input value={editForm.databaseName ?? ""} onChange={(event) => setEditForm({ ...editForm, databaseName: event.target.value })} className={`${inputCls} w-full mt-1`} />
                </label>
              </div>

              <label className="block text-xs text-gray-500">
                Services in start order
                <textarea
                  rows={4}
                  value={editForm.serviceNames}
                  onChange={(event) => setEditForm({ ...editForm, serviceNames: event.target.value })}
                  className={`${inputCls} w-full mt-1 font-mono`}
                />
              </label>

              <div className="grid grid-cols-3 gap-3">
                <label className="text-xs text-gray-500">
                  Build tool
                  <select value={editForm.buildKind} onChange={(event) => setEditForm({ ...editForm, buildKind: event.target.value })} className={`${inputCls} w-full mt-1`}>
                    <option value="msbuild">MSBuild</option>
                    <option value="dotnet">dotnet</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </label>
                <label className="text-xs text-gray-500 col-span-2">
                  Tool path
                  <input value={editForm.buildPath} onChange={(event) => setEditForm({ ...editForm, buildPath: event.target.value })} className={`${inputCls} w-full mt-1`} />
                </label>
              </div>
              <label className="block text-xs text-gray-500">
                Target framework
                <input value={editForm.targetFramework} onChange={(event) => setEditForm({ ...editForm, targetFramework: event.target.value })} placeholder="Optional, e.g. net48 or net8.0" className={`${inputCls} w-full mt-1`} />
              </label>

              <div className="flex gap-2 pt-2">
                <button type="submit" className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-md">Save instance</button>
                <button type="button" onClick={() => { setEditing(null); setEditForm(null); }} className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-md">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
