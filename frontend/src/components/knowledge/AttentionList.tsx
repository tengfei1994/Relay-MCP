import { Link } from "react-router-dom";

export interface AttentionListProps {
  pendingReview: number | undefined;
  unlinkedEvidence: number | undefined;
  failedRuns: number | undefined;
  isAdmin: boolean;
}

interface AttentionItem {
  label: string;
  to: string;
  value: number | undefined;
  tone: "sun" | "mint" | "coral";
}

export default function AttentionList({ pendingReview, unlinkedEvidence, failedRuns, isAdmin }: AttentionListProps) {
  const items: AttentionItem[] = [
    { label: "Candidate insights waiting for review", to: "/knowledge/candidate-insights", value: pendingReview, tone: "sun" },
    { label: "Evidence not linked to any knowledge", to: "/knowledge/evidence", value: unlinkedEvidence, tone: "mint" },
    { label: "Imports that failed", to: isAdmin ? "/knowledge/product-docs/imports" : "/knowledge/operations/ingest", value: failedRuns, tone: "coral" },
  ];
  const hasAttention = items.some((item) => item.value === undefined || item.value > 0);

  if (!hasAttention) return <p className="attention-empty">Nothing needs attention</p>;

  return (
    <div className="attention-list">
      {items.map((item) => {
        const active = item.value === undefined || item.value > 0;
        return (
          <Link className="attention-row" to={item.to} key={item.label}>
            <span>{item.label}</span>
            <b className={active ? `attention-${item.tone}` : "text-muted"}>{item.value === undefined ? "—" : item.value}</b>
          </Link>
        );
      })}
    </div>
  );
}
