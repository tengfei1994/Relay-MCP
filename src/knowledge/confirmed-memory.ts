import { z } from "zod";
import type { KnowledgeStore } from "./store.js";

export const CONFIRMED_MEMORY_TYPES = ["Fact", "Decision", "Case", "Pattern"] as const;
export type ConfirmedMemoryType = typeof CONFIRMED_MEMORY_TYPES[number];
export type ConfirmedMemoryStatus = "confirmed" | "deprecated";

export interface ConfirmedMemorySource {
  kind: "candidate_insight" | "manual" | "legacy";
  id?: string;
  locator: string;
}

export interface ConfirmedMemoryScope {
  projectId: string;
  environment?: string;
  scopeType: "project" | "environment" | "organization" | "global" | "system";
  scopeKey: string;
  visibility: "private" | "project" | "organization" | "global";
}

export interface ConfirmedMemoryAudit {
  reason: string;
  reviewId?: string;
  action: "promote" | "edit" | "manual";
  metadata?: Record<string, unknown>;
}

export type ConfirmedMemoryDetails =
  | { subject: string; value: string }
  | { decision: string; rationale: string; alternatives: string[] }
  | { symptoms: string; rootCause: string; resolution: string; verification: string }
  | { statement: string; applicability: string; signals: string[]; exceptions: string[] };

export interface ConfirmedMemoryInput {
  id: string;
  type: ConfirmedMemoryType;
  title: string;
  statement: string;
  details: ConfirmedMemoryDetails;
  scope: ConfirmedMemoryScope;
  evidenceRefs: string[];
  source: ConfirmedMemorySource;
  confirmedBy: number;
  confirmedAt: string;
  audit: ConfirmedMemoryAudit;
  status?: ConfirmedMemoryStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConfirmedMemory extends ConfirmedMemoryInput {
  status: ConfirmedMemoryStatus;
  createdAt: string;
  updatedAt: string;
}

const detailsSchemas: Record<ConfirmedMemoryType, z.ZodTypeAny> = {
  Fact: z.object({ subject: z.string().trim().min(1), value: z.string().trim().min(1) }).strict(),
  Decision: z.object({ decision: z.string().trim().min(1), rationale: z.string().trim().min(1), alternatives: z.array(z.string().trim().min(1)).max(50) }).strict(),
  Case: z.object({ symptoms: z.string().trim().min(1), rootCause: z.string().trim().min(1), resolution: z.string().trim().min(1), verification: z.string().trim().min(1) }).strict(),
  Pattern: z.object({ statement: z.string().trim().min(1), applicability: z.string().trim().min(1), signals: z.array(z.string().trim().min(1)).max(50), exceptions: z.array(z.string().trim().min(1)).max(50) }).strict(),
};

export function validateConfirmedMemoryDetails(type: ConfirmedMemoryType, details: unknown): ConfirmedMemoryDetails {
  return detailsSchemas[type].parse(details) as ConfirmedMemoryDetails;
}

export function assertConfirmedMemoryInput(input: ConfirmedMemoryInput): void {
  if (!CONFIRMED_MEMORY_TYPES.includes(input.type)) throw new Error(`Invalid Confirmed Memory type: ${String(input.type)}`);
  if (!input.evidenceRefs.length) throw new Error("Confirmed Memory requires at least one Evidence reference");
  if (!input.scope.projectId || !input.scope.scopeKey) throw new Error("Confirmed Memory scope is required");
  if (!input.source.locator) throw new Error("Confirmed Memory source is required");
  if (!Number.isInteger(input.confirmedBy) || input.confirmedBy <= 0) throw new Error("Confirmed Memory confirmer is required");
  if (!input.confirmedAt.trim() || !Number.isFinite(Date.parse(input.confirmedAt))) throw new Error("Confirmed Memory confirmation time is required");
  if (!input.audit.reason.trim()) throw new Error("Confirmed Memory audit reason is required");
  validateConfirmedMemoryDetails(input.type, input.details);
}

function parse<T>(value: unknown, fallback: T): T { try { return JSON.parse(String(value ?? "")) as T; } catch { return fallback; } }

export function confirmedMemoryFromRow(row: Record<string, unknown>): ConfirmedMemory {
  const scope = parse<ConfirmedMemoryScope>(row.scope_json, { projectId: String(row.project_id ?? ""), scopeType: "project", scopeKey: String(row.project_id ?? ""), visibility: "project" });
  return {
    id: String(row.id), type: String(row.memory_type) as ConfirmedMemoryType, title: String(row.title), statement: String(row.statement),
    details: parse<ConfirmedMemoryDetails>(row.details_json, {} as ConfirmedMemoryDetails), scope,
    evidenceRefs: parse<string[]>(row.evidence_refs_json, []), source: parse<ConfirmedMemorySource>(row.source_json, { kind: "legacy", locator: "unknown" }),
    confirmedBy: Number(row.confirmed_by), confirmedAt: String(row.confirmed_at), audit: parse<ConfirmedMemoryAudit>(row.audit_json, { action: "manual", reason: "legacy" }),
    status: String(row.status) as ConfirmedMemoryStatus, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export class ConfirmedMemoryService {
  constructor(private readonly store: KnowledgeStore, private readonly clock: () => Date = () => new Date()) {}

  save(input: ConfirmedMemoryInput): ConfirmedMemory {
    assertConfirmedMemoryInput(input);
    const existing = this.store.db.prepare("SELECT memory_type FROM knowledge_confirmed_memories WHERE id = ?").get(input.id) as { memory_type?: string } | undefined;
    if (existing && existing.memory_type !== input.type) throw new Error("Confirmed Memory type is immutable");
    if (!this.store.canRead(input.confirmedBy, input.scope.projectId)) throw new Error("Confirmed Memory access denied for project");
    const reviewer = this.store.db.prepare("SELECT can_review FROM knowledge_acl WHERE project_id = ? AND user_id = ?").get(input.scope.projectId, input.confirmedBy) as { can_review?: number } | undefined;
    if (reviewer?.can_review !== 1) throw new Error("Confirmed Memory requires a reviewer");
    const missing = input.evidenceRefs.filter((id) => !this.store.db.prepare("SELECT 1 FROM knowledge_evidence WHERE id = ? AND deleted_at IS NULL").get(id));
    if (missing.length) throw new Error(`Confirmed Memory Evidence not found: ${missing.join(", ")}`);
    const outside = input.evidenceRefs.filter((id) => {
      const row = this.store.db.prepare("SELECT project_id FROM knowledge_evidence WHERE id = ?").get(id) as { project_id?: string } | undefined;
      return row?.project_id !== input.scope.projectId && !this.store.db.prepare("SELECT 1 FROM knowledge_evidence_acl WHERE evidence_id = ? AND project_id = ?").get(id, input.scope.projectId);
    });
    if (outside.length) throw new Error(`Confirmed Memory Evidence is outside the project ACL: ${outside.join(", ")}`);
    const now = this.clock().toISOString();
    const value: ConfirmedMemory = { ...input, status: input.status ?? "confirmed", createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now };
    this.store.db.prepare(`INSERT INTO knowledge_confirmed_memories
      (id,memory_type,title,statement,details_json,project_id,environment,scope_json,evidence_refs_json,source_json,confirmed_by,confirmed_at,audit_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET memory_type=excluded.memory_type,title=excluded.title,statement=excluded.statement,details_json=excluded.details_json,project_id=excluded.project_id,environment=excluded.environment,scope_json=excluded.scope_json,evidence_refs_json=excluded.evidence_refs_json,source_json=excluded.source_json,confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at,audit_json=excluded.audit_json,status=excluded.status,updated_at=excluded.updated_at`)
      .run(value.id, value.type, value.title, value.statement, JSON.stringify(value.details), value.scope.projectId, value.scope.environment ?? null, JSON.stringify(value.scope), JSON.stringify(value.evidenceRefs), JSON.stringify(value.source), value.confirmedBy, value.confirmedAt, JSON.stringify(value.audit), value.status, value.createdAt, value.updatedAt);
    const link = this.store.db.prepare("INSERT OR IGNORE INTO knowledge_entity_evidence(entity_type,entity_id,evidence_id,created_at) VALUES ('confirmed_memory',?,?,?)");
    for (const evidenceId of value.evidenceRefs) link.run(value.id, evidenceId, value.createdAt);
    this.store.audit({ actorId: value.confirmedBy, projectId: value.scope.projectId, action: "confirmed_memory.save", entityType: "confirmed_memory", entityId: value.id, details: { type: value.type, evidenceCount: value.evidenceRefs.length, reason: value.audit.reason } });
    return value;
  }

  get(input: { actorId: number; id: string }): ConfirmedMemory {
    const row = this.store.db.prepare("SELECT * FROM knowledge_confirmed_memories WHERE id = ?").get(input.id) as Record<string, unknown> | undefined;
    if (!row || !this.store.canRead(input.actorId, String(row.project_id))) throw new Error("Confirmed Memory not found");
    return confirmedMemoryFromRow(row);
  }

  list(input: { actorId: number; projectId: string; type?: ConfirmedMemoryType; environment?: string; limit?: number }): ConfirmedMemory[] {
    if (!this.store.canRead(input.actorId, input.projectId)) throw new Error("Confirmed Memory access denied for project");
    const conditions = ["(project_id = ? OR json_extract(scope_json, '$.visibility') IN ('global','organization'))", "status = 'confirmed'"]; const params: unknown[] = [input.projectId];
    if (input.type) { conditions.push("memory_type = ?"); params.push(input.type); }
    if (input.environment) { conditions.push("(environment IS NULL OR environment = ?)"); params.push(input.environment); }
    const rows = this.store.db.prepare(`SELECT * FROM knowledge_confirmed_memories WHERE ${conditions.join(" AND ")} ORDER BY confirmed_at DESC LIMIT ?`).all(...params, Math.max(1, Math.min(input.limit ?? 50, 100))) as Array<Record<string, unknown>>;
    return rows.map(confirmedMemoryFromRow).filter((memory) => {
      if (memory.scope.projectId === input.projectId) return true;
      return memory.evidenceRefs.every((evidenceId) => Boolean(this.store.db.prepare("SELECT 1 FROM knowledge_evidence_acl WHERE evidence_id = ? AND project_id = ?").get(evidenceId, input.projectId)));
    });
  }
}
