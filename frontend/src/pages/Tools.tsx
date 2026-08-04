import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Filter,
  Search,
  TerminalSquare,
  X,
} from "lucide-react";
import { api } from "../api/client";

type Tool = {
  name: string;
  category: string;
  description: string;
  access: "read-only" | "mutation";
  execution: "remote-capable" | "local-service";
  lifecycle: "preferred" | "standard" | "legacy";
};

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

const badgeStyles: Record<string, string> = {
  "read-only": "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  mutation: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  "remote-capable": "border-sky-500/30 bg-sky-500/10 text-sky-300",
  "local-service": "border-gray-700 bg-gray-800/70 text-gray-400",
  preferred: "border-indigo-500/30 bg-indigo-500/10 text-indigo-300",
  standard: "border-gray-700 bg-gray-800/70 text-gray-400",
  legacy: "border-rose-500/30 bg-rose-500/10 text-rose-300",
};

function Badge({ children }: { children: string }) {
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] ${badgeStyles[children] ?? badgeStyles.standard}`}>
      {children}
    </span>
  );
}

export default function ToolsPage() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [category, setCategory] = useState("all");
  const [access, setAccess] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Tool | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api.listTools()
      .then((result) => {
        setTools(result.tools);
        setCategories(result.categories);
        setSelected(result.tools[0] ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load tools"))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tools.filter((tool) => {
      const matchesCategory = category === "all" || tool.category === category;
      const matchesAccess = access === "all" || tool.access === access;
      const matchesQuery = !needle || `${tool.name} ${tool.description} ${tool.category}`.toLowerCase().includes(needle);
      return matchesCategory && matchesAccess && matchesQuery;
    });
  }, [tools, category, access, query]);

  const grouped = useMemo(() => categoryOrder
    .map((id) => ({ id, tools: filtered.filter((tool) => tool.category === id) }))
    .filter((group) => group.tools.length > 0), [filtered]);

  return (
    <div className="min-h-full bg-gray-950">
      <header className="border-b border-gray-800 bg-gray-950/95 px-8 py-7">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
                <TerminalSquare size={20} />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-gray-100">MCP Tools</h1>
                <p className="mt-1 text-sm text-gray-500">Command reference for the Relay MCP surface</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span>{tools.length} commands</span>
            <span className="text-gray-700">·</span>
            <span>{filtered.length} shown</span>
          </div>
        </div>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <label className="relative min-w-[280px] flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-3 text-gray-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search command name or description"
              className="h-10 w-full rounded-md border border-gray-800 bg-gray-900 pl-9 pr-9 text-sm text-gray-200 outline-none transition focus:border-indigo-500"
            />
            {query && (
              <button onClick={() => setQuery("")} className="absolute right-2 top-2 rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-200" aria-label="Clear search">
                <X size={15} />
              </button>
            )}
          </label>
          <div className="flex h-10 items-center rounded-md border border-gray-800 bg-gray-900 p-1">
            <Filter size={14} className="mx-2 text-gray-500" />
            {["all", "read-only", "mutation"].map((value) => (
              <button
                key={value}
                onClick={() => setAccess(value)}
                className={`rounded px-3 py-1.5 text-xs transition ${access === value ? "bg-gray-700 text-gray-100" : "text-gray-500 hover:text-gray-200"}`}
              >
                {value === "all" ? "All access" : value === "read-only" ? "Read-only" : "Mutation"}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-202px)] grid-cols-[220px_minmax(0,1fr)_330px]">
        <aside className="border-r border-gray-800 bg-gray-925 px-4 py-5">
          <p className="mb-3 px-2 text-[11px] font-semibold uppercase tracking-wider text-gray-600">Categories</p>
          <button
            onClick={() => setCategory("all")}
            className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-sm ${category === "all" ? "bg-indigo-500/10 text-indigo-300" : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"}`}
          >
            <span>All commands</span><span className="text-xs text-gray-600">{tools.length}</span>
          </button>
          <div className="mt-2 space-y-1">
            {categories.map((item) => {
              const count = tools.filter((tool) => tool.category === item.id).length;
              return (
                <button
                  key={item.id}
                  onClick={() => setCategory(item.id)}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${category === item.id ? "bg-indigo-500/10 text-indigo-300" : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"}`}
                >
                  <span>{item.label}</span><span className="text-xs text-gray-600">{count}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-8 border-t border-gray-800 pt-5">
            <p className="px-2 text-xs leading-5 text-gray-600">This directory is generated from the server-side MCP tool catalog.</p>
          </div>
        </aside>

        <main className="min-w-0 px-6 py-5">
          {loading && <div className="py-16 text-center text-sm text-gray-500">Loading command catalog…</div>}
          {error && <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="py-16 text-center">
              <Search className="mx-auto mb-3 text-gray-700" size={26} />
              <p className="text-sm text-gray-400">No commands match the current filters.</p>
            </div>
          )}
          {!loading && !error && grouped.map((group) => (
            <section key={group.id} className="mb-8">
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">{categoryLabels[group.id]}</h2>
                <span className="text-xs text-gray-700">{group.tools.length}</span>
              </div>
              <div className="divide-y divide-gray-800 overflow-hidden rounded-md border border-gray-800 bg-gray-900/50">
                {group.tools.map((tool) => (
                  <button
                    key={tool.name}
                    onClick={() => setSelected(tool)}
                    className={`flex w-full items-center gap-4 px-4 py-4 text-left transition hover:bg-gray-800/60 ${selected?.name === tool.name ? "bg-indigo-500/5" : ""}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="text-sm font-medium text-gray-200">{tool.name}</code>
                        {tool.lifecycle === "preferred" && <Badge>preferred</Badge>}
                        {tool.lifecycle === "legacy" && <Badge>legacy</Badge>}
                      </div>
                      <p className="mt-1 truncate text-xs text-gray-500">{tool.description}</p>
                    </div>
                    <div className="hidden items-center gap-2 md:flex">
                      <Badge>{tool.access}</Badge>
                      <Badge>{tool.execution}</Badge>
                    </div>
                    <ChevronRight size={16} className="shrink-0 text-gray-700" />
                  </button>
                ))}
              </div>
            </section>
          ))}
        </main>

        <aside className="border-l border-gray-800 bg-gray-925 px-5 py-6">
          {selected ? (
            <>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-400">{categoryLabels[selected.category]}</p>
                  <h2 className="mt-2 break-all font-mono text-sm font-semibold leading-6 text-gray-100">{selected.name}</h2>
                </div>
                <BookOpen size={17} className="mt-1 shrink-0 text-gray-600" />
              </div>
              <p className="mt-6 text-sm leading-6 text-gray-400">{selected.description}</p>
              <div className="mt-6 space-y-3 border-t border-gray-800 pt-5">
                <div className="flex items-center justify-between text-xs"><span className="text-gray-600">Access</span><Badge>{selected.access}</Badge></div>
                <div className="flex items-center justify-between text-xs"><span className="text-gray-600">Execution</span><Badge>{selected.execution}</Badge></div>
                <div className="flex items-center justify-between text-xs"><span className="text-gray-600">Lifecycle</span><Badge>{selected.lifecycle}</Badge></div>
              </div>
              <div className="mt-7 rounded-md border border-gray-800 bg-gray-900 p-4">
                {selected.access === "mutation" ? (
                  <div className="flex gap-3">
                    <CircleAlert size={16} className="mt-0.5 shrink-0 text-amber-400" />
                    <p className="text-xs leading-5 text-gray-500">This command can change remote state. Use a deploymentId, verify the target, and prefer async execution for long operations.</p>
                  </div>
                ) : (
                  <div className="flex gap-3">
                    <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" />
                    <p className="text-xs leading-5 text-gray-500">This command is classified as read-only by the Relay catalog.</p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="py-12 text-center text-sm text-gray-600">Select a command to inspect it.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
