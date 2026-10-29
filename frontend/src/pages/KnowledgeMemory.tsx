import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useProjectScope } from "../context/ProjectScope";
import { PageTabs } from "../components/shell/PageTabs";
import { Badge, DataTable, Drawer, EmptyState, ErrorState, Input, PageHeader, Select, StatusPill } from "../components/ui";

type MemoryTab = "sessions" | "evidence" | "observations" | "candidate-insights" | "confirmed-memory";
type JsonRecord = Record<string, unknown>;
const TABS: readonly MemoryTab[] = ["sessions", "evidence", "observations", "candidate-insights", "confirmed-memory"];
const TYPES = ["Fact", "Decision", "Case", "Pattern"] as const;
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null;
const text = (value: unknown, fallback = "") => typeof value === "string" || typeof value === "number" ? String(value) : fallback;
const listFrom = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.filter(isRecord) : [];
type MemoryPayloadKey = "memories" | "insights" | "sessions" | "evidence" | "observations";
const listFromPayload = (value: unknown, key: MemoryPayloadKey): JsonRecord[] => {
  if (!isRecord(value)) return [];
  return listFrom(value[key]);
};

const titleOf = (row: JsonRecord) => text(row.title ?? row.displayTitle ?? row.statement ?? row.summary ?? row.id, "Untitled record");
const summaryOf = (row: JsonRecord) => text(row.statement ?? row.displaySummary ?? row.summary ?? row.objective, "No summary available");
const labelOf = (tab: MemoryTab) => tab === "candidate-insights" ? "Candidate insights" : tab === "confirmed-memory" ? "Confirmed memory" : tab[0].toUpperCase() + tab.slice(1);
const dateOf = (value: unknown) => {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};

function RecordDrawer({ row, tab, onClose }: { row: JsonRecord; tab: MemoryTab; onClose: () => void }) {
  const evidence = Array.isArray(row.evidenceRefs) ? row.evidenceRefs : [];
  const audit = row.audit ?? row.reviewReason;
  const impact = row.impact ?? row.impactSummary ?? row.affectedRecords;
  const review = row.review ?? row.reviewStatus ?? row.reviewReason;
  const metadata: Array<[string, unknown]> = [
    ["Type", row.type ?? row.kind],
    ["Scope", isRecord(row.scope) ? `${text(row.scope.scopeType)}:${text(row.scope.scopeKey)}` : row.projectId],
    ["Source", isRecord(row.source) ? row.source.locator : row.sourceLocator],
    ["Reviewed", row.reviewedAt ?? row.confirmedAt ?? row.updatedAt],
  ];
  return (
    <Drawer open title={titleOf(row)} onClose={onClose}>
      <div className="space-y-8">
        <section>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge tone="iris">{labelOf(tab)}</Badge>
            <StatusPill status={row.status ?? row.lifecycle ?? "confirmed"} />
            <code className="text-xs text-muted">{text(row.id, "unknown")}</code>
          </div>
          <h3 className="mb-3 font-display text-lg font-semibold">Summary</h3>
          <dl className="grid gap-3 sm:grid-cols-2">
            {metadata.map(([name, value]) => <div key={name}><dt className="text-sm text-muted">{name}</dt><dd className="mt-1 break-words text-sm">{text(value, "—")}</dd></div>)}
          </dl>
          <p className="mt-5 whitespace-pre-wrap text-[15px] leading-6 text-muted">{summaryOf(row)}</p>
        </section>
        <section>
          <h3 className="mb-3 font-display text-lg font-semibold">Evidence</h3>
          {evidence.length ? <ul className="divide-y divide-white/10">{evidence.map((item, index) => <li key={`${text(item)}-${index}`} className="flex items-center justify-between gap-3 py-3"><code className="break-all text-xs text-muted">{text(item)}</code><Badge tone="mint">Linked</Badge></li>)}</ul> : <p className="text-sm text-muted">No linked evidence.</p>}
        </section>
        <section>
          <h3 className="mb-3 font-display text-lg font-semibold">History</h3>
          {audit ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-6 text-muted">{typeof audit === "string" ? audit : JSON.stringify(audit, null, 2)}</pre> : <p className="text-sm text-muted">No review history yet.</p>}
        </section>
        <section>
          <h3 className="mb-3 font-display text-lg font-semibold">Impact</h3>
          {impact ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-sm leading-6 text-muted">{typeof impact === "string" ? impact : JSON.stringify(impact, null, 2)}</pre> : <p className="text-sm text-muted">No impact relationships are recorded.</p>}
        </section>
        <section>
          <h3 className="mb-3 font-display text-lg font-semibold">Review</h3>
          {review ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-sm leading-6 text-muted">{typeof review === "string" ? review : JSON.stringify(review, null, 2)}</pre> : <p className="text-sm text-muted">No review decision is recorded.</p>}
        </section>
      </div>
    </Drawer>
  );
}

export default function KnowledgeMemory() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { projects, projectId, setProjectId, loading: scopeLoading, error: scopeError } = useProjectScope();
  const routeTab = (TABS.find((item) => location.pathname.endsWith(`/${item}`)) ?? "confirmed-memory") as MemoryTab;
  const [tab, setTab] = useState<MemoryTab>(routeTab);
  const [type, setType] = useState("");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [rows, setRows] = useState<JsonRecord[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const selectedId = params.get("id");
  const selected = useMemo(() => rows.find((row) => text(row.id) === selectedId), [rows, selectedId]);

  useEffect(() => { setTab(routeTab); }, [routeTab]);
  useEffect(() => {
    if (tab !== "sessions" && projectId === undefined) {
      setRows([]);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    let task: Promise<unknown>;
    if (tab === "confirmed-memory") {
      task = api.knowledgeConfirmedMemories(projectId ?? "", type ? { type } : {});
    } else if (tab === "candidate-insights") {
      task = api.knowledgeCandidateInsights(projectId ?? "");
    } else if (tab === "sessions") {
      task = api.knowledgeSessions();
    } else if (tab === "evidence") {
      task = api.knowledgeEvidenceList(projectId);
    } else {
      if (projectId === undefined) return;
      task = api.knowledgeObservations(projectId);
    }
    task.then((result: unknown) => {
      if (!active) return;
      const key: MemoryPayloadKey = tab === "confirmed-memory"
        ? "memories"
        : tab === "candidate-insights"
          ? "insights"
          : tab;
      setRows(listFromPayload(result, key));
    }).catch((reason: unknown) => {
      if (!active) return;
      setRows([]);
      setError(reason instanceof Error ? reason.message : "Unable to load Memory workspace");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [projectId, tab, type, reloadCount]);

  const open = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("id", id);
    setParams(next, { replace: false });
  };
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete("id");
    navigate(`${location.pathname}${next.toString() ? `?${next}` : ""}`, { replace: true });
  };
  const applyQuery = (value: string) => {
    setQuery(value);
    const next = new URLSearchParams(params);
    value ? next.set("q", value) : next.delete("q");
    setParams(next, { replace: true });
  };
  const visibleRows = rows.filter((row) => !query.trim() || `${titleOf(row)} ${summaryOf(row)}`.toLowerCase().includes(query.trim().toLowerCase()));
  const title = labelOf(tab);
  const columns = [
    { key: "record", header: "Record", render: (row: JsonRecord) => <div className="min-w-0"><strong className="block truncate font-medium">{titleOf(row)}</strong><span className="mt-1 block line-clamp-2 text-sm text-muted">{summaryOf(row)}</span></div> },
    { key: "status", header: "Status", render: (row: JsonRecord) => <StatusPill status={row.status ?? row.lifecycle ?? "confirmed"} /> },
    { key: "updated", header: "Updated", render: (row: JsonRecord) => <span className="text-sm text-muted">{dateOf(row.updatedAt ?? row.confirmedAt ?? row.createdAt)}</span> },
  ];

  return (
    <div className="mx-auto max-w-[1280px] px-5 py-8 sm:px-8">
      <PageHeader title="Memory" description="Sessions, evidence and the insights built from them." tabs={<PageTabs section="memory" />} />
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <label className="relative min-w-[280px] flex-1">
          <span className="sr-only">Search {title}</span>
          <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-3 text-muted" />
          <Input className="pl-9" placeholder={`Search ${title.toLowerCase()}`} value={query} onChange={(event) => applyQuery(event.target.value)} />
        </label>
        <label className="min-w-[210px]">
          <span className="sr-only">Project</span>
          <Select value={projectId === undefined ? "" : String(projectId)} onChange={(event) => setProjectId(Number(event.target.value))} disabled={scopeLoading || projects.length === 0}>
            <option value="">Select project</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </Select>
        </label>
        {tab === "confirmed-memory" && <label className="min-w-[190px]"><span className="sr-only">Memory type</span><Select value={type} onChange={(event) => setType(event.target.value)}><option value="">All confirmed memory</option>{TYPES.map((item) => <option key={item} value={item}>{item}</option>)}</Select></label>}
        <span className="text-sm text-muted">{visibleRows.length} results</span>
      </div>
      {scopeError && <ErrorState className="mb-4" message={scopeError} description="The project scope could not be loaded." />}
      {error && <ErrorState className="mb-4" message={error} onRetry={() => setReloadCount((count) => count + 1)} />}
      {loading || scopeLoading ? <div className="ui-glass p-6 text-sm text-muted" role="status">Loading {title.toLowerCase()}…</div> : !visibleRows.length ? <EmptyState title={`No ${title.toLowerCase()} records`} description="Try another filter or capture more knowledge." /> : <DataTable columns={columns} rows={visibleRows} rowKey={(row) => text(row.id)} selectedRowKey={selectedId ?? undefined} onRowClick={(row) => open(text(row.id))} />}
      {selected && <RecordDrawer row={selected} tab={tab} onClose={close} />}
    </div>
  );
}
