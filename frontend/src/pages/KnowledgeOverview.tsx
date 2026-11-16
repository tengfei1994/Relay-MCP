import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../App";
import { useProjectScope, type Project } from "../context/ProjectScope";
import { buildPlate } from "../lib/plate";
import { Button, ErrorState, Skeleton } from "../components/ui";
import AttentionList from "../components/knowledge/AttentionList";
import IndexPlate from "../components/knowledge/IndexPlate";
import IngestRunList, { type IngestRun } from "../components/knowledge/IngestRunList";
import { StandardPage } from "../components/knowledge/KnowledgeFrame";

import "../components/knowledge/overview.css";

interface IndexData {
  documents: number;
  indexedDocuments: number;
  stale: boolean;
}
interface PlateCounts {
  ok: number;
  stale: number;
  fail: number;
  wait: number;
}

interface DashboardData {
  counts: Array<{ kind: string; lifecycle: string; count: number }>;
}

interface CaptureData {
  status?: string;
  deadLetterCount?: number;
}

interface OverviewSnapshot {
  projects: Project[];
  projectId: number | undefined;
  index: IndexData;
  indexAvailable: boolean;
  dashboard: DashboardData | undefined;
  capture: CaptureData | undefined;
  runs: IngestRun[];
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

function runList(value: unknown): IngestRun[] {
  const payload = record(value);
  const rawRuns = Array.isArray(payload?.runs) ? payload.runs as unknown[] : [];
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
  const { projects, projectId, loading: scopeLoading } = useProjectScope();
  const [snapshot, setSnapshot] = useState<OverviewSnapshot>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [animationKey, setAnimationKey] = useState(0);
  const requestRef = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async () => {
    if (scopeLoading) return;
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
        projects,
        projectId,
        index: indexData(indexResult),
        indexAvailable: indexResult !== undefined,
        dashboard: dashboardData(dashboardResult),
        capture: captureData(captureResult),
        runs: runList(runResult),
        productDocumentCount: pageTotal(productResult),
        unlinkedEvidence: undefined,
      });
      setAnimationKey((key) => key + 1);
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
  }, [projectId, projects, scopeLoading]);

  useEffect(() => {
    if (!scopeLoading) void load();
    return () => requestRef.current?.abort();
  }, [load, scopeLoading]);

  const pendingReview = useMemo(() => snapshot?.dashboard?.counts
    .filter((item) => item.kind === "candidate" && item.lifecycle === "draft")
    .reduce((total, item) => total + item.count, 0), [snapshot]);
  const failedRuns = snapshot?.runs.filter((run) => /failed|partial/i.test(String(run.status ?? ""))).length;
  const plate = snapshot ? buildPlate({
    documents: snapshot.index.documents,
    indexedDocuments: snapshot.index.indexedDocuments,
    stale: snapshot.index.stale,
    failedBatches: 0,
  }) : { wells: Array.from({ length: 96 }, () => "empty" as const), batchSize: 1 };
  const counts: PlateCounts = { ok: 0, stale: 0, fail: 0, wait: 0 };
  for (const state of plate.wells) if (state !== "empty") counts[state] += 1;
  const notCurrent = counts.stale + counts.fail + counts.wait;
  const documents = snapshot?.index.documents ?? 0;
  const statusLabel = snapshot && !snapshot.indexAvailable ? "Index unavailable" : documents === 0 ? "No indexed documents" : snapshot?.index.stale ? "Index stale" : notCurrent === 0 ? "Index current" : `${notCurrent} batches need attention`;
  const captureStatus = snapshot?.capture?.status ? snapshot.capture.status.toLowerCase() : "unknown";
  const isAdmin = user?.isAdmin === true;

  if (error && !snapshot) {
    return <StandardPage className="overview-page"><ErrorState message={error} description="Check the Knowledge service and retry the overview." onRetry={() => void load()} /></StandardPage>;
  }

  return (
    <StandardPage className="overview-page">
      <section className="knowledge-overview-surface" aria-label="Knowledge workspace">
        <div className="knowledge-overview-status" aria-live="polite">
          <div><span>Status</span><strong>{statusLabel}</strong></div>
          <div><span>Documents</span><strong>{snapshot ? documents.toLocaleString() : "—"}</strong></div>
          <div><span>Current batches</span><strong className="text-mint">{snapshot ? counts.ok : "—"}</strong></div>
          <div><span>Needs attention</span><strong className={notCurrent > 0 ? "text-sun" : "text-mint"}>{snapshot ? notCurrent : "—"}</strong></div>
          <div className="knowledge-overview-status-actions">
            <Button variant="ghost" loading={loading} onClick={() => void load()}><RefreshCw size={15} /> Refresh</Button>
            {snapshot?.index.stale && <Link className="button-ghost button-sm" to="/knowledge/operations/index">Index controls</Link>}
          </div>
        </div>

        <div className="knowledge-overview-main">
          <div className="knowledge-overview-coverage">
            <div className="knowledge-overview-section-heading"><h2>Index coverage</h2><span>{snapshot?.indexAvailable ? `${counts.ok} current · ${counts.stale} stale · ${counts.fail} failed · ${counts.wait} waiting` : "Waiting for index data"}</span></div>
            <IndexPlate wells={plate.wells} batchSize={plate.batchSize} loading={!snapshot} animationKey={animationKey} />
          </div>
          <div className="knowledge-overview-column">
            <div className="knowledge-overview-section-heading"><h2>Needs attention</h2><span>Open a queue to continue</span></div>
            {snapshot ? <AttentionList pendingReview={pendingReview} unlinkedEvidence={snapshot.unlinkedEvidence} failedRuns={failedRuns} isAdmin={isAdmin} /> : <div className="overview-loading"><Skeleton width="100%" height="46px" /><Skeleton width="100%" height="46px" /></div>}
            <div className="knowledge-overview-section-heading knowledge-overview-section-heading-spaced"><h2>Workspaces</h2><span>Jump to a working surface</span></div>
            <nav className="knowledge-overview-links" aria-label="Knowledge workspaces">
              <Link to="/knowledge/product-docs"><span>Product docs</span><b>{snapshot?.productDocumentCount ?? "—"}</b><small>documents</small></Link>
              <Link to="/knowledge/memory"><span>Memory</span><b>{pendingReview ?? "—"}</b><small>waiting for review</small></Link>
              <Link to="/knowledge/operations/capture"><span>Operations</span><b>{failedRuns && failedRuns > 0 ? failedRuns : captureStatus}</b><small>{failedRuns && failedRuns > 0 ? "failed imports" : "capture status"}</small></Link>
            </nav>
          </div>
        </div>

        <div className="knowledge-overview-activity">
          <div className="knowledge-overview-section-heading"><h2>Recent ingest runs</h2><Link className="section-link" to="/knowledge/operations/ingest">View all</Link></div>
          <IngestRunList runs={snapshot?.runs ?? []} loading={!snapshot} isAdmin={isAdmin} />
        </div>
      </section>
    </StandardPage>
  );
}
