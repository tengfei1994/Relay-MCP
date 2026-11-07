import { runtimeProblemSignals, runtimeStreams } from "./runtime-signals.js";
import type { BusinessContext } from "./domain.js";

export interface CandidateNarrative {
  version: string;
  assessment: "signal" | "routine" | "insufficient";
  title: string;
  summary: string;
  occurredAt?: string;
  environment?: string;
  facts: string[];
  unknowns: string[];
  recommendation: string;
  nextSteps: string[];
  sourceSignals: Array<{ source: string; text: string }>;
  businessContext: BusinessContext;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function short(value: unknown): string { return typeof value === "string" ? value.replace(/\s+/g, " ").slice(0, 100).trim() : ""; }

function providedContext(payload: Record<string, unknown>): Partial<BusinessContext> {
  const nested = record(payload.businessContext ?? payload.business_context);
  const value = (keys: string[]) => keys.map((key) => short(nested[key] ?? payload[key])).find(Boolean);
  return {
    businessPurpose: value(["businessPurpose", "business_purpose", "purpose"]),
    affectedProcess: value(["affectedProcess", "affected_process", "businessProcess", "business_process"]),
    businessImpact: value(["businessImpact", "business_impact", "impact"]),
    technicalComponentPurpose: value(["technicalComponentPurpose", "technical_component_purpose", "componentPurpose", "component_purpose"]),
  };
}

function deriveBusinessContext(payload: Record<string, unknown>, eventType: string, firstSignal: string, missingPaths: number): BusinessContext {
  const provided = providedContext(payload);
  const cache = /cache|formsbin|binform/i.test([eventType, firstSignal, JSON.stringify(payload)].join(" "));
  const directory = /dir\\s|directory|path|exists=/i.test([firstSignal, JSON.stringify(payload)].join(" "));
  const defaults: BusinessContext = cache
    ? { businessPurpose: "Support fast SampleManager form loading and keep definitions aligned with runtime files.", affectedProcess: "Data entry, result processing or review using the affected forms.", businessImpact: "A stale or damaged cache may prevent forms from opening, display an older version or omit controls.", technicalComponentPurpose: "FormsBin stores compiled form runtime files.", confidence: "inferred" }
    : directory
    ? { businessPurpose: "Check server configuration and runtime dependencies.", affectedProcess: "Environment checks before deployment, upgrade or troubleshooting.", businessImpact: missingPaths ? "A missing path may affect deployment or operation, but this record does not establish that it is required." : "This record does not show an impact on the business process.", technicalComponentPurpose: "Directory listings help locate runtime configuration and dependencies.", confidence: "inferred" }
    : /build/i.test(eventType)
    ? { businessPurpose: "Produce deployable software or configuration.", affectedProcess: "Development, release and upgrade workflows.", businessImpact: "A failed build can block a release; a successful build does not prove business functionality.", technicalComponentPurpose: "Build artifacts turn source code and configuration into a runnable version.", confidence: "inferred" }
    : { businessPurpose: "Support a remote operations or diagnostic task.", affectedProcess: "The operational workflow associated with this task.", businessImpact: "The record does not describe a specific business interruption or its scope.", technicalComponentPurpose: "The source does not identify the technical component's purpose.", confidence: "unknown" };
  return {
    ...defaults,
    ...Object.fromEntries(Object.entries(provided).filter(([, value]) => Boolean(value))),
    confidence: Object.values(provided).some(Boolean) ? "provided" : defaults.confidence,
  } as BusinessContext;
}

/** Read-only projection over the original event; never overwrites a reviewer edit. */
export function describeCandidate(body: string, fallback: { environment?: unknown; occurredAt?: unknown } = {}): CandidateNarrative {
  let envelope: Record<string, unknown> = {};
  try { envelope = record(JSON.parse(body)); } catch { /* Plain-text legacy sources remain explicitly unknown. */ }
  const payload = record(envelope.payload);
  const input = record(payload.input);
  const environment = short(payload.environment ?? input.environment ?? fallback.environment);
  const occurredAt = short(envelope.occurredAt ?? fallback.occurredAt);
  const streams = runtimeStreams(payload);
  const signals = runtimeProblemSignals(payload);
  const output = streams.map((s) => s.text).join("\n");
  const dirs = new Map<string, boolean>();
  for (const match of output.matchAll(/(?:^|\n)\s*DIR\s+([^\r\n]+?)\s+exists=(True|False)\s*(?=\r?\n|$)/gi)) dirs.set(match[1], match[2].toLowerCase() === "true");
  const missing = [...dirs].filter(([, exists]) => !exists);
  const found = [...dirs].filter(([, exists]) => exists);
  const names = (entries: Array<[string, boolean]>) => entries.slice(0, 4).map(([path]) => {
    const marker = path.match(/\\Server\\([^\\]+)\\(.+)$/i);
    return marker ? marker[1] + " / " + marker[2].replaceAll("\\", " / ") : path.split(/[\\/]/).filter(Boolean).slice(-2).join(" / ");
  }).join(", ");
  const status = short(payload.status).toLowerCase();
  const success = ["succeeded", "success", "completed", "ok", "passed"].includes(status);
  const eventType = short(envelope.eventType);
  const failure = /(?:failed|interrupted|cancelled|rolled_back)$/.test(eventType) || ["failed", "failure", "error", "cancelled"].includes(status) || (typeof payload.exitCode === "number" && payload.exitCode !== 0);
  const contract = /failed|invalid/.test(short(payload.parseStatus ?? payload.parse_status)) || !!payload.parseError || !!payload.parse_error;
  const validation = short(payload.validationStatus ?? payload.validation_status);
  const incompleteValidation = ["unknown", "not_run"].includes(validation);
  const hasSignal = signals.length > 0 || failure || contract || validation === "failed";
  const truncated = /truncat(?:ed|ion)|已截断/i.test(output) || payload.truncated === true;
  const prefix = environment ? "In the " + environment + " environment, " : "";
  const activity = dirs.size ? "the task checked server directories and listed their files" : eventType.startsWith("deployment.") ? "the system ran a deployment" : /build/.test(short(payload.kind)) ? "the system ran a build" : "the system ran a remote task";
  const facts: string[] = [];
  if (success) facts.push("The runner reported success. This does not establish that all business checks passed.");
  else if (failure) facts.push("The task record indicates that execution did not complete normally.");
  else facts.push("The source record does not report an explicit successful completion.");
  if (found.length) facts.push("Found " + names(found) + (found.length > 4 ? " and other directories." : "."));
  if (missing.length) facts.push("Not found: " + names(missing) + ". The source does not say whether these paths are required.");
  let title = dirs.size ? "Server directory check completed" : "Remote task record needs review";
  let finding = "";
  let nextSteps = ["Confirm what the task was intended to check and whether the result meets that requirement."];
  const first = signals[0]?.text ?? "";
  const businessContext = deriveBusinessContext(payload, eventType, first, missing.length);
  if (contract) {
    title = "Task output did not match the expected format";
    finding = "The output failed its format check and may not be usable by downstream steps.";
    nextSteps = ["Compare the expected format with the returned data, correct it and repeat the format check."];
  } else if (/rolled_back/.test(eventType)) {
    title = "Deployment rolled back; recovery needs verification";
    finding = "The record reports a rollback, but the event alone does not confirm service recovery.";
    nextSteps = ["Check the restored version, service status and business verification results."];
  } else if (/interrupted|cancelled/.test(eventType)) {
    title = "Task interrupted or cancelled; completion is unknown";
    finding = "The task did not finish normally. Its completed steps and their effects need review.";
    nextSteps = ["Check the last completed step and the server's current state before deciding whether to continue."];
  } else if (/service/i.test(first) && /wait|start|ready/i.test(first)) {
    const service = first.match(/\bservice\s+['"]?([A-Za-z0-9_.-]+)/i)?.[1];
    const duration = first.match(/(\d+)\s*(?:seconds?|secs?|秒)/i)?.[1];
    title = "Service startup is still waiting";
    finding = "The log reports that " + (service ? "service " + service : "the service") + " is waiting to start" + (duration ? " after " + duration + " seconds" : "") + ". Its final startup status needs verification.";
    nextSteps = ["Check the service state after the task and inspect the startup log for a final result."];
  } else if (/timeout|timed? out|超时/i.test(first)) {
    title = "Operation timed out; final result is unknown";
    finding = "The operation did not return within the wait period. The remote operation may still be running or may have completed.";
    nextSteps = ["Check the remote execution state and final result before deciding whether to retry."];
  } else if (/denied|permission|unauthorized|权限/i.test(first)) {
    title = "Operation blocked by an access restriction";
    finding = "The task reported access denied; affected steps may not have completed.";
    nextSteps = ["Check the execution account, target and required permissions before retrying."];
  } else if (/stale|cache/i.test(first)) {
    title = "Runtime record indicates a possibly stale cache";
    finding = "The log reports an abnormal cache state; its cause and effect on functionality need verification.";
    nextSteps = ["Compare the cache version with its source files and check whether the issue can be reproduced."];
  } else if (/missing|not found|找不到|缺失/i.test(first)) {
    title = "A resource was not found during execution";
    finding = "The log reports a missing file, dependency or other resource. Check the location and whether it is required.";
    nextSteps = ["Check the resource name, location and configuration requirements in the original message."];
  } else if (/partial|degraded|乱码/i.test(first)) {
    title = "Task output may be incomplete or unusable";
    finding = "The log reports partial results or an output quality issue; check for missing data.";
    nextSteps = ["Compare the output with the expected result for completeness and readability."];
  } else if (hasSignal) {
    title = failure ? "Remote task failed; the cause needs review" : "Task reported a signal that needs review";
    finding = "The source contains a problem signal, but does not establish its cause or business impact.";
    nextSteps = ["Review the source record and add the problem description, impact and reproduction results."];
  } else if (dirs.size) {
    title = missing.length ? "Directory check completed; some paths were not found" : "Directory check completed; requested paths found";
    finding = missing.length
      ? "Some checked paths do not exist. Whether this is a configuration issue depends on whether they are required."
      : "The retained directory results show the requested paths exist; no clear failure signal was found.";
    nextSteps = missing.length ? ["Check whether the missing paths are required. An exploratory check alone may be routine."] : ["Keep the result as directory evidence; add functional checks if functionality must be verified."];
  } else if (success) {
    title = "Task completed; no reusable problem conclusion yet";
    finding = "The retained output contains no clear problem, root cause or fix ready for review.";
  }
  if (finding) facts.push(finding);
  const assessment = hasSignal ? "signal" : (success && !missing.length && !truncated && !incompleteValidation && !!Object.keys(payload).length) ? "routine" : "insufficient";
  const unknowns = ["The source does not establish the root cause, effectiveness of a fix or applicability; a person must confirm them."];
  if (truncated) unknowns.unshift("Some output was truncated, so omitted details may contain additional information.");
  if (incompleteValidation) unknowns.unshift("Runtime validation was not run or its result is unknown; task completion does not mean validation passed.");
  if (!Object.keys(payload).length) unknowns.unshift("This legacy record lacks structured execution context and cannot be reconstructed automatically.");
  return {
    version: "candidate-narrative-v1", assessment, title,
    summary: (prefix ? prefix + activity : activity[0].toUpperCase() + activity.slice(1)) + ". " + finding,
    environment: environment || undefined, occurredAt: occurredAt || undefined,
    facts, unknowns, nextSteps,
    recommendation: assessment === "routine"
      ? "Treat this as routine execution evidence. Reject the candidate if there is no issue to reproduce and address."
      : assessment === "signal"
      ? "Review the signal and reproduction first; create a Case only after the issue is reproduced. Verify the cause and fix separately."
      : "Defer review until the expected result and findings are available. Reject the candidate if it is only a routine check.",
    sourceSignals: signals.slice(0, 4), businessContext,
  };
}
