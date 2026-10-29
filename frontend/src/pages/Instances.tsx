import { useEffect, useState } from "react";
import { AlertTriangle, Boxes, Check, Database, Pencil, RefreshCw, Server, Trash2, Wrench } from "lucide-react";
import { api } from "../api/client";
import { Button, ConfirmDialog, Drawer, EmptyState, Field, Input, Select, StatusPill, Textarea, useToast } from "../components/ui";

type ServiceRecord = {
  name: string;
  displayName?: string;
  state?: string;
  startMode?: string;
  pathName?: string;
};

type BuildProfile = {
  kind?: string;
  selectedPath?: string;
  targetFramework?: string;
  candidates?: unknown[];
};

type DatabaseProbe = {
  status?: string;
  tableCount?: number;
  sampleManagerTableCount?: number;
};

type InstanceRecord = {
  id: number;
  serverId: number;
  name: string;
  version?: string;
  runtimeKind: string;
  status?: string;
  rootPath: string;
  exePath?: string;
  formsPath?: string;
  formsBinPath?: string;
  solutionAssembliesPath?: string;
  logfilePath?: string;
  dataPath?: string;
  databaseHost?: string;
  databaseName?: string;
  databaseAuthType?: string;
  databaseConfigSource?: string;
  services?: ServiceRecord[];
  buildProfile?: BuildProfile;
};

type CandidateRecord = Omit<InstanceRecord, "id" | "serverId"> & {
  confidence?: number;
  warnings?: string[];
  databaseProbe?: DatabaseProbe;
};

type ServerRecord = {
  id: number;
  name: string;
  os?: string;
};

type EditForm = InstanceRecord & {
  serviceNames: string;
  buildKind: string;
  buildPath: string;
  targetFramework: string;
};

function runtimeLabel(value: string) {
  if (value === "framework") return ".NET Framework";
  if (value === "dotnet") return ".NET";
  return "Unknown";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}
function field(value: object, key: string): unknown {
  return key in value ? (value as Record<string, unknown>)[key] : undefined;
}

function present<T>(value: T | null): value is T {
  return value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function serviceFrom(value: unknown): ServiceRecord | null {
  if (typeof value !== "object" || value === null || typeof field(value, "name") !== "string") return null;
  return {
    name: field(value, "name") as string,
    displayName: optionalString(field(value, "displayName")),
    state: optionalString(field(value, "state")),
    startMode: optionalString(field(value, "startMode")),
    pathName: optionalString(field(value, "pathName")),
  };
}

function buildProfileFrom(value: unknown): BuildProfile | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidates = field(value, "candidates");
  return {
    kind: optionalString(field(value, "kind")),
    selectedPath: optionalString(field(value, "selectedPath")),
    targetFramework: optionalString(field(value, "targetFramework")),
    candidates: Array.isArray(candidates) ? candidates : undefined,
  };
}

function databaseProbeFrom(value: unknown): DatabaseProbe | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tableCount = field(value, "tableCount");
  const sampleManagerTableCount = field(value, "sampleManagerTableCount");
  return {
    status: optionalString(field(value, "status")),
    tableCount: typeof tableCount === "number" ? tableCount : undefined,
    sampleManagerTableCount: typeof sampleManagerTableCount === "number" ? sampleManagerTableCount : undefined,
  };
}

function candidateFrom(value: unknown): CandidateRecord | null {
  if (typeof value !== "object" || value === null || typeof field(value, "name") !== "string" || typeof field(value, "runtimeKind") !== "string" || typeof field(value, "rootPath") !== "string") return null;
  const services = field(value, "services");
  const warnings = field(value, "warnings");
  const confidence = field(value, "confidence");
  return {
    name: field(value, "name") as string,
    version: optionalString(field(value, "version")),
    runtimeKind: field(value, "runtimeKind") as string,
    status: optionalString(field(value, "status")),
    rootPath: field(value, "rootPath") as string,
    exePath: optionalString(field(value, "exePath")),
    formsPath: optionalString(field(value, "formsPath")),
    formsBinPath: optionalString(field(value, "formsBinPath")),
    solutionAssembliesPath: optionalString(field(value, "solutionAssembliesPath")),
    logfilePath: optionalString(field(value, "logfilePath")),
    dataPath: optionalString(field(value, "dataPath")),
    databaseHost: optionalString(field(value, "databaseHost")),
    databaseName: optionalString(field(value, "databaseName")),
    databaseAuthType: optionalString(field(value, "databaseAuthType")),
    databaseConfigSource: optionalString(field(value, "databaseConfigSource")),
    services: Array.isArray(services) ? services.map(serviceFrom).filter(present) : undefined,
    buildProfile: buildProfileFrom(field(value, "buildProfile")),
    confidence: typeof confidence === "number" ? confidence : undefined,
    warnings: Array.isArray(warnings) ? warnings.filter((warning): warning is string => typeof warning === "string") : undefined,
    databaseProbe: databaseProbeFrom(field(value, "databaseProbe")),
  };
}

function instanceFrom(value: unknown): InstanceRecord | null {
  if (typeof value !== "object" || value === null || typeof field(value, "id") !== "number" || typeof field(value, "serverId") !== "number") return null;
  const details = candidateFrom(value);
  return details ? { ...details, id: field(value, "id") as number, serverId: field(value, "serverId") as number } : null;
}

function serverFrom(value: unknown): ServerRecord | null {
  if (typeof value !== "object" || value === null || typeof field(value, "id") !== "number" || typeof field(value, "name") !== "string") return null;
  return { id: field(value, "id") as number, name: field(value, "name") as string, os: optionalString(field(value, "os")) };
}

function instancesFrom(value: unknown): InstanceRecord[] {
  const items = typeof value === "object" && value !== null ? field(value, "instances") : undefined;
  return Array.isArray(items) ? items.map(instanceFrom).filter(present) : [];
}

function candidatesFrom(value: unknown): CandidateRecord[] {
  const items = typeof value === "object" && value !== null ? field(value, "instances") : undefined;
  return Array.isArray(items) ? items.map(candidateFrom).filter(present) : [];
}

function serversFrom(value: unknown): ServerRecord[] {
  const items = typeof value === "object" && value !== null ? field(value, "servers") : undefined;
  return Array.isArray(items) ? items.map(serverFrom).filter(present) : [];
}

export default function InstancesPage() {
  const toast = useToast();
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [serverId, setServerId] = useState("");
  const [instances, setInstances] = useState<InstanceRecord[]>([]);
  const [candidates, setCandidates] = useState<CandidateRecord[]>([]);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [editing, setEditing] = useState<InstanceRecord | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [rootHint, setRootHint] = useState("");
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<InstanceRecord | null>(null);
  const selectedServer = servers.find((server) => String(server.id) === serverId);

  useEffect(() => {
    api.listServers().then((result) => {
      const nextServers = serversFrom(result);
      setServers(nextServers);
      const firstWindows = nextServers.find((server) => server.os === "windows");
      if (firstWindows) setServerId(String(firstWindows.id));
    }).catch((reason: unknown) => setError(errorMessage(reason)));
  }, []);

  useEffect(() => {
    if (!serverId) {
      setInstances([]);
      return;
    }
    api.listInstances(Number(serverId))
      .then((result) => setInstances(instancesFrom(result)))
      .catch((reason: unknown) => setError(errorMessage(reason)));
    setCandidates([]);
  }, [serverId]);

  const scan = async () => {
    setError("");
    setScanning(true);
    try {
      const result = await api.discoverInstances(Number(serverId), rootHint.trim() ? [rootHint.trim()] : []);
      const found = candidatesFrom(result);
      setCandidates(found);
      if (found.length === 0) setError("No SampleManager instances were detected.");
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    } finally {
      setScanning(false);
    }
  };

  const importCandidate = async (candidate: CandidateRecord) => {
    setSaving(candidate.rootPath);
    setError("");
    try {
      await api.saveInstance(Number(serverId), candidate);
      const result = await api.listInstances(Number(serverId));
      setInstances(instancesFrom(result));
      setCandidates((items) => items.filter((item) => item.rootPath !== candidate.rootPath));
      toast.success("Instance imported.");
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    } finally {
      setSaving(null);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteInstance(deleteTarget.id);
      setInstances((items) => items.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
      toast.success("Instance deleted.");
    } catch (reason: unknown) {
      throw new Error(errorMessage(reason));
    }
  };

  const openEdit = (instance: InstanceRecord) => {
    setEditing(instance);
    setEditForm({
      ...instance,
      serviceNames: instance.services?.map((service) => service.name).join("\n") ?? "",
      buildKind: instance.buildProfile?.kind ?? "unknown",
      buildPath: instance.buildProfile?.selectedPath ?? "",
      targetFramework: instance.buildProfile?.targetFramework ?? "",
    });
    setError("");
  };

  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing || !editForm) return;
    setError("");
    try {
      const serviceNames = editForm.serviceNames.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
      const services = serviceNames.map((name) => editForm.services?.find((service) => service.name === name) ?? {
        name, displayName: "", state: "", startMode: "", pathName: "",
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
      const instance = instanceFrom(typeof result === "object" && result !== null && "instance" in result ? result.instance : null);
      if (!instance) throw new Error("The server returned an invalid instance.");
      setInstances((items) => items.map((item) => item.id === editing.id ? instance : item));
      setEditing(null);
      setEditForm(null);
      toast.success("Instance saved.");
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    }
  };

  const editablePaths: Array<[string, "rootPath" | "exePath" | "formsPath" | "formsBinPath" | "solutionAssembliesPath" | "logfilePath" | "dataPath"]> = [
    ["Root path", "rootPath"], ["Exe path", "exePath"], ["Forms path", "formsPath"], ["FormsBin path", "formsBinPath"],
    ["SolutionAssemblies path", "solutionAssembliesPath"], ["Log path", "logfilePath"], ["Data path", "dataPath"],
  ];

  return (
    <div className="mx-auto max-w-[1280px] px-5 py-8 sm:px-8">
      <header className="mb-7 flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="font-display text-[30px] font-semibold leading-tight tracking-[-.02em] text-fg">Instances</h1>
          <p className="mt-2 max-w-[68ch] text-sm text-muted">Discover and maintain SampleManager instance paths, services and database targets.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Windows server"><Select value={serverId} onChange={(event) => setServerId(event.target.value)} className="min-w-52"><option value="">Select a Windows server</option>{servers.filter((server) => server.os === "windows").map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</Select></Field>
          <Field label="Root hint"><Input value={rootHint} onChange={(event) => setRootHint(event.target.value)} placeholder="Optional custom root" className="w-52" /></Field>
          <Button onClick={scan} disabled={!serverId || scanning} loading={scanning} variant="accent"><RefreshCw size={15} /> {scanning ? "Scanning" : "Scan"}</Button>
        </div>
      </header>

      {error && <div className="mb-5 rounded-[10px] border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-coral" role="alert">{error}</div>}

      {candidates.length > 0 && (
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between"><h2 className="font-display text-[22px] font-semibold text-fg">Discovered candidates</h2><span className="font-mono text-[13px] text-muted">{candidates.length} results</span></div>
          <div className="glass divide-y divide-white/[.09]">
            {candidates.map((candidate) => (
              <div key={candidate.rootPath} className="flex items-start gap-4 px-4 py-4 sm:px-5">
                <Boxes size={18} className="mt-1 shrink-0 text-sun" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-fg">{candidate.name}</span><span className="text-sm text-muted">{candidate.version || "Version unknown"}</span><StatusPill status={runtimeLabel(candidate.runtimeKind)} />{typeof candidate.confidence === "number" && <span className="font-mono text-[12px] text-muted">{candidate.confidence}% confidence</span>}</div>
                  <p className="mt-1 truncate font-mono text-[13px] text-muted">{candidate.rootPath}</p>
                  <p className="mt-2 text-[13px] text-muted">{candidate.services?.length ?? 0} services, database {candidate.databaseName ? `${candidate.databaseHost || "?"}\\${candidate.databaseName}` : "not detected"}, builder {candidate.buildProfile?.kind || "unknown"}</p>
                  {candidate.databaseConfigSource && <p className="mt-1 truncate text-[13px] text-muted" title={candidate.databaseConfigSource}>Connection evidence: {candidate.databaseConfigSource}</p>}
                  {candidate.databaseProbe?.status === "verified" && <p className="mt-1 text-[13px] text-mint">Schema verified: {candidate.databaseProbe.tableCount} tables, {candidate.databaseProbe.sampleManagerTableCount ?? 0} SampleManager core tables</p>}
                  {(candidate.warnings?.length ?? 0) > 0 && <div className="mt-2 flex items-start gap-1 text-[13px] text-sun"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{candidate.warnings?.join(", ")}</span></div>}
                </div>
                <Button onClick={() => importCandidate(candidate)} disabled={saving === candidate.rootPath} loading={saving === candidate.rootPath} variant="ghost"><Check size={14} /> Import</Button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between"><div><h2 className="font-display text-[22px] font-semibold text-fg">Confirmed instances</h2><p className="mt-1 text-sm text-muted">{selectedServer ? `Configured on ${selectedServer.name}` : "Select a Windows server to view instances"}</p></div><span className="font-mono text-[13px] text-muted">{instances.length} results</span></div>
        <div className="glass divide-y divide-white/[.09]">
          {instances.map((instance) => (
            <div key={instance.id} className="px-4 py-4 sm:px-5">
              <div className="flex items-start gap-4">
                <Boxes size={18} className="mt-1 shrink-0 text-iris" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-fg">{instance.name}</span><span className="text-sm text-muted">{instance.version || "Version unknown"}</span><StatusPill status={runtimeLabel(instance.runtimeKind)} /><StatusPill status={instance.status || "unknown"} /></div>
                  <p className="mt-1 truncate font-mono text-[13px] text-muted">{instance.rootPath}</p>
                  <div className="mt-4 grid gap-4 sm:grid-cols-3">
                    <div className="flex items-start gap-2"><Server size={14} className="mt-0.5 text-muted" /><div><p className="text-[13px] text-muted">Services</p><p className="text-[13px] text-fg">{instance.services?.map((service) => service.name).join(", ") || "None configured"}</p></div></div>
                    <div className="flex items-start gap-2"><Database size={14} className="mt-0.5 text-muted" /><div><p className="text-[13px] text-muted">{instance.databaseName || "Database not configured"}</p><p className="text-[13px] text-fg">{instance.databaseHost || instance.databaseAuthType || "No target"}</p>{instance.databaseConfigSource && <p className="max-w-64 truncate text-[12px] text-muted" title={instance.databaseConfigSource}>{instance.databaseConfigSource}</p>}</div></div>
                    <div className="flex items-start gap-2"><Wrench size={14} className="mt-0.5 text-muted" /><div><p className="text-[13px] text-muted">{instance.buildProfile?.kind || "Builder unknown"}</p><p className="max-w-64 truncate text-[13px] text-fg">{instance.buildProfile?.selectedPath || "No tool selected"}</p></div></div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1"><Button onClick={() => openEdit(instance)} variant="ghost" aria-label={`Edit ${instance.name}`}><Pencil size={15} /></Button><Button onClick={() => setDeleteTarget(instance)} variant="ghost" aria-label={`Delete ${instance.name}`}><Trash2 size={15} /></Button></div>
              </div>
            </div>
          ))}
          {instances.length === 0 && <EmptyState title="No instances configured" description="Select a Windows server and scan for SampleManager instances." />}
        </div>
      </section>

      {editing && editForm && (
        <Drawer open onClose={() => { setEditing(null); setEditForm(null); }} title={`Edit instance, ${editing.name}`}>
          <form onSubmit={saveEdit} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3"><Field label="Name"><Input value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} /></Field><Field label="Version"><Input value={editForm.version ?? ""} onChange={(event) => setEditForm({ ...editForm, version: event.target.value })} /></Field><Field label="Runtime"><Select value={editForm.runtimeKind} onChange={(event) => setEditForm({ ...editForm, runtimeKind: event.target.value })}><option value="framework">.NET Framework</option><option value="dotnet">.NET</option><option value="unknown">Unknown</option></Select></Field></div>
            {editablePaths.map(([label, key]) => <Field key={key} label={label}><Input value={editForm[key] ?? ""} onChange={(event) => setEditForm({ ...editForm, [key]: event.target.value })} /></Field>)}
            <div className="grid gap-3 sm:grid-cols-2"><Field label="Database server"><Input value={editForm.databaseHost ?? ""} onChange={(event) => setEditForm({ ...editForm, databaseHost: event.target.value })} /></Field><Field label="Database name"><Input value={editForm.databaseName ?? ""} onChange={(event) => setEditForm({ ...editForm, databaseName: event.target.value })} /></Field></div>
            <Field label="Services in start order"><Textarea rows={4} value={editForm.serviceNames} onChange={(event) => setEditForm({ ...editForm, serviceNames: event.target.value })} className="font-mono" /></Field>
            <div className="grid gap-3 sm:grid-cols-3"><Field label="Build tool"><Select value={editForm.buildKind} onChange={(event) => setEditForm({ ...editForm, buildKind: event.target.value })}><option value="msbuild">MSBuild</option><option value="dotnet">dotnet</option><option value="unknown">Unknown</option></Select></Field><Field label="Tool path" className="sm:col-span-2"><Input value={editForm.buildPath} onChange={(event) => setEditForm({ ...editForm, buildPath: event.target.value })} /></Field></div>
            <Field label="Target framework"><Input value={editForm.targetFramework} onChange={(event) => setEditForm({ ...editForm, targetFramework: event.target.value })} placeholder="Optional, for example net48 or net8.0" /></Field>
            <div className="flex justify-end gap-2 pt-2"><Button type="button" variant="ghost" onClick={() => { setEditing(null); setEditForm(null); }}>Cancel</Button><Button type="submit" variant="primary">Save instance</Button></div>
          </form>
        </Drawer>
      )}
      <ConfirmDialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="Delete instance" description={`Delete LIMS instance '${deleteTarget?.name ?? ""}' from Relay configuration?`} confirmLabel="Delete instance" tone="danger" onConfirm={remove} />
    </div>
  );
}
