import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../App";
import { useProjectScope } from "../context/ProjectScope";
import { Button, ErrorState, Skeleton } from "../components/ui";
import AttentionList from "../components/knowledge/AttentionList";
import IngestRunList, { type IngestRun } from "../components/knowledge/IngestRunList";
import { StandardPage } from "../components/knowledge/KnowledgeFrame";

import "../components/knowledge/overview.css";

interface IndexData {
  documents: number;
  indexedDocuments: number;
  stale: boolean;
}
interface DashboardData {
  counts: Array<{ kind: string; lifecycle: string; count: number }>;
}

interface CaptureData {
  status?: string;
  deadLetterCount?: number;
}

interface OverviewSnapshot {
  projectId: number | undefined;
  index: IndexData;
  indexAvailable: boolean;
  dashboard: DashboardData | undefined;
  capture: CaptureData | undefined;
  runs: IngestRun[] | undefined;
  productDocumentCount: number | undefined;
  unlinkedEvidence: number | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown, fallback = 0): number {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : fallback;
}


function indexData(value: unknown): IndexData {
  const payload = record(value);
  const index = record(payload?.index) ?? payload ?? {};
  return {
    documents: numberValue(index.documents),
    indexedDocuments: numberValue(index.indexedDocuments),
    stale: index.stale === true,
  };
}

function dashboardData(value: unknown): DashboardData | undefined {
  const payload = record(value);
  const rawCounts = Array.isArray(payload?.counts) ? payload.counts as unknown[] : undefined;
  if (!rawCounts) return undefined;
  const counts = rawCounts.flatMap((item) => {
    const entry = record(item);
    return typeof entry?.kind === "string" && typeof entry.lifecycle === "string"
      ? [{ kind: entry.kind, lifecycle: entry.lifecycle, count: numberValue(entry.count) }]
      : [];
  });
  return { counts };
}

function captureData(value: unknown): CaptureData | undefined {
  const payload = record(value);
  if (!payload) return undefined;
  return {
    status: typeof payload.status === "string" ? payload.status : undefined,
    deadLetterCount: payload.deadLetterCount === undefined ? undefined : numberValue(payload.deadLetterCount),
  };
}

function runList(value: unknown): IngestRun[] | undefined {
  const payload = record(value);
  if (!Array.isArray(payload?.runs)) return undefined;
  const rawRuns: unknown[] = payload.runs;
  return rawRuns.flatMap((item) => {
    const run = record(item);
    if (!run || (typeof run.id !== "string" && typeof run.id !== "number")) return [];
    return [{
      id: String(run.id),
      sourceLocator: typeof run.source_locator === "string" ? run.source_locator : undefined,
      status: typeof run.status === "string" ? run.status : undefined,
      imported: numberValue(run.imported),
      skipped: numberValue(run.skipped),
      failed: numberValue(run.failed),
    }];
  });
}

function pageTotal(value: unknown): number | undefined {
  const payload = record(value);
  const page = record(payload?.page);
  return page?.total === undefined ? undefined : numberValue(page.total);
}

export default function KnowledgeOverview() {
  const { user } = useAuth();
  const { projectId, loading: scopeLoading, error: scopeError } = useProjectScope();
  const [snapshot, setSnapshot] = useState<OverviewSnapshot>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const hasKnowledge = Boolean(user?.knowledgeEnabled || user?.isAdmin);
  const requestRef = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async () => {
    if (scopeLoading || !hasKnowledge) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const [captureResult, runResult, indexResult, dashboardResult, productResult] = await Promise.all([
        api.knowledgeOperationsCapture().catch(() => undefined),
        api.knowledgeOperationsIngestRuns(8).catch(() => undefined),
        api.knowledgeOperationsIndex().catch(() => undefined),
        projectId === undefined ? Promise.resolve(undefined) : api.knowledgeDashboard(projectId).catch(() => undefined),
        api.productDocumentsList({ limit: 1 }).catch(() => undefined),
      ]);
      if (requestRef.current !== controller || controller.signal.aborted) return;
      setSnapshot({
        projectId,
        index: indexData(indexResult),
        indexAvailable: indexResult !== undefined,
        dashboard: dashboardData(dashboardResult),
        capture: captureData(captureResult),
        runs: runList(runResult),
        productDocumentCount: pageTotal(productResult),
        unlinkedEvidence: undefined,
      });
      if (projectId !== undefined) {
        void api.knowledgeEvidenceList(projectId, { unlinked: "true", limit: 1 }, { signal: controller.signal })
          .then((result) => {
            if (requestRef.current !== controller || controller.signal.aborted) return;
            setSnapshot((current) => current && current.projectId === projectId
              ? { ...current, unlinkedEvidence: pageTotal(result) }
              : current);
          })
          .catch(() => {
            // The optional attention count must not block the usable overview.
          });
      }
    } catch (reason: unknown) {
      if (requestRef.current === controller && !controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "Unable to load Knowledge overview");
      }
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }, [projectId, scopeLoading, hasKnowledge]);

  useEffect(() => {
    if (!scopeLoading) void load();
    return () => requestRef.current?.abort();
  }, [load, scopeLoading]);

  const pendingReview = useMemo(() => snapshot?.dashboard?.counts
    .filter((item) => item.kind === "candidate" && item.lifecycle === "draft")
    .reduce((total, item) => total + item.count, 0), [snapshot]);
  const failedRuns = snapshot?.runs?.filter((run) => /failed|partial/i.test(String(run.status ?? ""))).length;
  const index = snapshot?.indexAvailable ? snapshot.index : undefined;
  const statusLabel = loading && !snapshot ? "Checking" : !index ? "Unavailable" : index.stale
    ? "Stale" : index.documents === 0 ? "Empty" : "Ready";
  const coverage = index && index.documents > 0 ? Math.min(100, Math.round(index.indexedDocuments / index.documents * 100)) : undefined;
  const captureStatus = snapshot?.capture?.status ? snapshot.capture.status.toLowerCase() : "unknown";
  const isAdmin = user?.isAdmin === true;

  if (!hasKnowledge) return <StandardPage><ErrorState message="Knowledge access is off" description="Ask your Relay administrator to enable Knowledge for your account." /></StandardPage>;

  if (error && !snapshot) {
    return <StandardPage className="overview-page"><ErrorState message={error} description="Check the Knowledge service and retry the overview." onRetry={() => void load()} /></StandardPage>;
  }

  return (
    <StandardPage className="overview-page">
      <header className="knowledge-summary-heading">
        <h1>Knowledge</h1>
        <Button variant="ghost" loading={loading} onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" />Refresh</Button>
      </header>
      {scopeError && <p className="mb-3 text-sm text-coral" role="status">Project data is unavailable. Account-level Knowledge is shown below.</p>}
      <section className="knowledge-summary" aria-label="Knowledge overview">
        <div className="knowledge-summary-index">
          <div className="knowledge-summary-section-heading"><h2>Index coverage</h2>
            <strong data-index={statusLabel.toLowerCase()} role="status">{statusLabel}</strong>
          </div>
          {loading && !snapshot ? <Skeleton width="100%" height="46px" /> : index ? (
            <>
              <p>{index.indexedDocuments.toLocaleString()} of {index.documents.toLocaleString()} documents indexed</p>
              {coverage !== undefined && <progress value={coverage} max={100} aria-label="Document index coverage">{coverage}%</progress>}
              {index.stale && <Link className="section-link" to="/knowledge/operations/index">View index controls</Link>}
            </>
          ) : <p>Index coverage could not be checked. Use Refresh to try again.</p>}
        </div>
        <div className="knowledge-summary-attention">
          <div className="knowledge-summary-section-heading"><h2>Review queues</h2></div>
          {snapshot ? <AttentionList pendingReview={pendingReview} unlinkedEvidence={snapshot.unlinkedEvidence} failedRuns={failedRuns} isAdmin={isAdmin} />
            : <Skeleton width="100%" height="46px" />}
        </div>
        <nav className="knowledge-summary-links" aria-label="Knowledge sections">
          <Link to="/knowledge/product-docs">Product docs{snapshot?.productDocumentCount !== undefined ? " (" + snapshot.productDocumentCount + ")" : ""}</Link>
          <Link to="/knowledge/memory">Memory</Link>
          <Link to="/knowledge/operations/capture">Capture · {captureStatus}</Link>
        </nav>
        <div className="knowledge-summary-ingest">
          <div className="knowledge-summary-section-heading"><h2>Recent ingest runs</h2><Link className="section-link" to="/knowledge/operations/ingest">View all</Link></div>
          {snapshot && !snapshot.runs
            ? <p role="status">Ingest history is unavailable. Use Refresh to try again.</p>
            : <IngestRunList runs={snapshot?.runs ?? []} loading={!snapshot} isAdmin={isAdmin} />}
        </div>
      </section>
    </StandardPage>
  );
}
