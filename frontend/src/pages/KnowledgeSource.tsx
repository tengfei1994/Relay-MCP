import { useEffect, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { api } from "../api/client";
import { Badge, cardClass, inputClass, PageShell, StatePanel } from "../components/KnowledgePrimitives";

export default function KnowledgeSource() {
  const [sets, setSets] = useState<any[]>([]);
  const [baselines, setBaselines] = useState<any[]>([]);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [baselineId, setBaselineId] = useState("");
  const [oldId, setOldId] = useState("");
  const [newId, setNewId] = useState("");
  const [snapshotId, setSnapshotId] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [changes, setChanges] = useState<any[]>([]);
  const [files, setFiles] = useState<any[]>([]);
  const [filePage, setFilePage] = useState({ limit: 100, offset: 0, total: 0 });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [solution, setSolution] = useState("");
  const [snapshotSource, setSnapshotSource] = useState("");
  const [snapshotName, setSnapshotName] = useState("");
  const [snapshotProject, setSnapshotProject] = useState("");
  const [snapshotVersion, setSnapshotVersion] = useState("");

  const load = async () => {
    try {
      const [artifactResult, baselineResult, snapshotResult] = await Promise.all([api.knowledgeArtifactSets(), api.knowledgeSourceBaselines(), api.knowledgeProjectSnapshots()]);
      setSets(artifactResult.sets ?? []);
      setBaselines(baselineResult.baselines ?? []);
      setSnapshots(snapshotResult.snapshots ?? []);
      setBaselineId((current) => current || baselineResult.baselines?.[0]?.id || "");
      setOldId((current) => current || baselineResult.baselines?.[0]?.id || "");
      setNewId((current) => current || baselineResult.baselines?.[1]?.id || baselineResult.baselines?.[0]?.id || "");
      setSnapshotId((current) => current || snapshotResult.snapshots?.[0]?.id || "");
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load source control data"); }
  };
  useEffect(() => { void load(); }, []);

  const importSet = async () => {
    if (!source || !name || !version) { setError("Solution source, name, and version are required."); return; }
    setError("");
    try {
      const job = await api.knowledgeArtifactImport({ source, name, version, solution: solution || undefined, kind: "solution" });
      if (job.id) for (let i = 0; i < 120; i++) {
        const state = await api.knowledgeIngestJob(job.id);
        if (["succeeded", "failed"].includes(state.job?.status)) {
          if (state.job.status === "failed") throw new Error(state.job.error ?? "Artifact import failed");
          break;
        }
        const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, 500); await promise;
      }
      setSource(""); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Artifact import failed"); }
  };
  const importSnapshot = async () => {
    if (!snapshotSource || !snapshotName) { setError("Snapshot source and name are required."); return; }
    try {
      const result = await api.knowledgeProjectSnapshot({ source: snapshotSource, name: snapshotName, projectId: snapshotProject || undefined, version: snapshotVersion || undefined });
      setSnapshotSource(""); setSnapshotName(""); await load(); setSnapshotId(result.snapshotId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Project snapshot import failed"); }
  };
  const publish = async () => {
    const baseline = baselines.find((item) => item.id === baselineId);
    if (!baseline) return;
    try { await api.knowledgeArtifactPublish(baseline.artifact_set_id); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Publish failed"); }
  };
  const compare = async () => {
    if (!oldId || !snapshotId || !newId) return;
    try { const result = await api.knowledgeUpgradeCompare({ oldBaselineId: oldId, projectSnapshotId: snapshotId, newBaselineId: newId }); setChanges(result.changes ?? []); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "Upgrade comparison failed"); }
  };
  const search = async () => {
    if (!baselineId || !query.trim()) return;
    setLoading(true); setError("");
    try { const result = await api.knowledgeSourceSearch({ query, baselineId }); setResults(result.results ?? []); } catch (cause) { setError(cause instanceof Error ? cause.message : "Source search failed"); } finally { setLoading(false); }
  };
  const loadFiles = async (offset = 0) => {
    if (!baselineId) return;
    try { const result = await api.knowledgeSourceBaselineFiles(baselineId, filePage.limit, offset); setFiles(result.files ?? []); setFilePage({ limit: result.page.limit, offset: result.page.offset, total: result.page.total }); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load source files"); }
  };

  return <PageShell title="Solution Knowledge" description="Reference baselines, project snapshots, source evidence, and three-way upgrade analysis.">
    {error && <StatePanel state="error" message={error} />}
    <div className="grid gap-4 xl:grid-cols-2">
      <section className={cardClass}>
        <div className="flex items-center justify-between"><h3 className="font-medium text-gray-100">Solution baseline</h3><button onClick={() => void load()} className="rounded border border-gray-700 p-2 text-gray-400" aria-label="Refresh source control"><RefreshCw size={14} /></button></div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2"><input className={inputClass} placeholder="Server directory or ZIP" value={source} onChange={(event) => setSource(event.target.value)} /><input className={inputClass} placeholder="Artifact name" value={name} onChange={(event) => setName(event.target.value)} /><input className={inputClass} placeholder="Solution" value={solution} onChange={(event) => setSolution(event.target.value)} /><input className={inputClass} placeholder="Version (required)" value={version} onChange={(event) => setVersion(event.target.value)} /></div>
        <button onClick={() => void importSet()} className="mt-3 rounded bg-cyan-700 px-3 py-2 text-xs text-white">Import baseline asynchronously</button>
        <label className="mt-4 block text-xs text-gray-400">Published or staged baseline<select className={`${inputClass} mt-1`} value={baselineId} onChange={(event) => { setBaselineId(event.target.value); setFiles([]); }}>{baselines.map((baseline) => <option key={baseline.id} value={baseline.id}>{baseline.solution} {baseline.version} · {baseline.status}</option>)}</select></label>
        <div className="mt-2 flex gap-2"><button onClick={() => void publish()} className="rounded border border-gray-700 px-3 py-2 text-xs text-gray-200">Publish selected</button><button onClick={() => void loadFiles(0)} className="rounded border border-gray-700 px-3 py-2 text-xs text-gray-200">Load files</button></div>
        <p className="mt-3 text-xs text-gray-500">{sets.length} artifact sets retained; publication is explicit and audited.</p>
      </section>

      <section className={cardClass}>
        <h3 className="font-medium text-gray-100">Project snapshot</h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2"><input className={inputClass} placeholder="Server directory or ZIP" value={snapshotSource} onChange={(event) => setSnapshotSource(event.target.value)} /><input className={inputClass} placeholder="Snapshot name" value={snapshotName} onChange={(event) => setSnapshotName(event.target.value)} /><input className={inputClass} placeholder="Project ID (optional)" value={snapshotProject} onChange={(event) => setSnapshotProject(event.target.value)} /><input className={inputClass} placeholder="Version (optional)" value={snapshotVersion} onChange={(event) => setSnapshotVersion(event.target.value)} /></div>
        <button onClick={() => void importSnapshot()} className="mt-3 rounded bg-cyan-700 px-3 py-2 text-xs text-white">Import project snapshot</button>
        <label className="mt-4 block text-xs text-gray-400">Current project snapshot<select className={`${inputClass} mt-1`} value={snapshotId} onChange={(event) => setSnapshotId(event.target.value)}>{snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.name} {snapshot.version ?? ""} · {snapshot.file_count} files</option>)}</select></label>
      </section>
    </div>

    <section className={cardClass}>
      <h3 className="font-medium text-gray-100">Three-way upgrade comparison</h3>
      <div className="mt-3 grid gap-2 md:grid-cols-3"><label className="text-xs text-gray-400">Old baseline<select className={`${inputClass} mt-1`} value={oldId} onChange={(event) => setOldId(event.target.value)}>{baselines.map((baseline) => <option key={baseline.id} value={baseline.id}>{baseline.solution} {baseline.version}</option>)}</select></label><label className="text-xs text-gray-400">Project snapshot<select className={`${inputClass} mt-1`} value={snapshotId} onChange={(event) => setSnapshotId(event.target.value)}>{snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>)}</select></label><label className="text-xs text-gray-400">New baseline<select className={`${inputClass} mt-1`} value={newId} onChange={(event) => setNewId(event.target.value)}>{baselines.map((baseline) => <option key={baseline.id} value={baseline.id}>{baseline.solution} {baseline.version}</option>)}</select></label></div>
      <button onClick={() => void compare()} className="mt-3 rounded bg-cyan-700 px-3 py-2 text-xs text-white">Compare upgrade</button>
      <div className="mt-3 space-y-2">{changes.map((change) => <div key={change.path} className="rounded border border-gray-800 p-2 text-xs"><div className="flex justify-between gap-3"><span className="break-all text-gray-300">{change.path}</span><Badge tone={change.potentialConflict ? "rose" : "blue"}>{change.status}</Badge></div><div className="mt-1 grid gap-1 text-gray-500 md:grid-cols-3">{(["old", "project", "next"] as const).map((side) => <span key={side}>{side} Evidence: <span className="break-all text-gray-400">{change.evidenceRefs?.[side] ?? "—"}</span></span>)}</div></div>)}</div>
    </section>

    <div className="grid gap-4 xl:grid-cols-2">
      <section className={cardClass}><h3 className="font-medium text-gray-100">Source search</h3><div className="mt-3 flex gap-2"><input className={inputClass} placeholder="FTS query" value={query} onChange={(event) => setQuery(event.target.value)} /><button onClick={() => void search()} className="rounded bg-cyan-700 px-3 text-white" aria-label="Search source"><Search size={14} /></button></div>{loading ? <StatePanel state="loading" message="Searching source chunks…" /> : <div className="mt-3 space-y-2">{results.map((result) => <div key={result.id} className="rounded border border-gray-800 p-2 text-xs"><p className="text-gray-200">{result.relative_path} · {result.symbol ?? "file"}</p><p className="text-gray-500">Lines {result.line_start}–{result.line_end}</p></div>)}</div>}</section>
      <section className={cardClass}><div className="flex items-center justify-between"><h3 className="font-medium text-gray-100">Source files</h3><span className="text-xs text-gray-500">{filePage.total} total</span></div><div className="mt-3 max-h-80 space-y-1 overflow-auto">{files.map((file) => <div key={file.id} className="rounded border border-gray-800 p-2 text-xs"><p className="break-all text-gray-300">{file.path}</p><p className="break-all text-gray-600">Evidence {file.id} · SHA-256 {file.sha256}</p></div>)}</div><div className="mt-3 flex items-center gap-2 text-xs"><button disabled={filePage.offset === 0} onClick={() => void loadFiles(Math.max(0, filePage.offset - filePage.limit))} className="rounded border border-gray-700 px-2 py-1 disabled:opacity-40">Previous</button><span className="text-gray-500">{filePage.total ? `${filePage.offset + 1}–${Math.min(filePage.offset + filePage.limit, filePage.total)}` : "0"}</span><button disabled={filePage.offset + filePage.limit >= filePage.total} onClick={() => void loadFiles(filePage.offset + filePage.limit)} className="rounded border border-gray-700 px-2 py-1 disabled:opacity-40">Next</button></div></section>
    </div>
  </PageShell>;
}
