import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { dirname } from "path";
import { mkdirSync } from "fs";
import "dotenv/config";

export interface AgentState {
  userId: number;
  agentId: string;
  username: string;
  machine?: string;
  lastSeenAt: string;
  lastClientTimestamp?: string;
}

export interface AgentJob {
  id: string;
  userId: number;
  agentId: string;
  kind: "exec" | "powershell" | "artifact-upload";
  payload: Record<string, unknown>;
  timeoutMs: number;
  status: string;
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
  result?: AgentJobResult;
}

export interface AgentJobResult {
  status: string;
  message?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export class AgentOfflineError extends Error {
  readonly category = "connection" as const;
  constructor(message: string) {
    super(message);
    this.name = "AgentOfflineError";
  }
}

export class AgentStore {
  private readonly db: Database.Database;

  constructor(dbPath = process.env.DB_PATH ?? "./data/app.db") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.ensureSchema();
  }

  close() {
    this.db.close();
  }

  heartbeat(state: Omit<AgentState, "lastSeenAt">): AgentState {
    const lastSeenAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_states (user_id, agent_id, username, machine, last_seen_at, last_client_timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, agent_id) DO UPDATE SET
        username = excluded.username,
        machine = excluded.machine,
        last_seen_at = excluded.last_seen_at,
        last_client_timestamp = excluded.last_client_timestamp
    `).run(
      state.userId,
      state.agentId,
      state.username,
      state.machine ?? null,
      lastSeenAt,
      state.lastClientTimestamp ?? null
    );
    try {
      this.db.prepare(`
        UPDATE servers
        SET status = 'connected'
        WHERE user_id = ? AND lower(agent_id) = lower(?)
      `).run(state.userId, state.agentId);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("no such table: servers")) throw error;
    }
    return { ...state, lastSeenAt };
  }

  getAgentState(userId: number, agentId: string): AgentState | undefined {
    const row = this.db.prepare(`
      SELECT user_id, agent_id, username, machine, last_seen_at, last_client_timestamp
      FROM agent_states
      WHERE user_id = ? AND lower(agent_id) = lower(?)
    `).get(userId, agentId) as any;
    if (!row) return undefined;
    return {
      userId: row.user_id,
      agentId: row.agent_id,
      username: row.username,
      machine: row.machine ?? undefined,
      lastSeenAt: row.last_seen_at,
      lastClientTimestamp: row.last_client_timestamp ?? undefined,
    };
  }

  assertOnline(userId: number, agentId: string, maxAgeMs = Number(process.env.RELAY_AGENT_OFFLINE_MS ?? 90000)): AgentState {
    const state = this.getAgentState(userId, agentId);
    if (!state) {
      throw new AgentOfflineError(`Agent link exists, but agent '${agentId}' has never checked in`);
    }
    const ageMs = Date.now() - Date.parse(state.lastSeenAt);
    if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) {
      throw new AgentOfflineError(`Agent link exists, but agent '${agentId}' is offline; last heartbeat ${state.lastSeenAt}`);
    }
    return state;
  }

  enqueueJob(userId: number, agentId: string, kind: AgentJob["kind"], payload: Record<string, unknown>, timeoutMs: number): AgentJob {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_jobs (id, user_id, agent_id, kind, payload_json, timeout_ms, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
    `).run(id, userId, agentId, kind, JSON.stringify(payload), timeoutMs, createdAt);
    return { id, userId, agentId, kind, payload, timeoutMs, status: "queued", createdAt };
  }

  claimNextJob(userId: number, agentId: string): AgentJob | undefined {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT *
        FROM agent_jobs
        WHERE user_id = ? AND lower(agent_id) = lower(?) AND status = 'queued'
        ORDER BY created_at
        LIMIT 1
      `).get(userId, agentId) as any;
      if (!row) return undefined;
      const claimedAt = new Date().toISOString();
      const changed = this.db.prepare(`
        UPDATE agent_jobs
        SET status = 'running', claimed_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(claimedAt, row.id);
      if (changed.changes !== 1) return undefined;
      return this.mapJob({ ...row, status: "running", claimed_at: claimedAt });
    });
    return claim();
  }

  appendEvent(userId: number, agentId: string, jobId: string, event: unknown) {
    this.assertJobOwner(userId, agentId, jobId);
    this.db.prepare(`
      INSERT INTO agent_job_events (job_id, created_at, event_json)
      VALUES (?, ?, ?)
    `).run(jobId, new Date().toISOString(), JSON.stringify(event));
  }

  completeJob(userId: number, agentId: string, jobId: string, result: AgentJobResult) {
    this.assertJobOwner(userId, agentId, jobId);
    const status = result.status === "completed" && (result.exitCode ?? 0) === 0 ? "completed" : "failed";
    this.db.prepare(`
      UPDATE agent_jobs
      SET status = ?, completed_at = ?, result_json = ?
      WHERE id = ?
    `).run(status, new Date().toISOString(), JSON.stringify(result), jobId);
  }

  getJob(jobId: string): AgentJob | undefined {
    const row = this.db.prepare("SELECT * FROM agent_jobs WHERE id = ?").get(jobId) as any;
    return row ? this.mapJob(row) : undefined;
  }

  cancelJob(jobId: string, status = "cancelled") {
    this.db.prepare(`
      UPDATE agent_jobs
      SET status = ?, completed_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(status, new Date().toISOString(), jobId);
  }

  async waitForJob(jobId: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentJob> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        this.cancelJob(jobId);
        throw new Error(`Agent job '${jobId}' was cancelled`);
      }
      const job = this.getJob(jobId);
      if (!job) throw new Error(`Agent job '${jobId}' disappeared`);
      if (job.status === "completed" || job.status === "failed") return job;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.cancelJob(jobId, "unknown");
    throw new Error(`Agent job '${jobId}' timed out after ${timeoutMs}ms; remote completion is unknown`);
  }

  private assertJobOwner(userId: number, agentId: string, jobId: string) {
    const row = this.db.prepare(`
      SELECT id FROM agent_jobs
      WHERE id = ? AND user_id = ? AND lower(agent_id) = lower(?)
    `).get(jobId, userId, agentId);
    if (!row) throw new Error(`Agent job '${jobId}' not found`);
  }

  private mapJob(row: any): AgentJob {
    return {
      id: row.id,
      userId: row.user_id,
      agentId: row.agent_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json),
      timeoutMs: row.timeout_ms,
      status: row.status,
      createdAt: row.created_at,
      claimedAt: row.claimed_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
    };
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_states (
        user_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL COLLATE NOCASE,
        username TEXT NOT NULL,
        machine TEXT,
        last_seen_at TEXT NOT NULL,
        last_client_timestamp TEXT,
        PRIMARY KEY (user_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS agent_jobs (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL COLLATE NOCASE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT,
        result_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_agent_jobs_next
      ON agent_jobs (user_id, agent_id, status, created_at);

      CREATE TABLE IF NOT EXISTS agent_job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
    `);
  }
}

let defaultStore: AgentStore | undefined;

export function getAgentStore(): AgentStore {
  defaultStore ??= new AgentStore();
  return defaultStore;
}
