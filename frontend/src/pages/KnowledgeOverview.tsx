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
import PlaneCard from "../components/knowledge/PlaneCard";

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
  const { projects, projectId, selectedProject, loading: scopeLoading } = useProjectScope();
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
        api.knowledgeOperationsCapture(),
        api.knowledgeOperationsIngestRuns(8),
        api.knowledgeOperationsIndex(),
        projectId === undefined ? Promise.resolve(undefined) : api.knowledgeDashboard(projectId),
        api.productDocumentsList({ limit: 1 }),
      ]);
      if (requestRef.current !== controller || controller.signal.aborted) return;
      setSnapshot({
        projects,
        projectId,
        index: indexData(indexResult),
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
  }) : { wells: Array.from({ length: 96 }, () => "wait" as const), batchSize: 1 };
  const counts: PlateCounts = { ok: 0, stale: 0, fail: 0, wait: 0 };
  for (const state of plate.wells) counts[state] += 1;
  const notCurrent = counts.stale + counts.fail + counts.wait;
  const documents = snapshot?.index.documents ?? 0;
  const title = documents === 0 ? "No documents indexed yet" : snapshot?.index.stale ? "Index is stale" : notCurrent === 0 ? "Index is current" : `Index is current except ${notCurrent} ${notCurrent === 1 ? "batch" : "batches"}`;
  const lede = documents === 0
    ? "Import product documents to build the index."
    : plate.batchSize === 1
      ? "Each well is one document. Hover a well for its position and state."
      : `Each well is a batch of about ${plate.batchSize} documents. Hover a well for its position and state.`;
  const projectName = selectedProject?.name ?? snapshot?.projects.find((project) => project.id === snapshot.projectId)?.name;
  const captureStatus = snapshot?.capture?.status ? snapshot.capture.status.toLowerCase() : "unknown";
  const isAdmin = user?.isAdmin === true;

  if (error && !snapshot) {
    return <div className="page overview-page"><ErrorState message={error} description="Check the Knowledge service and retry the overview." onRetry={() => void load()} /></div>;
  }

  return (
    <div className="page overview-page">
      <section className="overview-hero">
        <IndexPlate wells={plate.wells} batchSize={plate.batchSize} loading={!snapshot} animationKey={animationKey} />
        <div className="overview-intro">
          {snapshot ? <>
            <h1 className="overview-title">{title}</h1>
            <p className="overview-lede">{lede}</p>
            <ul className="plate-legend" aria-label="Index coverage legend">
              <li><i className="legend-dot legend-ok" />Current <b>{counts.ok}</b></li>
              <li><i className="legend-dot legend-stale" />Stale <b>{counts.stale}</b></li>
              {counts.fail > 0 && <li><i className="legend-dot legend-fail" />Failed <b>{counts.fail}</b></li>}
              <li><i className="legend-dot legend-wait" />Waiting <b>{counts.wait}</b></li>
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="accent" loading={loading} onClick={() => void load()}><RefreshCw size={16} />Refresh</Button>
              {snapshot.index.stale && <Link className="button-ghost button-sm" to="/knowledge/operations/index">Open index controls</Link>}
            </div>
            <h2 className="attention-heading">Needs attention</h2>
            <AttentionList pendingReview={pendingReview} unlinkedEvidence={snapshot.unlinkedEvidence} failedRuns={failedRuns} isAdmin={isAdmin} />
          </> : <div className="overview-loading"><Skeleton width="88%" height="48px" /><Skeleton width="95%" height="56px" /><Skeleton width="100%" height="88px" /></div>}
        </div>
      </section>

      <section className="overview-block">
        <h2 className="section-heading">Where to work</h2>
        <div className="plane-grid">
          <PlaneCard title="Product docs" description="Versioned documentation you can import, compare and search." footnote={snapshot ? `${snapshot.productDocumentCount ?? "—"} documents` : <Skeleton width="96px" height="16px" />} to="/knowledge/product-docs" tint="110,231,200" />
          <PlaneCard title="Memory" description="What sessions captured, and the insights waiting to become knowledge." footnote={snapshot ? `${pendingReview ?? "—"} waiting for review` : <Skeleton width="128px" height="16px" />} to="/knowledge/memory" tint="255,180,84" />
          <PlaneCard title="Operations" description="Capture, ingest and index health, with rebuild controls." footnote={snapshot ? failedRuns && failedRuns > 0 ? `${failedRuns} failed imports` : `Capture ${captureStatus}` : <Skeleton width="104px" height="16px" />} to="/knowledge/operations/capture" tint={failedRuns && failedRuns > 0 ? "255,122,112" : "138,180,255"} />
        </div>
      </section>

      <section className="overview-block">
        <div className="section-heading-row"><h2 className="section-heading">Recent ingest runs</h2><Link className="section-link" to="/knowledge/operations/ingest">View all runs</Link></div>
        <IngestRunList runs={snapshot?.runs ?? []} loading={!snapshot} isAdmin={isAdmin} />
        {projectName && <p className="default-project">Default project: <span>{projectName}</span></p>}
      </section>
    </div>
  );
}
