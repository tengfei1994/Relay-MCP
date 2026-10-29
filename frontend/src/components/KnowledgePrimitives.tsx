import { Link, NavLink } from "react-router-dom";
import { AlertCircle, Clock3, Database, FileText, GitBranch, Loader2, LockKeyhole, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

export const inputClass = "h-[38px] rounded-field border border-line bg-[var(--field)] px-3 text-sm text-fg outline-none transition placeholder:text-muted/70 hover:border-line-strong focus:border-mint focus:ring-2 focus:ring-mint/20";
export const cardClass = "glass rounded-panel p-4";

type Breadcrumb = { label: string; to?: string };
type BadgeTone = "muted" | "mint" | "sun" | "coral" | "gray" | "green" | "amber" | "rose" | "blue" | "purple";

export function PageShell({ title, description, breadcrumbs, actions, children }: { title: string; description?: string; breadcrumbs?: Breadcrumb[]; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-[1280px] px-5 py-8 pb-16 sm:px-8 sm:py-10 sm:pb-24 lg:px-10">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            {breadcrumbs && (
              <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                {breadcrumbs.map((item, index) => (
                  <span key={`${item.label}-${index}`} className="flex items-center gap-2">
                    {index > 0 && <span aria-hidden="true">/</span>}
                    {item.to ? <Link to={item.to} className="transition-colors hover:text-fg">{item.label}</Link> : <span className="text-fg">{item.label}</span>}
                  </span>
                ))}
              </nav>
            )}
            <h1 className="font-display text-[30px] font-semibold leading-tight tracking-[-.02em] text-fg">{title}</h1>
            {description && <p className="mt-2 max-w-[68ch] text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center justify-end gap-3">{actions}</div>}
        </header>
        {children}
      </div>
    </div>
  );
}

export function StatePanel({ state, message, onRetry }: { state: "loading" | "error" | "empty"; message: string; onRetry?: () => void }) {
  const Icon = state === "loading" ? Loader2 : state === "error" ? AlertCircle : FileText;
  const iconClass = state === "loading" ? "animate-spin text-mint" : state === "error" ? "text-coral" : "text-muted";
  return (
    <div className={`${cardClass} flex min-h-32 flex-col items-center justify-center gap-3 text-center`}>
      <Icon size={22} className={iconClass} />
      <p className="max-w-lg text-sm text-muted">{message}</p>
      {onRetry && state === "error" && <button onClick={onRetry} className="inline-flex min-h-9 items-center gap-2 rounded-ctl border border-line px-3 text-xs text-fg transition-colors hover:bg-white/[.06]"><RefreshCw size={13} /> Retry</button>}
    </div>
  );
}

const badgeTones: Record<BadgeTone, string> = {
  muted: "border-white/[.16] bg-white/[.04] text-muted",
  mint: "border-mint/40 bg-mint/10 text-mint",
  sun: "border-sun/40 bg-sun/10 text-sun",
  coral: "border-coral/40 bg-coral/10 text-coral",
  gray: "border-white/[.16] bg-white/[.04] text-muted",
  green: "border-mint/40 bg-mint/10 text-mint",
  amber: "border-sun/40 bg-sun/10 text-sun",
  rose: "border-coral/40 bg-coral/10 text-coral",
  blue: "border-mint/40 bg-mint/10 text-mint",
  purple: "border-white/[.16] bg-white/[.04] text-muted",
};

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: BadgeTone }) {
  return <span className={`inline-flex max-w-full items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${badgeTones[tone]}`}><span className="truncate">{children}</span></span>;
}

function sentenceCase(value: unknown): string {
  const text = String(value ?? "unknown").trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Unknown";
}

export function StatusBadge({ value }: { value: unknown }) {
  const text = String(value ?? "unknown");
  const tone: BadgeTone = /failed|error|deprecated|rejected/i.test(text) ? "coral" : /warning|partial|needs_review|stale|queued|running/i.test(text) ? "sun" : /approved|succeeded|verified|ready|healthy|accepted/i.test(text) ? "mint" : "muted";
  return <Badge tone={tone}>{sentenceCase(value)}</Badge>;
}

export function ScopeBanner({ project, environment, scope = "project runtime", acl = "owner / granted reviewers" }: { project?: string; environment?: string; scope?: string; acl?: string }) {
  const items = [
    { label: "Project", value: project || "Global", Icon: Database },
    { label: "Environment", value: environment || (project ? "not selected" : "all"), Icon: Clock3 },
    { label: "Scope", value: scope, Icon: GitBranch },
    { label: "ACL", value: acl, Icon: LockKeyhole },
  ];
  return (
    <div className={`${cardClass} mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 border-mint/20 bg-mint/[.04]`}>
      {items.map(({ label, value, Icon }) => (
        <div key={label} className="flex items-center gap-2 text-sm">
          <Icon size={15} className="text-mint" />
          <span className="text-muted">{label}</span>
          <span className="font-medium text-fg">{value}</span>
        </div>
      ))}
    </div>
  );
}

export function LifecyclePipeline({ current }: { current?: string }) {
  const tabs = [["Sessions", "/knowledge/sessions"], ["Evidence", "/knowledge/evidence"], ["Observations", "/knowledge/observations"], ["Candidate Insights", "/knowledge/candidate-insights"], ["Confirmed Memory", "/knowledge/confirmed-memory"]] as const;
  return (
    <nav className="glass flex max-w-full flex-wrap gap-1 rounded-full border-line bg-[var(--field)] p-1" aria-label="Memory workspace">
      {tabs.map(([label, to]) => (
        <NavLink key={label} to={to} className={({ isActive }) => `inline-flex min-h-8 items-center rounded-full px-3.5 py-1.5 text-sm transition-colors ${isActive || current?.toLowerCase() === label.toLowerCase() ? "bg-white/[.10] text-fg" : "text-muted hover:text-fg"}`}>{label}</NavLink>
      ))}
    </nav>
  );
}

export function formatDate(value: unknown): string {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function confidenceLabel(value: unknown): string {
  const score = Number(value);
  if (!Number.isFinite(score)) return "Not scored";
  if (score < 0.4) return "Low · signal only";
  if (score < 0.7) return "Medium · needs validation";
  return "High · evidence-backed";
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonValue(value: unknown, fallback: JsonRecord = {}): JsonRecord {
  if (isJsonRecord(value)) return value;
  try {
    const parsed: unknown = JSON.parse(String(value ?? ""));
    return isJsonRecord(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
