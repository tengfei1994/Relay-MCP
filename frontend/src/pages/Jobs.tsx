import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowRight, RefreshCw } from "lucide-react";
import { api, type RelayJob, type RelayJobLog } from "../api/client";
import { AppPageFrame } from "../components/shell/AppPageFrame";
import { Button, Dialog, EmptyState, ErrorState, Field, Select, Skeleton, StatusPill } from "../components/ui";
import { useProjectScope } from "../context/ProjectScope";

const states = [
  ["all", "All statuses"], ["running", "Running"], ["succeeded", "Succeeded"], ["failed", "Failed"],
  ["cancelled", "Cancelled"], ["interrupted", "Interrupted"], ["unknown", "Unknown"],
] as const;

type JobDetails = RelayJob & { logs: RelayJobLog[]; target?: { server: string; instance?: string | null } };

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString() : "—";
}

function JobDetail({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [job, setJob] = useState<JobDetails>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [level, setLevel] = useState("all");

  useEffect(() => {
    let active = true;
    let next: number | undefined;
    async function load() {
      try {
        const result = await api.job(jobId);
        if (!active) return;
        setJob(result.job);
        setError(false);
        if (result.job.status === "running") next = window.setTimeout(load, 5000);
      } catch {
        if (active) setError(true);
      }
    }
    void load();
    return () => { active = false; window.clearTimeout(next); };
  }, [jobId, attempt]);

  const logs = job?.logs.filter((entry) => level === "all" || entry.level === level) ?? [];
  return (
    <Dialog open onClose={onClose} title={job ? job.kind.replaceAll("_", " ") : "Job details"} description={job?.description} wide>
      {error && <ErrorState message="Could not load job details" onRetry={() => { setError(false); setAttempt((value) => value + 1); }} />}
      {!job && !error && <Skeleton className="h-24 w-full" aria-label="Loading job details" />}
      {job && (
        <div className="space-y-5">
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div><dt className="text-muted">Status</dt><dd><StatusPill status={job.status} /></dd></div>
            <div><dt className="text-muted">Project</dt><dd>{job.project || "—"}</dd></div>
            <div><dt className="text-muted">Target</dt><dd>{job.target ? [job.target.server, job.target.instance].filter(Boolean).join(" · ") : "Not recorded"}</dd></div>
            <div><dt className="text-muted">Environment</dt><dd>{job.environment ?? "Not recorded"}</dd></div>
            <div><dt className="text-muted">Started</dt><dd>{formatDate(job.startedAt)}</dd></div>
            <div><dt className="text-muted">Finished</dt><dd>{formatDate(job.finishedAt)}</dd></div>
            {job.phase && <div><dt className="text-muted">Phase</dt><dd>{job.phase.replaceAll("_", " ")}</dd></div>}
            {job.errorCategory && <div><dt className="text-muted">Error category</dt><dd>{job.errorCategory}</dd></div>}
            {job.retryOf && <div className="col-span-2"><dt className="text-muted">Retried job</dt><dd className="break-all">{job.retryOf}</dd></div>}
          </dl>
          {job.status === "failed" && <p className="text-sm text-muted">{job.retrySafe
            ? "This job was marked safe to retry. Run the original operation again in your MCP client."
            : "Check the logs and verify the result on the target before running the operation again."}</p>}
          <section aria-labelledby="job-log-heading">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
              <h3 id="job-log-heading" className="font-medium">Recent logs</h3>
              <Field label="Log level"><Select value={level} onChange={(event) => setLevel(event.target.value)}>
                <option value="all">All levels</option><option value="info">Info</option><option value="stdout">Output</option><option value="stderr">Errors</option>
              </Select></Field>
            </div>
            {logs.length ? <ol className="max-h-72 divide-y divide-line overflow-y-auto rounded-field border border-line bg-[var(--bg-0)]">
              {logs.map((entry, index) => <li key={entry.at + index} className="px-3 py-2">
                <p className="text-xs text-muted">{formatDate(entry.at)} · {entry.level}</p>
                <pre className="whitespace-pre-wrap break-all text-xs">{entry.message}</pre>
              </li>)}
            </ol> : <p className="text-sm text-muted">{level === "all" ? "No logs recorded." : "No logs match this level."}</p>}
          </section>
        </div>
      )}
    </Dialog>
  );
}

export default function JobsPage({ embedded = false }: { embedded?: boolean }) {
  const { selectedProject } = useProjectScope();
  const [jobs, setJobs] = useState<RelayJob[]>();
  const [status, setStatus] = useState("all");
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("job");
  function showJob(id?: string) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (id) next.set("job", id);
      else next.delete("job");
      return next;
    }, { replace: true });
  }
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(true);

  useEffect(() => {
    let active = true;
    let next: number | undefined;
    async function load() {
      try {
        const result = await api.listJobs();
        if (!active) return;
        setJobs(result.jobs);
        setError(false);
        if (result.jobs.some((job) => job.status === "running")) next = window.setTimeout(load, 5000);
      } catch {
        if (active) setError(true);
      } finally {
        if (active) setRefreshing(false);
      }
    }
    void load();
    return () => { active = false; window.clearTimeout(next); };
  }, [attempt]);

  function refresh() {
    setRefreshing(true);
    setAttempt((value) => value + 1);
  }

  const visible = jobs?.filter((job) =>
    (status === "all" || job.status === status) &&
    (!selectedProject || (job.projectId ? job.projectId === String(selectedProject.id) : job.project === selectedProject.name)),
  );
  const content = (
    <>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl font-semibold">Jobs</h1><p className="text-sm text-muted">{selectedProject?.name ?? "All projects"}</p></div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Status"><Select value={status} onChange={(event) => setStatus(event.target.value)}>
            {states.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select></Field>
          <Button variant="ghost" onClick={refresh} loading={refreshing}><RefreshCw size={16} aria-hidden="true" />Refresh</Button>
        </div>
      </header>
      {error && <ErrorState role="alert" className="mb-3" message="Could not load jobs" onRetry={refresh} />}
      {!jobs && !error && <div role="status" aria-label="Loading jobs"><Skeleton className="h-24 w-full" /></div>}
      {visible && !visible.length && !error && <EmptyState title={status === "all" ? "No jobs found" : "No jobs match this status"}
        description={status === "all" ? "Jobs appear here after an asynchronous operation in an MCP client." : "Choose a different status to see more jobs."}
        action={status === "all" ? undefined : <Button variant="ghost" onClick={() => setStatus("all")}>Clear filter</Button>} />}
      {visible && visible.length > 0 && (
        <ul className="divide-y divide-line rounded-panel border border-line bg-white">
          {visible.map((job) => <li key={job.id}>
            <button type="button" className="grid min-h-16 w-full grid-cols-[minmax(0,1fr)_auto_18px] items-center gap-3 px-4 py-2 text-left hover:bg-[var(--hover)]" onClick={() => showJob(job.id)}>
              <span className="min-w-0"><strong className="block break-words font-medium">{job.kind.replaceAll("_", " ")}</strong>
                                {job.description && <span className="block text-sm text-muted">{job.description}</span>}
                <span className="block text-sm text-muted">{formatDate(job.startedAt)}{job.environment && " · " + job.environment}</span></span>
              <StatusPill status={job.status} /><ArrowRight size={16} aria-hidden="true" />
            </button>
          </li>)}
        </ul>
      )}
      {selectedId && <JobDetail key={selectedId} jobId={selectedId} onClose={() => showJob()} />}
    </>
  );
  return embedded ? content : <AppPageFrame>{content}</AppPageFrame>;
}
