import { createHash } from "node:crypto";

const WORK_SESSION_TOOLS = new Set([
  "knowledge_work_session_open", "knowledge_work_session_update", "knowledge_work_session_close",
  "knowledge_work_session_get", "knowledge_work_session_list",
]);
const ENUM_METADATA: Readonly<Record<string, readonly string[]>> = {
  phase: ["explore", "diagnosis", "implementation", "validation", "closure"],
  risk: ["read_only", "reversible_change", "controlled_change", "production"],
  knowledgeMode: ["retrieve", "capture", "retrieve_and_capture"],
  status: ["open", "active", "awaiting_review", "completed", "abandoned", "needs_clarification"],
};
const ACTIONS = new Set(["understand", "diagnose", "design", "implement", "deploy", "verify", "capture"]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function addDigest(metadata: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) return;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) return;
    metadata[`${key}Hash`] = createHash("sha256").update(text, "utf8").digest("hex");
    metadata[`${key}Length`] = [...text].length;
    metadata[`${key}Bytes`] = Buffer.byteLength(text, "utf8");
  } catch {
    // Malformed in-process values must not make audit throw or echo the value.
    metadata[`${key}Serializable`] = false;
  }
}

/** Metadata for the audit copy only; service validation receives the original. */
export function workSessionAuditArguments(toolName: string, input: unknown): Record<string, unknown> | undefined {
  if (!WORK_SESSION_TOOLS.has(toolName)) return undefined;
  const metadata: Record<string, unknown> = { schemaVersion: 1 };
  const args = object(input);
  if (!args) return metadata;
  for (const key of ["intent", "patch", "summary", "result", "idempotencyKey"] as const) addDigest(metadata, key, args[key]);
  if (typeof args.sessionId === "string" && /^session-[a-f0-9]{32}$/.test(args.sessionId)) metadata.sessionId = args.sessionId;
  else addDigest(metadata, "sessionId", args.sessionId);
  if (typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 200) metadata.limit = args.limit;

  const envelope = object(toolName === "knowledge_work_session_open" ? args.intent : toolName === "knowledge_work_session_update" ? args.patch : undefined);
  if (envelope) {
    // Only canonical identity and closed enums are raw metadata. Free-form text,
    // unknown keys, and rejected values are represented solely by the digest.
    if (typeof envelope.projectId === "string" && /^[1-9]\d*$/.test(envelope.projectId) && Number.isSafeInteger(Number(envelope.projectId))) metadata.projectId = envelope.projectId;
    for (const [key, values] of Object.entries(ENUM_METADATA)) {
      if (typeof envelope[key] === "string" && values.includes(envelope[key])) metadata[key] = envelope[key];
    }
    if (Array.isArray(envelope.actions) && envelope.actions.length <= ACTIONS.size && envelope.actions.every(action => typeof action === "string" && ACTIONS.has(action))) metadata.actions = [...envelope.actions];
  }
  return metadata;
}
