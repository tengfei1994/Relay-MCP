import type { RelayDomainEvent } from "./store.js";
import { extractExecutionSummaryStreams } from "../shared/output.js";

export type EventClass =
  | "telemetry_only"
  | "observation"
  | "execution_failure"
  | "integration_contract_failure"
  | "deployment_failure"
  | "deployment_rollback"
  | "runtime_validation_failure"
  | "needs_review";

export interface EventClassification {
  eventClass: EventClass;
  captureCandidate: boolean;
  storeObservation: boolean;
  captureReason: string;
  problemStatement?: string;
}

export interface ExecutionObservationSignals {
  stdout?: string;
  stderr?: string;
  output?: unknown;
  logs: string[];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "true" || value === "yes";
}

function meaningful(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim()) && !/^\(empty\)$/i.test(value.trim());
  return value !== undefined && value !== null;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && meaningful(value) ? value.trim() : undefined;
}

/**
 * Normalize execution output from both current structured events and legacy
 * events that embedded summarizeExec output inside payload.summary.
 */
export function extractExecutionObservationSignals(payload: Record<string, unknown>): ExecutionObservationSignals {
  const summaryStreams = extractExecutionSummaryStreams(textValue(payload.summary));
  const logs = Array.isArray(payload.logs)
    ? payload.logs
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .filter((entry) => entry.level === "stdout" || entry.level === "stderr")
      .map((entry) => textValue(entry.message))
      .filter((message): message is string => Boolean(message))
    : [];
  const stdout = textValue(payload.stdout) ?? summaryStreams.stdout;
  const stderr = textValue(payload.stderr) ?? summaryStreams.stderr;
  const output = meaningful(payload.output) ? payload.output : meaningful(payload.result) ? payload.result : meaningful(payload.observedOutput) ? payload.observedOutput : undefined;
  return { stdout, stderr, output, logs };
}

function hasExecutionObservation(signals: ExecutionObservationSignals): boolean {
  return Boolean(signals.stdout || signals.stderr || meaningful(signals.output) || signals.logs.length > 0);
}

/** Deterministic, provider-independent classification for operational events. */
export function classifyRelayEvent(event: RelayDomainEvent): EventClassification {
  const payload = event.payload ?? {};
  const status = text(payload.status)?.toLowerCase();
  const parseStatus = text(payload.parseStatus ?? payload.parse_status)?.toLowerCase();
  const parseError = text(payload.parseError ?? payload.parse_error);
  const error = text(payload.error) ?? text(payload.message);
  const validation = text(payload.validationStatus ?? payload.validation_status)?.toLowerCase();
  const explicitlyMarked = truthy(payload.recordAsKnowledge) || truthy(payload.record_as_knowledge) || truthy(payload.knowledge);
  const warning = Boolean(text(payload.warning) ?? text(payload.warnings));
  const executionSignals = extractExecutionObservationSignals(payload);
  const success = ["succeeded", "success", "completed", "ok", "passed"].includes(status ?? "");
  const failed = ["failed", "failure", "error"].includes(status ?? "") || Boolean(error);

  if (explicitlyMarked) return { eventClass: "needs_review", captureCandidate: true, storeObservation: false, captureReason: "User explicitly marked this event for Knowledge review.", problemStatement: error ?? `${event.type} was explicitly marked for Knowledge review.` };
  if (event.type === "deployment.rolled_back") return { eventClass: "deployment_rollback", captureCandidate: true, storeObservation: false, captureReason: "Deployment rollback was recorded.", problemStatement: error ?? `Deployment ${event.deploymentId ?? event.id} was rolled back.` };
  if (event.type.startsWith("deployment.") && (event.type === "deployment.failed" || failed)) return { eventClass: "deployment_failure", captureCandidate: true, storeObservation: false, captureReason: "Deployment ended with a failure signal.", problemStatement: error ?? `Deployment ${event.deploymentId ?? event.id} failed.` };
  if (validation && ["failed", "failure", "unknown", "not_run"].includes(validation)) return { eventClass: "runtime_validation_failure", captureCandidate: true, storeObservation: false, captureReason: `Runtime validation status is ${validation}.`, problemStatement: error ?? `Runtime validation for ${event.deploymentId ?? event.jobId ?? event.id} is ${validation}.` };
  if (parseStatus === "failed" || parseStatus === "invalid" || Boolean(parseError)) return { eventClass: "integration_contract_failure", captureCandidate: true, storeObservation: false, captureReason: "Structured output parsing failed or violated the integration contract.", problemStatement: parseError ?? `${event.type} completed but its structured output could not be parsed.` };
  // Relay interruptions/cancellations are terminal execution anomalies even
  // when their payload only carries an `unknown`/`cancelled` status. Keep
  // these events reviewable instead of treating them as routine telemetry.
  if (event.type === "job.interrupted" || event.type === "job.cancelled") return { eventClass: "execution_failure", captureCandidate: true, storeObservation: false, captureReason: "Job execution was interrupted or cancelled before normal completion.", problemStatement: error ?? `Job ${event.jobId ?? event.id} was ${event.type.endsWith("interrupted") ? "interrupted" : "cancelled"}.` };
  if (event.type === "deployment.interrupted") return { eventClass: "deployment_failure", captureCandidate: true, storeObservation: false, captureReason: "Deployment execution was interrupted before normal completion.", problemStatement: error ?? `Deployment ${event.deploymentId ?? event.id} was interrupted.` };
  if (event.type.startsWith("job.") && failed) return { eventClass: "execution_failure", captureCandidate: true, storeObservation: false, captureReason: "Job ended with a failure or error signal.", problemStatement: error ?? `Job ${event.jobId ?? event.id} failed.` };
  if (!success && (event.type.endsWith(".finished") || event.type.endsWith(".unknown") || event.type.endsWith(".pending_validation"))) return { eventClass: "needs_review", captureCandidate: true, storeObservation: false, captureReason: "Terminal outcome is missing a confirmed success status.", problemStatement: `${event.type} has no confirmed successful status.` };
  if (warning || payload.facts || payload.observedSymptoms) return { eventClass: "observation", captureCandidate: false, storeObservation: true, captureReason: "The event contains facts or warnings but no confirmed reusable conclusion." };
  if (hasExecutionObservation(executionSignals)) {
    const stream = executionSignals.stderr ? "stderr output" : executionSignals.stdout ? "captured execution output" : "structured execution results";
    return {
      eventClass: "observation",
      captureCandidate: false,
      storeObservation: true,
      captureReason: `The event contains ${stream} that records runtime facts without a confirmed reusable conclusion.`,
      problemStatement: executionSignals.stderr
        ? "The execution completed but emitted stderr output that requires review."
        : "The execution produced observable runtime output without a confirmed reusable conclusion.",
    };
  }
  return { eventClass: "telemetry_only", captureCandidate: false, storeObservation: false, captureReason: "Routine successful execution without an anomaly or reusable Knowledge signal." };
}
