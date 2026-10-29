import { useEffect, useState } from "react";
import { Search, RefreshCw } from "lucide-react";
import { api } from "../api/client";
import { PageHeader, Drawer, ConfirmDialog, Button, StatusPill } from "../components/ui";

type SourceItem = Record<string, unknown>;
type PageInfo = { limit: number; offset: number; total: number };
type SourceResponse = { files?: SourceItem[]; page: PageInfo };
type Change = SourceItem & { evidenceRefs?: Record<string, unknown>; symbols?: SourceItem[] };
const text = (value: unknown, fallback = "") => typeof value === "string" ? value : value == null ? fallback : String(value);
const number = (value: unknown, fallback = 0) => typeof value === "number" ? value : Number(value) || fallback;

export default function KnowledgeSource() {
  const [sets, setSets] = useState<SourceItem[]>([]);
  const [baselines, setBaselines] = useState<SourceItem[]>([]);
  const [snapshots, setSnapshots] = useState<SourceItem[]>([]);
  const [baselineId, setBaselineId] = useState("");
  const [oldId, setOldId] = useState("");
  const [newId, setNewId] = useState("");
  const [snapshotId, setSnapshotId] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SourceItem[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [files, setFiles] = useState<SourceItem[]>([]);
  const [filePage, setFilePage] = useState<PageInfo>({ limit: 100, offset: 0, total: 0 });
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
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [drawer, setDrawer] = useState<"baseline" | "snapshot" | "compare" | "search" | "files" | null>(null);

  const load = async () => {
    try {
      const [artifactResult, baselineResult, snapshotResult] = await Promise.all([api.knowledgeArtifactSets(), api.knowledgeSourceBaselines(), api.knowledgeProjectSnapshots()]);
      const artifactSets = (artifactResult.sets ?? []) as SourceItem[];
      const baselineRows = (baselineResult.baselines ?? []) as SourceItem[];
      const snapshotRows = (snapshotResult.snapshots ?? []) as SourceItem[];
      setSets(artifactSets); setBaselines(baselineRows); setSnapshots(snapshotRows);
      setBaselineId((current) => current || text(baselineRows[0]?.id));
      setOldId((current) => current || text(baselineRows[0]?.id));
      setNewId((current) => current || text(baselineRows[1]?.id) || text(baselineRows[0]?.id));
      setSnapshotId((current) => current || text(snapshotRows[0]?.id));
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load source control data"); }
  };
  useEffect(() => { void load(); }, []);

  const importSet = async () => {
    if (!source || !name || !version) { setError("Solution source, name, and version are required."); return; }
    setError("");
    try {
      const job = await api.knowledgeArtifactImport({ source, name, version, solution: solution || undefined, kind: "solution" }) as { id?: string };
      if (job.id) for (let i = 0; i < 120; i++) {
        const state = await api.knowledgeIngestJob(job.id) as { job?: { status?: string; error?: string } };
        if (["succeeded", "failed"].includes(text(state.job?.status))) {
          if (state.job?.status === "failed") throw new Error(state.job.error ?? "Artifact import failed");
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
      setSource(""); setName(""); setVersion(""); setSolution(""); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Artifact import failed"); }
  };
  const importSnapshot = async () => {
    if (!snapshotSource || !snapshotName) { setError("Snapshot source and name are required."); return; }
    try {
      const result = await api.knowledgeProjectSnapshot({ source: snapshotSource, name: snapshotName, projectId: snapshotProject || undefined, version: snapshotVersion || undefined }) as { snapshotId?: string };
      setSnapshotSource(""); setSnapshotName(""); await load(); setSnapshotId(result.snapshotId ?? "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Project snapshot import failed"); }
  };
  const publish = async () => {
    const baseline = baselines.find((item) => text(item.id) === baselineId);
    if (!baseline) return;
    try { await api.knowledgeArtifactPublish(text(baseline.artifact_set_id)); await load(); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "Publish failed"); }
  };
  const compare = async () => {
    if (!oldId || !snapshotId || !newId) return;
    try { const result = await api.knowledgeUpgradeCompare({ oldBaselineId: oldId, projectSnapshotId: snapshotId, newBaselineId: newId }) as { changes?: Change[] }; setChanges(result.changes ?? []); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "Upgrade comparison failed"); }
  };
  const search = async () => {
    if (!baselineId || !query.trim()) return;
    setLoading(true); setError("");
    try { const result = await api.knowledgeSourceSearch({ query, baselineId }) as { results?: SourceItem[] }; setResults(result.results ?? []); } catch (cause) { setError(cause instanceof Error ? cause.message : "Source search failed"); } finally { setLoading(false); }
  };
  const loadFiles = async (offset = 0) => {
    if (!baselineId) return;
    try { const result = await api.knowledgeSourceBaselineFiles(baselineId, filePage.limit, offset) as SourceResponse; setFiles(result.files ?? []); setFilePage(result.page); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load source files"); }
  };

  return <div className="mx-auto max-w-[1280px] px-5 py-8 sm:px-8">
    <PageHeader title="Solutions" description="Solution artifacts and their sources." actions={<Button onClick={() => void load()} variant="ghost"><RefreshCw size={15} /> Refresh</Button>} />
    {error && <p role="alert" className="mb-4 rounded-panel border border-coral/40 bg-coral/10 p-3 text-sm text-coral">{error}</p>}
    <div className="mb-4 flex flex-wrap gap-2" aria-label="Solution sections">
      {(["baseline", "snapshot", "compare", "search", "files"] as const).map((name) => <Button key={name} variant={drawer === name ? "accent" : "ghost"} onClick={() => setDrawer(name)}>{name === "baseline" ? "Solution baseline" : name === "snapshot" ? "Project snapshot" : name === "compare" ? "Compare upgrades" : name === "search" ? "Search sources" : "Source files"}</Button>)}
    </div>
    <section className="glass p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-display text-xl font-semibold">Solution baselines</h2><p className="mt-1 text-sm text-muted">{sets.length} artifact sets retained. Publication is explicit and audited.</p></div><StatusPill status={baselines.length ? "ready" : "empty"} /></div>
      <div className="mt-4 flex flex-wrap gap-2"><Button variant="ghost" onClick={() => setConfirmPublish(true)} disabled={!baselineId}>Publish selected baseline</Button><Button variant="ghost" onClick={() => { setDrawer("files"); void loadFiles(0); }} disabled={!baselineId}>Load source files</Button></div>
      <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-white/10 text-muted"><th className="px-3 py-2">Solution</th><th className="px-3 py-2">Version</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Actions</th></tr></thead><tbody>{baselines.map((item) => <tr key={text(item.id)} className="border-b border-white/5"><td className="px-3 py-3">{text(item.solution, "Unassigned")}</td><td className="px-3 py-3 font-mono text-xs">{text(item.version)}</td><td className="px-3 py-3"><StatusPill status={text(item.status)} /></td><td className="px-3 py-3"><Button variant="ghost" onClick={() => { setBaselineId(text(item.id)); setFiles([]); setDrawer("files"); void loadFiles(0); }}>View files</Button></td></tr>)}</tbody></table>{!baselines.length && <p className="p-6 text-center text-sm text-muted">Import a baseline to start managing solution sources.</p>}</div>
    </section>
    <Drawer open={drawer !== null} onClose={() => setDrawer(null)} title={drawer === "baseline" ? "Import solution baseline" : drawer === "snapshot" ? "Import project snapshot" : drawer === "compare" ? "Compare upgrades" : drawer === "search" ? "Search sources" : "Source files"}>
      {drawer === "baseline" && <div className="space-y-3"><input className="field w-full" placeholder="Server directory or ZIP" value={source} onChange={(event) => setSource(event.target.value)} /><input className="field w-full" placeholder="Artifact name" value={name} onChange={(event) => setName(event.target.value)} /><input className="field w-full" placeholder="Solution" value={solution} onChange={(event) => setSolution(event.target.value)} /><input className="field w-full" placeholder="Version (required)" value={version} onChange={(event) => setVersion(event.target.value)} /><Button onClick={() => void importSet()}>Import baseline</Button></div>}
      {drawer === "snapshot" && <div className="space-y-3"><input className="field w-full" placeholder="Server directory or ZIP" value={snapshotSource} onChange={(event) => setSnapshotSource(event.target.value)} /><input className="field w-full" placeholder="Snapshot name" value={snapshotName} onChange={(event) => setSnapshotName(event.target.value)} /><input className="field w-full" placeholder="Project ID (optional)" value={snapshotProject} onChange={(event) => setSnapshotProject(event.target.value)} /><input className="field w-full" placeholder="Version (optional)" value={snapshotVersion} onChange={(event) => setSnapshotVersion(event.target.value)} /><Button onClick={() => void importSnapshot()}>Import project snapshot</Button></div>}
      {drawer === "compare" && <div className="space-y-3"><SelectField label="Old baseline" value={oldId} onChange={setOldId} options={baselines} /><SelectField label="Project snapshot" value={snapshotId} onChange={setSnapshotId} options={snapshots} /><SelectField label="New baseline" value={newId} onChange={setNewId} options={baselines} /><Button onClick={() => void compare()}>Compare upgrade</Button><div className="space-y-2">{changes.map((change) => <div key={text(change.path)} className="rounded-field border border-white/10 p-3 text-xs"><div className="flex justify-between gap-3"><span className="break-all">{text(change.path)}</span><StatusPill status={text(change.status)} /></div><div className="mt-2 grid gap-1 text-muted sm:grid-cols-3">{(["old", "project", "next"] as const).map((side) => <span key={side}>{side}: {text(change.evidenceRefs?.[side], "none")}</span>)}</div><SymbolChanges symbols={change.symbols ?? []} /></div>)}</div></div>}
      {drawer === "search" && <div className="space-y-3"><div className="relative"><Search className="absolute left-3 top-3 text-muted" size={15} /><input className="field w-full pl-9" placeholder="Search source text" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} /></div><Button onClick={() => void search()} disabled={loading}>{loading ? "Searching" : "Search sources"}</Button>{results.map((result) => <div key={text(result.id)} className="rounded-field border border-white/10 p-3 text-xs"><p>{text(result.relative_path)} <span className="text-muted">{text(result.symbol, "file")}</span></p><p className="mt-1 text-muted">Lines {text(result.line_start)} to {text(result.line_end)}</p></div>)}</div>}
      {drawer === "files" && <div><SelectField label="Baseline" value={baselineId} onChange={(value) => { setBaselineId(value); setFiles([]); }} options={baselines} /><Button className="mt-3" variant="ghost" onClick={() => void loadFiles(0)}>Load files</Button><div className="mt-3 space-y-2">{files.map((file) => <div key={text(file.id)} className="rounded-field border border-white/10 p-3 text-xs"><p className="break-all">{text(file.path)}</p><p className="mt-1 break-all text-muted">Evidence {text(file.id)}; SHA-256 {text(file.sha256)}</p></div>)}{!files.length && <p className="py-4 text-sm text-muted">Choose a baseline and load its source files.</p>}</div><div className="mt-3 flex items-center gap-2 text-xs"><Button variant="ghost" disabled={filePage.offset === 0} onClick={() => void loadFiles(Math.max(0, filePage.offset - filePage.limit))}>Previous</Button><span className="text-muted">{filePage.total ? `${filePage.offset + 1} to ${Math.min(filePage.offset + filePage.limit, filePage.total)}` : "0"}</span><Button variant="ghost" disabled={filePage.offset + filePage.limit >= filePage.total} onClick={() => void loadFiles(filePage.offset + filePage.limit)}>Next</Button></div></div>}
    </Drawer>
    <ConfirmDialog open={confirmPublish} onClose={() => setConfirmPublish(false)} title="Publish baseline" description="This action is recorded in the audit log." confirmLabel="Publish baseline" tone="primary" requireReason onConfirm={async () => { setConfirmPublish(false); await publish(); }} />
  </div>;
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: SourceItem[] }) { return <label className="block space-y-1 text-sm text-muted"><span>{label}</span><select className="field w-full" value={value} onChange={(event) => onChange(event.target.value)}><option value="">Select {label.toLowerCase()}</option>{options.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.name) || `${text(item.solution)} ${text(item.version)}`}</option>)}</select></label>; }
function SymbolChanges({ symbols }: { symbols: SourceItem[] }) { if (!symbols.length) return null; return <div className="mt-2 space-y-1 border-t border-white/10 pt-2">{symbols.map((symbol) => <div key={text(symbol.symbol)} className="rounded-field bg-black/20 p-2"><div className="flex items-center justify-between gap-2"><span>{text(symbol.kind)}: {text(symbol.name)}</span><StatusPill status={text(symbol.status)} /></div><div className="mt-1 grid gap-1 text-[11px] text-muted sm:grid-cols-3">{(["old", "project", "next"] as const).map((side) => <span key={side}>{side}: {Array.isArray((symbol.evidenceRefs as unknown)) ? (symbol.evidenceRefs as unknown[]).map(String).join(", ") : text((symbol.evidenceRefs as Record<string, unknown> | undefined)?.[side], "none")}</span>)}</div></div>)}</div>; }
