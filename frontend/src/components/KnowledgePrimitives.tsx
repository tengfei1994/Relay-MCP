import { Link, NavLink } from "react-router-dom";
import { AlertCircle, CheckCircle2, Clock3, Database, FileText, GitBranch, Loader2, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

export const inputClass = "h-9 rounded-md border border-gray-800 bg-gray-900 px-3 text-sm text-gray-200 outline-none focus:border-indigo-500";
export const cardClass = "rounded-xl border border-gray-800 bg-gray-900/70 p-4 shadow-sm";

export function PageShell({ title, description, breadcrumbs, actions, children }: { title: string; description?: string; breadcrumbs?: Array<{ label: string; to?: string }>; actions?: ReactNode; children: ReactNode }) {
  return <div className="min-h-full p-4 sm:p-6 lg:p-8">
    <div className="mx-auto max-w-[1600px]">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {breadcrumbs && <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">{breadcrumbs.map((item, index) => <span key={`${item.label}-${index}`} className="flex items-center gap-2">{index > 0 && <span>/</span>}{item.to ? <Link to={item.to} className="hover:text-gray-200">{item.label}</Link> : <span className="text-gray-300">{item.label}</span>}</span>)}</div>}
          <h2 className="text-2xl font-semibold tracking-tight text-gray-100">{title}</h2>
          {description && <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-400">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  </div>;
}

export function StatePanel({ state, message, onRetry }: { state: "loading" | "error" | "empty"; message: string; onRetry?: () => void }) {
  const Icon = state === "loading" ? Loader2 : state === "error" ? AlertCircle : FileText;
  return <div className={`${cardClass} flex min-h-32 flex-col items-center justify-center gap-2 text-center`}>
    <Icon size={22} className={state === "error" ? "text-rose-400" : "text-gray-500" + (state === "loading" ? " animate-spin" : "")} />
    <p className="max-w-lg text-sm text-gray-400">{message}</p>
    {onRetry && state === "error" && <button onClick={onRetry} className="inline-flex items-center gap-2 rounded-md border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"><RefreshCw size={13} /> Retry</button>}
  </div>;
}

export function Badge({ children, tone = "gray" }: { children: ReactNode; tone?: "gray" | "green" | "amber" | "rose" | "blue" | "purple" }) {
  const tones = { gray: "border-gray-700 bg-gray-800 text-gray-300", green: "border-emerald-800/70 bg-emerald-950/60 text-emerald-300", amber: "border-amber-800/70 bg-amber-950/60 text-amber-300", rose: "border-rose-800/70 bg-rose-950/60 text-rose-300", blue: "border-cyan-800/70 bg-cyan-950/60 text-cyan-300", purple: "border-indigo-800/70 bg-indigo-950/60 text-indigo-300" };
  return <span className={`inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}><span className="truncate">{children}</span></span>;
}

export function StatusBadge({ value }: { value: unknown }) {
  const text = String(value ?? "unknown");
  const tone = /failed|error|deprecated|rejected/i.test(text) ? "rose" : /warning|partial|needs_review|stale|queued|running/i.test(text) ? "amber" : /approved|succeeded|verified|ready|healthy|accepted/i.test(text) ? "green" : "gray";
  return <Badge tone={tone}>{text.replaceAll("_", " ")}</Badge>;
}

export function ScopeBanner({ project, environment, scope = "project runtime", acl = "owner / granted reviewers" }: { project?: string; environment?: string; scope?: string; acl?: string }) {
  return <div className={`${cardClass} mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 border-indigo-900/60 bg-indigo-950/20`}>
    <div className="flex items-center gap-2 text-sm"><Database size={15} className="text-indigo-300" /><span className="text-gray-500">Project</span><span className="font-medium text-gray-200">{project || "Global"}</span></div>
    <div className="flex items-center gap-2 text-sm"><Clock3 size={15} className="text-indigo-300" /><span className="text-gray-500">Environment</span><span className="font-medium text-gray-200">{environment || (project ? "not selected" : "all")}</span></div>
    <div className="flex items-center gap-2 text-sm"><GitBranch size={15} className="text-indigo-300" /><span className="text-gray-500">Scope</span><span className="font-medium text-gray-200">{scope}</span></div>
    <div className="flex items-center gap-2 text-sm"><LockKeyhole size={15} className="text-indigo-300" /><span className="text-gray-500">ACL</span><span className="font-medium text-gray-200">{acl}</span></div>
  </div>;
}

const pipeline = [
  ["Evidence", "/knowledge/evidence", ShieldCheck],
  ["Observation", "/knowledge/observations", Clock3],
  ["Candidate", "/knowledge/candidates", FileText],
  ["Case", "/knowledge/cases", CheckCircle2],
  ["Pattern", "/knowledge/patterns", GitBranch],
  ["Playbook", "/knowledge/playbooks", Database],
] as const;

export function LifecyclePipeline({ current }: { current?: string }) {
  return <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/50 p-3">{pipeline.map(([label, to, Icon], index) => <span key={label} className="flex items-center gap-2">{index > 0 && <span className="text-gray-700">→</span>}<NavLink to={to} className={({ isActive }) => `inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs ${isActive || current?.toLowerCase() === label.toLowerCase() ? "bg-indigo-600/20 text-indigo-200 ring-1 ring-indigo-500/50" : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"}`}><Icon size={13} />{label}</NavLink></span>)}</div>;
}

export function formatDate(value: unknown): string { const date = new Date(String(value ?? "")); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(); }
export function confidenceLabel(value: unknown): string { const score = Number(value); if (!Number.isFinite(score)) return "Not scored"; if (score < 0.4) return "Low · signal only"; if (score < 0.7) return "Medium · needs validation"; return "High · evidence-backed"; }
export function jsonValue(value: unknown, fallback: unknown = {}): any { if (value && typeof value === "object") return value; try { return JSON.parse(String(value ?? "")); } catch { return fallback; } }
