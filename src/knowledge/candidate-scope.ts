import { z } from "zod";
import type { WorkSession } from "./work-session.js";

const scopeSchema = z.object({
  schemaVersion: z.literal(1), origin: z.enum(["compile", "review"]), capturedAt: z.string().datetime(),
  projectId: z.string().min(1), environment: z.string().nullable(), sampleManagerVersion: z.string().nullable(),
  solution: z.string().nullable(), module: z.string().nullable(),
}).strict();
export type CandidateScopeSnapshot = z.infer<typeof scopeSchema>;
export function candidateScopeSnapshot(session: WorkSession, origin: CandidateScopeSnapshot["origin"], capturedAt: string): CandidateScopeSnapshot {
  return scopeSchema.parse({ schemaVersion: 1, origin, capturedAt, projectId: session.projectId,
    environment: session.environment ?? null, sampleManagerVersion: session.intent.sampleManagerVersion ?? null,
    solution: session.intent.solution ?? null, module: session.intent.module ?? null });
}
export function readCandidateScope(value: unknown): CandidateScopeSnapshot | undefined {
  try { const parsed = scopeSchema.safeParse(typeof value === "string" ? JSON.parse(value) : value); return parsed.success ? parsed.data : undefined; }
  catch { return undefined; }
}
export function candidateScopeMatches(scope: CandidateScopeSnapshot, row: Record<string, unknown>): boolean {
  return row.project_id === scope.projectId && (row.environment ?? null) === scope.environment &&
    (row.samplemanager_version ?? null) === scope.sampleManagerVersion && (row.solution ?? null) === scope.solution && (row.module ?? null) === scope.module;
}

// Apply before lexical candidate limiting and before external embedding/rerank.
// Unrelated Case/Memory records retain their existing lifecycle and scope rules.
const snapshot = "CASE WHEN json_valid(ci.scope_snapshot_json) THEN ci.scope_snapshot_json ELSE '{}' END";
export const CANDIDATE_CASE_SCOPE_GUARD_SQL = `(d.kind<>'case' OR d.source_locator NOT LIKE 'candidate-insight:%' OR EXISTS (
  SELECT 1 FROM knowledge_candidate_insights ci WHERE d.source_locator='candidate-insight:'||ci.id AND ci.status='accepted'
  AND json_extract(${snapshot},'$.schemaVersion')=1 AND json_extract(${snapshot},'$.origin') IN ('compile','review')
  AND ci.project_id=@projectId AND ci.project_id=d.project_id AND json_extract(${snapshot},'$.projectId') IS d.project_id
  ${[["environment","environment"],["sampleManagerVersion","samplemanager_version"],["solution","solution"],["module","module"]].map(([key,column]) => `AND json_type(${snapshot},'$.${key}') IN ('text','null') AND json_extract(${snapshot},'$.${key}') IS d.${column}`).join("\n")}
))`;
