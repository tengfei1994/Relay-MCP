import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { api } from "../api/client";
import { Badge, formatDate } from "./KnowledgePrimitives";
import { Button, StatusPill } from "./ui";

type HistoryKind = "events" | "dead-letter";

type Page = { total: number; limit?: number; offset?: number };
interface CaptureEvent { id: string; type?: string; occurredAt?: string; jobId?: string; deploymentId?: string; payloadKeys?: string[] }
interface DeadLetter { id?: string; error?: string; eventId?: string; attempts?: number; sourcePath?: string; lineNumber?: number }
type HistoryResult = { page: Page; events?: CaptureEvent[]; deadLetters?: DeadLetter[] };

export default function CaptureHistory({ kind, refresh }: { kind: HistoryKind; refresh: number }) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<Array<CaptureEvent | DeadLetter>>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [jump, setJump] = useState("1");
  const requestId = useRef(0);
  const title = kind === "events" ? "Recent captures" : "Dead-letter details";
  const pages = Math.max(1, Math.ceil(total / size));

  useEffect(() => setJump(String(page)), [page]);
  useEffect(() => {
    const id = ++requestId.current;
    setBusy(true); setError("");
    const request = kind === "events"
      ? api.knowledgeOperationsCaptureEvents(size, (page - 1) * size)
      : api.knowledgeOperationsDeadLetters(size, (page - 1) * size);
    request.then((raw) => {
      if (id !== requestId.current) return;
      const result = raw as unknown as HistoryResult;
      const count = Number(result.page?.total ?? 0);
      setTotal(Number.isFinite(count) ? count : 0);
      const last = Math.max(1, Math.ceil(count / size));
      if (page > last) { setPage(last); return; }
      setRows(kind === "events" ? (result.events ?? []) : (result.deadLetters ?? []));
    }).catch((err: unknown) => {
      if (id === requestId.current) setError(err instanceof Error ? err.message : "Unable to load capture history");
    }).finally(() => { if (id === requestId.current) setBusy(false); });
    return () => { requestId.current++; };
  }, [kind, page, size, refresh, retry]);

  const numbers = [...new Set([1, pages, ...Array.from({ length: 5 }, (_, i) => page + i - 2)])]
    .filter((number) => number >= 1 && number <= pages).sort((a, b) => a - b);
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(page * size, total);
  return <section className="glass overflow-hidden" aria-label={title} aria-busy={busy}>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
      <div><h2 className="font-display text-[17px] font-semibold text-fg">{title}</h2><p className="mt-1 text-sm text-muted">Capture records are retained with safe provenance and no raw payloads.</p></div>
      <label className="flex items-center gap-2 text-xs text-muted">Rows per page
        <select aria-label={`${title} rows per page`} disabled={busy} value={size} onChange={(event) => { setSize(Number(event.target.value)); setPage(1); }} className="h-8 rounded-field border border-line bg-[var(--field)] px-2 text-fg">
          {[10, 20, 50].map((number) => <option key={number} value={number}>{number}</option>)}
        </select>
      </label>
    </div>
    {error ? <div role="alert" className="flex flex-wrap items-center gap-3 p-5 text-sm text-coral"><span>{error}</span><Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={14} /> Retry</Button></div>
      : busy ? <p role="status" className="p-5 text-sm text-muted">Loading capture history…</p>
      : rows.length === 0 ? <p className="p-5 text-sm text-muted">No capture records yet.</p>
      : <div className="divide-y divide-white/10">
        {rows.map((row, index) => {
          const event = row as CaptureEvent;
          const deadLetter = row as DeadLetter;
          const key = kind === "events" ? event.id : deadLetter.id ?? `${deadLetter.sourcePath ?? "dead-letter"}:${deadLetter.lineNumber ?? index}`;
          return <div key={key} className="min-w-0 px-5 py-4 [overflow-wrap:anywhere]">
            {kind === "events" ? <>
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-fg">{event.type ?? "Unknown event"}</span><Badge>{event.payloadKeys?.length ?? 0} payload fields</Badge></div>
              <p className="mt-1 text-xs text-muted">{formatDate(event.occurredAt)}, {event.jobId ?? "no job"}, {event.deploymentId ?? "no deployment"}</p>
              <p className="mt-1 font-mono text-xs text-muted/80">{event.id}</p>
            </> : <>
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-coral">{deadLetter.error ?? "Unknown error"}</span><StatusPill status="failed" /></div>
              <p className="mt-1 text-xs text-muted">{deadLetter.eventId ?? "no event ID"}, attempts {deadLetter.attempts ?? "unknown"}</p>
              <p className="mt-1 font-mono text-xs text-muted/80">{deadLetter.sourcePath ?? "unknown source"}, line {deadLetter.lineNumber ?? "unknown"}</p>
            </>}
          </div>;
        })}
      </div>}
    <nav aria-label={`${title} pagination`} className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-5 py-4">
      <span className="text-xs text-muted">Showing <span className="font-mono text-fg">{from}</span> to <span className="font-mono text-fg">{to}</span> of <span className="font-mono text-fg">{total}</span></span>
      <div className="flex items-center gap-1"><Button variant="ghost" size="sm" aria-label={`${title} previous page`} disabled={busy || page === 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={14} /></Button>
        {numbers.map((number, index) => <span key={number} className="inline-flex items-center gap-1">{index > 0 && number - numbers[index - 1] > 1 && <span className="px-1 text-muted">…</span>}<button aria-label={`${title} page ${number}`} aria-current={number === page ? "page" : undefined} disabled={busy} onClick={() => setPage(number)} className={`h-8 min-w-8 rounded-ctl px-2 text-xs ${number === page ? "bg-mint text-ink" : "text-muted hover:bg-white/10 hover:text-fg"}`}>{number}</button></span>)}
        <Button variant="ghost" size="sm" aria-label={`${title} next page`} disabled={busy || page === pages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={14} /></Button>
      </div>
      <form className="flex items-center gap-2 text-xs text-muted" onSubmit={(event) => { event.preventDefault(); const number = Number(jump); if (Number.isInteger(number) && number >= 1 && number <= pages) setPage(number); }}>
        <label>Go to page <input aria-label={`${title} page number`} type="number" min={1} max={pages} value={jump} onChange={(event) => setJump(event.target.value)} className="ml-1 h-8 w-16 rounded-field border border-line bg-[var(--field)] px-2 text-fg" /></label><Button variant="ghost" size="sm" disabled={busy}>Go</Button>
      </form>
    </nav>
  </section>;
}
