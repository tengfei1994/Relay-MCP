import { createHash } from "crypto";
import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type { KnowledgeOutboxEvent, KnowledgeStore } from "./store.js";
import { EvidenceStore } from "./evidence-store.js";
import { KnowledgeRepository } from "./repository.js";
import { candidateProblemStatement, candidateTitle, generateCandidateCard } from "./candidate-card.js";
import type { InferenceProvider } from "./providers.js";
import { classifyRelayEvent, extractExecutionObservationSignals } from "./event-classifier.js";
import { OBSERVATION_REVIEW_RULE, recordObservationReview } from "./observation-review.js";

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
  /** Optional inference provider; failures fall back to deterministic cards. */
  inference?: InferenceProvider;
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

function eventMetadata(event: KnowledgeOutboxEvent): { sampleManagerVersion?: string; solution?: string; module?: string; candidateType: "case" | "pattern" | "playbook"; applicability?: string; tags: string[]; summary: string } {
  const payload = event.payload;
  const text = (key: string) => typeof payload[key] === "string" && String(payload[key]).trim() ? String(payload[key]).trim() : undefined;
  const candidateType = ["case", "pattern", "playbook"].includes(String(payload.candidateType)) ? String(payload.candidateType) as "case" | "pattern" | "playbook" : "case";
  const tags = Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean) : [];
  const summary = text("summary") ?? text("error") ?? text("status") ?? `${event.type} captured from Relay execution`;
  return { sampleManagerVersion: text("sampleManagerVersion") ?? text("samplemanagerVersion") ?? text("version"), solution: text("solution"), module: text("module"), candidateType, applicability: text("applicability"), tags, summary };
}

function candidateBody(event: KnowledgeOutboxEvent, projectId: string | number): string {
  // This is the canonical source representation and the candidate's
  // provenance record. It remains verifiable after outbox metadata is pruned.
  const metadata = eventMetadata(event);
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
    summary: metadata.summary,
    tags: metadata.tags,
    applicability: metadata.applicability,
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
function eventEnvironment(event: KnowledgeOutboxEvent): string | undefined {
  const value = event.payload.environment ?? event.payload.env;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function observationFacts(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const signals = extractExecutionObservationSignals(payload);
  const facts: Array<Record<string, unknown>> = [];
  if (signals.stdout) facts.push({ field: "stdout", value: signals.stdout });
  if (signals.stderr) facts.push({ field: "stderr", value: signals.stderr });
  if (meaningfulObservationValue(signals.output)) facts.push({ field: "output", value: signals.output });
  signals.logs.slice(0, 20).forEach((message, index) => facts.push({ field: `log[${index}]`, value: message }));

  const hasStructuredOutput = Boolean(signals.stdout || signals.stderr || meaningfulObservationValue(signals.output) || signals.logs.length);
  for (const [field, value] of Object.entries(payload)) {
    if (value === undefined || value === null || typeof value === "object") continue;
    if (field === "summary" && hasStructuredOutput) continue;
    facts.push({ field, value });
    if (facts.length >= 30) break;
  }
  return facts.slice(0, 30);
}

function meaningfulObservationValue(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim()) && !/^\(empty\)$/i.test(value.trim());
  return value !== undefined && value !== null;
}

function observationNeedsCandidate(payload: Record<string, unknown>): boolean {
  const signals = extractExecutionObservationSignals(payload);
  const benign = (value: string): boolean => {
    const normalized = value.trim();
    return !normalized
      || /^(?:\(empty\)|none|n\/a|ok|success|succeeded|passed|no\s+(?:errors?|warnings?|failures?))$/i.test(normalized)
      || (/\b(?:build|execution|command)\s+succeeded\b/i.test(normalized) && /\b0\s+warnings?\b/i.test(normalized) && /\b0\s+errors?\b/i.test(normalized))
      || /^0\s+(?:warnings?|errors?|failures?)$/i.test(normalized);
  };
  const meaningful = (value: unknown): boolean => {
    if (typeof value === "string") return !benign(value);
    if (Array.isArray(value)) return value.some(meaningful);
    return value === true || (typeof value === "number" && value > 0);
  };
  const text = [signals.stderr, ...signals.logs, typeof signals.stdout === "string" ? signals.stdout : undefined, typeof signals.output === "string" ? signals.output : undefined]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .split(/\r?\n/)
    .filter((line) => !benign(line))
    .join(" ")
    .replace(/\b(?:0|no)\s+(?:errors?|warnings?|failures?)\b(?:\(s\))?/gi, "")
    .replace(/\b(?:errors?|warnings?|failures?)\s*[:=]\s*0\b/gi, "");
  return meaningful(payload.warning) || meaningful(payload.warnings) || meaningful(payload.observedSymptoms) || /\b(error|failed|failure|warning|warn|degraded|partial|empty|missing|not found|invalid|exception|timeout|denied)\b|乱码/i.test(text);
}

async function materializeObservationCandidate(store: KnowledgeStore, event: KnowledgeOutboxEvent, projectId: string | number, observationId: string, evidenceRefs: string[], classification: ReturnType<typeof classifyRelayEvent>, reviewNow: Date): Promise<string> {
  const candidateId = `candidate-${createHash("sha256").update(`observation:${observationId}`, "utf8").digest("hex")}`;
  const metadata = eventMetadata(event); const now = new Date().toISOString(); const body = candidateBody(event, projectId); const digest = createHash("sha256").update(body, "utf8").digest("hex");
  const candidate: import("./domain.js").Candidate = { id: candidateId, kind: "candidate", title: `Observation candidate: ${event.type} ${event.jobId ?? event.deploymentId ?? event.id}`, body, lifecycle: "draft", projectId: String(projectId), projectNameSnapshot: event.projectNameSnapshot, environment: eventEnvironment(event), sampleManagerVersion: metadata.sampleManagerVersion, solution: metadata.solution, module: metadata.module, candidateType: "case", eventId: event.id, deploymentId: event.deploymentId, jobId: event.jobId, sourceObservationId: observationId, locator: `observation:${observationId}`, sha256: digest, evidenceRefs, createdAt: now, updatedAt: now };
  // Observation rows have their own table and are not Knowledge Documents;
  // source_observation_id is the canonical link without violating FK rules.
  const generated = await generateCandidateCard({ event, projectId, candidateId, evidenceRefs, inference: undefined, eventClass: classification.eventClass, captureReason: "Automatically generated from an Observation with a concrete problem signal.", problemStatement: candidateProblemStatement(event, classification.problemStatement) ?? "A concrete runtime signal was captured and requires reviewer verification.", impact: "Requires reviewer verification before becoming a Case." });
  // Generation is outside the transaction; the candidate, evidence links and
  // review decision commit together. Re-check after await for another worker.
  return store.db.transaction(() => {
    const existing = store.db.prepare("SELECT id FROM knowledge_candidates WHERE source_observation_id=?").get(observationId) as { id: string } | undefined;
    const targetId = existing?.id ?? candidateId;
    if (!existing) {
      new KnowledgeRepository(store).saveCandidate(candidate);
      store.saveCandidateCard(generated.card);
      store.upsertDocument({ ...candidate, title: candidateTitle(event, generated.card), updatedAt: generated.card.updatedAt });
      store.audit({ projectId: String(projectId), action: "knowledge.observation.candidate_created", entityType: "candidate", entityId: candidateId, details: { observationId, eventId: event.id, evidenceCount: evidenceRefs.length } });
    }
    recordObservationReview(store, { observationId, projectId: String(projectId), outcome: "promoted", reason: "Concrete runtime problem signal detected; draft Candidate created for human verification.", candidateId: targetId, now: reviewNow });
    return targetId;
  }).immediate();
}

function parseStringList(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

/**
 * Re-evaluate the durable Observation pool on every worker cycle. Observations
 * are intentionally not a terminal queue state: new rules and providers may
 * discover that an older observation is actionable after it was first stored.
 */
export async function evaluateObservationPool(store: KnowledgeStore, limit = 20, now = new Date()): Promise<number> {
  const rows = store.db.prepare(`
    SELECT o.id AS observation_id, o.project_id, o.evidence_refs_json,
           e.id, e.type, e.occurred_at, e.project_id AS event_project_id,
           e.project_name_snapshot, e.job_id, e.deployment_id, e.event_key,
           e.actor_id, e.payload_json
    FROM knowledge_observations o
    LEFT JOIN relay_domain_events e ON e.id = o.event_id
    LEFT JOIN knowledge_observation_reviews r ON r.observation_id = o.id
    WHERE r.observation_id IS NULL OR (r.outcome != 'promoted' AND
      (r.next_review_at <= ? OR r.rule_version != ? OR r.source_sha256 IS NOT o.source_sha256))
    ORDER BY r.reviewed_at ASC, o.created_at ASC, o.id ASC
    LIMIT ?
  `).all(now.toISOString(), OBSERVATION_REVIEW_RULE, Math.max(1, Math.min(limit, 100))) as Array<Record<string, unknown>>;
  let created = 0;
  for (const row of rows) {
    const projectId = row.project_id ?? row.event_project_id;
    const observationId = String(row.observation_id);
    try {
    if (projectId === undefined || projectId === null || String(projectId).trim() === "") throw new Error("Observation project identity is unavailable.");
    const existing = store.db.prepare("SELECT id FROM knowledge_candidates WHERE source_observation_id=?").get(observationId) as { id: string } | undefined;
    if (existing) {
      store.db.transaction(() => recordObservationReview(store, { observationId, projectId: String(projectId), outcome: "promoted", reason: "Existing linked Candidate reconciled; no duplicate created.", candidateId: existing.id, now })).immediate();
      continue;
    }
    if (!row.id) throw new Error("Observation source event is unavailable.");
    const event = {
      id: String(row.id), type: String(row.type) as KnowledgeOutboxEvent["type"], occurredAt: String(row.occurred_at),
      projectId: String(projectId), projectNameSnapshot: row.project_name_snapshot ? String(row.project_name_snapshot) : undefined,
      jobId: row.job_id ? String(row.job_id) : undefined, deploymentId: row.deployment_id ? String(row.deployment_id) : undefined,
      actorId: row.actor_id === undefined || row.actor_id === null ? undefined : Number(row.actor_id), eventKey: String(row.event_key),
      payload: JSON.parse(String(row.payload_json ?? "{}")), attempts: 0, availableAt: String(row.occurred_at), claimToken: "pool-evaluation",
    } as KnowledgeOutboxEvent;
    const evidenceRefs = parseStringList(row.evidence_refs_json);
    const classification = classifyRelayEvent(event);
    if (!classification.captureCandidate && !observationNeedsCandidate(event.payload)) {
      store.db.transaction(() => recordObservationReview(store, { observationId, projectId: String(projectId), outcome: "deferred", reason: "No concrete runtime problem signal found by deterministic rules; retained for periodic re-evaluation.", now })).immediate();
      continue;
    }
    await materializeObservationCandidate(store, event, String(projectId), observationId, evidenceRefs, classification, now);
    created++;
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const errorCode = typeof code === "string" && /^SQLITE_[A-Z_]+$/.test(code) ? code : "observation_review_failed";
      store.db.transaction(() => recordObservationReview(store, { observationId, projectId: projectId == null ? undefined : String(projectId), outcome: "error", reason: `Source data or candidate materialization failed (${errorCode}); review will retry without blocking other observations.`, errorCode, now })).immediate();
    }
  }
  return created;
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
    const record = evidence.put({ content, mimeType: evidenceMime(item.key), sourceKind: evidenceSourceKind(item.key), projectId: String(projectId), environment: eventEnvironment(event), locator: `relay-event:${event.id}:${item.key}` });
    refs.push(record.id);
    store.db.prepare("INSERT OR IGNORE INTO knowledge_entity_evidence(entity_type,entity_id,evidence_id,created_at) VALUES ('candidate',?,?,?)").run(candidateId, record.id, new Date().toISOString());
  }
  store.db.prepare("UPDATE knowledge_candidates SET evidence_refs_json = ? WHERE id = ?").run(JSON.stringify([...new Set(refs)]), candidateId);
  store.audit({ projectId: String(projectId), action: "knowledge.candidate.evidence_linked", entityType: "candidate", entityId: candidateId, details: { eventId: event.id, evidenceCount: refs.length } });
  return refs;
}

function materializeObservationEvidence(store: KnowledgeStore, event: KnowledgeOutboxEvent, projectId: string | number, observationId: string): string[] {
  const values = collectEvidence(event.payload);
  if (values.length === 0) return [];
  const root = store.evidenceRoot ?? join(process.env.RELAY_STATE_ROOT ?? join(process.env.WORKSPACE_ROOT ?? ".", ".relay-mcp"), "knowledge-evidence");
  const evidence = new EvidenceStore(store, root);
  const refs: string[] = [];
  const now = new Date().toISOString();
  for (const item of values) {
    const content = Buffer.isBuffer(item.value) ? item.value : typeof item.value === "string" ? Buffer.from(item.value, "utf8") : Buffer.from(JSON.stringify(item.value), "utf8");
    const record = evidence.put({ content, mimeType: evidenceMime(item.key), sourceKind: evidenceSourceKind(item.key), projectId: String(projectId), environment: eventEnvironment(event), locator: `relay-event:${event.id}:${item.key}` });
    refs.push(record.id);
    store.db.prepare("INSERT OR IGNORE INTO knowledge_entity_evidence(entity_type,entity_id,evidence_id,created_at) VALUES ('observation',?,?,?)").run(observationId, record.id, now);
  }
  return [...new Set(refs)];
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

      const classification = classifyRelayEvent(event);
      // Routine successful executions are retained in the immutable event and
      // audit trail but must not flood the Candidate review queue.
      if (!classification.captureCandidate && !classification.storeObservation) {
        store.audit({ projectId: event.projectId ? String(event.projectId) : undefined, action: "knowledge.event.classified", entityType: "event", entityId: event.id, details: { eventClass: classification.eventClass, captureReason: classification.captureReason } });
        store.acknowledge(consumer, event.id, event.claimToken);
        continue;
      }

      let projectId: string | number;
      // Resolver outages are recoverable infrastructure failures. Resolve
      // before applying the poison-event cap so a long app.db outage cannot
      // permanently acknowledge and lose the candidate; a resolver that is
      // healthy but returns no project remains finite and dead-letterable.
      projectId = resolveProject(event, resolveProjectId);

      if (!classification.captureCandidate && classification.storeObservation) {
        const now = new Date().toISOString();
        const body = candidateBody(event, projectId);
        const digest = createHash("sha256").update(body, "utf8").digest("hex");
        const observationId = `observation-${createHash("sha256").update(event.id, "utf8").digest("hex")}`;
        const observationEvidenceRefs = materializeObservationEvidence(store, event, projectId, observationId);
        store.saveObservation({ id: observationId, eventId: event.id, projectId: String(projectId), eventClass: classification.eventClass, captureReason: classification.captureReason, problemStatement: classification.problemStatement, facts: observationFacts(event.payload), evidenceRefs: observationEvidenceRefs, sourceLocator: `relay-event:${event.id}`, sourceSha256: digest, createdAt: now, updatedAt: now });
        store.audit({ projectId: String(projectId), action: "knowledge.observation.captured", entityType: "observation", entityId: observationId, details: { eventId: event.id, eventClass: classification.eventClass, evidenceCount: observationEvidenceRefs.length } });
        store.acknowledge(consumer, event.id, event.claimToken);
        count++;
        continue;
      }

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
      const metadata = eventMetadata(event);
      const candidate: import("./domain.js").Candidate = {
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
        sampleManagerVersion: metadata.sampleManagerVersion,
        solution: metadata.solution,
        module: metadata.module,
        candidateType: metadata.candidateType,
        eventId: event.id,
        deploymentId: event.deploymentId,
        jobId: event.jobId,
        locator: `relay-event:${event.id}`,
        sha256: digest,
        createdAt: now,
        updatedAt: now,
      };
      const repository = new KnowledgeRepository(store);
      repository.saveCandidate(candidate);
      const evidenceRefs = materializeEvidence(store, event, projectId, candidateId);
      const generated = await generateCandidateCard({ event, projectId, candidateId, evidenceRefs, inference: hooks?.inference, eventClass: classification.eventClass, captureReason: classification.captureReason, problemStatement: classification.problemStatement, impact: classification.problemStatement });
      store.saveCandidateCard(generated.card);
      // Re-upsert through the canonical store so chunk/FTS projections and
      // source metadata stay in sync with the semantic title.
      store.upsertDocument({ ...candidate, title: candidateTitle(event, generated.card), updatedAt: generated.card.updatedAt });
      if (generated.providerError) store.audit({ projectId: String(projectId), action: "knowledge.candidate.card_provider_rejected", entityType: "candidate", entityId: candidateId, details: { eventId: event.id, error: generated.providerError } });
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

  // Review new and historical observations even when the outbox is idle.
  try { await evaluateObservationPool(store, limit); }
  catch (error) { cycleFailed = true; firstFailure ??= error; }
  if (cycleFailed) hooks?.onFailure?.(firstFailure, firstFailureEvent);
  // Do not reset consecutive failure/readiness state merely because a failed
  // event is waiting for its backoff window and this cycle claims nothing.
  // A successful materialization (or an acknowledged non-terminal event)
  // provides an actual recovery signal.
  else if (events.length > 0) hooks?.onSuccess?.(count);
  return count;
}
