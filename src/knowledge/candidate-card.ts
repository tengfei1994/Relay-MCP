import type { InferenceProvider } from "./providers.js";
import type { CandidateCard } from "./domain.js";
import type { RelayDomainEvent } from "./store.js";

const SECRET_KEY = /(password|passwd|pwd|token|secret|api[_-]?key|credential|authorization|connection|string)/i;

export interface CandidateCardGenerationInput {
  event: RelayDomainEvent;
  projectId: string | number;
  candidateId?: string;
  evidenceRefs: string[];
  inference?: InferenceProvider;
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
  const error = text(event.payload.error) ?? text(event.payload.message);
  const subject = event.deploymentId ? `deployment ${event.deploymentId}` : event.jobId ? `job ${event.jobId}` : `event ${event.id}`;
  const summary = error ? `${event.type} captured for ${subject}: ${error.slice(0, 240)}` : `${event.type} captured for ${subject}${status ? ` with status ${status}` : ""}.`;
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
    problemStatement: error ? `${event.type} reported for ${subject}: ${error}` : `${event.type} was observed for ${subject}; the event payload is retained as Raw Event evidence.`,
    facts: safeFacts(event, projectId),
    symptoms: [...new Set([...(error ? [error] : []), ...strings(event.payload.symptoms), ...strings(event.payload.observedSymptoms)])].slice(0, 20),
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
