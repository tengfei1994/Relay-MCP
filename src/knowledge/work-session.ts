import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { KnowledgeStore } from "./store.js";

export const INTENT_ACTIONS = ["understand", "diagnose", "design", "implement", "deploy", "verify", "capture"] as const;
export const INTENT_PHASES = ["explore", "diagnosis", "implementation", "validation", "closure"] as const;
export const WORK_SESSION_STATUSES = ["open", "active", "awaiting_review", "completed", "abandoned", "needs_clarification"] as const;

export type IntentAction = typeof INTENT_ACTIONS[number];
export type IntentPhase = typeof INTENT_PHASES[number];
export type WorkSessionStatus = typeof WORK_SESSION_STATUSES[number];
export type IntentRisk = "read_only" | "reversible_change" | "controlled_change" | "production";
export type KnowledgeMode = "retrieve" | "capture" | "retrieve_and_capture";

export interface IntentEnvelope {
  actions: IntentAction[];
  phase: IntentPhase;
  objective: string;
  desiredOutcome?: string;
  constraints: string[];
  acceptanceCriteria: string[];
  projectId: string;
  environment?: string;
  instanceId?: string;
  sampleManagerVersion?: string;
  solution?: string;
  module?: string;
  risk: IntentRisk;
  knowledgeMode: KnowledgeMode;
  actorId: number;
}

export interface WorkSession {
  id: string;
  actorId: number;
  projectId: string;
  environment?: string;
  status: WorkSessionStatus;
  intent: IntentEnvelope;
  summary?: string;
  unknowns: string[];
  acceptanceResults: Record<string, boolean | string>;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

const intentSchema = z.object({
  actions: z.array(z.enum(INTENT_ACTIONS)).min(1).max(INTENT_ACTIONS.length),
  phase: z.enum(INTENT_PHASES),
  objective: z.string().trim().min(1).max(4_000),
  desiredOutcome: z.string().trim().max(4_000).optional(),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(100),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(100),
  projectId: z.string().trim().min(1).max(200),
  environment: z.string().trim().max(200).optional(),
  instanceId: z.string().trim().max(200).optional(),
  sampleManagerVersion: z.string().trim().max(100).optional(),
  solution: z.string().trim().max(300).optional(),
  module: z.string().trim().max(300).optional(),
  risk: z.enum(["read_only", "reversible_change", "controlled_change", "production"]),
  knowledgeMode: z.enum(["retrieve", "capture", "retrieve_and_capture"]),
  actorId: z.number().int().positive(),
}).strict();

export function validateIntentEnvelope(input: unknown): IntentEnvelope {
  return intentSchema.parse(input) as IntentEnvelope;
}

const TERMINAL_STATUSES: readonly WorkSessionStatus[] = ["completed", "abandoned"];

/** Hidden reasoning / chain-of-thought fields are never persisted anywhere. */
const NEVER_PERSISTED_KEY = /chain.?of.?thought|hidden.?reasoning|^reasoning$|^thinking$|system.?prompt/i;

function rejectNeverPersistedKeys(value: unknown, path: string): void {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (NEVER_PERSISTED_KEY.test(key)) throw new Error(`Work Session ${path} contains '${key}'; sensitive fields and hidden reasoning are never persisted`);
    if (item && typeof item === "object") rejectNeverPersistedKeys(item, `${path}.${key}`);
  }
}

/** High-risk intents must declare how the change is bounded and verified. */
function riskScopeSatisfied(intent: IntentEnvelope): boolean {
  if (intent.risk === "production") return intent.acceptanceCriteria.length > 0 && intent.constraints.length > 0;
  if (intent.risk === "controlled_change") return intent.acceptanceCriteria.length > 0;
  return true;
}

function parseJson<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value ?? "")) as T; } catch { return fallback; }
}

function sessionFromRow(row: Record<string, unknown>): WorkSession {
  return {
    id: String(row.id), actorId: Number(row.actor_id), projectId: String(row.project_id),
    environment: row.environment ? String(row.environment) : undefined,
    status: String(row.status) as WorkSessionStatus,
    intent: parseJson<IntentEnvelope>(row.intent_json, {} as IntentEnvelope), summary: row.summary ? String(row.summary) : undefined,
    unknowns: parseJson<string[]>(row.unknowns_json, []), acceptanceResults: parseJson<Record<string, boolean | string>>(row.acceptance_results_json, {}),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), closedAt: row.closed_at ? String(row.closed_at) : undefined,
  };
}

function safeText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text.slice(0, max) : undefined;
}

export class WorkSessionService {
  constructor(private readonly store: KnowledgeStore, private readonly clock: () => Date = () => new Date()) {}

  private assertAccess(actorId: number, projectId: string): void {
    if (!this.store.canRead(actorId, projectId)) throw new Error("Work Session access denied");
  }

  private row(sessionId: string): Record<string, unknown> | undefined {
    return this.store.db.prepare("SELECT * FROM knowledge_work_sessions WHERE id=?").get(sessionId) as Record<string, unknown> | undefined;
  }

  private load(actorId: number, sessionId: string): WorkSession {
    const row = this.row(sessionId);
    if (!row || Number(row.actor_id) !== actorId) throw new Error("Work Session not found");
    this.assertAccess(actorId, String(row.project_id));
    return sessionFromRow(row);
  }

  /** Persisted operation log: a replayed key applies no mutation and no audit. */
  private recordOp(sessionId: string, op: "update" | "close", idempotencyKey: string): boolean {
    if (idempotencyKey.length > 300) throw new Error("idempotencyKey is too long");
    return this.store.db.prepare("INSERT OR IGNORE INTO knowledge_work_session_ops(session_id,op,idempotency_key,applied_at) VALUES (?,?,?,?)")
      .run(sessionId, op, idempotencyKey, this.clock().toISOString()).changes > 0;
  }

  open(input: { actorId: number; idempotencyKey: string; intent: IntentEnvelope; summary?: string }): WorkSession {
    const intent = validateIntentEnvelope({ ...input.intent, actorId: input.actorId });
    if (intent.actorId !== input.actorId) throw new Error("Intent actor does not match caller");
    this.assertAccess(input.actorId, intent.projectId);
    const key = String(input.idempotencyKey ?? "").trim(); if (!key || key.length > 300) throw new Error("idempotencyKey is required");
    const id = `session-${createHash("sha256").update(`${input.actorId}\0${key}`).digest("hex").slice(0, 32)}`;
    const status: WorkSessionStatus = riskScopeSatisfied(intent) ? "open" : "needs_clarification";
    const now = this.clock().toISOString();
    return this.store.db.transaction(() => {
      const inserted = this.store.db.prepare(`INSERT INTO knowledge_work_sessions(id,actor_id,project_id,environment,status,intent_json,summary,unknowns_json,acceptance_results_json,idempotency_key,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(actor_id, idempotency_key) DO NOTHING`)
        .run(id, input.actorId, intent.projectId, intent.environment ?? null, status, JSON.stringify(intent), safeText(input.summary, 8_000) ?? null, "[]", "{}", key, now, now);
      if (inserted.changes === 0) {
        // Idempotent replay (or a concurrent open that committed first): return
        // the original record without writing a second effective audit entry.
        const existing = this.row(id) ?? this.store.db.prepare("SELECT * FROM knowledge_work_sessions WHERE actor_id=? AND idempotency_key=?").get(input.actorId, key) as Record<string, unknown>;
        this.assertAccess(input.actorId, String(existing.project_id));
        return sessionFromRow(existing);
      }
      this.store.audit({ actorId: input.actorId, projectId: intent.projectId, action: "knowledge.work_session.open", entityType: "work_session", entityId: id, details: { status, intent: { actions: intent.actions, phase: intent.phase, projectId: intent.projectId, risk: intent.risk, knowledgeMode: intent.knowledgeMode } } });
      return this.load(input.actorId, id);
    }).immediate();
  }

  update(input: { actorId: number; sessionId: string; idempotencyKey?: string; patch: Partial<Pick<IntentEnvelope, "phase" | "desiredOutcome" | "constraints" | "acceptanceCriteria" | "environment" | "instanceId" | "sampleManagerVersion" | "solution" | "module" | "risk" | "knowledgeMode">> & { summary?: string; status?: WorkSessionStatus } }): WorkSession {
    const current = this.load(input.actorId, input.sessionId);
    if (TERMINAL_STATUSES.includes(current.status)) return current;
    rejectNeverPersistedKeys(input.patch, "patch");
    const requestedStatus = input.patch.status;
    if (requestedStatus !== undefined) {
      if (!WORK_SESSION_STATUSES.includes(requestedStatus)) throw new Error("Invalid Work Session status");
      if (requestedStatus === "completed") throw new Error("Complete a Work Session through the close operation");
    }
    const idempotencyKey = input.idempotencyKey?.trim() || undefined;
    return this.store.db.transaction(() => {
      if (idempotencyKey && !this.recordOp(current.id, "update", idempotencyKey)) {
        return this.load(input.actorId, current.id);
      }
      const freshRow = this.row(current.id);
      if (!freshRow) throw new Error("Work Session not found");
      const fresh = sessionFromRow(freshRow);
      if (TERMINAL_STATUSES.includes(fresh.status)) return fresh;
      const { summary: _summary, status: _status, ...intentPatch } = input.patch;
      const intent = validateIntentEnvelope({ ...fresh.intent, ...intentPatch, actorId: input.actorId, projectId: fresh.projectId });
      let status = requestedStatus ?? fresh.status;
      if (requestedStatus === undefined && (fresh.status === "open" || fresh.status === "needs_clarification")) {
        status = riskScopeSatisfied(intent) ? "active" : "needs_clarification";
      }
      const summary = safeText(input.patch.summary ?? fresh.summary, 8_000);
      // A repeated no-op patch must not produce another effective audit entry.
      if (status === fresh.status && JSON.stringify(intent) === JSON.stringify(fresh.intent) && (summary ?? null) === (fresh.summary ?? null)) return fresh;
      const now = this.clock().toISOString();
      const result = this.store.db.prepare("UPDATE knowledge_work_sessions SET status=?,intent_json=?,summary=?,updated_at=? WHERE id=? AND status NOT IN ('completed','abandoned')")
        .run(status, JSON.stringify(intent), summary ?? null, now, current.id);
      if (result.changes === 0) return this.load(input.actorId, current.id);
      this.store.audit({ actorId: input.actorId, projectId: fresh.projectId, action: "knowledge.work_session.update", entityType: "work_session", entityId: current.id, details: { status, idempotencyKey: idempotencyKey ? "provided" : undefined } });
      return this.load(input.actorId, current.id);
    }).immediate();
  }

  close(input: { actorId: number; sessionId: string; idempotencyKey?: string; result?: { summary?: string; unknowns?: string[]; acceptanceResults?: Record<string, boolean | string> } }): WorkSession {
    const current = this.load(input.actorId, input.sessionId);
    if (current.status === "completed") return current;
    if (current.status === "abandoned") throw new Error("Work Session is already abandoned");
    rejectNeverPersistedKeys(input.result ?? {}, "result");
    const idempotencyKey = input.idempotencyKey?.trim() || undefined;
    return this.store.db.transaction(() => {
      const freshRow = this.row(current.id);
      if (!freshRow) throw new Error("Work Session not found");
      const fresh = sessionFromRow(freshRow);
      if (fresh.status === "completed") return fresh;
      if (fresh.status === "abandoned") throw new Error("Work Session is already abandoned");
      if (idempotencyKey && !this.recordOp(fresh.id, "close", idempotencyKey)) return fresh;
      const result = input.result ?? {};
      const now = this.clock().toISOString();
      const unknowns = Array.isArray(result.unknowns) ? result.unknowns.map((value) => String(value).slice(0, 2_000)).slice(0, 100) : fresh.unknowns;
      const acceptance = result.acceptanceResults && typeof result.acceptanceResults === "object" ? result.acceptanceResults : fresh.acceptanceResults;
      // The conditional transition guarantees exactly one winner under
      // concurrent closes; the loser observes the terminal state and returns
      // the original record without a duplicate audit entry.
      const updated = this.store.db.prepare("UPDATE knowledge_work_sessions SET status='completed',summary=?,unknowns_json=?,acceptance_results_json=?,updated_at=?,closed_at=? WHERE id=? AND status NOT IN ('completed','abandoned')")
        .run(safeText(result.summary ?? fresh.summary, 8_000) ?? null, JSON.stringify(unknowns), JSON.stringify(acceptance), now, now, current.id);
      if (updated.changes === 0) {
        const racedRow = this.row(current.id);
        if (racedRow && String(racedRow.status) === "completed") return sessionFromRow(racedRow);
        throw new Error("Work Session is already abandoned");
      }
      this.store.audit({ actorId: input.actorId, projectId: fresh.projectId, action: "knowledge.work_session.close", entityType: "work_session", entityId: current.id, details: { idempotencyKey: idempotencyKey ? "provided" : undefined, acceptanceCount: Object.keys(acceptance).length, unknownCount: unknowns.length } });
      return this.load(input.actorId, current.id);
    }).immediate();
  }

  get(input: { actorId: number; sessionId: string }): WorkSession { return this.load(input.actorId, input.sessionId); }

  /** ACL-filtered listing: sessions on projects the actor can no longer read are hidden. */
  list(input: { actorId: number; limit?: number }): WorkSession[] {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const rows = this.store.db.prepare("SELECT * FROM knowledge_work_sessions WHERE actor_id=? ORDER BY updated_at DESC LIMIT ?").all(input.actorId, limit) as Array<Record<string, unknown>>;
    return rows.map(sessionFromRow).filter((session) => this.store.canRead(input.actorId, session.projectId));
  }

  /**
   * Correlation gate for Jobs/Deployments/tools: the caller must own the
   * session, keep read access to its project, and match the session scope.
   * Closed sessions no longer accept new work.
   */
  assertSessionUsable(input: { actorId: number; sessionId: string; projectId?: string; environment?: string }): WorkSession {
    const session = this.load(input.actorId, input.sessionId);
    if (TERMINAL_STATUSES.includes(session.status)) throw new Error("Work Session is closed");
    if (input.projectId && session.projectId !== input.projectId) throw new Error("Work Session project does not match caller");
    if (input.environment && session.environment && session.environment !== input.environment) throw new Error("Work Session environment does not match caller");
    return session;
  }

  correlateEvent(input: { actorId: number; sessionId: string; eventId: string; eventType: string; intentStep?: string; objectiveRef?: string; acceptanceCriterionRef?: string }): void {
    const session = this.load(input.actorId, input.sessionId); const now = this.clock().toISOString();
    this.store.db.prepare(`INSERT OR IGNORE INTO knowledge_work_session_events(id,session_id,event_id,event_type,intent_step,objective_ref,acceptance_criterion_ref,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), session.id, input.eventId, input.eventType, safeText(input.intentStep, 100) ?? null, safeText(input.objectiveRef, 200) ?? null, safeText(input.acceptanceCriterionRef, 200) ?? null, now);
  }

  listEvents(input: { actorId: number; sessionId: string }): Array<Record<string, unknown>> {
    const session = this.load(input.actorId, input.sessionId);
    return this.store.db.prepare("SELECT id,event_id,event_type,intent_step,objective_ref,acceptance_criterion_ref,created_at FROM knowledge_work_session_events WHERE session_id=? ORDER BY created_at,rowid").all(session.id) as Array<Record<string, unknown>>;
  }

  /** Time-ordered aggregation of everything correlated to the session. */
  summarize(input: { actorId: number; sessionId: string }): { session: WorkSession; eventCounts: Record<string, number>; events: Array<Record<string, unknown>> } {
    const session = this.load(input.actorId, input.sessionId);
    const events = this.listEvents(input);
    const eventCounts: Record<string, number> = {};
    for (const event of events) {
      const type = String(event.event_type);
      eventCounts[type] = (eventCounts[type] ?? 0) + 1;
    }
    return { session, eventCounts, events };
  }
}
