import type { InferenceProvider } from "./providers.js";
import type { CandidateCard } from "./domain.js";
import type { RelayDomainEvent } from "./store.js";
import { eventClassLabel, lifecycleHumanStatus } from "./display-projection.js";
import { extractExecutionObservationSignals } from "./event-classifier.js";

const SECRET_KEY = /(password|passwd|pwd|token|secret|api[_-]?key|credential|authorization|connection|string)/i;

export interface CandidateCardGenerationInput {
  event: RelayDomainEvent;
  projectId: string | number;
  candidateId?: string;
  evidenceRefs: string[];
  inference?: InferenceProvider;
  eventClass?: string;
  captureReason?: string;
  problemStatement?: string;
  impact?: string;
}

export interface CandidateCardGenerationResult {
  card: CandidateCard;
  providerError?: string;
}

export interface LegacyCandidateCardInput {
  candidateId: string;
  projectId: string | number;
  body: string;
  evidenceRefs: string[];
  eventId?: string;
  eventType?: string;
  occurredAt?: string;
  projectNameSnapshot?: string;
  jobId?: string;
  deploymentId?: string;
  sampleManagerVersion?: string;
  solution?: string;
  module?: string;
  environment?: string;
  updatedAt?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 20);
  const single = text(value);
  return single ? [single] : [];
}

function clipped(value: string, max = 360): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

/** Keep symptoms human-readable while preserving labels in the summary. */
function symptomText(value: string): string {
  return value.replace(/^[A-Za-z][A-Za-z ]*:\s*/, "").trim();
}

function isBenignDiagnosticText(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  return /^(?:\(empty\)|none|n\/a|ok|success|succeeded|passed|no\s+(?:errors?|warnings?|failures?))$/i.test(normalized)
    || (/\b(?:build|execution|command)\s+succeeded\b/i.test(normalized) && /\b0\s+warnings?\b/i.test(normalized) && /\b0\s+errors?\b/i.test(normalized))
    || /^0\s+(?:warnings?|errors?|failures?)$/i.test(normalized);
}

function signalValues(event: RelayDomainEvent): { primary?: string; all: string[] } {
  const payload = event.payload ?? {};
  const all: string[] = [];
  const isSuspicious = (value: string): boolean => /\b(?:error|failed|failure|warning|warn|degraded|partial|missing|not found|invalid|exception|timeout|denied|unavailable|refused)\b|乱码/i.test(value);
  const add = (label: string, value: unknown) => {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item !== "string") continue;
      const normalized = clipped(item);
      if (!normalized || isBenignDiagnosticText(normalized)) continue;
      all.push(`${label}: ${normalized}`);
    }
  };
  // Prioritize fields that describe an actionable problem over routine output.
  add("Error", payload.error);
  if (typeof payload.message === "string" && isSuspicious(payload.message)) add("Error", payload.message);
  add("Warning", payload.warning);
  add("Warning", payload.warnings);
  add("Observed symptom", payload.observedSymptoms);
  add("Symptom", payload.symptoms);
  add("stderr", payload.stderr);
  if (Array.isArray(payload.logs)) {
    for (const entry of payload.logs) {
      const message = typeof entry === "string" ? entry : entry && typeof entry === "object" ? (entry as Record<string, unknown>).message : undefined;
      if (typeof message === "string" && isSuspicious(message)) add("Log", message);
    }
  }
  // stdout/output is useful context, but only retain lines that look anomalous;
  // this keeps the review card readable instead of dumping command output.
  for (const key of ["stdout", "output", "result", "observedOutput"]) {
    const value = payload[key];
    if (typeof value !== "string") continue;
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const suspiciousLines = lines.filter(isSuspicious);
    (suspiciousLines.length ? suspiciousLines : []).slice(0, 4).forEach((line) => add(key, line));
  }
  // Legacy events often keep summarizeExec output in payload.summary. Reuse
  // the same stream extractor so reviewers see the actual stderr/warning
  // instead of a generic statement.
  const execution = extractExecutionObservationSignals(payload);
  if (execution.stderr && isSuspicious(execution.stderr)) add("stderr", execution.stderr);
  if (execution.stdout) execution.stdout.split(/\r?\n/).filter(isSuspicious).slice(0, 4).forEach((line) => add("stdout", line));
  execution.logs.filter(isSuspicious).slice(0, 4).forEach((line) => add("Log", line));
  return { primary: all[0], all: [...new Set(all)].slice(0, 20) };
}

/** Build a reviewer-facing problem statement from concrete event signals. */
export function candidateProblemStatement(event: RelayDomainEvent, fallback?: string): string | undefined {
  const signal = signalValues(event).primary;
  if (signal) return `${event.type} reported a concrete runtime signal — ${signal}`;
  const normalizedFallback = text(fallback);
  if (normalizedFallback && !/derived from an observed runtime problem signal|requires reviewer verification before becoming a case/i.test(normalizedFallback)) return normalizedFallback;
  return undefined;
}

function safeFacts(event: RelayDomainEvent, projectId: string | number): Array<Record<string, unknown>> {
  const facts: Array<Record<string, unknown>> = [
    { field: "eventType", value: event.type, source: "relay-domain-event", confirmed: true },
    { field: "occurredAt", value: event.occurredAt, source: "relay-domain-event", confirmed: true },
    { field: "projectId", value: String(projectId), source: "relay-domain-event", confirmed: true },
  ];
  if (event.jobId) facts.push({ field: "jobId", value: event.jobId, source: "relay-domain-event", confirmed: true });
  if (event.deploymentId) facts.push({ field: "deploymentId", value: event.deploymentId, source: "relay-domain-event", confirmed: true });
  for (const [key, value] of Object.entries(event.payload)) {
    if (SECRET_KEY.test(key) || value === undefined || value === null || typeof value === "object") continue;
    const normalized = typeof value === "string" ? value.trim().slice(0, 500) : value;
    if (normalized !== "") facts.push({ field: key, value: normalized, source: "event.payload", confirmed: true });
  }
  return facts.slice(0, 30);
}

function deterministicCard(input: CandidateCardGenerationInput, inferenceStatus: CandidateCard["inferenceStatus"] = "deterministic"): CandidateCard {
  const { event, projectId, evidenceRefs } = input;
  const status = text(event.payload.status);
  const error = [text(event.payload.error), text(event.payload.message)]
    .find((value): value is string => typeof value === "string" && !isBenignDiagnosticText(value));
  const signals = signalValues(event);
  const subject = event.deploymentId ? `deployment ${event.deploymentId}` : event.jobId ? `job ${event.jobId}` : `event ${event.id}`;
  const summary = signals.primary
    ? `${event.type} captured for ${subject}: ${signals.primary.slice(0, 240)}`
    : `${event.type} captured for ${subject}${status ? ` with status ${status}` : ""}.`;
  const rootCause = text(event.payload.rootCause) ?? text(event.payload.hypothesis);
  const hypothesis = rootCause ? `unconfirmed: ${rootCause}` : "unconfirmed: root cause is not established from the source event";
  const verificationPlan = strings(event.payload.verificationPlan ?? event.payload.verification_plan);
  if (!verificationPlan.length) verificationPlan.push("Review linked Evidence and reproduce the observed event in a controlled environment.");
  if (!verificationPlan.some((item) => /root cause|hypothesis|verify/i.test(item))) verificationPlan.push("Verify the root-cause hypothesis against logs, manifest, tests, and rollback state.");
  const actions = strings(event.payload.actions ?? event.payload.action);
  if (!actions.length) actions.push(status === "failed" || error ? "Assign the candidate to a reviewer and investigate the linked Evidence." : "Review the captured Evidence before reusing this observation.");
  const verification = strings(event.payload.verification ?? event.payload.verificationResult);
  const verifiedConclusion = text(event.payload.verifiedConclusion) && (event.payload.verificationStatus === "verified" || event.payload.verified === true) ? text(event.payload.verifiedConclusion) : undefined;
  const tags = [...new Set([event.type, status, ...strings(event.payload.tags)].filter((item): item is string => Boolean(item)))].slice(0, 30);
  const applicability = text(event.payload.applicability) ?? ([text(event.payload.sampleManagerVersion) ?? text(event.payload.version), text(event.payload.solution), text(event.payload.module), text(event.payload.environment)].filter(Boolean).join(" / ") || undefined);
  const card: CandidateCard = {
    candidateId: input.candidateId ?? `candidate-${event.id}`,
    summary,
    problemStatement: candidateProblemStatement(event, input.problemStatement) ?? (error ? `${event.type} reported for ${subject}: ${error}` : `${event.type} was observed for ${subject}; the event payload is retained as Raw Event evidence.`),
    facts: safeFacts(event, projectId),
    symptoms: [...new Set([...(signals.all.length ? signals.all.map(symptomText) : error ? [error] : []), ...strings(event.payload.symptoms), ...strings(event.payload.observedSymptoms)])].slice(0, 20),
    hypothesis,
    verificationPlan: verificationPlan.slice(0, 20),
    verifiedConclusion,
    actions: actions.slice(0, 20),
    verification: verification.slice(0, 20),
    applicability,
    tags,
    confidence: verifiedConclusion ? 0.8 : 0.2,
    generatedBy: "deterministic-rule-v1",
    inferenceStatus,
    eventClass: input.eventClass,
    captureReason: input.captureReason,
    impact: input.impact,
    recordType: "candidate",
    displayTitle: summary,
    displaySummary: candidateProblemStatement(event, input.problemStatement) ?? summary,
    unknowns: ["Root cause has not been verified.", "Impact and reuse boundaries still need reviewer confirmation."],
    nextAction: actions[0] ?? verificationPlan[0],
    captureReasonText: input.captureReason ?? `Captured because the event was classified as ${eventClassLabel(input.eventClass)}.`,
    humanStatus: lifecycleHumanStatus("draft", "candidate"),
    provenance: { eventId: event.id, jobId: event.jobId, deploymentId: event.deploymentId, sourceLocator: `relay-event:${event.id}` },
    updatedAt: new Date().toISOString(),
  };
  // Keep this validation explicit: deterministic output cannot claim a source
  // Evidence ID that was not materialized for this event.
  if (evidenceRefs.some((ref) => !ref || typeof ref !== "string")) throw new Error("Candidate Evidence references must be materialized IDs");
  return card;
}

/** Build a reviewable card for legacy candidates that predate card persistence. */
export function generateDeterministicCandidateCard(input: CandidateCardGenerationInput): CandidateCard {
  return deterministicCard(input);
}

/**
 * Reconstruct the event envelope used by candidates written before the
 * Candidate Card projection existed. This keeps the original body untouched
 * while giving legacy rows the same deterministic, reviewable projection as
 * newly captured events.
 */
export function generateDeterministicCandidateCardFromLegacy(input: LegacyCandidateCardInput): CandidateCard {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(input.body);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    // Older candidates may contain plain text rather than the canonical JSON
    // envelope. Preserve a bounded copy as an unstructured payload fact.
  }
  const knownTypes = new Set([
    "job.started", "job.retry", "job.finished", "job.failed", "job.unknown", "job.cancelled", "job.interrupted",
    "deployment.started", "deployment.finished", "deployment.failed", "deployment.unknown", "deployment.rolled_back",
    "deployment.interrupted", "deployment.needs_review", "deployment.pending_validation",
  ]);
  const parsedType = typeof parsed.eventType === "string" ? parsed.eventType : undefined;
  const parsedPayload = parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
    ? parsed.payload as Record<string, unknown>
    : { legacyBody: input.body.slice(0, 2_000) };
  const payload: Record<string, unknown> = { ...parsedPayload };
  for (const [key, value] of [["sampleManagerVersion", input.sampleManagerVersion], ["solution", input.solution], ["module", input.module], ["environment", input.environment]] as const) {
    if (payload[key] === undefined && value) payload[key] = value;
  }
  const event: RelayDomainEvent = {
    id: String(parsed.eventId ?? input.eventId ?? input.candidateId),
    type: (knownTypes.has(parsedType ?? "") ? parsedType : "job.unknown") as RelayDomainEvent["type"],
    occurredAt: String(parsed.occurredAt ?? input.occurredAt ?? new Date().toISOString()),
    projectId: String(parsed.projectId ?? input.projectId),
    projectNameSnapshot: typeof parsed.projectNameSnapshot === "string" ? parsed.projectNameSnapshot : input.projectNameSnapshot,
    jobId: String(parsed.jobId ?? input.jobId ?? "") || undefined,
    deploymentId: String(parsed.deploymentId ?? input.deploymentId ?? "") || undefined,
    payload,
    eventKey: String(parsed.eventKey ?? `legacy:${input.candidateId}`),
    actorId: typeof parsed.actorId === "number" ? parsed.actorId : undefined,
  };
  const card = deterministicCard({ event, projectId: input.projectId, candidateId: input.candidateId, evidenceRefs: input.evidenceRefs });
  card.tags = [...new Set(["legacy-candidate", ...card.tags])].slice(0, 30);
  if (input.updatedAt) card.updatedAt = input.updatedAt;
  return card;
}

function parseProviderCard(raw: string, input: CandidateCardGenerationInput): CandidateCard {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const allowed = new Set(input.evidenceRefs);
  const proposedRefs = Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs.filter((item): item is string => typeof item === "string") : [];
  if (proposedRefs.some((ref) => !allowed.has(ref))) throw new Error("Inference provider returned a non-existent Evidence reference");
  const card = deterministicCard(input, "provider");
  const requiredText = (key: string, fallback: string): string => text(parsed[key]) ?? fallback;
  const boundedStrings = (key: string, fallback: string[]): string[] => {
    const value = strings(parsed[key]);
    return value.length ? value.slice(0, 20) : fallback;
  };
  card.summary = requiredText("summary", card.summary);
  card.problemStatement = requiredText("problem_statement", card.problemStatement);
  card.hypothesis = `unconfirmed: ${requiredText("hypothesis", card.hypothesis.replace(/^unconfirmed:\s*/i, ""))}`;
  card.symptoms = boundedStrings("symptoms", card.symptoms);
  card.verificationPlan = boundedStrings("verification_plan", card.verificationPlan);
  card.actions = boundedStrings("actions", card.actions);
  card.verification = boundedStrings("verification", card.verification);
  card.applicability = text(parsed.applicability) ?? card.applicability;
  card.tags = boundedStrings("tags", card.tags);
  card.generatedBy = "inference-provider-schema-v1";
  return card;
}

export async function generateCandidateCard(input: CandidateCardGenerationInput): Promise<CandidateCardGenerationResult> {
  if (!input.inference) return { card: deterministicCard(input) };
  const prompt = JSON.stringify({
    task: "Generate a reviewable Knowledge Candidate card. Do not present hypotheses as verified conclusions.",
    event: input.event,
    allowedEvidenceRefs: input.evidenceRefs,
    output: ["summary", "problem_statement", "symptoms", "hypothesis", "verification_plan", "actions", "verification", "applicability", "tags", "evidenceRefs"],
  });
  try {
    const raw = await input.inference.complete(prompt);
    return { card: parseProviderCard(raw, input) };
  } catch (error) {
    return { card: deterministicCard(input, "rejected"), providerError: error instanceof Error ? error.message : String(error) };
  }
}

export function candidateTitle(event: RelayDomainEvent, card: CandidateCard): string {
  const subject = event.deploymentId ? `Deployment ${event.deploymentId}` : event.jobId ? `Job ${event.jobId}` : `Event ${event.id}`;
  return `${event.type.replaceAll(".", " ")} · ${subject}: ${card.summary.slice(0, 120)}`;
}
