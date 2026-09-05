import Database from "better-sqlite3";
import { dirname } from "path";
import { mkdirSync } from "fs";
import { assertKnowledgeDbIsolated, canonicalPath } from "../shared/canonical-path.js";
import { parseBoundedNumber } from "../shared/runtime-config.js";
import { INITIAL_KNOWLEDGE_SCHEMA } from "./migrations/001-initial.js";
import { KNOWLEDGE_DOMAIN_MIGRATION } from "./migrations/002-domain.js";
import { EVENT_PROJECT_IDENTITY_MIGRATION } from "./migrations/003-event-project-identity.js";
import { KNOWLEDGE_GOVERNANCE_AUDIT_MIGRATION } from "./migrations/004-governance-audit.js";
import { EVENT_RELIABILITY_MIGRATION } from "./migrations/005-event-reliability.js";
import { EVENT_ACTOR_MIGRATION } from "./migrations/006-event-actor.js";
import { EVENT_KEY_BACKFILL_MIGRATION } from "./migrations/007-event-key-backfill.js";
import { CONSUMER_HEARTBEAT_MIGRATION } from "./migrations/008-consumer-heartbeats.js";
import { KNOWLEDGE_SEARCH_MIGRATION } from "./migrations/009-search.js";
import { KNOWLEDGE_FACTS_SEARCH_MIGRATION } from "./migrations/010-facts-search.js";
import { KNOWLEDGE_API_GOVERNANCE_MIGRATION } from "./migrations/011-api-governance.js";
import { KNOWLEDGE_HYBRID_RETRIEVAL_MIGRATION } from "./migrations/011-hybrid-retrieval.js";
import { randomUUID } from "crypto";
import { assertLifecycleTransition, KNOWLEDGE_LIFECYCLE, type KnowledgeDocument, type KnowledgeLifecycle } from "./domain.js";
import { sanitizeAuditArguments } from "../shared/audit-sanitizer.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

const KNOWLEDGE_MIGRATIONS = [
  { version: "001-initial", sql: INITIAL_KNOWLEDGE_SCHEMA },
  KNOWLEDGE_DOMAIN_MIGRATION,
  EVENT_PROJECT_IDENTITY_MIGRATION,
  KNOWLEDGE_GOVERNANCE_AUDIT_MIGRATION,
  EVENT_RELIABILITY_MIGRATION,
  EVENT_ACTOR_MIGRATION,
  EVENT_KEY_BACKFILL_MIGRATION,
  CONSUMER_HEARTBEAT_MIGRATION,
  KNOWLEDGE_SEARCH_MIGRATION,
  KNOWLEDGE_FACTS_SEARCH_MIGRATION,
  KNOWLEDGE_API_GOVERNANCE_MIGRATION,
  KNOWLEDGE_HYBRID_RETRIEVAL_MIGRATION,
];

const DEFAULT_CONSUMER_HEARTBEAT_MS = parseBoundedNumber(
  process.env.KNOWLEDGE_CONSUMER_HEARTBEAT_MS,
  7 * 24 * 60 * 60 * 1000,
  1_000,
  90 * 24 * 60 * 60 * 1000,
);

export const RELAY_DOMAIN_EVENT_TYPES = [
  "job.started",
  "job.retry",
  "job.finished",
  "job.failed",
  "job.unknown",
  "job.cancelled",
  "job.interrupted",
  "deployment.started",
  "deployment.finished",
  "deployment.failed",
  "deployment.unknown",
  "deployment.rolled_back",
  "deployment.interrupted",
  "deployment.needs_review",
  "deployment.pending_validation",
] as const;

export interface RelayDomainEvent {
  id: string;
  type: typeof RELAY_DOMAIN_EVENT_TYPES[number];
  occurredAt: string;
  projectId?: string;
  projectNameSnapshot?: string;
  jobId?: string;
  deploymentId?: string;
  payload: Record<string, unknown>;
  eventKey: string;
  actorId?: number;
}

export type RelayDomainEventInput = Omit<RelayDomainEvent, "eventKey"> & { eventKey?: string };

export interface KnowledgeStoreOptions {
  dbPath: string;
  /** Optional explicit app.db path; defaults to DB_PATH or ./data/app.db. */
  appDbPath?: string;
  casebookRoot?: string;
  evidenceRoot?: string;
  clock?: () => Date;
}

export interface KnowledgeOutboxEvent extends RelayDomainEvent { attempts: number; availableAt: string; claimToken: string; }

export class EventKeyConflictError extends Error {
  readonly code = "event_key_conflict";
  constructor(readonly eventKey: string, readonly existingId: string) {
    super(`Event key '${eventKey}' conflicts with existing event '${existingId}'`);
    this.name = "EventKeyConflictError";
  }
}

/**
 * Isolated Knowledge Plane persistence. It deliberately does not open or alter app.db.
 * Consumers use event id checkpoints, making replay safe even after a worker crash.
 */
export class KnowledgeStore {
  readonly db!: Database.Database;
  readonly casebookRoot?: string;
  readonly evidenceRoot?: string;
  private readonly now: () => Date;

  constructor(options: KnowledgeStoreOptions) {
    const appDbPath = options.appDbPath ?? process.env.DB_PATH ?? "./data/app.db";
    const dbPath = canonicalPath(options.dbPath);
    assertKnowledgeDbIsolated(dbPath, appDbPath);

    let opened: Database.Database | undefined;
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      opened = new Database(dbPath);
      this.db = opened;
      this.db.pragma("foreign_keys = ON");
      this.casebookRoot = options.casebookRoot;
      this.evidenceRoot = options.evidenceRoot;
      this.now = options.clock ?? (() => new Date());
      this.migrate();
    } catch (error) {
      // A constructor that throws cannot be closed by its caller. Release the
      // native handle here so migration failures do not leave a Windows file
      // lock that prevents the next recovery attempt.
      try {
        if (opened?.open) opened.close();
      } catch {
        // Preserve the migration/open error as the useful failure.
      }
      throw error;
    }
  }

  migrate(): void {
    // Bootstrap before querying it: migration must work on a brand-new database.
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = this.db.prepare("SELECT version FROM schema_migrations WHERE version = ?");
    const insert = this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)");
    const run = this.db.transaction(() => {
      for (const migration of KNOWLEDGE_MIGRATIONS) {
        if (applied.get(migration.version)) continue;
        try { this.db.exec(migration.sql); }
        catch (error) {
          // SQLite has no ADD COLUMN IF NOT EXISTS; tolerate a column that was
          // applied before a crash but whose migration marker was not written.
          if (migration.version === "003-event-project-identity" && /duplicate column name/i.test(String(error))) {
            // already applied before the marker was committed
          } else if (migration.version === "005-event-reliability" && /duplicate column name/i.test(String(error))) {
            // 005 may have crashed after adding event_key but before its other
            // DDL completed. Do not recreate the unique index here: 007 first
            // normalizes and dead-letters historical duplicate keys.
            this.db.exec("CREATE TABLE IF NOT EXISTS knowledge_outbox_claims (event_id TEXT NOT NULL REFERENCES relay_domain_events(id), consumer_name TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, claimed_until TEXT, claimed_by TEXT, last_error TEXT, consumed_at TEXT, PRIMARY KEY(event_id, consumer_name)); CREATE INDEX IF NOT EXISTS idx_knowledge_outbox_claims_ready ON knowledge_outbox_claims(consumer_name, available_at, claimed_until);");
          } else if (migration.version === "006-event-actor" && /duplicate column name/i.test(String(error))) {
            // column was applied before migration marker commit
          } else throw error;
        }
        insert.run(migration.version, this.now().toISOString());
      }
    });
    run();
    // Databases created by the early P01 preview may already carry the
    // 002-domain marker but not the type projections introduced later. Make
    // this additive repair safe and idempotent without rewriting user data.
    const requiredTables = ["knowledge_cases", "knowledge_patterns", "knowledge_playbooks", "knowledge_candidates", "knowledge_entity_evidence", "knowledge_ingest_runs", "knowledge_evidence_acl"];
    const missingTable = requiredTables.some((name) => !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    if (missingTable) this.db.exec(KNOWLEDGE_DOMAIN_MIGRATION.sql);
    const columns: Record<string, Array<[string, string]>> = {
      knowledge_cases: [["status", "TEXT NOT NULL DEFAULT 'draft'"], ["samplemanager_version", "TEXT"], ["solution", "TEXT"], ["module", "TEXT"], ["environment", "TEXT"]],
      knowledge_patterns: [["status", "TEXT NOT NULL DEFAULT 'draft'"], ["samplemanager_version", "TEXT"], ["solution", "TEXT"], ["module", "TEXT"], ["environment", "TEXT"]],
      knowledge_playbooks: [["status", "TEXT NOT NULL DEFAULT 'draft'"], ["samplemanager_version", "TEXT"], ["solution", "TEXT"], ["module", "TEXT"], ["environment", "TEXT"]],
      knowledge_candidates: [["status", "TEXT NOT NULL DEFAULT 'draft'"], ["reviewed_by", "INTEGER"], ["verified_at", "TEXT"], ["samplemanager_version", "TEXT"], ["solution", "TEXT"], ["module", "TEXT"], ["environment", "TEXT"]],
      knowledge_relations: [["project_id", "TEXT"], ["samplemanager_version", "TEXT"], ["solution", "TEXT"], ["module", "TEXT"], ["environment", "TEXT"], ["source_sha256", "TEXT"]],
    };
    for (const [table, definitions] of Object.entries(columns)) {
      const present = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
      for (const [name, definition] of definitions) if (!present.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }

  append(event: RelayDomainEventInput): void {
    const now = this.now().toISOString();
    const write = this.db.transaction(() => {
      const eventKey = typeof event.eventKey === "string" && event.eventKey.trim()
        ? event.eventKey.trim()
        : event.jobId ? `job:${event.jobId}:${event.type.slice("job.".length)}`
          : event.deploymentId ? `deployment:${event.deploymentId}:${event.type.slice("deployment.".length)}`
            : undefined;
      if (!eventKey) throw new Error("Knowledge events require eventKey or jobId/deploymentId for deterministic idempotency");
      const sameId = this.db.prepare("SELECT id,type,project_id,project_name_snapshot,job_id,deployment_id,actor_id,event_key,occurred_at,payload_json FROM relay_domain_events WHERE id = ?").get(event.id) as Record<string, unknown> | undefined;
      if (sameId) {
        const sameContent = String(sameId.event_key ?? "") === eventKey
          && String(sameId.type) === event.type
          && (sameId.project_id ?? null) === (event.projectId ?? null)
          && (sameId.project_name_snapshot ?? null) === (event.projectNameSnapshot ?? null)
          && (sameId.job_id ?? null) === (event.jobId ?? null)
          && (sameId.deployment_id ?? null) === (event.deploymentId ?? null)
          && (sameId.actor_id ?? null) === (event.actorId ?? null)
          && String(sameId.occurred_at) === event.occurredAt
          && canonicalJson(JSON.parse(String(sameId.payload_json))) === canonicalJson(event.payload);
        if (!sameContent) throw new EventKeyConflictError(eventKey, String(sameId.id));
        this.db.prepare("INSERT OR IGNORE INTO knowledge_outbox(event_id, available_at) VALUES (?, ?)").run(String(sameId.id), now);
        return;
      }
      const existing = this.db.prepare("SELECT id,type,project_id,job_id,deployment_id,actor_id FROM relay_domain_events WHERE event_key = ?").get(eventKey) as Record<string, unknown> | undefined;
      if (existing) {
        const same = String(existing.type) === event.type
          && (existing.project_id ?? null) === (event.projectId ?? null)
          && (existing.job_id ?? null) === (event.jobId ?? null)
          && (existing.deployment_id ?? null) === (event.deploymentId ?? null)
          && (existing.actor_id ?? null) === (event.actorId ?? null);
        const stored = this.db.prepare("SELECT occurred_at,payload_json,project_name_snapshot FROM relay_domain_events WHERE id = ?").get(String(existing.id)) as Record<string, unknown>;
        const sameImmutableContent = same
          && String(stored.occurred_at) === event.occurredAt
          && (stored.project_name_snapshot ?? null) === (event.projectNameSnapshot ?? null)
          && canonicalJson(JSON.parse(String(stored.payload_json))) === canonicalJson(event.payload);
        if (!sameImmutableContent) throw new EventKeyConflictError(eventKey, String(existing.id));
        this.db.prepare("INSERT OR IGNORE INTO knowledge_outbox(event_id, available_at) VALUES (?, ?)").run(String(existing.id), now);
        return;
      }
      const result = this.db.prepare(`INSERT OR IGNORE INTO relay_domain_events
        (id,type,occurred_at,project_id,project_name_snapshot,job_id,deployment_id,payload_json,event_key,actor_id) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(event.id, event.type, event.occurredAt, event.projectId ?? null, event.projectNameSnapshot ?? null, event.jobId ?? null, event.deploymentId ?? null, JSON.stringify(event.payload), eventKey, event.actorId ?? null);
      const canonical = result.changes ? event.id : (this.db.prepare("SELECT id FROM relay_domain_events WHERE event_key = ?").get(eventKey) as { id?: string } | undefined)?.id;
      if (canonical) this.db.prepare("INSERT OR IGNORE INTO knowledge_outbox(event_id, available_at) VALUES (?, ?)").run(canonical, now);
    });
    write();
  }

  claim(consumerName: string, limit = 20, leaseMs = 30000): KnowledgeOutboxEvent[] {
    const now = this.now(); const nowIso = now.toISOString(); const claimedUntil = new Date(now.getTime() + Math.max(1000, Math.min(leaseMs, 300000))).toISOString(); const claimedBy = randomUUID();
    const tx = this.db.transaction(() => {
      this.heartbeatConsumer(consumerName);
      this.db.prepare(`INSERT OR IGNORE INTO knowledge_outbox_claims(event_id, consumer_name, available_at) SELECT o.event_id, ?, o.available_at FROM knowledge_outbox o JOIN relay_domain_events e ON e.id = o.event_id LEFT JOIN knowledge_consumer_checkpoint c ON c.event_id = o.event_id AND c.consumer_name = ? WHERE c.event_id IS NULL AND length(trim(e.event_key)) > 0`).run(consumerName, consumerName);
      this.db.prepare(`UPDATE knowledge_outbox_claims SET claimed_until = ?, claimed_by = ? WHERE consumer_name = ? AND consumed_at IS NULL AND available_at <= ? AND (claimed_until IS NULL OR claimed_until <= ?) AND event_id IN (SELECT event_id FROM knowledge_outbox_claims c JOIN relay_domain_events e ON e.id = c.event_id WHERE c.consumer_name = ? AND c.consumed_at IS NULL AND c.available_at <= ? AND (c.claimed_until IS NULL OR c.claimed_until <= ?) AND length(trim(e.event_key)) > 0 LIMIT ?)`).run(claimedUntil, claimedBy, consumerName, nowIso, nowIso, consumerName, nowIso, nowIso, Math.max(1, Math.min(limit, 100)));
      return this.db.prepare(`SELECT e.*, c.attempts, c.available_at, c.claimed_by FROM knowledge_outbox_claims c JOIN relay_domain_events e ON e.id = c.event_id WHERE c.consumer_name = ? AND c.claimed_by = ? AND length(trim(e.event_key)) > 0 ORDER BY e.occurred_at`).all(consumerName, claimedBy) as Array<Record<string, unknown>>;
    });
    const rows = tx();
    return rows.map((row) => ({
      id: String(row.id), type: row.type as RelayDomainEvent["type"], occurredAt: String(row.occurred_at),
      projectId: row.project_id ? String(row.project_id) : undefined, projectNameSnapshot: row.project_name_snapshot ? String(row.project_name_snapshot) : undefined, jobId: row.job_id ? String(row.job_id) : undefined,
      deploymentId: row.deployment_id ? String(row.deployment_id) : undefined, eventKey: String(row.event_key), actorId: row.actor_id === null || row.actor_id === undefined ? undefined : Number(row.actor_id), payload: JSON.parse(String(row.payload_json)),
      attempts: Number(row.attempts), availableAt: String(row.available_at), claimToken: String(row.claimed_by),
    }));
  }

  acknowledge(consumerName: string, eventId: string, claimToken?: string): void {
    const now = this.now().toISOString();
    const done = this.db.transaction(() => {
      const result = this.db.prepare("UPDATE knowledge_outbox_claims SET consumed_at = ?, claimed_until = NULL WHERE consumer_name = ? AND event_id = ? AND claimed_by = ? AND claimed_until > ? AND consumed_at IS NULL").run(now, consumerName, eventId, claimToken ?? "", now);
      if (result.changes !== 1) throw new Error("Knowledge outbox claim is no longer owned");
      this.db.prepare("INSERT OR IGNORE INTO knowledge_consumer_checkpoint(consumer_name,event_id,consumed_at) VALUES (?,?,?)").run(consumerName, eventId, now);
      this.heartbeatConsumer(consumerName);
    });
    done();
  }

  fail(eventId: string, error: unknown, retryAfterMs = 1000, consumerName?: string, claimToken?: string): void {
    // Ownership is mandatory: without the consumer name and claim token any
    // caller could mutate another consumer's retry state.
    if (!consumerName || !claimToken) throw new Error("Knowledge outbox fail() requires consumerName and claimToken");
    const message = error instanceof Error ? error.message : String(error); const availableAt = new Date(this.now().getTime() + retryAfterMs).toISOString();
    const result = this.db.prepare("UPDATE knowledge_outbox_claims SET attempts = attempts + 1, last_error = ?, available_at = ?, claimed_until = NULL, claimed_by = NULL WHERE event_id = ? AND consumer_name = ? AND claimed_by = ? AND claimed_until > ? AND consumed_at IS NULL").run(message, availableAt, eventId, consumerName, claimToken, this.now().toISOString());
    if (result.changes !== 1) throw new Error("Knowledge outbox claim is no longer owned");
    this.heartbeatConsumer(consumerName);
  }

  /** Mark a consumer active. Retention ignores consumers after this lease expires. */
  heartbeatConsumer(consumerName: string, ttlMs = DEFAULT_CONSUMER_HEARTBEAT_MS): void {
    const name = consumerName.trim();
    if (!name) throw new Error("Knowledge consumer name is required");
    const effectiveTtlMs = parseBoundedNumber(String(ttlMs), DEFAULT_CONSUMER_HEARTBEAT_MS, 1_000, 90 * 24 * 60 * 60 * 1000);
    const now = this.now();
    this.db.prepare(`INSERT INTO knowledge_consumer_registry(consumer_name,last_seen_at,active_until) VALUES (?,?,?)
      ON CONFLICT(consumer_name) DO UPDATE SET last_seen_at=excluded.last_seen_at, active_until=excluded.active_until`)
      .run(name, now.toISOString(), new Date(now.getTime() + effectiveTtlMs).toISOString());
  }

  consumerBacklog(consumerName: string): { count: number; oldestAvailableAt?: string } {
    const row = this.db.prepare(`SELECT COUNT(*) AS count, MIN(available_at) AS oldestAvailableAt
      FROM knowledge_outbox_claims WHERE consumer_name = ? AND consumed_at IS NULL`).get(consumerName) as { count: number; oldestAvailableAt?: string };
    return { count: Number(row.count), oldestAvailableAt: row.oldestAvailableAt ?? undefined };
  }

  /** Remove acknowledged delivery metadata older than the replay retention window. */
  pruneOutbox(retentionMs = 30 * 24 * 60 * 60 * 1000, consumers = ["knowledge-capture"]): { outbox: number; claims: number; checkpoints: number } {
    const effectiveRetentionMs = parseBoundedNumber(String(retentionMs), 30 * 24 * 60 * 60 * 1000, 60_000, 10 * 365 * 24 * 60 * 60 * 1000);
    const cutoff = new Date(this.now().getTime() - effectiveRetentionMs).toISOString();
    const requestedConsumers = [...new Set(consumers.map((consumer) => consumer.trim()).filter(Boolean))];
    if (requestedConsumers.length === 0) return { outbox: 0, claims: 0, checkpoints: 0 };

    return this.db.transaction(() => {
      const eligible = this.db.prepare("SELECT o.event_id FROM knowledge_outbox o WHERE o.available_at < ?").all(cutoff) as Array<{ event_id: string }>;
      const checkpointExists = this.db.prepare("SELECT 1 FROM knowledge_consumer_checkpoint WHERE consumer_name = ? AND event_id = ?");
      const activeRegisteredConsumers = new Set(
        (this.db.prepare("SELECT consumer_name FROM knowledge_consumer_registry WHERE active_until > ?").all(this.now().toISOString()) as Array<{ consumer_name: string }>)
          .map((row) => row.consumer_name),
      );
      const deleteExpiredRegistrations = this.db.prepare("DELETE FROM knowledge_consumer_registry WHERE active_until <= ?");
      const deleteClaim = this.db.prepare("DELETE FROM knowledge_outbox_claims WHERE event_id = ? AND consumer_name = ?");
      const deleteAllClaims = this.db.prepare("DELETE FROM knowledge_outbox_claims WHERE event_id = ?");
      const deleteAllCheckpoints = this.db.prepare("DELETE FROM knowledge_consumer_checkpoint WHERE event_id = ?");
      const deleteOutbox = this.db.prepare("DELETE FROM knowledge_outbox WHERE event_id = ?");
      let claims = 0, checkpoints = 0, outbox = 0;
      deleteExpiredRegistrations.run(this.now().toISOString());
      for (const row of eligible) {
        // Configured consumers are explicitly active. Dynamic consumers must
        // renew their heartbeat; a permanently stopped consumer cannot retain
        // outbox rows indefinitely merely because it claimed once long ago.
        const activeConsumers = [...new Set([...requestedConsumers, ...activeRegisteredConsumers])];
        const allActiveConsumersCompleted = activeConsumers.every((consumer) => Boolean(checkpointExists.get(consumer, row.event_id)));

        if (allActiveConsumersCompleted) {
          // Once every known/configured consumer has checkpointed, remove all
          // delivery metadata and the outbox row atomically.
          claims += Number(deleteAllClaims.run(row.event_id).changes);
          checkpoints += Number(deleteAllCheckpoints.run(row.event_id).changes);
          outbox += Number(deleteOutbox.run(row.event_id).changes);
          continue;
        }

        // Keep the outbox row and every incomplete consumer claim. A completed
        // consumer's checkpoint must remain while another consumer is pending;
        // otherwise claim() would legitimately recreate the completed delivery.
        // Its consumed claim can be discarded independently to reduce metadata.
        for (const consumer of requestedConsumers) {
          if (!checkpointExists.get(consumer, row.event_id)) continue;
          claims += Number(deleteClaim.run(row.event_id, consumer).changes);
        }
      }
      return { outbox, claims, checkpoints };
    })();
  }

  upsertDocument(document: KnowledgeDocument): KnowledgeDocument {
    if (!(KNOWLEDGE_LIFECYCLE as readonly string[]).includes(document.lifecycle)) {
      throw new Error(`Invalid knowledge lifecycle: ${String(document.lifecycle)}`);
    }
    const existing = this.db.prepare("SELECT kind,lifecycle FROM knowledge_documents WHERE id = ?").get(document.id) as { kind?: KnowledgeDocument["kind"]; lifecycle?: KnowledgeLifecycle } | undefined;
    if (existing?.kind && existing.kind !== document.kind) {
      throw new Error(`Knowledge document kind is immutable: ${existing.kind} -> ${document.kind}`);
    }
    if (existing && existing.lifecycle !== document.lifecycle) assertLifecycleTransition(existing.lifecycle!, document.lifecycle);
    this.db.prepare(`INSERT INTO knowledge_documents (id,kind,title,body,lifecycle,project_id,project_name_snapshot,samplemanager_version,solution,module,environment,source_locator,source_commit,source_sha256,created_at,updated_at)
      VALUES (@id,@kind,@title,@body,@lifecycle,@projectId,@projectNameSnapshot,@sampleManagerVersion,@solution,@module,@environment,@locator,@commit,@sha256,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,body=excluded.body,lifecycle=excluded.lifecycle,project_id=excluded.project_id,project_name_snapshot=excluded.project_name_snapshot,samplemanager_version=excluded.samplemanager_version,solution=excluded.solution,module=excluded.module,environment=excluded.environment,source_locator=excluded.source_locator,source_commit=excluded.source_commit,source_sha256=excluded.source_sha256,updated_at=excluded.updated_at`)
      .run({
        id: document.id,
        kind: document.kind,
        title: document.title,
        body: document.body,
        lifecycle: document.lifecycle,
        // better-sqlite3 throws on absent named parameters; optional scope
        // fields must bind as NULL rather than being omitted.
        projectId: document.projectId ?? null,
        projectNameSnapshot: document.projectNameSnapshot ?? null,
        sampleManagerVersion: document.sampleManagerVersion ?? null,
        solution: document.solution ?? null,
        module: document.module ?? null,
        environment: document.environment ?? null,
        locator: document.locator,
        commit: document.commit ?? null,
        sha256: document.sha256 ?? null,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      });
    // Keep the type-specific projection present for all ingestion paths. The
    // richer KnowledgeRepository subsequently fills optional fields, while
    // lightweight event capture still remains queryable through its domain
    // table.
    const projection = {
      id: document.id,
      status: document.lifecycle,
      sourceLocator: document.locator,
      sourceSha256: document.sha256 ?? null,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
    if (document.kind === "case") {
      this.db.prepare(`INSERT OR IGNORE INTO knowledge_cases(id,status,version,evidence_refs_json,source_locator,source_sha256,created_at,updated_at)
        VALUES (@id,@status,'1','[]',@sourceLocator,@sourceSha256,@createdAt,@updatedAt)`).run(projection);
      this.db.prepare("UPDATE knowledge_cases SET status=@status,source_locator=@sourceLocator,source_sha256=@sourceSha256,updated_at=@updatedAt WHERE id=@id").run(projection);
    } else if (document.kind === "pattern") {
      this.db.prepare(`INSERT OR IGNORE INTO knowledge_patterns(id,status,version,case_refs_json,evidence_refs_json,source_locator,source_sha256,created_at,updated_at)
        VALUES (@id,@status,'1','[]','[]',@sourceLocator,@sourceSha256,@createdAt,@updatedAt)`).run(projection);
      this.db.prepare("UPDATE knowledge_patterns SET status=@status,source_locator=@sourceLocator,source_sha256=@sourceSha256,updated_at=@updatedAt WHERE id=@id").run(projection);
    } else if (document.kind === "playbook") {
      this.db.prepare(`INSERT OR IGNORE INTO knowledge_playbooks(id,status,version,steps_json,evidence_refs_json,source_locator,source_sha256,created_at,updated_at)
        VALUES (@id,@status,'1','[]','[]',@sourceLocator,@sourceSha256,@createdAt,@updatedAt)`).run(projection);
      this.db.prepare("UPDATE knowledge_playbooks SET status=@status,source_locator=@sourceLocator,source_sha256=@sourceSha256,updated_at=@updatedAt WHERE id=@id").run(projection);
    } else if (document.kind === "candidate") {
      this.db.prepare(`INSERT OR IGNORE INTO knowledge_candidates(id,status,candidate_type,evidence_refs_json,source_locator,source_sha256,created_at,updated_at)
        VALUES (@id,@status,'case','[]',@sourceLocator,@sourceSha256,@createdAt,@updatedAt)`).run(projection);
      this.db.prepare("UPDATE knowledge_candidates SET status=@status,source_locator=@sourceLocator,source_sha256=@sourceSha256,updated_at=@updatedAt WHERE id=@id").run(projection);
    }
    return document;
  }

  canRead(userId: number, projectId: string | undefined): boolean {
    if (!projectId) return false;
    const row = this.db.prepare("SELECT can_read FROM knowledge_acl WHERE project_id = ? AND user_id = ?").get(projectId, userId) as { can_read?: number } | undefined;
    return row?.can_read === 1;
  }

  grantAcl(projectId: string, userId: number, canReview = false): void {
    this.db.prepare("INSERT INTO knowledge_acl(project_id,user_id,can_read,can_review) VALUES (?,?,1,?) ON CONFLICT(project_id,user_id) DO UPDATE SET can_read=1,can_review=excluded.can_review").run(projectId, userId, canReview ? 1 : 0);
  }

  audit(input: { actorId?: number; projectId?: string; action: string; entityType: string; entityId: string; details?: Record<string, unknown> }): void {
    this.db.prepare("INSERT INTO knowledge_audit(id,actor_id,project_id,action,entity_type,entity_id,details_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(randomUUID(), input.actorId ?? null, input.projectId ?? null, input.action, input.entityType, input.entityId, JSON.stringify(sanitizeAuditArguments(input.details ?? {})), this.now().toISOString());
  }

  listDocuments(userId: number, projectId: string): KnowledgeDocument[] {
    if (!this.canRead(userId, projectId)) throw new Error("Knowledge access denied for project");
    const rows = this.db.prepare("SELECT * FROM knowledge_documents WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.id), kind: row.kind as KnowledgeDocument["kind"], title: String(row.title), body: String(row.body), lifecycle: row.lifecycle as KnowledgeLifecycle, projectId: String(row.project_id), projectNameSnapshot: row.project_name_snapshot ? String(row.project_name_snapshot) : undefined, sampleManagerVersion: row.samplemanager_version ? String(row.samplemanager_version) : undefined, solution: row.solution ? String(row.solution) : undefined, module: row.module ? String(row.module) : undefined, environment: row.environment ? String(row.environment) : undefined, locator: String(row.source_locator), commit: row.source_commit ? String(row.source_commit) : undefined, sha256: row.source_sha256 ? String(row.source_sha256) : undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }));
  }

  close(): void { this.db.close(); }
}

export function createKnowledgeStore(options: KnowledgeStoreOptions): KnowledgeStore { return new KnowledgeStore(options); }

// Stable application/repository exports for API and MCP adapters. The
// implementation lives in repository.ts to keep persistence concerns separate.
export { KnowledgeRepository, KnowledgeApplicationService, createKnowledgeRepository } from "./repository.js";
