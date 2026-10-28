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

/** Only the audit copy is projected; the compiler still receives the original input. */
export function candidateCompileAuditArguments(toolName: string, input: unknown): Record<string, unknown> | undefined {
  if (toolName !== "knowledge_candidate_insight_compile") return undefined;
  const metadata: Record<string, unknown> = { schemaVersion: 1 };
  if (!input || typeof input !== "object" || Array.isArray(input)) return metadata;
  const args = input as Record<string, unknown>;
  for (const key of ["context", "providerId", "evidenceRefs"] as const) digest(metadata, key, args[key]);
  if (typeof args.sessionId === "string" && /^session-[a-f0-9]{32}$/.test(args.sessionId)) metadata.sessionId = args.sessionId;
  else digest(metadata, "sessionId", args.sessionId);
  if (Array.isArray(args.evidenceRefs)) metadata.evidenceCount = args.evidenceRefs.length;
  for (const key of ["async", "retry"] as const) if (typeof args[key] === "boolean") metadata[key] = args[key];
  return metadata;
}
