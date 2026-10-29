import { Link, useNavigate } from "react-router-dom";
import { EmptyState, Button, GlassPanel, SegmentedBar, Skeleton, StatusPill } from "../ui";
import { statusLabel, toneOf } from "../../lib/status";

export interface IngestRun {
  id: string;
  sourceLocator?: string;
  status?: string;
  imported: number;
  skipped: number;
  failed: number;
}

interface IngestRunListProps {
  runs: IngestRun[];
  loading?: boolean;
  isAdmin: boolean;
}

export default function IngestRunList({ runs, loading = false, isAdmin }: IngestRunListProps) {
  const navigate = useNavigate();
  if (loading) {
    return (
      <GlassPanel className="ingest-runs" aria-busy="true" aria-label="Loading ingest runs">
        {Array.from({ length: 3 }, (_, index) => <div className="ingest-skeleton" key={index}><Skeleton width="100%" height="12px" /><Skeleton width="100%" height="6px" /><Skeleton width="72px" height="18px" /></div>)}
      </GlassPanel>
    );
  }

  if (runs.length === 0) {
    return (
      <EmptyState
        title="No ingest runs yet"
        description="Import product documents to start one."
        action={isAdmin ? <Button variant="primary" onClick={() => navigate("/knowledge/product-docs/imports")}>Import documents</Button> : undefined}
      />
    );
  }

  return (
    <GlassPanel className="ingest-runs">
      {runs.slice(0, 5).map((run, index) => {
        const imported = Math.max(0, run.imported);
        const skipped = Math.max(0, run.skipped);
        const failed = Math.max(0, run.failed);
        const status = run.status ?? "unknown";
        const label = statusLabel(status);
        const tone = toneOf(status);
        return (
          <Link className={`ingest-run${index > 0 ? " ingest-run-border" : ""}`} to={`/knowledge/operations/ingest?run=${encodeURIComponent(run.id)}`} key={run.id}>
            <div className="min-w-0">
              <div className="ingest-path">{run.sourceLocator ?? run.id}</div>
              <div className="ingest-meta">{imported} imported, {skipped} skipped, {failed} failed</div>
            </div>
            <SegmentedBar imported={imported} skipped={skipped} failed={failed} />
            <span className="justify-self-end" data-tone={tone} aria-label={label}><StatusPill status={status} /></span>
          </Link>
        );
      })}
    </GlassPanel>
  );
}
