import { createHash } from "node:crypto";

function digest(metadata: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) return;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) return;
    metadata[`${key}Hash`] = createHash("sha256").update(text, "utf8").digest("hex");
    metadata[`${key}Length`] = [...text].length;
    metadata[`${key}Bytes`] = Buffer.byteLength(text, "utf8");
  } catch {
    metadata[`${key}Serializable`] = false;
  }
}

/** Pre-handler audit only: execution and schema validation retain the original arguments. */
export function knowledgeOperationAuditArguments(toolName: string, input: unknown): Record<string, unknown> | undefined {
  if (toolName !== "knowledge_get" && toolName !== "samplemanager_impact_analysis") return undefined;
  const metadata: Record<string, unknown> = { schemaVersion: 1 };
  if (!input || typeof input !== "object" || Array.isArray(input)) return metadata;
  const args = input as Record<string, unknown>;
  const textFields = toolName === "knowledge_get" ? ["documentId", "project"]
    : ["project", "environment", "objectId", "relationType", "intentStep", "objectiveRef", "acceptanceCriterionRef"];
  for (const key of textFields) digest(metadata, key, args[key]);
  if (typeof args.workSessionId === "string" && /^session-[a-f0-9]{32}$/.test(args.workSessionId)) metadata.workSessionId = args.workSessionId;
  else digest(metadata, "workSessionId", args.workSessionId);
  if (toolName === "samplemanager_impact_analysis") {
    if (typeof args.verifiedOnly === "boolean") metadata.verifiedOnly = args.verifiedOnly;
    if (typeof args.direction === "string" && ["upstream", "downstream", "both"].includes(args.direction)) metadata.direction = args.direction;
    if (typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 500) metadata.limit = args.limit;
    if (typeof args.maxDepth === "number" && Number.isSafeInteger(args.maxDepth) && args.maxDepth >= 0 && args.maxDepth <= 20) metadata.maxDepth = args.maxDepth;
  }
  return metadata;
}
