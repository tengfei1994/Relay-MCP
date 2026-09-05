import { createHash, randomUUID } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { EventKeyConflictError, RELAY_DOMAIN_EVENT_TYPES, type RelayDomainEvent, type RelayDomainEventInput } from "./store.js";
import { sanitizeAuditArguments } from "../shared/audit-sanitizer.js";

export interface RelayEventSink { append(event: RelayDomainEvent): void; }
const spoolPath = () => join(process.env.RELAY_STATE_ROOT ?? join(process.env.WORKSPACE_ROOT ?? "/workspace", ".relay-mcp"), "knowledge-event-spool.jsonl");
const MAX_AUDIT_PAYLOAD_BYTES = 256 * 1024;
type RelayEventEmission = Omit<RelayDomainEventInput, "id" | "occurredAt"> & { occurredAt?: string };

function sanitized(event: RelayEventEmission): RelayDomainEvent {
  const payload = sanitizeAuditArguments(event.payload) as Record<string, unknown>;
  const serialized = JSON.stringify(payload);
  const eventKey = typeof event.eventKey === "string" && event.eventKey.trim()
    ? event.eventKey.trim()
    : event.jobId ? `job:${event.jobId}:${event.type.slice("job.".length)}`
      : event.deploymentId ? `deployment:${event.deploymentId}:${event.type.slice("deployment.".length)}`
        : undefined;
  if (!eventKey) throw new Error("Relay events require eventKey or jobId/deploymentId for deterministic idempotency");
  return {
    ...event,
    eventKey,
    payload: Buffer.byteLength(serialized, "utf8") > MAX_AUDIT_PAYLOAD_BYTES
      ? { redacted: true, reason: "payload_too_large", bytes: Buffer.byteLength(serialized, "utf8") }
      : payload,
    id: randomUUID(),
    // Terminal-event recovery supplies the persisted finishedAt timestamp so
    // replaying an event cannot change its immutable content.
    occurredAt: event.occurredAt ?? new Date().toISOString(),
  };
}
let spoolFailures = 0;
let spoolWriteFault = false;
let lastSpoolError: string | undefined;
let drainScheduled = false;
let drainFailures = 0;
let lastDrainError: string | undefined;
let lastDrainErrorAt: string | undefined;
let lastSuccessfulDrainAt: string | undefined;
let deadLetterFailures = 0;
let deadLetterWriteFault = false;
let lastDeadLetterError: string | undefined;

function spool(record: RelayDomainEvent): boolean {
  try {
    const path = spoolPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
    spoolWriteFault = false;
    return true;
  } catch (error) {
    spoolFailures += 1;
    spoolWriteFault = true;
    lastSpoolError = error instanceof Error ? error.message : String(error);
    try { process.stderr.write(`[relay-event] spool write failed: ${lastSpoolError}\n`); } catch { /* ignore logging failure */ }
    return false;
  }
}

export interface RelayEventSpoolHealth {
  failedWrites: number;
  lastError?: string;
  pending: boolean;
  eventLossRisk: boolean;
  degraded: boolean;
  drainFailures: number;
  lastDrainErrorClass?: string;
  lastDrainErrorAt?: string;
  lastSuccessfulDrainAt?: string;
  deadLetterFailures: number;
  lastDeadLetterError?: string;
  spoolPath: string;
  drainingPath: string;
  oldestPendingAgeMs: number;
}

function drainErrorClass(message: string | undefined): string | undefined {
  if (!message) return undefined;
  if (/sqlite|database/i.test(message)) return "knowledge_db";
  if (/EACCES|EPERM|ENOENT|EROFS|EBUSY|EEXIST/i.test(message)) return "storage";
  return "other";
}

export function relayEventSpoolHealth(): RelayEventSpoolHealth {
  const path = spoolPath();
  const draining = `${path}.draining`;
  const pendingPaths = [path, draining].filter(existsSync);
  const oldestPendingAgeMs = pendingPaths.reduce((oldest, pendingPath) => {
    try { return Math.max(oldest, Date.now() - statSync(pendingPath).mtimeMs); }
    catch { return oldest; }
  }, 0);
  return {
    failedWrites: spoolFailures,
    lastError: lastSpoolError,
    pending: pendingPaths.length > 0,
    eventLossRisk: spoolWriteFault || deadLetterWriteFault || spoolFailures > 0 || deadLetterFailures > 0,
    degraded: spoolWriteFault || drainFailures > 0 || deadLetterWriteFault,
    drainFailures,
    lastDrainErrorClass: drainErrorClass(lastDrainError),
    lastDrainErrorAt,
    lastSuccessfulDrainAt,
    deadLetterFailures,
    lastDeadLetterError,
    spoolPath: path,
    drainingPath: draining,
    oldestPendingAgeMs,
  };
}

function scheduleDrain(sink: RelayEventSink | undefined, delayMs = 0): void {
  if (!sink || drainScheduled) return;
  drainScheduled = true;
  const timer = setTimeout(() => {
    drainScheduled = false;
    try {
      drainRelayEventSpool(sink);
      drainFailures = 0;
    } catch (error) {
      drainFailures += 1;
      lastDrainError = error instanceof Error ? error.message : String(error);
      lastDrainErrorAt = new Date().toISOString();
      try { process.stderr.write(`[relay-event] spool drain failed: ${drainErrorClass(lastDrainError)}\n`); } catch { /* ignore logging failure */ }
      // Back off instead of relying solely on the 10 s recovery timer.
      scheduleDrain(sink, Math.min(30_000 * 2 ** (drainFailures - 1), 300_000));
    }
  }, delayMs);
  timer.unref?.();
}

/** A failure-isolated adapter: Knowledge persistence never blocks the operational path. */
export function emitRelayEvent(sink: RelayEventSink | undefined, event: RelayEventEmission): boolean {
  try {
    const stored = spool(sanitized(event));
    if (stored) scheduleDrain(sink);
    return stored;
  } catch (error) {
    // Serialization or spooling must never break Job/Deployment flow.
    // Emit a degraded placeholder so the loss itself remains auditable.
    spoolFailures += 1;
    lastSpoolError = error instanceof Error ? error.message : String(error);
    try { process.stderr.write(`[relay-event] event serialization failed: ${lastSpoolError}\n`); } catch { /* ignore logging failure */ }
    try {
      const stored = spool({
        id: randomUUID(),
        type: RELAY_DOMAIN_EVENT_TYPES.includes(event.type) ? event.type : "job.failed",
        occurredAt: event.occurredAt ?? new Date().toISOString(),
        projectId: typeof event.projectId === "string" ? event.projectId : undefined,
        projectNameSnapshot: typeof event.projectNameSnapshot === "string" ? event.projectNameSnapshot : undefined,
        jobId: typeof event.jobId === "string" ? event.jobId : undefined,
        deploymentId: typeof event.deploymentId === "string" ? event.deploymentId : undefined,
        eventKey: event.eventKey ?? (event.jobId ? `job:${event.jobId}:serialization-failed` : event.deploymentId ? `deployment:${event.deploymentId}:serialization-failed` : `relay:serialization-failed:${randomUUID()}`),
        actorId: typeof event.actorId === "number" ? event.actorId : undefined,
        payload: { serializationFailed: true },
      });
      if (stored) scheduleDrain(sink);
    } catch { /* spool counters already record the loss */ }
    // The fallback is only a loss marker; it is not the original event and
    // therefore must never make terminal-event recovery mark the event done.
    return false;
  }
}

const DRAIN_LOCK_STALE_MS = 5 * 60_000;

function drainLockPath(): string { return `${spoolPath()}.lock`; }

/**
 * Exclusive drain mutex. The recovery timer, event-triggered drains, and any
 * sibling Relay process sharing RELAY_STATE_ROOT must not interleave: without
 * it one drainer can merge a .draining file back while another is reading it.
 * The lock file is created atomically ('wx'); locks older than the stale
 * threshold (or unreadable ones) are presumed abandoned and taken over.
 */
function acquireDrainLock(): string | undefined {
  const lock = drainLockPath();
  const lockToken = randomUUID();
  const payload = () => JSON.stringify({ pid: process.pid, at: new Date().toISOString(), lockToken });
  mkdirSync(dirname(lock), { recursive: true });
  try {
    writeFileSync(lock, payload(), { flag: "wx" });
    return lockToken;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
    let stale = false;
    try {
      const info = JSON.parse(readFileSync(lock, "utf8")) as { at?: string };
      stale = !info.at || Number.isNaN(Date.parse(info.at)) || Date.now() - Date.parse(info.at) > DRAIN_LOCK_STALE_MS;
    } catch { stale = true; }
    if (!stale) return undefined;
    try { unlinkSync(lock); } catch { /* another process may have taken it already */ }
    try { writeFileSync(lock, payload(), { flag: "wx" }); return lockToken; } catch { return undefined; }
  }
}

function releaseDrainLock(lockToken: string): void {
  const lock = drainLockPath();
  try {
    const current = JSON.parse(readFileSync(lock, "utf8")) as { lockToken?: string };
    if (current.lockToken === lockToken) unlinkSync(lock);
  } catch { /* already released or owned by a newer worker */ }
}

const RELAY_EVENT_TYPE_SET = new Set<string>(RELAY_DOMAIN_EVENT_TYPES);

/** Valid JSON is not enough: structurally invalid lines would poison the drain loop forever. */
function isRelayDomainEvent(value: unknown): value is RelayDomainEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.type === "string"
    && RELAY_EVENT_TYPE_SET.has(candidate.type)
    && typeof candidate.occurredAt === "string"
    && !!candidate.payload
    && typeof candidate.payload === "object"
    && !Array.isArray(candidate.payload)
    && typeof candidate.eventKey === "string"
    && (candidate.actorId === undefined || typeof candidate.actorId === "number");
}

function deadLetterLine(path: string, line: number, error: string, raw: string): boolean {
  try {
    appendFileSync(`${path}.dead-letter`, JSON.stringify({ line, error, length: raw.length, sha256: createHash("sha256").update(raw).digest("hex") }) + "\n", "utf8");
    deadLetterWriteFault = false;
    return true;
  } catch (failure) {
    deadLetterFailures += 1;
    deadLetterWriteFault = true;
    lastDeadLetterError = failure instanceof Error ? failure.message : String(failure);
    try { process.stderr.write(`[relay-event] dead-letter write failed: ${drainErrorClass(lastDeadLetterError) ?? "other"}\n`); } catch { /* ignore logging failure */ }
    return false;
  }
}

/** Best-effort recovery for events created while Knowledge DB was unavailable. */
export function drainRelayEventSpool(sink: RelayEventSink): number {
  const lockToken = acquireDrainLock();
  if (!lockToken) return 0;
  try {
    const path = spoolPath();
    const draining = `${path}.draining`;
    if (existsSync(draining)) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, readFileSync(draining));
      unlinkSync(draining);
    }
    if (!existsSync(path)) return 0;
    renameSync(path, draining);
    const lines = readFileSync(draining, "utf8").split("\n").filter(Boolean);
    let count = 0;
    try {
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        let parsed: unknown;
        try { parsed = JSON.parse(line); }
        catch (error) {
          if (!deadLetterLine(path, index + 1, error instanceof Error ? error.message : String(error), line)) {
            throw new Error("Unable to persist malformed relay event to dead-letter");
          }
          count++;
          continue;
        }
        if (!isRelayDomainEvent(parsed)) {
          if (!deadLetterLine(path, index + 1, "invalid relay event structure", line)) {
            throw new Error("Unable to persist invalid relay event to dead-letter");
          }
          count++;
          continue;
        }
        try { sink.append(parsed); count++; }
        catch (error) {
          if (error instanceof EventKeyConflictError || (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "event_key_conflict")) {
            if (!deadLetterLine(path, index + 1, error instanceof Error ? error.message : "event_key_conflict", line)) {
              throw new Error("Unable to persist conflicting relay event to dead-letter");
            }
            count++;
            continue;
          }
          throw error;
        }
      }
      unlinkSync(draining);
      // A completed drain proves the current storage path is healthy. Keep
      // cumulative counters for diagnostics, but clear transient readiness
      // faults so one historical incident cannot pin readiness degraded.
      drainFailures = 0;
      spoolWriteFault = false;
      lastSuccessfulDrainAt = new Date().toISOString();
      return count;
    } catch (error) {
      // Preserve only the unacknowledged suffix. The already delivered prefix is
      // intentionally not replayed; event IDs are idempotent in the Knowledge DB.
      appendFileSync(path, lines.slice(count).join("\n") + (lines.length > count ? "\n" : ""), "utf8");
      unlinkSync(draining);
      throw error;
    }
  } finally {
    releaseDrainLock(lockToken);
  }
}
