import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { api } from "../api/client";
import { Badge, formatDate } from "./KnowledgePrimitives";

type HistoryKind = "events" | "dead-letter";

export default function CaptureHistory({ kind, refresh }: { kind: HistoryKind; refresh: number }) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [jump, setJump] = useState("1");
  const requestId = useRef(0);
  const title = kind === "events" ? "Recent events" : "Dead-letter details";
  const pages = Math.max(1, Math.ceil(total / size));
  useEffect(() => { setJump(String(page)); }, [page]);
  useEffect(() => {
    const id = ++requestId.current;
    setBusy(true); setError(""); setRows([]);
    const request = kind === "events" ? api.knowledgeOperationsCaptureEvents(size, (page - 1) * size) : api.knowledgeOperationsDeadLetters(size, (page - 1) * size);
    request.then((result) => {
      if (id !== requestId.current) return;
      const count = Number(result.page.total);
      setTotal(count);
      const last = Math.max(1, Math.ceil(count / size));
      if (page > last) { setPage(last); return; }
      setRows(kind === "events" ? result.events : result.deadLetters);
    }).catch((err) => {
      if (id === requestId.current) setError(err instanceof Error ? err.message : "Unable to load history");
    }).finally(() => { if (id === requestId.current) setBusy(false); });
    return () => { requestId.current++; };
  }, [kind, page, size, refresh, retry]);

  const numbers = [...new Set([1, pages, ...Array.from({ length: 5 }, (_, i) => page + i - 2)])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const buttonClass = "inline-flex h-8 min-w-8 items-center justify-center rounded border border-gray-700 px-2 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-40";
  return <section className="min-w-0 border-t border-gray-800 py-4" aria-label={title} aria-busy={busy}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-medium text-gray-100">{title}</h3>
      <label className="flex items-center gap-2 text-xs text-gray-400">Rows per page
        <select aria-label={`${title} rows per page`} disabled={busy} value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }} className="rounded border border-gray-700 bg-gray-950 p-1.5">
          {[10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </div>
    {error ? <div role="alert" className="my-4 break-words text-sm text-rose-300">{error}<button onClick={() => setRetry((n) => n + 1)} className={`${buttonClass} ml-2`}><RefreshCw size={14} className="mr-1" />Retry</button></div>
      : busy ? <p role="status" className="py-4 text-sm text-gray-400">Loading page {page}...</p>
      : rows.length === 0 ? <p className="py-4 text-sm text-gray-400">No records.</p>
      : <div className="mt-3 max-h-[32rem] divide-y divide-gray-800 overflow-y-auto">
        {rows.map((row, index) => <div key={row.id ?? `${row.sourcePath}:${row.lineNumber ?? index}`} className="min-w-0 py-3 [overflow-wrap:anywhere]">
          {kind === "events" ? <>
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm text-gray-200">{row.type}</span><Badge>{(row.payloadKeys ?? []).length} payload fields</Badge></div>
            <p className="mt-1 text-xs text-gray-400">{formatDate(row.occurredAt)} · {row.jobId ?? "no job"} · {row.deploymentId ?? "no deployment"}</p>
            <p className="mt-1 text-xs text-gray-500">{row.id}</p>
          </> : <>
            <p className="text-sm text-rose-200">{row.error ?? "unknown error"}</p>
            <p className="mt-1 text-xs text-gray-400">{row.eventId ?? "no event ID"} · attempts {row.attempts ?? "unknown"}</p>
            <p className="mt-1 text-xs text-gray-500">{row.sourcePath} · line {row.lineNumber}</p>
          </>}
        </div>)}
      </div>}
    <nav aria-label={`${title} pagination`} className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-gray-800 pt-3">
      <span className="text-xs text-gray-400">{total === 0 ? 0 : (page - 1) * size + 1}-{Math.min(page * size, total)} of {total} · Page {page} of {pages}</span>
      <div className="flex flex-wrap items-center gap-1">
        <button title="Previous page" aria-label={`${title} previous page`} disabled={busy || page === 1} onClick={() => setPage((n) => n - 1)} className={buttonClass}><ChevronLeft size={14} /></button>
        {numbers.map((n, i) => <span key={n} className="inline-flex items-center gap-1">{i > 0 && n - numbers[i - 1] > 1 && <span className="px-1 text-gray-500">...</span>}<button aria-label={`${title} page ${n}`} aria-current={n === page ? "page" : undefined} disabled={busy} onClick={() => setPage(n)} className={`${buttonClass} ${n === page ? "border-cyan-500 bg-cyan-950 text-cyan-100" : ""}`}>{n}</button></span>)}
        <button title="Next page" aria-label={`${title} next page`} disabled={busy || page === pages} onClick={() => setPage((n) => n + 1)} className={buttonClass}><ChevronRight size={14} /></button>
      </div>
      <form className="flex items-center gap-2 text-xs text-gray-400" onSubmit={(e) => { e.preventDefault(); const n = Number(jump); if (Number.isInteger(n) && n >= 1 && n <= pages) setPage(n); }}>
        <label>Go to page <input aria-label={`${title} page number`} type="number" min={1} max={pages} value={jump} onChange={(e) => setJump(e.target.value)} className="ml-1 h-8 w-16 rounded border border-gray-700 bg-gray-950 px-2" /></label>
        <button disabled={busy} className={buttonClass}>Go</button>
      </form>
    </nav>
  </section>;
}
