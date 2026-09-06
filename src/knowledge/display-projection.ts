import type { CandidateCard, KnowledgeDocument, Evidence } from "./domain.js";

export type HumanStatus = "captured" | "under_review" | "reproduced" | "verified" | "approved" | "deprecated" | "routine";

const EVENT_CLASS_LABELS: Record<string, string> = {
  telemetry_only: "Routine execution",
  observation: "Runtime observation",
  execution_failure: "Execution failure",
  integration_contract_failure: "Integration contract failure",
  deployment_failure: "Deployment failure",
  deployment_rollback: "Deployment rollback",
  runtime_validation_failure: "Runtime validation failure",
  needs_review: "Needs review",
};

export function eventClassLabel(value?: string): string {
  return value ? EVENT_CLASS_LABELS[value] ?? value.replaceAll("_", " ") : "Knowledge review signal";
}

export function lifecycleHumanStatus(lifecycle?: string, recordType?: string): HumanStatus {
  if (lifecycle === "deprecated") return "deprecated";
  if (recordType === "telemetry") return "routine";
  if (lifecycle === "approved") return "approved";
  if (lifecycle === "verified") return "verified";
  if (lifecycle === "reproduced") return "reproduced";
  if (lifecycle === "draft") return "under_review";
  return "captured";
}

export function evidenceDisplayTitle(evidence: Pick<Evidence, "locator" | "sourceKind" | "mimeType">): string {
  const locator = evidence.locator ?? "";
  const lower = locator.toLowerCase();
  if (lower.includes("stdout")) return "Remote command stdout";
  if (lower.includes("stderr")) return "Remote command stderr";
  if (lower.includes("powershell") || lower.includes("command")) return "Remote PowerShell execution log";
  if (lower.includes("rollback")) return "Deployment rollback log";
  if (lower.includes("hash") || lower.includes("sha")) return "Assembly SHA-256 hash";
  if (lower.includes("manifest")) return "Deployment manifest";
  if (evidence.sourceKind === "log") return "Operational execution log";
  if (evidence.sourceKind === "test") return "Runtime validation result";
  if (evidence.sourceKind === "artifact") return "Operational artifact";
  if (/json|xml/i.test(evidence.mimeType)) return "Structured command output";
  return "Captured operational evidence";
}

export function evidenceDisplaySummary(evidence: Pick<Evidence, "locator" | "sourceKind">): string {
  const locator = evidence.locator ?? "";
  if (/stdout/i.test(locator)) return "The original standard output captured from the remote command.";
  if (/stderr/i.test(locator)) return "The original error output captured from the remote command.";
  if (evidence.sourceKind === "log") return "An immutable execution log retained for traceability.";
  if (evidence.sourceKind === "test") return "A validation result retained to show what was checked.";
  return "An immutable source artifact retained for traceability.";
}

export function candidateDisplayProjection(card: CandidateCard, document?: {
  lifecycle?: KnowledgeDocument["lifecycle"];
  eventId?: string;
  jobId?: string;
  deploymentId?: string;
  sourceLocator?: string;
}) {
  const unknowns = card.verifiedConclusion ? ["No unresolved root-cause statement recorded."] : ["Root cause has not been verified.", "Impact and reuse boundaries still need reviewer confirmation."];
  const nextAction = card.actions[0] ?? card.verificationPlan[0] ?? "Review the linked Evidence and reproduce the event.";
  return {
    recordType: "candidate",
    displayTitle: card.summary,
    displaySummary: card.problemStatement,
    problemStatement: card.problemStatement,
    facts: card.facts,
    unknowns,
    nextAction,
    captureReasonText: card.captureReason ?? `Captured because the event was classified as ${eventClassLabel(card.eventClass)}.`,
    humanStatus: lifecycleHumanStatus(document?.lifecycle, "candidate"),
    provenance: { eventId: document?.eventId, jobId: document?.jobId, deploymentId: document?.deploymentId, sourceLocator: document?.sourceLocator },
  };
}
