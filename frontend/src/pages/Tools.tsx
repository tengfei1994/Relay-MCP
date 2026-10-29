import { useEffect, useMemo, useState } from "react";
import { BookOpen, CheckCircle2, ChevronRight, CircleAlert, Filter, Search, TerminalSquare, X } from "lucide-react";
import { api } from "../api/client";
import { Badge, EmptyState, ErrorState, Skeleton } from "../components/ui";

type Tool = {
  name: string;
  category: string;
  description: string;
  access: "read-only" | "mutation";
  execution: "remote-capable" | "local-service";
  lifecycle: "preferred" | "standard" | "legacy";
  entity?: string;
  capability?: string;
};

type Inspector = {
  id: string;
  label: string;
  status: "ready" | "planned" | "unavailable";
  readOnly: boolean;
  description: string;
  plannedTool?: string;
  relatedEntities?: string[];
  evidenceKinds: string[];
};

type SampleManagerEntity = {
  id: string;
  label: string;
  description: string;
  inspectors: Inspector[];
};

type Category = {
  id: string;
  label: string;
};

type Selection =
  | { kind: "tool"; tool: Tool }
  | { kind: "inspector"; entity: SampleManagerEntity; inspector: Inspector };

const categoryOrder = ["project", "remote-execution", "playwright", "remote-files", "workspace", "jobs", "context", "samplemanager"];
const categoryLabels: Record<string, string> = {
  project: "Project",
  "remote-execution": "Remote execution",
  playwright: "Playwright",
  "remote-files": "Remote files",
  workspace: "Workspace",
  jobs: "Jobs",
  context: "Context",
  samplemanager: "SampleManager",
};

const badgeTone: Record<string, "mint" | "sun" | "coral" | "neutral"> = {
  "read-only": "mint",
  mutation: "sun",
  "remote-capable": "mint",
  "local-service": "neutral",
  preferred: "mint",
  standard: "neutral",
  legacy: "coral",
  ready: "mint",
  planned: "sun",
  unavailable: "neutral",
};

function CatalogBadge({ children }: { children: string }) {
  return <Badge tone={badgeTone[children] ?? "neutral"}>{children}</Badge>;
}

export default function ToolsPage() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [sampleManagerEntities, setSampleManagerEntities] = useState<SampleManagerEntity[]>([]);
  const [category, setCategory] = useState("all");
  const [entity, setEntity] = useState("all");
  const [access, setAccess] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api.listTools()
      .then((result) => {
        const nextTools = result.tools as Tool[];
        setTools(nextTools);
        setCategories(result.categories as Category[]);
        setSampleManagerEntities((result.sampleManagerEntities ?? []) as SampleManagerEntity[]);
        setSelected(nextTools[0] ? { kind: "tool", tool: nextTools[0] } : null);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to load tools"))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tools.filter((tool) => {
      const matchesCategory = category === "all" || tool.category === category;
      const matchesEntity = entity === "all" || tool.category !== "samplemanager" || tool.entity === entity;
      const matchesAccess = access === "all" || tool.access === access;
      const matchesQuery = !needle || `${tool.name} ${tool.description} ${tool.category} ${tool.entity ?? ""} ${tool.capability ?? ""}`.toLowerCase().includes(needle);
      return matchesCategory && matchesEntity && matchesAccess && matchesQuery;
    });
  }, [tools, category, entity, access, query]);

  const visibleEntities = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sampleManagerEntities
      .filter((item) => entity === "all" || item.id === entity)
      .map((item) => ({
        ...item,
        inspectors: item.inspectors.filter((inspector) => !needle || `${item.label} ${item.description} ${inspector.label} ${inspector.description} ${inspector.id}`.toLowerCase().includes(needle)),
      }))
      .filter((item) => item.inspectors.length > 0);
  }, [sampleManagerEntities, entity, query]);

  const grouped = useMemo(() => categoryOrder
    .map((id) => ({ id, tools: filtered.filter((tool) => tool.category === id) }))
    .filter((group) => group.tools.length > 0), [filtered]);

  return (
    <div className="mx-auto max-w-[1440px] px-5 py-8 sm:px-8">
      <header className="mb-7">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-mint/30 bg-mint/10 text-mint"><TerminalSquare size={20} /></div>
            <div><h1 className="font-display text-[30px] font-semibold leading-tight tracking-[-.02em] text-fg">Tools</h1><p className="mt-2 text-sm text-muted">Browse the Relay MCP command catalog and inspect capabilities.</p></div>
          </div>
          <div className="font-mono text-[13px] text-muted">{tools.length} commands, {filtered.length} shown</div>
        </div>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <label className="relative min-w-[280px] flex-1"><Search size={15} className="pointer-events-none absolute left-3 top-3 text-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search command name or description" className="h-10 w-full rounded-[10px] border border-white/10 bg-white/[.04] pl-9 pr-9 text-sm text-fg outline-none placeholder:text-muted focus:border-mint" />{query && <button onClick={() => setQuery("")} className="absolute right-2 top-2 rounded p-1 text-muted hover:bg-white/[.08] hover:text-fg" aria-label="Clear search"><X size={15} /></button>}</label>
          <div className="flex h-10 items-center rounded-[10px] border border-white/10 bg-white/[.04] p-1"><Filter size={14} className="mx-2 text-muted" />{["all", "read-only", "mutation"].map((value) => <button key={value} onClick={() => setAccess(value)} className={`rounded-[8px] px-3 py-1.5 text-xs transition ${access === value ? "bg-white/[.12] text-fg" : "text-muted hover:text-fg"}`}>{value === "all" ? "All access" : value === "read-only" ? "Read-only" : "Mutation"}</button>)}</div>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)_330px]">
        <aside className="glass p-4">
          <p className="mb-3 px-2 text-sm font-medium text-muted">Categories</p>
          <button onClick={() => setCategory("all")} className={`flex min-h-10 w-full items-center justify-between rounded-[8px] px-3 text-sm ${category === "all" ? "bg-mint/10 text-mint" : "text-muted hover:bg-white/[.06] hover:text-fg"}`}><span>All commands</span><span className="font-mono text-[12px]">{tools.length}</span></button>
          <div className="mt-2 space-y-1">{categories.map((item) => { const count = tools.filter((tool) => tool.category === item.id).length; return <button key={item.id} onClick={() => { setCategory(item.id); if (item.id !== "samplemanager") setEntity("all"); }} className={`flex min-h-10 w-full items-center justify-between rounded-[8px] px-3 text-left text-sm ${category === item.id ? "bg-mint/10 text-mint" : "text-muted hover:bg-white/[.06] hover:text-fg"}`}><span>{item.label}</span><span className="font-mono text-[12px]">{count}</span></button>; })}</div>
          {category === "samplemanager" && <div className="mt-7 border-t border-white/[.09] pt-5"><p className="mb-3 px-2 text-sm font-medium text-muted">Entities</p><button onClick={() => setEntity("all")} className={`flex min-h-10 w-full items-center justify-between rounded-[8px] px-3 text-sm ${entity === "all" ? "bg-iris/10 text-iris" : "text-muted hover:bg-white/[.06] hover:text-fg"}`}><span>All entities</span><span className="font-mono text-[12px]">{sampleManagerEntities.length}</span></button><div className="mt-2 space-y-1">{sampleManagerEntities.map((item) => <button key={item.id} onClick={() => setEntity(item.id)} className={`flex min-h-10 w-full items-center justify-between rounded-[8px] px-3 text-left text-sm ${entity === item.id ? "bg-iris/10 text-iris" : "text-muted hover:bg-white/[.06] hover:text-fg"}`}><span className="truncate">{item.label}</span><span className="font-mono text-[12px]">{item.inspectors.length}</span></button>)}</div></div>}
          <p className="mt-8 border-t border-white/[.09] px-2 pt-5 text-xs leading-5 text-muted">This directory is generated from the server-side MCP tool catalog.</p>
        </aside>

        <div className="min-w-0">
          {loading && <div className="glass space-y-3 p-5"><Skeleton className="h-5 w-48" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {error && <ErrorState message={error} />}
          {!loading && !error && filtered.length === 0 && <EmptyState title="No commands match" description="Try a broader search or choose a different access filter." />}
          {!loading && !error && category === "samplemanager" && visibleEntities.map((item) => <section key={item.id} className="mb-8"><div className="mb-3"><div className="flex items-center gap-2"><h2 className="font-display text-[22px] font-semibold text-fg">{item.label}</h2><span className="font-mono text-[12px] text-muted">{item.inspectors.length}</span></div><p className="mt-1 text-sm text-muted">{item.description}</p></div><div className="glass divide-y divide-white/[.09]">{item.inspectors.map((inspector) => <button key={`${item.id}.${inspector.id}`} onClick={() => setSelected({ kind: "inspector", entity: item, inspector })} className={`flex min-h-16 w-full items-center gap-4 px-4 py-4 text-left transition hover:bg-white/[.06] ${selected?.kind === "inspector" && selected.entity.id === item.id && selected.inspector.id === inspector.id ? "bg-iris/10" : ""}`}><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-medium text-fg">{inspector.label}</span><CatalogBadge>{inspector.status}</CatalogBadge></div><p className="mt-1 truncate text-sm text-muted">{inspector.description}</p></div>{inspector.plannedTool && <code className="hidden max-w-56 truncate text-[12px] text-muted xl:block">{inspector.plannedTool}</code>}<ChevronRight size={16} className="shrink-0 text-muted" /></button>)}</div></section>)}
          {!loading && !error && grouped.map((group) => <section key={group.id} className="mb-8"><div className="mb-3 flex items-center gap-2"><h2 className="font-display text-[22px] font-semibold text-fg">{categoryLabels[group.id]}</h2><span className="font-mono text-[12px] text-muted">{group.tools.length}</span></div><div className="glass divide-y divide-white/[.09]">{group.tools.map((tool) => <button key={tool.name} onClick={() => setSelected({ kind: "tool", tool })} className={`flex min-h-16 w-full items-center gap-4 px-4 py-4 text-left transition hover:bg-white/[.06] ${selected?.kind === "tool" && selected.tool.name === tool.name ? "bg-mint/10" : ""}`}><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><code className="text-sm font-medium text-fg">{tool.name}</code>{tool.lifecycle !== "standard" && <CatalogBadge>{tool.lifecycle}</CatalogBadge>}</div><p className="mt-1 truncate text-sm text-muted">{tool.description}</p></div><div className="hidden items-center gap-2 md:flex"><CatalogBadge>{tool.access}</CatalogBadge><CatalogBadge>{tool.execution}</CatalogBadge></div><ChevronRight size={16} className="shrink-0 text-muted" /></button>)}</div></section>)}
        </div>

        <aside className="glass min-w-0 p-5">
          {selected?.kind === "tool" ? <><div className="flex items-start justify-between gap-3"><div><p className="text-sm text-mint">{categoryLabels[selected.tool.category]}</p><h2 className="mt-2 break-all font-mono text-sm font-medium leading-6 text-fg">{selected.tool.name}</h2></div><BookOpen size={17} className="mt-1 shrink-0 text-muted" /></div><p className="mt-6 text-sm leading-6 text-muted">{selected.tool.description}</p><div className="mt-6 space-y-3 border-t border-white/[.09] pt-5">{selected.tool.entity && <div className="flex items-center justify-between text-xs"><span className="text-muted">Entity</span><span className="text-fg">{sampleManagerEntities.find((item) => item.id === selected.tool.entity)?.label ?? selected.tool.entity}</span></div>}{selected.tool.capability && <div className="flex items-center justify-between text-xs"><span className="text-muted">Capability</span><span className="text-fg">{selected.tool.capability.replace(/_/g, " ")}</span></div>}<div className="flex items-center justify-between text-xs"><span className="text-muted">Access</span><CatalogBadge>{selected.tool.access}</CatalogBadge></div><div className="flex items-center justify-between text-xs"><span className="text-muted">Execution</span><CatalogBadge>{selected.tool.execution}</CatalogBadge></div><div className="flex items-center justify-between text-xs"><span className="text-muted">Lifecycle</span><CatalogBadge>{selected.tool.lifecycle}</CatalogBadge></div></div><div className="mt-7 rounded-[10px] border border-white/[.09] bg-white/[.03] p-4">{selected.tool.access === "mutation" ? <div className="flex gap-3"><CircleAlert size={16} className="mt-0.5 shrink-0 text-sun" /><p className="text-xs leading-5 text-muted">This command can change remote state. Use a deploymentId, verify the target, and prefer async execution for long operations.</p></div> : <div className="flex gap-3"><CheckCircle2 size={16} className="mt-0.5 shrink-0 text-mint" /><p className="text-xs leading-5 text-muted">This command is classified as read-only by the Relay catalog.</p></div>}</div></> : selected?.kind === "inspector" ? <><div className="flex items-start justify-between gap-3"><div><p className="text-sm text-iris">{selected.entity.label}</p><h2 className="mt-2 text-sm font-medium leading-6 text-fg">{selected.inspector.label}</h2></div><BookOpen size={17} className="mt-1 shrink-0 text-muted" /></div><p className="mt-6 text-sm leading-6 text-muted">{selected.inspector.description}</p><div className="mt-6 space-y-3 border-t border-white/[.09] pt-5"><div className="flex items-center justify-between text-xs"><span className="text-muted">Status</span><CatalogBadge>{selected.inspector.status}</CatalogBadge></div><div className="flex items-center justify-between text-xs"><span className="text-muted">Access</span><CatalogBadge>{selected.inspector.readOnly ? "read-only" : "mutation"}</CatalogBadge></div>{selected.inspector.plannedTool && <div className="text-xs"><p className="text-muted">MCP tool</p><code className="mt-2 block break-all text-fg">{selected.inspector.plannedTool}</code></div>}</div>{selected.inspector.relatedEntities && selected.inspector.relatedEntities.length > 0 && <div className="mt-6"><p className="text-sm text-muted">Related entities</p><div className="mt-2 flex flex-wrap gap-2">{selected.inspector.relatedEntities.map((value) => <span key={value} className="rounded-[8px] border border-white/[.09] bg-white/[.03] px-2 py-1 text-xs text-muted">{sampleManagerEntities.find((item) => item.id === value)?.label ?? value}</span>)}</div></div>}<div className="mt-6"><p className="text-sm text-muted">Evidence</p><div className="mt-2 flex flex-wrap gap-2">{selected.inspector.evidenceKinds.map((value) => <span key={value} className="rounded-[8px] border border-white/[.09] bg-white/[.03] px-2 py-1 text-xs text-muted">{value}</span>)}</div></div><div className="mt-7 rounded-[10px] border border-white/[.09] bg-white/[.03] p-4"><div className="flex gap-3">{selected.inspector.status === "ready" ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-mint" /> : <CircleAlert size={16} className="mt-0.5 shrink-0 text-iris" />}<p className="text-xs leading-5 text-muted">{selected.inspector.status === "ready" ? "This inspector is available through the listed MCP tool." : "This inspector is part of the Capability Pack roadmap and is not yet callable."}</p></div></div></> : <div className="py-12 text-center text-sm text-muted">Select a command to inspect it.</div>}
        </aside>
      </div>
    </div>
  );
}
