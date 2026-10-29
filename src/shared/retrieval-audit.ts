import { createHash } from "node:crypto";
import { sanitizeAuditArguments } from "./audit-sanitizer.js";
import { workSessionAuditArguments } from "./work-session-audit.js";
import { candidateCompileAuditArguments } from "./candidate-compile-audit.js";
import { knowledgeOperationAuditArguments } from "./knowledge-operation-audit.js";

const RETRIEVAL_TOOLS = new Set([
  "memory_search", "knowledge_search", "knowledge_source_search",
  "knowledge_wiki_search", "samplemanager_diagnose",
]);
const SCOPE_FIELDS = [
  "project", "projectId", "environment", "sampleManagerVersion", "productVersion",
  "version", "solution", "module", "language", "scopeType", "scopeKey",
  "baselineId", "projectSnapshotId", "topicId", "workSessionId",
  "intentStep", "objectiveRef", "acceptanceCriterionRef", "status",
] as const;

/** A retrieval tool's audit copy is metadata; execution still receives the input. */
export function sanitizeToolAuditArguments(toolName: string, input: unknown): unknown {
  const operation = knowledgeOperationAuditArguments(toolName, input);
  if (operation) return operation;
  const candidate = candidateCompileAuditArguments(toolName, input);
  if (candidate) return candidate;
  const workSession = workSessionAuditArguments(toolName, input);
  if (workSession) return workSession;
  if (!RETRIEVAL_TOOLS.has(toolName)) return sanitizeAuditArguments(input);
  const metadata: Record<string, unknown> = { schemaVersion: 1 };
  if (!input || typeof input !== "object" || Array.isArray(input)) return metadata;
  const args = input as Record<string, unknown>;
  if (typeof args.query === "string") {
    metadata.queryHash = createHash("sha256").update(args.query, "utf8").digest("hex");
    metadata.queryLength = [...args.query].length;
    metadata.queryBytes = Buffer.byteLength(args.query, "utf8");
  }
  for (const key of SCOPE_FIELDS) {
    const value = args[key];
    if (typeof value === "string" && value.length <= 500) metadata[key] = value;
  }
  for (const key of ["limit", "offset"] as const) {
    if (typeof args[key] === "number" && Number.isSafeInteger(args[key]) && args[key] >= 0) metadata[key] = args[key];
  }
  // Unknown fields, raw nested objects and future response-like fields never
  // enter telemetry merely because the transport accepts an argument object.
  return sanitizeAuditArguments(metadata);
}
