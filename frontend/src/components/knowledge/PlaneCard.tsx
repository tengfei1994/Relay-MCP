import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { GlassPanel } from "../ui";

interface PlaneCardProps {
  title: string;
  description: string;
  footnote: ReactNode;
  to: string;
  tint: string;
}

export default function PlaneCard({ title, description, footnote, to, tint }: PlaneCardProps) {
  const style = { "--tint": tint } as CSSProperties;
  return (
    <Link to={to} className="plane-card-link" style={style}>
      <GlassPanel className="plane-card h-full">
        <div>
          <h3 className="font-display text-2xl font-semibold tracking-tight text-wrap-balance">{title}</h3>
          <p className="mt-2 max-w-[30ch] text-sm text-muted">{description}</p>
        </div>
        <span className="mt-auto font-mono text-[13px] font-medium" style={{ color: `rgb(${tint})` }}>{footnote}</span>
      </GlassPanel>
    </Link>
  );
}

export type { PlaneCardProps };
