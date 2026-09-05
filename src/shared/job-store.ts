import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { validateStateId } from "./state-id.js";
import { RemoteCommandTimeoutError } from "./remote-runner.js";
import { emitRelayEvent, type RelayEventSink } from "../knowledge/event-sink.js";
import { sanitizeAuditArguments } from "./audit-sanitizer.js";
import "dotenv/config";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const STATE_ROOT = process.env.RELAY_STATE_ROOT ?? join(WORKSPACE_ROOT, ".relay-mcp");
const JOB_ROOT = join(STATE_ROOT, "jobs");
const AUDIT_PATH = join(STATE_ROOT, "audit.jsonl");
const MAX_JOB_LOGS = Number(process.env.RELAY_JOB_LOG_LIMIT ?? 200);

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";

export interface JobLogEntry {
  at: string;
  level: "info" | "stdout" | "stderr";
  message: string;
}

export interface JobRecord {
  id: string;
  userId: number;
  username: string;
  project: string;
  kind: string;
  status: JobStatus;
  phase?: string;
  lastHeartbeatAt?: string;
  errorCategory?: string;
  retrySafe?: boolean;
  input: unknown;
  summary?: string;
  error?: string;
  logs?: JobLogEntry[];
  startedAt: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  cancelReason?: string;
  retryOf?: string;
  retryAttempt?: number;
  retryReason?: string;
  /** Persisted once the started event has been durably written to the spool. */
  startedEventEmittedAt?: string;
  /** Persisted once the terminal event has been durably written to the spool. */
  terminalEventEmittedAt?: string;
  /** Preserves interrupted-vs-unknown semantics during startup recovery. */
  terminalEventKind?: "finished" | "failed" | "cancelled" | "unknown" | "interrupted";
  /** Stable project identity used to make terminal-event replay immutable. */
  projectIdSnapshot?: string;
}

export interface JobRetryOptions {
  /** ID of the prior job execution being retried. */
  retryOf: string;
  /** One-based execution attempt number for the retried job. */
  retryAttempt?: number;
  /** Bounded human-readable reason for the retry. */
  retryReason?: string;
}

export interface JobContext {
  signal: AbortSignal;
  log: (message: string, level?: JobLogEntry["level"]) => void;
  phase: (name: string) => void;
}

export interface JobWaitOptions {
  waitMs?: number;
  pollMs?: number;
  returnOnPhaseChange?: boolean;
}

export interface JobWaitResult {
  job: JobRecord;
  reason: "terminal" | "wait_timeout" | "phase_changed";
  initialPhase?: string;
  waitedMs: number;
}

function structuredErrorSummary(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("evidence" in error)) return undefined;
  try {
    const evidence = sanitizeAuditArguments((error as { evidence: unknown }).evidence);
    return boundedText(JSON.stringify(evidence), 8_000);
  } catch {
    return JSON.stringify({ serializationError: "Structured error evidence could not be serialized" });
  }
}

/** Keep retained Knowledge context within a strict character bound. */
function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = `\n... truncated ${value.length - limit} character(s) ...\n`;
  if (marker.length >= limit) return marker.slice(0, limit);
  const contentLimit = limit - marker.length;
  const head = Math.floor(contentLimit * 0.6);
  const tail = contentLimit - head;
  return `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(-tail) : ""}`;
}

function boundedSanitizedText(value: string, limit: number): string {
  const sanitized = sanitizeAuditArguments(boundedText(value, limit));
  return typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
}

/** Bounded and sanitized terminal context retained in Knowledge candidates. */
function knowledgeTerminalPayload(
  job: Pick<JobRecord, "status" | "kind" | "errorCategory" | "error" | "summary" | "phase" | "retrySafe" | "cancelRequestedAt" | "cancelReason" | "retryOf" | "retryAttempt" | "retryReason" | "input" | "logs">,
): Record<string, unknown> {
  const logs = (job.logs ?? []).slice(-50).map((entry) => ({
    at: entry.at,
    level: entry.level,
    message: boundedSanitizedText(entry.message, 2_000),
  }));
  return sanitizeAuditArguments({
    status: job.status,
    kind: job.kind,
    errorCategory: job.errorCategory,
    error: job.error ? boundedText(job.error, 4_000) : undefined,
    summary: job.summary ? boundedText(job.summary, 8_000) : undefined,
    phase: job.phase,
    retrySafe: job.retrySafe,
    cancelRequestedAt: job.cancelRequestedAt,
    cancelReason: job.cancelReason ? boundedSanitizedText(job.cancelReason, 2_000) : undefined,
    retryOf: job.retryOf,
    retryAttempt: job.retryAttempt,
    retryReason: job.retryReason,
    input: sanitizeAuditArguments(job.input),
    logs,
  }) as Record<string, unknown>;
}

function boundedRetryAttempt(value: number | undefined): number {
  const attempt = value !== undefined && Number.isFinite(value) ? Math.trunc(value) : 2;
  return Math.max(1, Math.min(1000, attempt));
}

const activeJobs = new Map<string, AbortController>();
let eventSink: RelayEventSink | undefined;
let resolveProjectId: ((userId: number, projectName: string) => number | undefined) | undefined;

function resolveProjectIdSnapshot(userId: number, projectName: string): string | undefined {
  try {
    const projectId = resolveProjectId?.(userId, projectName);
    return projectId === undefined ? undefined : String(projectId);
  } catch {
    // Project resolution is advisory for operational state. The event keeps
    // projectNameSnapshot so the capture worker can resolve it later.
    return undefined;
  }
}

function startedJobEvent(job: Pick<JobRecord, "id" | "userId" | "username" | "project" | "kind" | "input" | "startedAt" | "projectIdSnapshot">): Parameters<typeof emitRelayEvent>[1] {
  return {
    type: "job.started",
    eventKey: `job:${job.id}:started`,
    occurredAt: job.startedAt,
    actorId: job.userId,
    projectId: job.projectIdSnapshot,
    projectNameSnapshot: job.project,
    jobId: job.id,
    payload: { userId: job.userId, username: job.username, kind: job.kind, input: job.input },
  };
}

function emitStartedJobEvent(job: JobRecord): boolean {
  return emitRelayEvent(eventSink, startedJobEvent(job));
}

function markStartedJobEventEmitted(job: JobRecord): JobRecord {
  const marked = { ...job, startedEventEmittedAt: new Date().toISOString() };
  saveJob(marked);
  return marked;
}

function terminalJobEvent(job: JobRecord): Parameters<typeof emitRelayEvent>[1] | undefined {
  if (!job.finishedAt) return undefined;
  const eventKind = job.terminalEventKind ?? (job.status === "succeeded" ? "finished"
    : job.status === "failed" ? "failed"
      : job.status === "cancelled" ? "cancelled"
        : job.status === "unknown" ? "unknown"
          : job.status === "interrupted" ? "interrupted"
            : undefined);
  const eventType = eventKind === "finished" ? "job.finished"
    : eventKind === "failed" ? "job.failed"
      : eventKind === "cancelled" ? "job.cancelled"
        : eventKind === "unknown" ? "job.unknown"
          : eventKind === "interrupted" ? "job.interrupted"
            : undefined;
  const eventSuffix = eventKind;
  if (!eventType || !eventSuffix) return undefined;
  return {
    type: eventType,
    eventKey: `job:${job.id}:${eventSuffix}`,
    occurredAt: job.finishedAt,
    actorId: job.userId,
    projectId: job.projectIdSnapshot,
    projectNameSnapshot: job.project,
    jobId: job.id,
    payload: knowledgeTerminalPayload(job),
  };
}

function emitTerminalJobEvent(job: JobRecord): boolean {
  const event = terminalJobEvent(job);
  return event ? emitRelayEvent(eventSink, event) : false;
}

function markTerminalJobEventEmitted(job: JobRecord): JobRecord {
  const marked = { ...job, terminalEventEmittedAt: new Date().toISOString() };
  saveJob(marked);
  return marked;
}

/** Replay terminal records left without a durable event marker after a crash. */
export function recoverUnemittedTerminalJobEvents(): number {
  ensureState();
  let count = 0;
  for (const name of readdirSync(JOB_ROOT)) {
    if (!name.endsWith(".json")) continue;
    try {
      const job = JSON.parse(readFileSync(join(JOB_ROOT, name), "utf8")) as JobRecord;
      if (job.status === "running" || job.terminalEventEmittedAt || !job.finishedAt) continue;
      if (emitTerminalJobEvent(job)) {
        markTerminalJobEventEmitted(job);
        count += 1;
      }
    } catch {
      // Preserve malformed records for manual inspection.
    }
  }
  return count;
}

/** Replay running records left without a durable started event after a crash. */
export function recoverUnemittedStartedJobEvents(): number {
  ensureState();
  let count = 0;
  for (const name of readdirSync(JOB_ROOT)) {
    if (!name.endsWith(".json")) continue;
    try {
      const job = JSON.parse(readFileSync(join(JOB_ROOT, name), "utf8")) as JobRecord;
      if (job.status !== "running" || job.startedEventEmittedAt || !job.startedAt) continue;
      if (emitStartedJobEvent(job)) {
        markStartedJobEventEmitted(job);
        count += 1;
      }
    } catch {
      // Preserve malformed records for manual inspection.
    }
  }
  return count;
}

/** Composition-root injection point; tests can provide an isolated sink. */
export function configureJobStore(options: { eventSink?: RelayEventSink; resolveProjectId?: (userId: number, projectName: string) => number | undefined } = {}): void {
  eventSink = options.eventSink;
  resolveProjectId = options.resolveProjectId;
  recoverUnemittedStartedJobEvents();
  recoverUnemittedTerminalJobEvents();
}

function ensureState(): void {
  mkdirSync(JOB_ROOT, { recursive: true });
  mkdirSync(STATE_ROOT, { recursive: true });
}

function jobPath(id: string): string {
  return join(JOB_ROOT, `${validateStateId(id, "job id")}.json`);
}

export function writeAudit(entry: Record<string, unknown>): void {
  ensureState();
  const safeEntry = sanitizeAuditArguments(entry) as Record<string, unknown>;
  appendFileSync(AUDIT_PATH, JSON.stringify({ at: new Date().toISOString(), ...safeEntry }) + "\n", "utf8");
}

export function saveJob(job: JobRecord): void {
  ensureState();
  writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2), "utf8");
}

export function getJob(id: string): JobRecord | undefined {
  ensureState();
  const path = jobPath(id);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as JobRecord;
}

export function listJobs(userId: number, limit = 20): JobRecord[] {
  ensureState();
  return readdirSync(JOB_ROOT)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(JOB_ROOT, name), "utf8")) as JobRecord)
    .filter((job) => job.userId === userId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, Math.max(1, Math.min(limit, 100)));
}

export async function waitForJobRecord(
  id: string,
  userId: number,
  options: JobWaitOptions = {}
): Promise<JobWaitResult> {
  const waitMs = Math.max(0, Math.min(options.waitMs ?? 90000, 110000));
  const pollMs = Math.max(50, Math.min(options.pollMs ?? 500, 5000));
  const started = Date.now();
  const initial = getJob(id);
  if (!initial || initial.userId !== userId) throw new Error(`Job '${id}' not found`);
  const initialPhase = initial.phase;

  while (true) {
    const current = getJob(id);
    if (!current || current.userId !== userId) throw new Error(`Job '${id}' not found`);
    const waitedMs = Date.now() - started;
    if (current.status !== "running") {
      return { job: current, reason: "terminal", initialPhase, waitedMs };
    }
    if (options.returnOnPhaseChange && current.phase !== initialPhase) {
      return { job: current, reason: "phase_changed", initialPhase, waitedMs };
    }
    if (waitedMs >= waitMs) {
      return { job: current, reason: "wait_timeout", initialPhase, waitedMs };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, waitMs - waitedMs)));
  }
}

export function appendJobLog(id: string, message: string, level: JobLogEntry["level"] = "info"): void {
  const job = getJob(id);
  if (!job) return;
  const logs = [...(job.logs ?? []), { at: new Date().toISOString(), level, message }];
  saveJob({ ...job, logs: logs.slice(-MAX_JOB_LOGS) });
}

export function startJob(
  user: { id: number; username: string },
  project: string,
  kind: string,
  input: unknown,
  work: (context: JobContext) => Promise<string>,
  retryOptions?: JobRetryOptions,
): JobRecord {
  const retryOf = retryOptions?.retryOf?.trim();
  if (retryOptions && !retryOf) throw new Error("retryOf is required when starting a retry job");
  const retryAttempt = retryOf === undefined
    ? undefined
    : boundedRetryAttempt(retryOptions?.retryAttempt);
  const retryReason = retryOf && retryOptions?.retryReason
    ? boundedText(retryOptions.retryReason, 2_000)
    : undefined;
  const stableProjectId = resolveProjectIdSnapshot(user.id, project);
  const job: JobRecord = {
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId: user.id,
    username: user.username,
    project,
    kind,
    status: "running",
    phase: "not_started",
    input,
    logs: [],
    startedAt: new Date().toISOString(),
    ...(retryOf ? { retryOf, retryAttempt, retryReason } : {}),
    ...(stableProjectId !== undefined ? { projectIdSnapshot: stableProjectId } : {}),
  };
  const controller = new AbortController();
  activeJobs.set(job.id, controller);
  saveJob(job);
  writeAudit({ userId: user.id, username: user.username, project, kind, jobId: job.id, event: "job_started" });
  const persistedStart = emitStartedJobEvent(job) ? markStartedJobEventEmitted(job) : job;
  if (retryOf) {
    emitRelayEvent(eventSink, {
      type: "job.retry",
      eventKey: `job:${job.id}:retry`,
      actorId: user.id,
      projectId: stableProjectId === undefined ? undefined : String(stableProjectId),
      projectNameSnapshot: project,
      jobId: job.id,
      payload: sanitizeAuditArguments({
        status: "retrying",
        kind,
        retryOf,
        retryAttempt,
        retryReason,
      }) as Record<string, unknown>,
    });
  }

  const log = (message: string, level: JobLogEntry["level"] = "info") => {
    const current = getJob(job.id) ?? job;
    saveJob({ ...current, lastHeartbeatAt: new Date().toISOString() });
    appendJobLog(job.id, message, level);
  };
  const phase = (name: string) => {
    const current = getJob(job.id) ?? job;
    saveJob({ ...current, phase: name, lastHeartbeatAt: new Date().toISOString() });
    appendJobLog(job.id, `phase=${name}`);
  };
  void Promise.resolve()
    .then(() => {
      if (controller.signal.aborted) {
        throw new Error("Job cancelled before remote execution started");
      }
      phase("connecting");
      log("Job started");
      return work({ signal: controller.signal, log, phase });
    })
    .then((summary) => {
      const current = getJob(job.id) ?? job;
      const cancelled = Boolean(controller.signal.aborted || current.cancelRequestedAt);
      const terminal = {
        ...current,
        status: cancelled ? "cancelled" : "succeeded",
        terminalEventKind: cancelled ? "cancelled" : "finished",
        phase: cancelled ? "cancelled" : "completed",
        lastHeartbeatAt: new Date().toISOString(),
        summary: cancelled ? undefined : summary,
        error: cancelled ? "Job cancelled" : undefined,
        finishedAt: new Date().toISOString(),
      } satisfies JobRecord;
      saveJob(terminal);
      log(cancelled ? "Job cancelled" : "Job succeeded");
      writeAudit({
        userId: user.id,
        username: user.username,
        project,
        kind,
        jobId: job.id,
        event: cancelled ? "job_cancelled" : "job_succeeded",
      });
      const persistedTerminal = getJob(job.id) ?? terminal;
      if (emitTerminalJobEvent(persistedTerminal)) markTerminalJobEventEmitted(persistedTerminal);
    })
    .catch((err) => {
      const current = getJob(job.id) ?? job;
      const cancelled = Boolean(controller.signal.aborted || current.cancelRequestedAt);
      const errorCategory = err instanceof Error && "category" in err
        ? String((err as Error & { category?: string }).category)
        : "remote_or_relay";
      const timedOut = err instanceof RemoteCommandTimeoutError || errorCategory === "timeout";
      const summary = cancelled ? undefined : structuredErrorSummary(err);
      const error = cancelled
        ? "Job cancelled"
        : timedOut
          ? "Remote command timed out; execution state is unknown. Verify the target before retrying."
          : err instanceof Error ? err.message : String(err);
      const terminal = {
        ...current,
        status: cancelled ? "cancelled" : timedOut ? "unknown" : "failed",
        terminalEventKind: cancelled ? "cancelled" : timedOut ? "unknown" : "failed",
        phase: cancelled ? "cancelled" : timedOut ? "unknown" : "failed",
        lastHeartbeatAt: new Date().toISOString(),
        errorCategory: cancelled ? "cancelled" : timedOut ? "timeout" : errorCategory,
        retrySafe: timedOut || errorCategory === "remote_exit" ? false : true,
        summary,
        error,
        finishedAt: new Date().toISOString(),
      } satisfies JobRecord;
      saveJob(terminal);
      log(error, "stderr");
      writeAudit({
        userId: user.id,
        username: user.username,
        project,
        kind,
        jobId: job.id,
        event: cancelled ? "job_cancelled" : "job_failed",
      });
      const persistedTerminal = getJob(job.id) ?? terminal;
      if (emitTerminalJobEvent(persistedTerminal)) markTerminalJobEventEmitted(persistedTerminal);
    })
    .finally(() => {
      activeJobs.delete(job.id);
    });

  return persistedStart;
}

export function cancelJob(id: string, userId: number, reason?: string): JobRecord {
  const job = getJob(id);
  if (!job || job.userId !== userId) throw new Error(`Job '${id}' not found`);
  if (job.status !== "running") return job;

  const updated: JobRecord = {
    ...job,
    cancelRequestedAt: new Date().toISOString(),
    ...(reason?.trim() ? { cancelReason: boundedSanitizedText(reason.trim(), 2_000) } : {}),
  };
  saveJob(updated);
  appendJobLog(id, "Cancellation requested");
  activeJobs.get(id)?.abort();
  writeAudit({ userId, project: job.project, kind: job.kind, jobId: id, event: "job_cancel_requested", cancelReason: updated.cancelReason });
  return getJob(id) ?? updated;
}

export function markInterruptedJobs(): number {
  ensureState();
  recoverUnemittedStartedJobEvents();
  let count = 0;
  for (const name of readdirSync(JOB_ROOT)) {
    if (!name.endsWith(".json")) continue;
    const path = join(JOB_ROOT, name);
    try {
      const job = JSON.parse(readFileSync(path, "utf8")) as JobRecord;
      if (job.status !== "running") continue;
      const projectIdSnapshot = job.projectIdSnapshot ?? resolveProjectIdSnapshot(job.userId, job.project);
      const terminal = {
        ...job,
        status: "unknown",
        terminalEventKind: "interrupted",
        phase: "unknown",
        errorCategory: "relay_restart",
        retrySafe: false,
        error: "Relay MCP restarted before this in-process job completed; remote execution state is unknown",
        finishedAt: new Date().toISOString(),
        ...(projectIdSnapshot ? { projectIdSnapshot } : {}),
      } satisfies JobRecord;
      saveJob(terminal);
      // Runs before the composition root injects the Knowledge sink; the event
      // is spooled and drained once Knowledge becomes available, so restart
      // terminal states still reach the outbox. resolveProjectId may still be
      // unset here, in which case consumers resolve via projectNameSnapshot.
      const persistedTerminal = getJob(job.id) ?? terminal;
      if (emitTerminalJobEvent(persistedTerminal)) markTerminalJobEventEmitted(persistedTerminal);
      count += 1;
    } catch {
      // Preserve malformed records for manual inspection.
    }
  }
  recoverUnemittedTerminalJobEvents();
  return count;
}

markInterruptedJobs();
