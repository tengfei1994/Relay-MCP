import type { CSSProperties } from "react";
import type { WellState } from "../../lib/plate";

const rows = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
const stateLabel: Record<WellState, string> = {
  ok: "current",
  stale: "stale",
  fail: "failed",
  wait: "waiting to index",
};
type PlateCounts = Record<WellState, number>;

interface IndexPlateProps {
  wells: WellState[];
  batchSize: number;
  loading?: boolean;
  animationKey?: number;
}

function brightness(index: number): number {
  let seed = 7;
  for (let i = 0; i <= index; i += 1) seed = (seed * 9301 + 49297) % 233280;
  return 0.82 + (seed / 233280) * 0.3;
}

export default function IndexPlate({ wells, batchSize, loading = false, animationKey = 0 }: IndexPlateProps) {
  const safeWells = wells.length === 96 ? wells : Array.from({ length: 96 }, () => "wait" as WellState);
  const counts: PlateCounts = { ok: 0, stale: 0, fail: 0, wait: 0 };
  for (const state of safeWells) counts[state] += 1;
  const ariaLabel = `Index coverage: ${counts.ok} of 96 batches current, ${counts.stale} stale, ${counts.fail} failed, ${counts.wait} waiting`;

  return (
    <div className="plate-shell">
      <div key={animationKey} className={`plate${loading ? " plate-loading" : ""}`} role="img" aria-label={ariaLabel}>
        <div className="plate-grid">
          <span aria-hidden="true" />
          {Array.from({ length: 12 }, (_, index) => <span className="plate-axis" key={`column-${index + 1}`}>{index + 1}</span>)}
          {rows.flatMap((row, rowIndex) => [
            <span className="plate-axis" aria-hidden="true" key={`row-${row}`}>{row}</span>,
            ...Array.from({ length: 12 }, (_, columnIndex) => {
              const index = rowIndex * 12 + columnIndex;
              const state = safeWells[index];
              const style: CSSProperties = loading
                ? { "--b": "1", "--d": "0ms" } as CSSProperties
                : { "--b": String(brightness(index)), "--d": `${(rowIndex + columnIndex) * 35}ms` } as CSSProperties;
              const location = `${row}${columnIndex + 1}`;
              const tooltip = `${location}, ${stateLabel[state]}${batchSize > 1 ? `, about ${batchSize} documents` : ""}`;
              return <span className={`well ${state}`} key={location} style={style} title={tooltip} />;
            }),
          ])}
        </div>
      </div>
    </div>
  );
}
