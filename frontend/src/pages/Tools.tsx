import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { BookOpen, CheckCircle2, ChevronRight, CircleAlert, Filter, Search, X } from "lucide-react";
import { api } from "../api/client";
import { Badge, Drawer, Skeleton } from "../components/ui";
import { AppPageFrame } from "../components/shell/AppPageFrame";

import "./tools.css";

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
  context: "Knowledge",
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

type ToolTreeNode = {
  id: string;
  label: string;
  children?: ToolTreeNode[];
  select?: () => void;
};

function ToolTree({ nodes, selectedId }: { nodes: ToolTreeNode[]; selectedId: string }) {
  const [expanded, setExpanded] = useState(new Set<string>());
  const [focused, setFocused] = useState("all");

  function toggle(id: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLLIElement>, node: ToolTreeNode) {
    if (event.target !== event.currentTarget) return;
    const item = event.currentTarget;
    const tree = item.closest('[role="tree"]');
    const items = Array.from(tree?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);
    const index = items.indexOf(item);
    let destination: HTMLElement | undefined | null;
    switch (event.key) {
      case "ArrowDown": destination = items[index + 1]; break;
      case "ArrowUp": destination = items[index - 1]; break;
      case "Home": destination = items[0]; break;
      case "End": destination = items.at(-1); break;
      case "ArrowRight":
        if (node.children && !expanded.has(node.id)) toggle(node.id);
        else if (node.children) destination = items[index + 1];
        break;
      case "ArrowLeft":
        if (expanded.has(node.id)) toggle(node.id);
        else destination = item.parentElement?.closest<HTMLElement>('[role="treeitem"]');
        break;
      case "Enter":
      case " ":
        if (node.select) node.select();
        else if (node.children) toggle(node.id);
        break;
      default: return;
    }
    event.preventDefault();
    destination?.focus();
  }

  function renderNode(node: ToolTreeNode) {
    const isOpen = expanded.has(node.id);
    return <li key={node.id} role="treeitem" aria-label={node.label} tabIndex={focused === node.id ? 0 : -1}
      aria-expanded={node.children ? isOpen : undefined}
      aria-selected={node.select ? node.id === selectedId : undefined}
      onFocus={(event) => { if (event.target === event.currentTarget) setFocused(node.id); }}
      onKeyDown={(event) => onKeyDown(event, node)}>
      <div onClick={(event) => {
        (event.currentTarget.parentElement as HTMLElement).focus();
        if (node.select) node.select();
        else toggle(node.id);
      }}>
        {node.children && <ChevronRight size={14} aria-hidden="true" />}{node.label}
      </div>
      {node.children && isOpen && <ul role="group">{node.children.map(renderNode)}</ul>}
    </li>;
  }

  return <ul className="tools-tree" role="tree" aria-label="Tool categories">{nodes.map(renderNode)}</ul>;
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


  const categoryItems = useMemo(() => {
    const labels = new Map(categories.map((item) => [item.id, item.label]));
    const ordered = categoryOrder.map((id) => ({ id, label: labels.get(id) ?? categoryLabels[id] ?? id })).filter((item) => categories.some((categoryItem) => categoryItem.id === item.id) || tools.some((tool) => tool.category === item.id));
    const known = new Set(categoryOrder);
    const extras = Array.from(new Set([...categories.map((item) => item.id), ...tools.map((tool) => tool.category)])).filter((id) => !known.has(id)).map((id) => ({ id, label: labels.get(id) ?? id }));
    return [...ordered, ...extras];
  }, [categories, tools]);
  const grouped = categoryItems.map(({ id }) => ({ id, tools: filtered.filter((tool) => tool.category === id) })).filter((group) => group.tools.length);
  const shownCount = category === "samplemanager"
    ? visibleEntities.reduce((total, item) => total + item.inspectors.length, 0)
    : filtered.length;

  return (
    <AppPageFrame variant="wide">
      <div className="tools-page">
        <div className="tools-layout">
          <aside className="tools-category-rail" aria-label="Tools category">
            <div className="tools-category-heading"><span>Tools</span><strong>Category</strong></div>
            <ToolTree selectedId={category === "all" ? "all" : entity === "all" ? category + ":view" : category + ":" + entity + ":view"} nodes={[
              { id: "all", label: "All tools", select: () => { setCategory("all"); setEntity("all"); } },
              ...categoryItems.map((item) => ({
                id: item.id, label: item.label, children: [
                  { id: item.id + ":view", label: "View category", select: () => { setCategory(item.id); setEntity("all"); } },
                  ...(item.id === "samplemanager" ? sampleManagerEntities.map((group) => ({
                    id: item.id + ":" + group.id, label: group.label, children: [
                      { id: item.id + ":" + group.id + ":view", label: "View inspectors", select: () => { setCategory(item.id); setEntity(group.id); } },
                    ],
                  })) : []),
                ],
              })),
            ]} />
          </aside>

          <div className="ui-detail-layout"><div className="tools-directory-column">
            <header className="tools-toolbar">
              <div className="tools-toolbar-count"><span className="tools-toolbar-label">Tool directory</span><span>{category === "samplemanager" ? `${sampleManagerEntities.reduce((total, item) => total + item.inspectors.length, 0)} inspectors` : `${tools.length} commands`} · {shownCount} shown</span></div>
              <div className="tools-toolbar-controls">
                <label className="tools-search"><Search size={15} aria-hidden="true" /><input aria-label="Search commands" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search commands" />{query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={15} /></button>}</label>
                {category === "samplemanager" && <label className="tools-select-wrap"><span className="sr-only">Entity</span><select aria-label="Filter SampleManager entity" value={entity} onChange={(event) => setEntity(event.target.value)}><option value="all">All entities</option>{sampleManagerEntities.map((item) => <option key={item.id} value={item.id}>{item.label} ({item.inspectors.length})</option>)}</select></label>}
                <div className="tools-access" role="group" aria-label="Filter access"><Filter size={14} aria-hidden="true" />{["all", "read-only", "mutation"].map((value) => <button type="button" key={value} onClick={() => setAccess(value)} className={access === value ? "is-active" : ""}>{value === "all" ? "All" : value === "read-only" ? "Read-only" : "Mutation"}</button>)}</div>
                {(query || access !== "all" || category !== "all") && <button type="button" className="tools-reset" onClick={() => { setQuery(""); setAccess("all"); setCategory("all"); setEntity("all"); }}>Clear filters</button>}
              </div>
            </header>

            <div className="tools-directory" aria-label="Tool directory results">
              {loading && <div className="tools-state"><Skeleton className="h-5 w-48" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
              {error && <div className="tools-state" role="alert"><CircleAlert size={18} className="text-coral" /><p>{error}</p></div>}
              {!loading && !error && category === "samplemanager" && visibleEntities.length === 0 && <div className="tools-state"><p>No inspectors match the current filters.</p></div>}
              {!loading && !error && category !== "samplemanager" && filtered.length === 0 && <div className="tools-state"><p>No commands match the current filters.</p></div>}
              {!loading && !error && category === "samplemanager" && visibleEntities.map((item) => <div key={item.id} className="tools-group">
                <div className="tools-group-heading"><div><h2>{item.label}</h2><p>{item.description}</p></div><span>{item.inspectors.length}</span></div>
                {item.inspectors.map((inspector) => <button type="button" key={`${item.id}.${inspector.id}`} onClick={() => setSelected({ kind: "inspector", entity: item, inspector })} className="tools-item"><div className="tools-item-copy"><div className="tools-item-title"><span>{inspector.label}</span><CatalogBadge>{inspector.status}</CatalogBadge></div><p>{inspector.description}</p></div>{inspector.plannedTool && <code className="tools-item-code">{inspector.plannedTool}</code>}<ChevronRight size={16} aria-hidden="true" /></button>)}
              </div>)}
              {!loading && !error && category !== "samplemanager" && grouped.map((group) => <div key={group.id} className="tools-group">
                <div className="tools-group-heading"><h2>{categoryLabels[group.id] ?? group.id}</h2><span>{group.tools.length}</span></div>
                {group.tools.map((tool) => <button type="button" key={tool.name} onClick={() => setSelected({ kind: "tool", tool })} className="tools-item"><div className="tools-item-copy"><div className="tools-item-title"><code>{tool.name}</code>{tool.lifecycle !== "standard" && <CatalogBadge>{tool.lifecycle}</CatalogBadge>}</div><p>{tool.description}</p></div><div className="tools-item-badges"><CatalogBadge>{tool.access}</CatalogBadge><CatalogBadge>{tool.execution}</CatalogBadge></div><ChevronRight size={16} aria-hidden="true" /></button>)}
              </div>)}
            </div>
          </div>
        <Drawer presentation="responsive" open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.kind === "tool" ? selected.tool.name : selected?.kind === "inspector" ? selected.inspector.label : "Tool details"} description={selected?.kind === "tool" ? categoryLabels[selected.tool.category] : selected?.kind === "inspector" ? selected.entity.label : undefined}>
          {selected?.kind === "tool" ? <div className="tools-detail"><div className="tools-detail-intro"><BookOpen size={18} aria-hidden="true" /><p>{selected.tool.description}</p></div><dl className="tools-detail-facts">{selected.tool.entity && <div><dt>Entity</dt><dd>{sampleManagerEntities.find((item) => item.id === selected.tool.entity)?.label ?? selected.tool.entity}</dd></div>}{selected.tool.capability && <div><dt>Capability</dt><dd>{selected.tool.capability.replace(/_/g, " ")}</dd></div>}<div><dt>Access</dt><dd><CatalogBadge>{selected.tool.access}</CatalogBadge></dd></div><div><dt>Execution</dt><dd><CatalogBadge>{selected.tool.execution}</CatalogBadge></dd></div><div><dt>Lifecycle</dt><dd><CatalogBadge>{selected.tool.lifecycle}</CatalogBadge></dd></div></dl><p className="tools-detail-note">{selected.tool.access === "mutation" ? <><CircleAlert size={16} aria-hidden="true" />This command can change data or trigger an operation. Review its requirements before use.</> : <><CheckCircle2 size={16} aria-hidden="true" />This command is read-only in the Relay catalog.</>}</p></div> : selected?.kind === "inspector" ? <div className="tools-detail"><div className="tools-detail-intro"><BookOpen size={18} aria-hidden="true" /><p>{selected.inspector.description}</p></div><dl className="tools-detail-facts"><div><dt>Status</dt><dd><CatalogBadge>{selected.inspector.status}</CatalogBadge></dd></div><div><dt>Access</dt><dd><CatalogBadge>{selected.inspector.readOnly ? "read-only" : "mutation"}</CatalogBadge></dd></div>{selected.inspector.plannedTool && <div><dt>MCP tool</dt><dd><code>{selected.inspector.plannedTool}</code></dd></div>}</dl>{selected.inspector.relatedEntities && selected.inspector.relatedEntities.length > 0 && <div className="tools-detail-tags"><span>Related entities</span><div>{selected.inspector.relatedEntities.map((value) => <span key={value}>{sampleManagerEntities.find((item) => item.id === value)?.label ?? value}</span>)}</div></div>}<div className="tools-detail-tags"><span>Evidence</span><div>{selected.inspector.evidenceKinds.map((value) => <span key={value}>{value}</span>)}</div></div><p className="tools-detail-note">{selected.inspector.status === "ready" ? <><CheckCircle2 size={16} aria-hidden="true" />This inspector is available through the listed MCP tool.</> : <><CircleAlert size={16} aria-hidden="true" />This inspector is part of the Capability Pack roadmap and is not yet callable.</>}</p></div> : null}
        </Drawer>
        </div>
        </div>
      </div>
    </AppPageFrame>
  );
}
