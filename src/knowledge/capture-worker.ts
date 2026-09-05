import { createHash } from "crypto";
import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type { KnowledgeOutboxEvent, KnowledgeStore } from "./store.js";
import { EvidenceStore } from "./evidence-store.js";

const MAX_CAPTURE_ATTEMPTS = 5;
const PROJECT_RESOLUTION_RETRY_BASE_MS = 5_000;
const PROJECT_RESOLUTION_RETRY_MAX_MS = 15 * 60_000;
const ORDINARY_RETRY_MS = 1_000;

const CAPTURE_EVENT_TYPES = new Set([
  "job.finished",
  "job.retry",
  "job.failed",
  "job.unknown",
  "job.interrupted",
  "job.cancelled",
  "deployment.finished",
  "deployment.failed",
  "deployment.unknown",
  "deployment.rolled_back",
  "deployment.interrupted",
  "deployment.needs_review",
  "deployment.pending_validation",
]);

function deadLetterPath(): string {
  return join(
    process.env.RELAY_STATE_ROOT ?? join(process.env.WORKSPACE_ROOT ?? "/workspace", ".relay-mcp"),
    "knowledge-capture-dead-letter.jsonl",
  );
}

/** Permanently unprocessable events are parked here instead of retrying forever. */
function deadLetter(event: KnowledgeOutboxEvent, reason: string): void {
  const path = deadLetterPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    JSON.stringify({ deadLetteredAt: new Date().toISOString(), reason, attempts: event.attempts, event }) + "\n",
    "utf8",
  );
}

/** A project lookup can recover when the app database becomes available again. */
export class ProjectResolutionUnavailableError extends Error {
  readonly code = "project_resolution_unavailable";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProjectResolutionUnavailableError";
  }
}

/** The resolver was available but the event has no recoverable project identity. */
export class ProjectResolutionNotFoundError extends Error {
  readonly code = "project_resolution_not_found";

  constructor(message: string) {
    super(message);
    this.name = "ProjectResolutionNotFoundError";
  }
}

export function projectResolutionRetryDelay(attempts: number): number {
  const safeAttempts = Number.isFinite(attempts) ? Math.trunc(attempts) : 0;
  const exponent = Math.max(0, Math.min(8, safeAttempts));
  return Math.min(PROJECT_RESOLUTION_RETRY_MAX_MS, PROJECT_RESOLUTION_RETRY_BASE_MS * 2 ** exponent);
}

export interface CaptureWorkerHooks {
  /** Called once for a failed capture cycle, including a failed claim(). */
  onFailure?: (error: unknown, event?: KnowledgeOutboxEvent) => void;
  /** Called only after a cycle completes without an item or database failure. */
  onSuccess?: (count: number) => void;
}

function hasProjectId(projectId: string | number | undefined): boolean {
  return projectId !== undefined && projectId !== "";
}

function resolveProject(
  event: KnowledgeOutboxEvent,
  resolveProjectId?: (actorId: number | undefined, projectName: string) => string | number | undefined,
): string | number {
  if (hasProjectId(event.projectId)) return event.projectId!;
  const projectName = event.projectNameSnapshot?.trim();
  if (!projectName) {
    throw new ProjectResolutionNotFoundError("Knowledge event has no project identity snapshot");
  }

  const actorId = event.actorId ?? (typeof event.payload.userId === "number" ? event.payload.userId : undefined);
  // Without an actor (or an event-level project id) this worker cannot safely
  // scope a name-only lookup. Treat it as permanently unprocessable rather
  // than retrying forever; a future producer can still emit a corrected event.
  if (actorId === undefined) {
    throw new ProjectResolutionNotFoundError("Knowledge event has no actor identity for project resolution");
  }
  if (!resolveProjectId) {
    throw new ProjectResolutionUnavailableError("project resolver unavailable");
  }
  let projectId: string | number | undefined;
  try {
    projectId = resolveProjectId(actorId, projectName);
  } catch (error) {
    throw new ProjectResolutionUnavailableError("project resolver unavailable", { cause: error });
  }
  if (!hasProjectId(projectId)) {
    throw new ProjectResolutionNotFoundError(`project resolver could not resolve '${projectName}'`);
  }
  return projectId!;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function candidateBody(event: KnowledgeOutboxEvent, projectId: string | number): string {
  // This is the canonical source representation and the candidate's
  // provenance record. It remains verifiable after outbox metadata is pruned.
  return canonicalJson({
    eventId: event.id,
    eventKey: event.eventKey,
    eventType: event.type,
    occurredAt: event.occurredAt,
    actorId: event.actorId,
    projectId: String(projectId),
    projectNameSnapshot: event.projectNameSnapshot,
    jobId: event.jobId,
    deploymentId: event.deploymentId,
    payload: event.payload,
  });
}

type CapturedEvidence = { key: string; value: unknown };
const EVIDENCE_KEY = /(?:evidence|artifact|log|manifest|output|hash|test|rollback|backup|command|stdout|stderr)/i;
function collectEvidence(value: unknown, path = "payload", out: CapturedEvidence[] = []): CapturedEvidence[] {
  if (value === null || value === undefined) return out;
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    if (EVIDENCE_KEY.test(path)) out.push({ key: path, value });
    return out;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => collectEvidence(item, `${path}[${index}]`, out)); return out; }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) collectEvidence(item, `${path}.${key}`, out);
  }
  return out;
}
function evidenceMime(key: string): string {
  if (/xml/i.test(key)) return "application/xml";
  if (/json|manifest/i.test(key)) return "application/json";
  if (/hash/i.test(key)) return "text/plain";
  if (/log|stdout|stderr|output|command|rollback/i.test(key)) return "text/plain";
  return "application/octet-stream";
}
function evidenceSourceKind(key: string): "log" | "artifact" | "manifest" | "test" | "other" {
  if (/log|stdout|stderr|output|command/i.test(key)) return "log";
  if (/manifest/i.test(key)) return "manifest";
  if (/test/i.test(key)) return "test";
  if (/artifact|backup|hash/i.test(key)) return "artifact";
  return "other";
}
function materializeEvidence(store: KnowledgeStore, event: KnowledgeOutboxEvent, projectId: string | number, candidateId: string): string[] {
  const values = collectEvidence(event.payload);
  if (values.length === 0) {
    store.audit({ projectId: String(projectId), action: "knowledge.candidate.observed", entityType: "candidate", entityId: candidateId, details: { eventId: event.id, evidenceCount: 0 } });
    return [];
  }
  const root = store.evidenceRoot ?? join(process.env.RELAY_STATE_ROOT ?? join(process.env.WORKSPACE_ROOT ?? ".", ".relay-mcp"), "knowledge-evidence");
  const evidence = new EvidenceStore(store, root);
  const refs: string[] = [];
  for (const item of values) {
    const content = Buffer.isBuffer(item.value) ? item.value : typeof item.value === "string" ? Buffer.from(item.value, "utf8") : Buffer.from(JSON.stringify(item.value), "utf8");
    const record = evidence.put({ content, mimeType: evidenceMime(item.key), sourceKind: evidenceSourceKind(item.key), projectId: String(projectId), locator: `relay-event:${event.id}:${item.key}` });
    refs.push(record.id);
    store.db.prepare("INSERT OR IGNORE INTO knowledge_entity_evidence(entity_type,entity_id,evidence_id,created_at) VALUES ('candidate',?,?,?)").run(candidateId, record.id, new Date().toISOString());
  }
  store.db.prepare("UPDATE knowledge_candidates SET evidence_refs_json = ? WHERE id = ?").run(JSON.stringify([...new Set(refs)]), candidateId);
  store.audit({ projectId: String(projectId), action: "knowledge.candidate.evidence_linked", entityType: "candidate", entityId: candidateId, details: { eventId: event.id, evidenceCount: refs.length } });
  return refs;
}

/**
 * Materialize terminal operational events into Knowledge candidates. Project
 * resolution distinguishes temporary resolver outages from a project that is
 * definitively absent; only infrastructure outages bypass the poison cap.
 */
export async function captureKnowledgeCandidates(
  store: KnowledgeStore,
  consumer = "knowledge-capture",
  limit = 20,
  resolveProjectId?: (actorId: number | undefined, projectName: string) => string | number | undefined,
  hooks?: CaptureWorkerHooks,
): Promise<number> {
  let count = 0;
  let cycleFailed = false;
  let firstFailure: unknown;
  let firstFailureEvent: KnowledgeOutboxEvent | undefined;
  let events: KnowledgeOutboxEvent[];

  try {
    // claim() is part of the capture cycle. A database lock/disconnect must be
    // observable by the caller instead of escaping outside worker accounting.
    events = store.claim(consumer, limit);
  } catch (error) {
    hooks?.onFailure?.(error);
    throw error;
  }

  for (const event of events) {
    try {
      // Non-terminal events are intentionally consumed without project
      // resolution; only candidate-producing events need a project scope.
      if (!CAPTURE_EVENT_TYPES.has(event.type)) {
        store.acknowledge(consumer, event.id, event.claimToken);
        continue;
      }

      let projectId: string | number;
      // Resolver outages are recoverable infrastructure failures. Resolve
      // before applying the poison-event cap so a long app.db outage cannot
      // permanently acknowledge and lose the candidate; a resolver that is
      // healthy but returns no project remains finite and dead-letterable.
      projectId = resolveProject(event, resolveProjectId);

      if (event.attempts >= MAX_CAPTURE_ATTEMPTS) {
        deadLetter(event, "max attempts exceeded");
        store.acknowledge(consumer, event.id, event.claimToken);
        continue;
      }

      const body = candidateBody(event, projectId);
      const digest = createHash("sha256").update(body, "utf8").digest("hex");
      const now = new Date().toISOString();
      const environment = typeof event.payload.environment === "string" ? event.payload.environment : undefined;
      const candidateId = `candidate-${createHash("sha256").update(event.id, "utf8").digest("hex")}`;
      store.upsertDocument({
        // Candidate identity follows the immutable event ID; source_sha256
        // below follows the actual canonical content instead of the ID.
        id: candidateId,
        kind: "candidate",
        title: `${event.type}: ${event.deploymentId ?? event.jobId ?? event.id}`,
        body,
        lifecycle: "draft",
        projectId: String(projectId),
        projectNameSnapshot: event.projectNameSnapshot,
        environment,
        locator: `relay-event:${event.id}`,
        sha256: digest,
        createdAt: now,
        updatedAt: now,
      });
      materializeEvidence(store, event, projectId, candidateId);
      store.acknowledge(consumer, event.id, event.claimToken);
      count++;
    } catch (error) {
      cycleFailed = true;
      firstFailure ??= error;
      firstFailureEvent ??= event;
      if (!(error instanceof ProjectResolutionUnavailableError) && event.attempts >= MAX_CAPTURE_ATTEMPTS) {
        deadLetter(event, error instanceof ProjectResolutionNotFoundError ? "project resolution not found" : "max attempts exceeded");
        store.acknowledge(consumer, event.id, event.claimToken);
        continue;
      }
      const retryAfterMs = error instanceof ProjectResolutionUnavailableError
        ? projectResolutionRetryDelay(event.attempts)
        : ORDINARY_RETRY_MS;
      try {
        store.fail(event.id, error, retryAfterMs, consumer, event.claimToken);
      } catch (failure) {
        hooks?.onFailure?.(failure, event);
        throw failure;
      }
    }
  }

  if (cycleFailed) hooks?.onFailure?.(firstFailure, firstFailureEvent);
  // Do not reset consecutive failure/readiness state merely because a failed
  // event is waiting for its backoff window and this cycle claims nothing.
  // A successful materialization (or an acknowledged non-terminal event)
  // provides an actual recovery signal.
  else if (events.length > 0) hooks?.onSuccess?.(count);
  return count;
}
