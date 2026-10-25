import { completeVerifiedEngineReindex } from "../../knowledge/engine-reindex.js";
import { searchProductBackend, getProductBackend, listEngineProductBackend, diffProductBackend, searchEngineProductReferences, productCatalogVisibility } from "../../knowledge/product-backend.js";
import { managedControlPlane, activeWikiService } from "../../knowledge/engine-service.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { getKnowledgeStore } from "../knowledge-context.js";
import { EvidenceStore } from "../../knowledge/evidence-store.js";
import { KnowledgeRepository } from "../../knowledge/repository.js";
import { importCasebook, importContextFacts } from "../../knowledge/importer.js";
import { analyzeRelationImpact, queryRelations } from "../../knowledge/relations.js";
import { searchKnowledge } from "../../knowledge/retriever.js";
import { correctProductMetadata, updateProductDocumentLifecycle } from "../../knowledge/knowledge-products.js";
import { ingestArtifactSet, ingestProjectSnapshot } from "../../knowledge/artifact-ingest.js";
import { enqueueArtifactImport, enqueueProductImport, enqueueProductMigration, MigrationQueueBusyError } from "../../knowledge/ingest-worker.js";
import { compareSourceBaselines, type SourceManifest } from "../../knowledge/source-baseline.js";
import { classifyRelayEvent } from "../../knowledge/event-classifier.js";
import { describeCandidate } from "../../knowledge/candidate-narrative.js";
import { readDeadLetterPage } from "../../knowledge/dead-letter-page.js";
import { existsSync, readFileSync } from "node:fs";
import { resolveWorkspacePath } from "../../shared/workspace-path.js";
import { relayEventSpoolHealth } from "../../knowledge/event-sink.js";
import { evidenceDisplaySummary, evidenceDisplayTitle, lifecycleHumanStatus } from "../../knowledge/display-projection.js";
import { WorkSessionService, validateIntentEnvelope } from "../../knowledge/work-session.js";
import { ProviderRegistry } from "../../knowledge/provider-registry.js";
import { createManagedProviderRegistry, ProviderSetupService } from "../../knowledge/provider-setup.js";
import { ManagedProviderError } from "../../knowledge/provider-probe.js";
import { MigrationController } from "../../knowledge/migration-control.js";
import { runReleaseGates } from "../../knowledge/release-gates.js";
import { CandidateInsightCompiler } from "../../knowledge/candidate-insight.js";
import { createCandidateInsightProvider } from "../../knowledge/candidate-provider.js";
import { CandidateInsightReviewService } from "../../knowledge/candidate-review.js";
import { enqueueCandidateInsight, getCandidateInsightJob } from "../../knowledge/candidate-worker.js";
import { WIKI_PAGE_STATUSES } from "../../knowledge/wiki.js";
import { WeKnoraError } from "../../knowledge/weknora.js";
import { WeKnoraIngestor } from "../../knowledge/weknora-ingest.js";
import { ContextPackService } from "../../knowledge/context-pack.js";
import { loadRelayContextSources } from "../../knowledge/context-sources.js";
import { resolveRetrievalProjectId } from "../../knowledge/weknora-scope.js";
import { canReadTopicBinding } from "../../knowledge/topic-access.js";
import {
  acceptCandidate,
  deprecateDocument,
  editDocument,
  mergeCandidates,
  promoteCaseToPattern,
  proposePlaybook,
  rejectCandidate,
  reviewDocument,
  editCandidateCard,
} from "../../knowledge/review-service.js";

const projectIdSchema = z.coerce.number().int().positive();
const MAX_INLINE_EVIDENCE_BYTES = 5 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TTL_MS = 5 * 60 * 1000;

type KnowledgeRow = Record<string, unknown>;

function parseBoundedInt(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function queryValue(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (Array.isArray(value)) return value[0] === undefined ? undefined : String(value[0]);
  return value === undefined || value === null || String(value).trim() === "" ? undefined : String(value);
}

function safeDocument(row: KnowledgeRow, includeBody = true, card?: ReturnType<ReturnType<typeof getKnowledgeStore>["getCandidateCard"]>, scope?: ReturnType<ReturnType<typeof getKnowledgeStore>["getScopeBinding"]>): Record<string, unknown> {
  const parseList = (value: unknown): unknown[] => {
    if (Array.isArray(value)) return value;
    try { const parsed = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  };
  const recordType = String(row.record_type ?? row.kind ?? "");
  const businessContext = row.business_context_json ? safeRows(() => JSON.parse(String(row.business_context_json)), undefined) : card?.businessContext;
  // Derive from the original source on every read, including historical cards.
  const narrative = String(row.kind) === "candidate" ? describeCandidate(String(row.body ?? ""), { environment: row.environment, occurredAt: row.created_at }) : undefined;
  return {
    id: String(row.id),
    kind: String(row.kind),
    title: String(row.title ?? ""),
    ...(includeBody ? { body: String(row.body ?? "") } : { summary: card?.summary ?? String(row.body ?? "").slice(0, 500) }),
    lifecycle: String(row.lifecycle),
    projectId: row.project_id === null || row.project_id === undefined ? undefined : String(row.project_id),
    projectNameSnapshot: row.project_name_snapshot ? String(row.project_name_snapshot) : undefined,
    sampleManagerVersion: row.samplemanager_version ? String(row.samplemanager_version) : undefined,
    solution: row.solution ? String(row.solution) : undefined,
    module: row.module ? String(row.module) : undefined,
    environment: row.environment ? String(row.environment) : undefined,
    candidateType: row.candidate_type ? String(row.candidate_type) : undefined,
    documentFamilyId: row.document_family_id ? String(row.document_family_id) : undefined,
    documentType: row.document_type ? String(row.document_type) : undefined,
    language: row.language ? String(row.language) : undefined,
    authority: row.authority ? String(row.authority) : undefined,
    sourcePath: row.source_path ? String(row.source_path) : undefined,
    metadata: row.metadata_json ? safeRows(() => JSON.parse(String(row.metadata_json)), undefined) : undefined,
    diffReviewStatus: row.diff_review_status ? String(row.diff_review_status) : undefined,
    diffReviewedAt: row.diff_reviewed_at ? String(row.diff_reviewed_at) : undefined,
    eventId: row.event_id ? String(row.event_id) : undefined,
    sourceCandidateId: row.source_candidate_id ? String(row.source_candidate_id) : undefined,
    jobId: row.job_id ? String(row.job_id) : undefined,
    deploymentId: row.deployment_id ? String(row.deployment_id) : undefined,
    evidenceCount: row.evidence_count === undefined ? undefined : Number(row.evidence_count),
    evidenceRefs: row.evidence_refs_json === undefined ? undefined : parseList(row.evidence_refs_json),
    caseRefs: row.case_refs_json === undefined ? undefined : parseList(row.case_refs_json),
    steps: row.steps_json === undefined ? undefined : parseList(row.steps_json),
    rollback: row.rollback ? String(row.rollback) : undefined,
    skillDiff: row.skill_diff ? String(row.skill_diff) : undefined,
    applicability: row.applicability ? String(row.applicability) : undefined,
    confidence: row.confidence === null || row.confidence === undefined ? undefined : Number(row.confidence),
    recordType: recordType || undefined,
    displayTitle: narrative?.title ?? (row.display_title ? String(row.display_title) : card?.displayTitle ?? card?.summary),
    displaySummary: narrative?.summary ?? (row.display_summary ? String(row.display_summary) : card?.displaySummary ?? card?.problemStatement),
    ...(narrative ? { narrative } : {}),
    ...(businessContext ? { businessContext } : {}),
    unknowns: row.unknowns_json === undefined ? card?.unknowns : parseList(row.unknowns_json),
    nextAction: row.next_action ? String(row.next_action) : card?.nextAction,
    captureReasonText: row.capture_reason_text ? String(row.capture_reason_text) : card?.captureReasonText ?? card?.captureReason,
    humanStatus: row.human_status ? String(row.human_status) : card?.humanStatus ?? lifecycleHumanStatus(row.lifecycle ? String(row.lifecycle) : undefined, recordType),
    provenance: row.provenance_json ? safeRows(() => JSON.parse(String(row.provenance_json)), undefined) : card?.provenance,
    sourceLocator: String(row.source_locator ?? ""),
    sourceCommit: row.source_commit ? String(row.source_commit) : undefined,
    sourceSha256: row.source_sha256 ? String(row.source_sha256) : undefined,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    ...(card ? { card } : {}),
    ...(scope ? { scope } : {}),
  };
}

function enrichDocumentRow(store: ReturnType<typeof getKnowledgeStore>, row: KnowledgeRow): KnowledgeRow {
  const kind = String(row.kind);
  if (kind === "candidate") {
    const candidate = store.db.prepare(`SELECT candidate_type,event_id,job_id,deployment_id,
      (SELECT COUNT(*) FROM knowledge_entity_evidence e WHERE e.entity_type = 'candidate' AND e.entity_id = knowledge_candidates.id) AS evidence_count
      FROM knowledge_candidates WHERE id = ?`).get(String(row.id)) as KnowledgeRow | undefined;
    return { ...row, ...(candidate ?? {}) };
  }
  if (kind === "case") {
    const source = store.db.prepare("SELECT event_id,job_id,deployment_id,source_candidate_id,evidence_refs_json,business_context_json FROM knowledge_cases WHERE id = ?").get(String(row.id)) as KnowledgeRow | undefined;
    if (!source) return row;
    let evidenceCount: number | undefined;
    try {
      const refs = JSON.parse(String(source.evidence_refs_json ?? "[]"));
      evidenceCount = Array.isArray(refs) ? refs.length : undefined;
    } catch { /* malformed legacy metadata remains readable */ }
    return { ...row, ...source, ...(evidenceCount === undefined ? {} : { evidence_count: evidenceCount }) };
  }
  if (kind === "pattern") {
    const source = store.db.prepare("SELECT applicability,case_refs_json,evidence_refs_json,confidence,reviewed_by,verified_at FROM knowledge_patterns WHERE id = ?").get(String(row.id)) as KnowledgeRow | undefined;
    return { ...row, ...(source ?? {}) };
  }
  if (kind === "playbook") {
    const source = store.db.prepare("SELECT steps_json,rollback,skill_diff,evidence_refs_json,confidence,reviewed_by,verified_at FROM knowledge_playbooks WHERE id = ?").get(String(row.id)) as KnowledgeRow | undefined;
    return { ...row, ...(source ?? {}) };
  }
  return row;
}

function safeEvidence(value: Record<string, unknown>): Record<string, unknown> {
  // storagePath is an implementation detail and must never be sent to a web client.
  return {
    id: value.id,
    sha256: value.sha256,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    sourceKind: value.sourceKind,
    projectId: value.projectId,
    environment: value.environment,
    locator: value.locator,
    displayTitle: evidenceDisplayTitle({ locator: String(value.locator ?? ""), sourceKind: value.sourceKind as any, mimeType: String(value.mimeType ?? "") }),
    displaySummary: evidenceDisplaySummary({ locator: String(value.locator ?? ""), sourceKind: value.sourceKind as any }),
    retention: value.retention,
    linkedCount: value.linkedCount === undefined ? undefined : Number(value.linkedCount),
    createdAt: value.createdAt,
    deletedAt: value.deletedAt,
  };
}

function resolveProject(userId: number, raw: unknown) {
  const parsed = projectIdSchema.safeParse(raw);
  if (!parsed.success) throw new Error("projectId is required");
  const project = db.select().from(projects).where(and(eq(projects.id, parsed.data), eq(projects.userId, userId))).get();
  if (!project) throw new Error("Project not found");
  const store = getKnowledgeStore();
  // The control plane remains the source of identity. The Knowledge ACL is a
  // mirrored grant and never broadens the user's project ownership.
  store.grantAcl(String(project.id), userId, false);
  return { project, store, projectId: String(project.id) };
}

/** Resolve a shared/deduplicated Evidence row without exposing other projects. */
function resolveEvidenceProject(userId: number, store: ReturnType<typeof getKnowledgeStore>, evidenceId: string): string {
  const row = store.db.prepare("SELECT project_id FROM knowledge_evidence WHERE id = ? AND deleted_at IS NULL").get(evidenceId) as { project_id?: string | null } | undefined;
  if (!row) throw new Error("Evidence not found");
  const acl = store.db.prepare("SELECT project_id FROM knowledge_evidence_acl WHERE evidence_id = ?").all(evidenceId) as Array<{ project_id: string }>;
  const candidates = [...new Set([row.project_id ?? undefined, ...acl.map((item) => item.project_id)].filter((value): value is string => Boolean(value)))];
  for (const projectId of candidates) {
    const numeric = Number(projectId);
    if (Number.isSafeInteger(numeric) && numeric > 0) {
      try { resolveProject(userId, numeric); return projectId; } catch { /* try another shared project */ }
    }
    if (store.canRead(userId, projectId)) return projectId;
  }
  throw new Error("Evidence not found");
}

function idempotencyKey(req: FastifyRequest): string | undefined {
  const raw = req.headers["idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (key === undefined) return undefined;
  const value = String(key).trim();
  if (!value || value.length > 200 || /[\r\n]/.test(value)) throw new Error("Idempotency-Key must be 1-200 safe characters");
  return value;
}

function replayScope(value: unknown): string {
  if (value === undefined) return "";
  const canonical = JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
  return createHash("sha256").update(canonical ?? "", "utf8").digest("hex").slice(0, 24);
}

function replayOrRun<T>(store: ReturnType<typeof getKnowledgeStore>, userId: number, operation: string, key: string | undefined, work: () => T, scope?: unknown): T {
  if (!key) return work();
  const scopedOperation = `${operation}:${replayScope(scope)}`;
  const previous = store.db.prepare("SELECT response_json FROM knowledge_api_idempotency WHERE user_id = ? AND operation = ? AND idempotency_key = ?").get(userId, scopedOperation, key) as { response_json?: string } | undefined;
  if (previous?.response_json) return JSON.parse(previous.response_json) as T;
  const result = work();
  try {
    store.db.prepare("INSERT INTO knowledge_api_idempotency(user_id,operation,idempotency_key,response_json,created_at) VALUES (?,?,?,?,?)")
      .run(userId, scopedOperation, key, JSON.stringify(result), new Date().toISOString());
  } catch (error) {
    // A concurrent identical request may have won the unique race. Return its
    // durable response instead of executing a mutation twice.
    const concurrent = store.db.prepare("SELECT response_json FROM knowledge_api_idempotency WHERE user_id = ? AND operation = ? AND idempotency_key = ?").get(userId, scopedOperation, key) as { response_json?: string } | undefined;
    if (concurrent?.response_json) return JSON.parse(concurrent.response_json) as T;
    throw error;
  }
  return result;
}

function sendError(reply: FastifyReply, error: unknown, status = 400) {
  return reply.status(status).send({ error: error instanceof Error ? error.message : String(error) });
}

function managedProviderRegistry(store = getKnowledgeStore()): ProviderRegistry {
  return createManagedProviderRegistry(store);
}

function weknoraControlPlane(store = getKnowledgeStore()) { return managedControlPlane(store); }

const OBSERVATION_WITH_REVIEW = `SELECT o.*, r.outcome AS review_outcome, r.reason AS review_reason,
  r.rule_version AS review_rule_version, r.reviewed_at, r.next_review_at, r.review_count,
  r.candidate_id AS review_candidate_id FROM knowledge_observations o
  LEFT JOIN knowledge_observation_reviews r ON r.observation_id=o.id`;

function safeObservation(row: KnowledgeRow): Record<string, unknown> {
  const parse = (value: unknown): unknown[] => {
    try {
      const parsed = JSON.parse(String(value ?? "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    id: String(row.id),
    recordType: "observation",
    eventId: String(row.event_id),
    projectId: row.project_id ? String(row.project_id) : undefined,
    eventClass: String(row.event_class),
    displayTitle: String(row.display_title ?? row.event_class),
    displaySummary: String(row.display_summary ?? row.problem_statement ?? row.capture_reason),
    problemStatement: row.problem_statement ? String(row.problem_statement) : undefined,
    facts: parse(row.facts_json),
    unknowns: parse(row.unknowns_json),
    nextAction: row.next_action ? String(row.next_action) : undefined,
    captureReasonText: String(row.capture_reason),
    humanStatus: String(row.human_status ?? "captured"),
    review: row.review_outcome ? {
      outcome: String(row.review_outcome), reason: String(row.review_reason),
      ruleVersion: String(row.review_rule_version), reviewedAt: String(row.reviewed_at),
      nextReviewAt: row.next_review_at ? String(row.next_review_at) : undefined,
      count: Number(row.review_count), candidateId: row.review_candidate_id ? String(row.review_candidate_id) : undefined,
    } : undefined,
    evidenceRefs: parse(row.evidence_refs_json),
    sourceLocator: String(row.source_locator),
    sourceSha256: row.source_sha256 ? String(row.source_sha256) : undefined,
    provenance: row.provenance_json ? safeRows(() => JSON.parse(String(row.provenance_json)), undefined) : { eventId: row.event_id, sourceLocator: row.source_locator },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function safeRows<T>(work: () => T, fallback: T): T {
  try { return work(); } catch { return fallback; }
}

function knowledgeHealth(store: ReturnType<typeof getKnowledgeStore>) {
  const fts = safeRows(() => Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_fts").get() as { count?: number }).count ?? 0), 0);
  const vectors = safeRows(() => Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_embeddings").get() as { count?: number }).count ?? 0), 0);
  const spool = relayEventSpoolHealth();
  const heartbeat = safeRows(() => store.db.prepare("SELECT last_seen_at,active_until FROM knowledge_consumer_registry WHERE consumer_name = ?").get("knowledge-capture") as { last_seen_at?: string; active_until?: string } | undefined, undefined);
  const workerStatus = heartbeat?.active_until && Date.parse(heartbeat.active_until) > Date.now() ? "running" : "stale_or_not_seen";
  return {
    database: { status: "available", checkedAt: new Date().toISOString() },
    fts: { status: fts > 0 ? "ready" : "empty", indexedRows: fts },
    vectors: { status: vectors > 0 ? "ready" : "disabled_or_empty", indexedRows: vectors },
    captureWorker: { status: workerStatus, owner: "remote-ops-mcp", lastSeenAt: heartbeat?.last_seen_at, activeUntil: heartbeat?.active_until },
    spool,
  };
}

function knowledgeReviewAllowed(store: ReturnType<typeof getKnowledgeStore>, userId: number): boolean {
  return store.db.prepare("SELECT 1 FROM knowledge_acl WHERE user_id = ? AND can_review = 1 LIMIT 1").get(userId) !== undefined;
}

function knowledgeReadAllowed(store: ReturnType<typeof getKnowledgeStore>, userId: number): boolean {
  if (store.db.prepare("SELECT 1 FROM knowledge_acl WHERE user_id = ? AND can_read = 1 LIMIT 1").get(userId) !== undefined) return true;
  // A control-plane project owner is allowed to read global Product Knowledge
  // before any project page has mirrored its Knowledge ACL grant.
  return db.select({ id: projects.id }).from(projects).where(eq(projects.userId, userId)).get() !== undefined;
}

function readDeadLetters(store: ReturnType<typeof getKnowledgeStore>, limit = 50): Array<Record<string, unknown>> {
  const stateRoot = store.evidenceRoot ? store.evidenceRoot.replace(/[\\/]evidence[\\/]?$/, "") : ".relay-mcp";
  const paths = [`${stateRoot}/knowledge-event-spool.jsonl.dead-letter`, `${stateRoot}/knowledge-capture-dead-letter.jsonl`];
  return paths.flatMap((path) => safeRows(() => readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const event = parsed.event && typeof parsed.event === "object" ? parsed.event as Record<string, unknown> : parsed;
      const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : undefined;
      return {
        sourcePath: path,
        eventId: event.id ?? parsed.eventId,
        type: event.type ?? parsed.type,
        projectId: event.projectId ?? parsed.projectId,
        jobId: event.jobId ?? parsed.jobId,
        deploymentId: event.deploymentId ?? parsed.deploymentId,
        payloadKeys: payload ? Object.keys(payload).slice(0, 100) : undefined,
        error: parsed.error,
        attempts: parsed.attempts,
        sha256: parsed.sha256,
        length: parsed.length ?? line.length,
      };
    } catch { return { sourcePath: path, error: "invalid dead-letter record", length: line.length }; }
  }), []));
}

function rebuildKnowledgeIndexes(store: ReturnType<typeof getKnowledgeStore>, projectId?: string): { documents: number; facts: number } {
  const docs = projectId
    ? Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents WHERE project_id = ?").get(projectId) as { count?: number }).count ?? 0)
    : Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents").get() as { count?: number }).count ?? 0);
  const facts = projectId
    ? Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_facts WHERE project_id = ?").get(projectId) as { count?: number }).count ?? 0)
    : Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_facts").get() as { count?: number }).count ?? 0);
  store.db.transaction(() => {
    if (projectId) {
      store.db.prepare("DELETE FROM knowledge_fts WHERE document_id IN (SELECT id FROM knowledge_documents WHERE project_id = ?)").run(projectId);
      store.db.prepare("DELETE FROM knowledge_facts_fts WHERE fact_id IN (SELECT id FROM knowledge_facts WHERE project_id = ?)").run(projectId);
      store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) SELECT c.document_id,d.title,c.content FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE d.project_id = ?").run(projectId);
      store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) SELECT d.id,d.title,d.body FROM knowledge_documents d WHERE d.project_id = ? AND NOT EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.document_id=d.id)").run(projectId);
      store.db.prepare("INSERT INTO knowledge_facts_fts(rowid,fact_id,text,tags) SELECT rowid,id,text,tags_json FROM knowledge_facts WHERE project_id = ?").run(projectId);
    } else {
      store.db.prepare("DELETE FROM knowledge_fts").run();
      store.db.prepare("DELETE FROM knowledge_facts_fts").run();
      store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) SELECT c.document_id,d.title,c.content FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id").run();
      store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) SELECT d.id,d.title,d.body FROM knowledge_documents d WHERE NOT EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.document_id=d.id)").run();
      store.db.prepare("INSERT INTO knowledge_facts_fts(rowid,fact_id,text,tags) SELECT rowid,id,text,tags_json FROM knowledge_facts").run();
    }
  })();
  return { documents: docs, facts };
}

function knowledgeProviderSummary(store: ReturnType<typeof getKnowledgeStore>): Array<Record<string, unknown>> {
  const vectorCount = safeRows(() => Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_embeddings").get() as { count?: number }).count ?? 0), 0);
  const configured = (name: string) => Boolean(process.env[name] && String(process.env[name]).trim());
  return [
    { name: "FTS5", type: "lexical", model: "sqlite-fts5", status: "ready", configured: true, secretConfigured: false, lastCallAt: null, errorRate: null },
    { name: "Embeddings", type: "vector", model: process.env.KNOWLEDGE_EMBEDDING_MODEL ?? "local-deterministic-v1", status: vectorCount ? "ready" : "disabled_or_empty", configured: true, indexedRows: vectorCount, secretConfigured: false, lastCallAt: null, errorRate: null },
    { name: "Rerank", type: "rerank", model: process.env.KNOWLEDGE_RERANK_MODEL ?? "local-lexical-v1", status: "ready", configured: true, secretConfigured: false, lastCallAt: null, errorRate: null },
    { name: "Inference", type: "inference", model: process.env.KNOWLEDGE_INFERENCE_MODEL ?? "not configured", status: configured("KNOWLEDGE_INFERENCE_PROVIDER") ? "ready" : "disabled", configured: configured("KNOWLEDGE_INFERENCE_PROVIDER"), secretConfigured: configured("KNOWLEDGE_INFERENCE_SECRET_REF"), lastCallAt: null, errorRate: null },
    { name: "Redaction", type: "redaction", model: process.env.KNOWLEDGE_REDACTION_MODEL ?? "local-regex-v1", status: "ready", configured: true, secretConfigured: false, lastCallAt: null, errorRate: null },
  ];
}

function parseKinds(raw: unknown): Array<"candidate" | "case" | "pattern" | "playbook" | "fact"> | undefined {
  const value = raw === undefined || raw === null ? undefined : String(raw);
  if (!value) return undefined;
  const allowed = new Set(["candidate", "case", "pattern", "playbook", "fact"]);
  const kinds = value.split(",").map((item) => item.trim()).filter((item): item is "candidate" | "case" | "pattern" | "playbook" | "fact" => allowed.has(item));
  return kinds.length ? kinds : undefined;
}

function parseBoolean(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  return raw === true || String(raw).toLowerCase() === "true";
}

function canAccessDocument(store: ReturnType<typeof getKnowledgeStore>, userId: number, row: KnowledgeRow, targetProjectId?: string): boolean {
  const sourceProjectId = row.project_id === null || row.project_id === undefined ? undefined : String(row.project_id);
  const target = targetProjectId ?? sourceProjectId;
  if (!target || !store.canRead(userId, target)) return false;
  if (sourceProjectId === target) return true;
  const scope = store.getScopeBinding(String(row.id));
  return Boolean(scope && (scope.visibility === "global" || scope.visibility === "organization") && ["verified", "approved"].includes(String(row.lifecycle)));
}

function documentEvidenceRefs(store: ReturnType<typeof getKnowledgeStore>, row: KnowledgeRow, targetProjectId?: string): string[] {
  const refs = (store.db.prepare("SELECT evidence_id FROM knowledge_entity_evidence WHERE entity_id = ? ORDER BY created_at").all(String(row.id)) as Array<{ evidence_id: string }>).map((item) => item.evidence_id);
  const sourceProjectId = row.project_id === null || row.project_id === undefined ? undefined : String(row.project_id);
  if (sourceProjectId === (targetProjectId ?? sourceProjectId)) return [...new Set(refs)];
  return [...new Set(refs.filter((evidenceId) => Boolean(store.db.prepare("SELECT 1 FROM knowledge_evidence_acl WHERE evidence_id = ? AND project_id = ?").get(evidenceId, targetProjectId))))];
}

function loadDocumentForUser(store: ReturnType<typeof getKnowledgeStore>, userId: number, documentId: string, targetProjectId?: string): KnowledgeRow {
  const row = store.db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(documentId) as KnowledgeRow | undefined;
  if (!row || !canAccessDocument(store, userId, row, targetProjectId)) throw new Error("Knowledge document not found");
  return row;
}

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get("/api/knowledge/search", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    try {
      const { store, projectId } = resolveProject(request.user.id, query.projectId);
      const result = await searchKnowledge(store, {
        userId: request.user.id,
        projectId,
        query: String(query.q ?? query.query ?? ""),
        limit: parseBoundedInt(query.limit, 20, 1, 100),
        sampleManagerVersion: queryValue(query, "sampleManagerVersion"),
        solution: queryValue(query, "solution"),
        module: queryValue(query, "module"),
        environment: queryValue(query, "environment"),
        scopeType: queryValue(query, "scopeType"),
        scopeKey: queryValue(query, "scopeKey"),
        kinds: parseKinds(query.kinds),
        includeDeprecated: parseBoolean(query.includeDeprecated) ?? false,
      });
      return reply.send(result);
    } catch (error) { return sendError(reply, error, error instanceof Error && error.message === "Project not found" ? 404 : 400); }
  });

  app.get("/api/knowledge/documents/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const store = getKnowledgeStore();
      const query = request.query as Record<string, unknown>;
      const targetProjectId = query.projectId === undefined ? undefined : resolveProject(request.user.id, query.projectId).projectId;
      const product = store.db.prepare("SELECT kind FROM knowledge_documents WHERE id=?").get(id) as {kind?:string}|undefined;
      if(product?.kind==="product_document" || store.db.prepare("SELECT 1 FROM knowledge_weknora_documents WHERE id=? OR external_document_id=?").get(id,id)) {
        const document=await getProductBackend(store,{documentId:id,userId:request.user.id,isAdmin:request.user.isAdmin,projectId:targetProjectId,environment:queryValue(query,"environment")});
        return reply.send({document,evidenceRefs:[],reviews:[]});
      }
      const row = loadDocumentForUser(store, request.user.id, id, targetProjectId);
      const evidenceRefs = documentEvidenceRefs(store, row, targetProjectId);
      const reviews = store.db.prepare("SELECT id,reviewer_id,action,reason,before_json,after_json,created_at FROM knowledge_reviews WHERE entity_id = ? ORDER BY created_at DESC").all(id);
      const enriched = enrichDocumentRow(store, row);
      return reply.send({ document: safeDocument(enriched, true, String(row.kind) === "candidate" ? store.getCandidateCard(id) : undefined, store.getScopeBinding(id)), evidenceRefs, reviews });
    } catch (error) { return sendError(reply, error, 404); }
  });

  app.get("/api/knowledge/observations/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id);
    const store = getKnowledgeStore();
    try {
      const row = store.db.prepare(`${OBSERVATION_WITH_REVIEW} WHERE o.id = ?`).get(id) as KnowledgeRow | undefined;
      if (!row || !row.project_id || !store.canRead(request.user.id, String(row.project_id))) throw new Error("Observation not found");
      return reply.send({ observation: safeObservation(row) });
    } catch (error) { return sendError(reply, error, 404); }
  });

  app.post("/api/knowledge/documents/:id/evidence", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id);
    const body = z.object({ evidenceId: z.string().trim().min(1).max(300), operation: z.enum(["attach", "detach"]), reason: z.string().trim().min(1).max(2_000) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid Evidence link request", details: body.error.issues });
    const store = getKnowledgeStore();
    try {
      const row = loadDocumentForUser(store, request.user.id, id);
      if (!["candidate", "case", "pattern", "playbook"].includes(String(row.kind))) return reply.status(400).send({ error: "Evidence can only be linked to runtime Knowledge objects" });
      const projectId = row.project_id === null || row.project_id === undefined ? undefined : String(row.project_id);
      const acl = projectId ? store.db.prepare("SELECT can_review FROM knowledge_acl WHERE project_id = ? AND user_id = ?").get(projectId, request.user.id) as { can_review?: number } | undefined : undefined;
      if (!request.user.isAdmin && acl?.can_review !== 1) return reply.status(403).send({ error: "Reviewer access required" });
      if (body.data.operation === "attach") resolveEvidenceProject(request.user.id, store, body.data.evidenceId);
      const result = replayOrRun(store, request.user.id, "knowledge:evidence-link", idempotencyKey(request), () => {
        const repository = new KnowledgeRepository(store);
        if (body.data.operation === "attach") repository.attachEvidence(String(row.kind) as any, id, body.data.evidenceId);
        else repository.detachEvidence(String(row.kind) as any, id, body.data.evidenceId);
        const now = new Date().toISOString(); store.db.prepare("UPDATE knowledge_documents SET updated_at = ? WHERE id = ?").run(now, id);
        const evidenceRefs = documentEvidenceRefs(store, row, projectId);
        store.audit({ actorId: request.user.id, projectId, action: `knowledge.evidence.${body.data.operation}`, entityType: String(row.kind), entityId: id, details: { evidenceId: body.data.evidenceId, reason: body.data.reason, evidenceRefs } });
        return { ok: true, documentId: id, evidenceId: body.data.evidenceId, operation: body.data.operation, evidenceRefs, updatedAt: now };
      }, body.data);
      return reply.send(result);
    } catch (error) { return sendError(reply, error, 403); }
  });

  app.get("/api/knowledge/evidence/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const store = getKnowledgeStore();
    try {
      const projectId = resolveEvidenceProject(request.user.id, store, id);
      const evidence = new EvidenceStore(store, store.evidenceRoot ?? "./data/evidence").metadata(request.user.id, id);
      const linkedRows = store.db.prepare(`SELECT ee.entity_type,ee.entity_id,d.kind,d.title,d.lifecycle,d.project_id
        FROM knowledge_entity_evidence ee LEFT JOIN knowledge_documents d ON d.id=ee.entity_id
        WHERE ee.evidence_id=? ORDER BY ee.created_at`).all(id) as Array<Record<string, unknown>>;
      const linkedObjects = linkedRows.filter((row) => {
        const linkedProject = row.project_id === null || row.project_id === undefined ? undefined : String(row.project_id);
        if (!linkedProject || linkedProject === projectId) return true;
        return store.canRead(request.user.id, linkedProject);
      }).map((row) => ({ type: row.entity_type, id: row.entity_id, kind: row.kind, title: row.title, lifecycle: row.lifecycle, projectId: row.project_id }));
      const sharedProjectIds = store.db.prepare("SELECT project_id FROM knowledge_evidence_acl WHERE evidence_id=? ORDER BY project_id").all(id).map((row: any) => String(row.project_id)).filter((sharedId) => sharedId === projectId || store.canRead(request.user.id, sharedId));
      return reply.send({ evidence: safeEvidence(evidence as unknown as Record<string, unknown>), linkedObjects, sharedProjectIds });
    } catch { return reply.status(404).send({ error: "Evidence not found" }); }
  });

  app.post("/api/knowledge/evidence/:id/download-session", { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ maxBytes: z.number().int().positive().max(100 * 1024 * 1024).optional() }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "Invalid download session request" });
    const store = getKnowledgeStore();
    try {
      const projectId = resolveEvidenceProject(request.user.id, store, id);
      const evidence = new EvidenceStore(store, store.evidenceRoot ?? "./data/evidence").metadata(request.user.id, id);
      const maxBytes = parsed.data.maxBytes ?? 100 * 1024 * 1024;
      if (evidence.sizeBytes > maxBytes) return reply.status(413).send({ error: "Evidence exceeds requested download limit", sizeBytes: evidence.sizeBytes, maxBytes });
      const sessionId = `knowledge-download-${randomUUID()}`;
      const expiresAt = new Date(Date.now() + DEFAULT_DOWNLOAD_TTL_MS).toISOString();
      store.db.prepare("INSERT INTO knowledge_download_sessions(id,evidence_id,user_id,project_id,expires_at,max_bytes,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(sessionId, id, request.user.id, projectId, expiresAt, maxBytes, new Date().toISOString());
      store.audit({ actorId: request.user.id, projectId, action: "evidence.download_session_created", entityType: "evidence", entityId: id, details: { sessionId, expiresAt, maxBytes } });
      return reply.status(201).send({ sessionId, evidenceId: id, expiresAt, maxBytes, mimeType: evidence.mimeType, sizeBytes: evidence.sizeBytes, sha256: evidence.sha256 });
    } catch (error) { return sendError(reply, error, 404); }
  });

  app.get("/api/knowledge/evidence/:id/content", { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const store = getKnowledgeStore();
    try {
      const evidenceStore = new EvidenceStore(store, store.evidenceRoot ?? "./data/evidence");
      const header = request.headers["x-knowledge-download-session"];
      const query = request.query as Record<string, unknown>;
      const sessionId = (Array.isArray(header) ? header[0] : header) ?? query.sessionId;
      const row = store.db.prepare("SELECT mime_type,size_bytes FROM knowledge_evidence WHERE id = ? AND deleted_at IS NULL").get(id) as { mime_type?: string; size_bytes?: number } | undefined;
      if (!row) return reply.status(404).send({ error: "Evidence not found" });
      let maxBytes = MAX_INLINE_EVIDENCE_BYTES;
      if (sessionId) {
        const session = store.db.prepare("SELECT id,max_bytes FROM knowledge_download_sessions WHERE id = ? AND evidence_id = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?").get(String(sessionId), id, request.user.id, new Date().toISOString()) as { id: string; max_bytes: number } | undefined;
        if (!session) return reply.status(403).send({ error: "Download session is invalid or expired" });
        maxBytes = Number(session.max_bytes);
        if (Number(row.size_bytes) > maxBytes) return reply.status(413).send({ error: "Evidence exceeds download session limit" });
        const consumed = store.db.prepare("UPDATE knowledge_download_sessions SET used_at = ? WHERE id = ? AND used_at IS NULL").run(new Date().toISOString(), session.id);
        if (consumed.changes !== 1) return reply.status(409).send({ error: "Download session has already been used" });
      } else if (Number(row.size_bytes) > MAX_INLINE_EVIDENCE_BYTES) {
        return reply.status(428).send({ error: "Create a download session before reading large Evidence" });
      }
      const projectId = resolveEvidenceProject(request.user.id, store, id);
      const content = evidenceStore.download(request.user.id, id, maxBytes);
      store.audit({ actorId: request.user.id, projectId, action: "evidence.download_http", entityType: "evidence", entityId: id, details: { bytes: content.length, sessionId: sessionId ?? undefined } });
      return reply.type(row.mime_type ?? "application/octet-stream").header("Content-Length", String(content.length)).send(content);
    } catch (error) { return sendError(reply, error, 403); }
  });

  app.get("/api/knowledge/relations", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    try {
      const { store, projectId } = resolveProject(request.user.id, query.projectId);
      return reply.send({ relations: queryRelations(store, { userId: request.user.id, projectId, objectId: queryValue(query, "objectId"), relationType: queryValue(query, "relationType"), verifiedOnly: parseBoolean(query.verifiedOnly) ?? false, limit: parseBoundedInt(query.limit, 100, 1, 500), sampleManagerVersion: queryValue(query, "sampleManagerVersion"), solution: queryValue(query, "solution"), module: queryValue(query, "module"), environment: queryValue(query, "environment") }) });
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/relations/impact", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    try {
      const { store, projectId } = resolveProject(request.user.id, query.projectId);
      const requestedDirection = queryValue(query, "direction");
      const direction = requestedDirection === "upstream" || requestedDirection === "downstream" ? requestedDirection : "both";
      return reply.send(analyzeRelationImpact(store, { userId: request.user.id, projectId, objectId: queryValue(query, "objectId"), relationType: queryValue(query, "relationType"), verifiedOnly: parseBoolean(query.verifiedOnly) ?? false, limit: parseBoundedInt(query.limit, 500, 1, 500), maxDepth: parseBoundedInt(query.maxDepth, 3, 0, 20), direction }));
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/candidates", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    try {
      const { store, projectId } = resolveProject(request.user.id, query.projectId);
      const limit = parseBoundedInt(query.limit, 50, 1, 200); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000); const status = queryValue(query, "status");
      const conditions = ["d.project_id = ?", "d.kind = 'candidate'"]; const params: unknown[] = [projectId];
      if (status) { conditions.push("d.lifecycle = ?"); params.push(status); } else conditions.push("d.lifecycle <> 'deprecated'");
      for (const [column, key] of [["c.candidate_type", "candidateType"], ["d.samplemanager_version", "sampleManagerVersion"], ["d.solution", "solution"], ["d.module", "module"], ["d.environment", "environment"]] as const) {
        const value = queryValue(query, key); if (value) { conditions.push(`${column} = ?`); params.push(value); }
      }
      const createdAfter = queryValue(query, "createdAfter"); if (createdAfter) { conditions.push("d.created_at >= ?"); params.push(createdAfter); }
      const createdBefore = queryValue(query, "createdBefore"); if (createdBefore) { conditions.push("d.created_at <= ?"); params.push(createdBefore); }
      const minEvidence = queryValue(query, "minEvidenceCount"); if (minEvidence) { conditions.push("(SELECT COUNT(*) FROM knowledge_entity_evidence e WHERE e.entity_type='candidate' AND e.entity_id=d.id) >= ?"); params.push(parseBoundedInt(minEvidence, 0, 0, 100000)); }
      const rows = store.db.prepare(`SELECT d.*,c.candidate_type,c.event_id,c.job_id,c.deployment_id,(SELECT COUNT(*) FROM knowledge_entity_evidence e WHERE e.entity_type='candidate' AND e.entity_id=d.id) AS evidence_count FROM knowledge_documents d LEFT JOIN knowledge_candidates c ON c.id=d.id WHERE ${conditions.join(" AND ")} ORDER BY d.updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as KnowledgeRow[];
      const total = store.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_documents d LEFT JOIN knowledge_candidates c ON c.id=d.id WHERE ${conditions.join(" AND ")}`).get(...params) as { count?: number };
      return reply.send({ candidates: rows.map((row) => { const enriched = enrichDocumentRow(store, row); return safeDocument(enriched, false, store.getCandidateCard(String(row.id)), store.getScopeBinding(String(row.id))); }), page: { limit, offset, total: Number(total.count ?? 0) } });
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/observations", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    try {
      const { store, projectId } = resolveProject(request.user.id, query.projectId);
      const limit = parseBoundedInt(query.limit, 50, 1, 200);
      const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
      const rows = store.db.prepare(`${OBSERVATION_WITH_REVIEW} WHERE o.project_id = ? ORDER BY o.updated_at DESC LIMIT ? OFFSET ?`).all(projectId, limit, offset) as KnowledgeRow[];
      const total = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_observations WHERE project_id = ?").get(projectId) as { count?: number };
      return reply.send({ observations: rows.map(safeObservation), page: { limit, offset, total: Number(total.count ?? 0) } });
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/reviews", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    try {
      const { store, projectId } = resolveProject(request.user.id, query.projectId); const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
      const rows = store.db.prepare(`SELECT r.id,r.document_id,r.entity_type,r.entity_id,r.reviewer_id,r.action,r.reason,r.before_json,r.after_json,r.created_at FROM knowledge_reviews r JOIN knowledge_documents d ON d.id = r.document_id WHERE d.project_id = ? ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).all(projectId, limit, offset);
      return reply.send({ reviews: rows, page: { limit, offset } });
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/feedback", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    try {
      const { store, projectId } = resolveProject(request.user.id, query.projectId); const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
      const rows = store.db.prepare(`SELECT f.id,f.document_id,f.entity_id,f.user_id,f.helpful,f.comment,f.created_at FROM knowledge_feedback f JOIN knowledge_documents d ON d.id = f.document_id WHERE d.project_id = ? ORDER BY f.created_at DESC LIMIT ? OFFSET ?`).all(projectId, limit, offset);
      return reply.send({ feedback: rows, page: { limit, offset } });
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.post("/api/knowledge/reviews", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({
      action: z.enum(["review", "accept", "reject", "edit", "edit_card", "merge", "promote", "deprecate", "playbook_proposal"]).default("review"),
      documentId: z.string().min(1).optional(), lifecycle: z.enum(["reproduced", "verified", "approved", "deprecated"]).optional(), reason: z.string().trim().min(1).max(2_000),
      title: z.string().trim().min(1).max(500).optional(), body: z.string().max(100_000).optional(),
      sourceId: z.string().min(1).optional(), targetId: z.string().min(1).optional(), patternId: z.string().min(1).optional(), patternTitle: z.string().trim().min(1).max(500).optional(), patternBody: z.string().max(100_000).optional(),
      projectId: z.string().min(1).optional(), playbookId: z.string().min(1).optional(), skillDiff: z.string().max(100_000).optional(),
      scopeType: z.enum(["system", "version", "solution", "module", "organization", "project", "environment"]).optional(), scopeKey: z.string().max(500).optional(), visibility: z.enum(["private", "project", "organization", "global"]).optional(), redactionStatus: z.enum(["unknown", "unredacted", "redacted"]).optional(),
      card: z.object({ summary: z.string().max(2_000).optional(), problemStatement: z.string().max(10_000).optional(), facts: z.array(z.record(z.unknown())).max(50).optional(), symptoms: z.array(z.string().max(2_000)).max(50).optional(), hypothesis: z.string().max(10_000).optional(), verificationPlan: z.array(z.string().max(2_000)).max(50).optional(), verifiedConclusion: z.string().max(10_000).nullable().optional(), actions: z.array(z.string().max(2_000)).max(50).optional(), verification: z.array(z.string().max(2_000)).max(50).optional(), applicability: z.string().max(2_000).nullable().optional(), tags: z.array(z.string().max(200)).max(50).optional(), confidence: z.number().min(0).max(1).optional(), businessContext: z.object({ businessPurpose: z.string().max(4_000), affectedProcess: z.string().max(4_000), businessImpact: z.string().max(4_000), technicalComponentPurpose: z.string().max(4_000), confidence: z.enum(["provided", "inferred", "unknown"]) }).optional() }).optional(),
    }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid review", details: body.error.issues });
    const store = getKnowledgeStore(); const data = body.data;
    try {
      const documentId = data.documentId ?? data.sourceId;
      if (data.action !== "playbook_proposal" && !documentId && data.action !== "merge" && data.action !== "promote") throw new Error("documentId is required");
      const result = replayOrRun(store, request.user.id, `review:${data.action}`, idempotencyKey(request), () => {
        if (data.action === "accept") { acceptCandidate(store, request.user.id, documentId!, data.reason); return { ok: true, action: data.action, documentId }; }
        if (data.action === "reject") { rejectCandidate(store, request.user.id, documentId!, data.reason); return { ok: true, action: data.action, documentId }; }
        if (data.action === "deprecate") { deprecateDocument(store, request.user.id, documentId!, data.reason); return { ok: true, action: data.action, documentId }; }
        if (data.action === "edit") return { document: editDocument(store, request.user.id, documentId!, { title: data.title, body: data.body }, data.reason) };
        if (data.action === "edit_card") return { card: editCandidateCard(store, request.user.id, documentId!, { ...data.card, applicability: data.card?.applicability ?? undefined, verifiedConclusion: data.card?.verifiedConclusion ?? undefined }, data.reason) };
        if (data.action === "merge") { if (!data.sourceId || !data.targetId) throw new Error("sourceId and targetId are required"); mergeCandidates(store, request.user.id, data.sourceId, data.targetId, data.reason); return { ok: true, action: data.action, sourceId: data.sourceId, targetId: data.targetId }; }
        if (data.action === "promote") { if (!data.sourceId || !data.patternId || !data.patternTitle) throw new Error("sourceId, patternId and patternTitle are required"); return { document: promoteCaseToPattern(store, request.user.id, data.sourceId, { id: data.patternId, title: data.patternTitle, body: data.patternBody, reason: data.reason, scopeType: data.scopeType, scopeKey: data.scopeKey, visibility: data.visibility, redactionStatus: data.redactionStatus }) }; }
        if (data.action === "playbook_proposal") { if (!data.playbookId || !data.projectId || !data.title || data.body === undefined) throw new Error("playbookId, projectId, title and body are required"); return { document: proposePlaybook(store, request.user.id, { id: data.playbookId, projectId: data.projectId, title: data.title, body: data.body, skillDiff: data.skillDiff, reason: data.reason }) }; }
        if (!data.lifecycle) throw new Error("lifecycle is required for a review action");
        reviewDocument(store, request.user.id, documentId!, data.lifecycle, data.reason); return { ok: true, action: data.action, documentId, lifecycle: data.lifecycle };
      }, body.data);
      return reply.send(result);
    } catch (error) { return sendError(reply, error, 403); }
  });

  app.post("/api/knowledge/feedback", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ documentId: z.string().min(1), helpful: z.boolean().optional(), comment: z.string().max(2_000).optional() }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid feedback", details: body.error.issues });
    const store = getKnowledgeStore();
    try {
      const row = loadDocumentForUser(store, request.user.id, body.data.documentId);
      const result = replayOrRun(store, request.user.id, "feedback", idempotencyKey(request), () => {
        const id = `feedback-${randomUUID()}`; const createdAt = new Date().toISOString();
        store.db.prepare("INSERT INTO knowledge_feedback(id,document_id,entity_id,user_id,helpful,comment,created_at) VALUES (?,?,?,?,?,?,?)").run(id, body.data.documentId, body.data.documentId, request.user.id, body.data.helpful === undefined ? null : body.data.helpful ? 1 : 0, body.data.comment ?? null, createdAt);
        store.audit({ actorId: request.user.id, projectId: String(row.project_id), action: "knowledge.feedback", entityType: "document", entityId: body.data.documentId, details: { helpful: body.data.helpful } });
        return { ok: true, id, documentId: body.data.documentId, createdAt };
      }, body.data);
      return reply.send(result);
    } catch (error) { return sendError(reply, error, 404); }
  });

  app.post("/api/knowledge/ingest", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ projectId: z.number().int().positive(), casebookRoot: z.string().optional(), contextFiles: z.array(z.string()).optional() }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid ingestion request", details: body.error.issues });
    try {
      const { store, projectId } = resolveProject(request.user.id, body.data.projectId);
      const result = replayOrRun(store, request.user.id, "ingest", idempotencyKey(request), () => {
        const report = importCasebook(store, { root: body.data.casebookRoot ?? store.casebookRoot ?? "./casebook", projectId, projectNameSnapshot: String(body.data.projectId), evidenceRoot: store.evidenceRoot });
        const facts = body.data.contextFiles?.length ? importContextFacts(store, { files: body.data.contextFiles, userId: request.user.id, projectId, projectNameSnapshot: String(body.data.projectId) }) : undefined;
        return { report, facts };
      }, body.data);
      return reply.send(result);
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.post("/api/knowledge/reindex", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ projectId: z.number().int().positive() }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "projectId is required" });
    try {
      const { store, projectId } = resolveProject(request.user.id, body.data.projectId);
      const result = replayOrRun(store, request.user.id, "reindex", idempotencyKey(request), () => {
        const documents = Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents WHERE project_id = ?").get(projectId) as { count?: number } | undefined)?.count ?? 0);
        const facts = Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_facts WHERE project_id = ?").get(projectId) as { count?: number } | undefined)?.count ?? 0);
        store.db.transaction(() => {
          store.db.prepare("DELETE FROM knowledge_fts WHERE document_id IN (SELECT id FROM knowledge_documents WHERE project_id = ?)").run(projectId);
          store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) SELECT c.document_id, d.title, c.content FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id WHERE d.project_id = ?").run(projectId);
          store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) SELECT d.id, d.title, d.body FROM knowledge_documents d WHERE d.project_id = ? AND NOT EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.document_id = d.id)").run(projectId);
          store.db.prepare("DELETE FROM knowledge_facts_fts WHERE rowid IN (SELECT rowid FROM knowledge_facts WHERE project_id = ?)").run(projectId);
          store.db.prepare("INSERT INTO knowledge_facts_fts(rowid,fact_id,text,tags) SELECT rowid,id,text,tags_json FROM knowledge_facts WHERE project_id = ?").run(projectId);
        })();
        store.audit({ actorId: request.user.id, projectId, action: "knowledge.reindex", entityType: "index", entityId: `project:${projectId}`, details: { documents, facts } });
        return { ok: true, projectId, documents, facts, completedAt: new Date().toISOString() };
      }, body.data);
      return reply.send(result);
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/index-status", { onRequest: [app.authenticate] }, async (request, reply) => {
    try {
      const { store, projectId } = resolveProject(request.user.id, (request.query as Record<string, unknown>).projectId);
      const counts = store.db.prepare("SELECT kind, lifecycle, COUNT(*) AS count FROM knowledge_documents WHERE project_id = ? GROUP BY kind,lifecycle ORDER BY kind,lifecycle").all(projectId);
      const indexCoverage = store.db.prepare(`SELECT
        (SELECT COUNT(*) FROM knowledge_documents WHERE project_id = ?) AS documents,
        (SELECT COUNT(DISTINCT f.document_id) FROM knowledge_fts f JOIN knowledge_documents d ON d.id = f.document_id WHERE d.project_id = ?) AS indexedDocuments,
        (SELECT COUNT(*) FROM knowledge_facts WHERE project_id = ?) AS facts,
        (SELECT COUNT(DISTINCT f.fact_id) FROM knowledge_facts_fts f JOIN knowledge_facts d ON d.id = f.fact_id WHERE d.project_id = ?) AS indexedFacts`).get(projectId, projectId, projectId, projectId) as Record<string, unknown>;
      const staleReasons: string[] = [];
      if (Number(indexCoverage.documents ?? 0) !== Number(indexCoverage.indexedDocuments ?? 0)) staleReasons.push("document_index_incomplete");
      if (Number(indexCoverage.facts ?? 0) !== Number(indexCoverage.indexedFacts ?? 0)) staleReasons.push("fact_index_incomplete");
      const lastIngest = store.db.prepare("SELECT id,status,imported,skipped,failed,started_at,finished_at,error FROM knowledge_ingest_runs ORDER BY started_at DESC LIMIT 1").get();
      return reply.send({ projectId, stale: staleReasons.length > 0, staleReasons, indexCoverage, counts, lastIngest, checkedAt: new Date().toISOString() });
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/dashboard", { onRequest: [app.authenticate] }, async (request, reply) => {
    try {
      const { store, projectId } = resolveProject(request.user.id, (request.query as Record<string, unknown>).projectId);
      const kinds = ["product_document", "candidate", "case", "pattern", "playbook", "fact", "evidence"];
      const counts = safeRows(() => store.db.prepare("SELECT kind, lifecycle, COUNT(*) AS count FROM knowledge_documents WHERE project_id = ? GROUP BY kind, lifecycle ORDER BY kind, lifecycle").all(projectId) as Array<Record<string, unknown>>, []);
      const globalProductCount = safeRows(() => Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents d WHERE d.kind = 'product_document' AND EXISTS (SELECT 1 FROM knowledge_scope_bindings s WHERE s.document_id=d.id AND s.visibility='global')").get() as { count?: number }).count ?? 0), 0);
      const evidenceCount = safeRows(() => Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_evidence WHERE project_id = ? AND deleted_at IS NULL").get(projectId) as { count?: number }).count ?? 0), 0);
      const totals = kinds.map((kind) => ({ kind, count: kind === "product_document" ? globalProductCount : kind === "evidence" ? evidenceCount : counts.filter((item) => String(item.kind) === kind).reduce((sum, item) => sum + Number(item.count ?? 0), 0) }));
      const backlog = safeRows(() => store.consumerBacklog("knowledge-capture"), { count: 0 });
      const lastReview = safeRows(() => store.db.prepare("SELECT r.id,r.action,r.entity_type,r.entity_id,r.created_at FROM knowledge_reviews r JOIN knowledge_documents d ON d.id = r.document_id WHERE d.project_id = ? ORDER BY r.created_at DESC LIMIT 1").get(projectId), undefined);
      const lastIngest = safeRows(() => store.db.prepare("SELECT id,status,imported,skipped,failed,started_at,finished_at,error FROM knowledge_ingest_runs ORDER BY started_at DESC LIMIT 1").get(), undefined);
      const recentEvents = safeRows(() => store.db.prepare("SELECT id,type,occurred_at,job_id,deployment_id FROM relay_domain_events WHERE project_id = ? ORDER BY occurred_at DESC LIMIT 10").all(projectId), []);
      return reply.send({ projectId, totals, counts, scope: { globalProductDocuments: globalProductCount, projectDocuments: counts.reduce((sum, item) => sum + Number(item.count ?? 0), 0) }, recent: { lastReview, lastIngest, events: recentEvents }, health: knowledgeHealth(store), capture: { backlog, workerManagedBy: "remote-ops-mcp", checkedAt: new Date().toISOString() } });
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/evidence", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const projectRaw = queryValue(query, "projectId");
    try {
      const store = getKnowledgeStore();
      const projectId = projectRaw ? resolveProject(request.user.id, projectRaw).projectId : undefined;
      const limit = parseBoundedInt(query.limit, 100, 1, 500);
      const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
      const params: unknown[] = [];
      const where = ["e.deleted_at IS NULL"];
      if (projectId) {
        where.push("(e.project_id = ? OR EXISTS (SELECT 1 FROM knowledge_evidence_acl a WHERE a.evidence_id=e.id AND a.project_id=?))");
        params.push(projectId, projectId);
      } else if (!request.user.isAdmin) {
        const owned = db.select({ id: projects.id }).from(projects).where(eq(projects.userId, request.user.id)).all().map((row) => String(row.id));
        if (!owned.length) return reply.send({ evidence: [], page: { limit, offset, total: 0 } });
        where.push(`(e.project_id IN (${owned.map(() => "?").join(",")}) OR EXISTS (SELECT 1 FROM knowledge_evidence_acl a WHERE a.evidence_id=e.id AND a.project_id IN (${owned.map(() => "?").join(",")})))`);
        params.push(...owned, ...owned);
      }
      if (parseBoolean(query.unlinked)) where.push("NOT EXISTS (SELECT 1 FROM knowledge_entity_evidence x WHERE x.evidence_id = e.id)");
      const sourceKind = queryValue(query, "sourceKind"); if (sourceKind) { where.push("e.source_kind = ?"); params.push(sourceKind); }
      const retention = queryValue(query, "retention"); if (retention) { where.push("e.retention = ?"); params.push(retention); }
      const environment = queryValue(query, "environment"); if (environment) { where.push("(e.environment = ? OR EXISTS (SELECT 1 FROM knowledge_entity_evidence ee JOIN knowledge_documents d ON d.id = ee.entity_id WHERE ee.evidence_id = e.id AND d.environment = ?))"); params.push(environment, environment); }
      const createdAfter = queryValue(query, "createdAfter"); if (createdAfter) { where.push("e.created_at >= ?"); params.push(createdAfter); }
      const createdBefore = queryValue(query, "createdBefore"); if (createdBefore) { where.push("e.created_at <= ?"); params.push(createdBefore); }
      const sourceQuery = queryValue(query, "q"); if (sourceQuery) { where.push("(e.source_locator LIKE ? OR e.id LIKE ?)"); params.push(`%${sourceQuery}%`, `%${sourceQuery}%`); }
      const jobId = queryValue(query, "jobId"); if (jobId) { where.push("e.source_locator LIKE ?"); params.push(`%${jobId}%`); }
      const deploymentId = queryValue(query, "deploymentId"); if (deploymentId) { where.push("e.source_locator LIKE ?"); params.push(`%${deploymentId}%`); }
      const rows = store.db.prepare(`SELECT e.id,e.sha256,e.mime_type,e.size_bytes,e.source_kind,e.project_id,e.environment,e.source_locator,e.retention,e.created_at,
        (SELECT COUNT(*) FROM knowledge_entity_evidence x WHERE x.evidence_id=e.id) AS linked_count
        FROM knowledge_evidence e WHERE ${where.join(" AND ")} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as KnowledgeRow[];
      const total = store.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_evidence e WHERE ${where.join(" AND ")}`).get(...params) as { count?: number };
      return reply.send({ evidence: rows.map((row) => safeEvidence({ id: row.id, sha256: row.sha256, mimeType: row.mime_type, sizeBytes: row.size_bytes, sourceKind: row.source_kind, projectId: row.project_id, environment: row.environment, locator: row.source_locator, retention: row.retention, createdAt: row.created_at, linkedCount: row.linked_count })), page: { limit, offset, total: Number(total.count ?? 0) } });
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/documents", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    try {
      const { store, projectId } = resolveProject(request.user.id, query.projectId);
      const limit = parseBoundedInt(query.limit, 200, 1, 500);
      const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
      const requestedKinds = queryValue(query, "kinds")?.split(",").map((kind) => kind.trim()).filter((kind) => ["candidate", "case", "pattern", "playbook", "fact"].includes(kind));
      const params: unknown[] = [projectId];
      const kindClause = requestedKinds?.length ? ` AND d.kind IN (${requestedKinds.map(() => "?").join(",")})` : " AND d.kind != 'product_document'";
      if (requestedKinds?.length) params.push(...requestedKinds);
      const rows = store.db.prepare(`SELECT d.* FROM knowledge_documents d WHERE d.project_id = ?${kindClause} ORDER BY d.updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as KnowledgeRow[];
      const total = store.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_documents d WHERE d.project_id = ?${kindClause}`).get(...params) as { count?: number };
      return reply.send({ documents: rows.map((row) => { const enriched = enrichDocumentRow(store, row); return safeDocument(enriched, false, String(row.kind) === "candidate" ? store.getCandidateCard(String(row.id)) : undefined, store.getScopeBinding(String(row.id))); }), page: { limit, offset, total: Number(total.count ?? 0) } });
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/diagnostics", { onRequest: [app.authenticate] }, async (request, reply) => {
    try {
      const { store, projectId } = resolveProject(request.user.id, (request.query as Record<string, unknown>).projectId);
      const stateRoot = store.evidenceRoot ? store.evidenceRoot.replace(/[\\/]evidence[\\/]?$/, "") : ".relay-mcp";
      const paths = [`${stateRoot}/knowledge-event-spool.jsonl.dead-letter`, `${stateRoot}/knowledge-capture-dead-letter.jsonl`];
      const deadLetters = paths.flatMap((path) => safeRows(() => readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-20).map((line) => { try { return { ...JSON.parse(line), sourcePath: path }; } catch { return { raw: line, sourcePath: path }; } }), []));
      return reply.send({ projectId, health: knowledgeHealth(store), deadLetters: deadLetters.slice(-50), checkedAt: new Date().toISOString() });
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/ingest-runs", { onRequest: [app.authenticate] }, async (request, reply) => {
    try {
      const { store } = resolveProject(request.user.id, (request.query as Record<string, unknown>).projectId);
      const limit = parseBoundedInt((request.query as Record<string, unknown>).limit, 50, 1, 200);
      return reply.send({ runs: safeRows(() => store.db.prepare("SELECT id,source_locator,status,imported,skipped,failed,started_at,finished_at,error FROM knowledge_ingest_runs ORDER BY started_at DESC LIMIT ?").all(limit), []) });
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.post("/api/knowledge/product-docs/import", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ root: z.string().min(1).optional(), projectId: z.number().int().positive().optional(), path: z.string().min(1).optional(), product: z.string().max(200).optional(), sampleManagerVersion: z.string().max(80).optional(), solution: z.string().max(200).optional(), module: z.string().max(200).optional(), language: z.string().max(20).optional(), authority: z.string().max(80).optional(), documentFamilyId: z.string().max(200).optional(), manifestPath: z.string().min(1).optional(), asynchronous: z.boolean().optional().default(true) }).refine((value) => Boolean(value.root || (value.projectId && value.path)), "root or projectId/path is required").safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid product document import", details: body.error.issues });
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    try {
      const root = body.data.root ?? (() => { const project = db.select().from(projects).where(and(eq(projects.id, body.data.projectId!), eq(projects.userId, request.user.id))).get(); if (!project) throw new Error("Project not found"); return resolveWorkspacePath(project.workspacePath, body.data.path!, { mustExist: true }); })();
      if (!existsSync(root)) return reply.status(403).send({ error: "An existing source file or directory is required" });
      const store = getKnowledgeStore(); const key = idempotencyKey(request);
      const report = replayOrRun(store, request.user.id, "product-documents:import", key, () => enqueueProductImport(store, { ...body.data, root, sampleManagerVersion: body.data.sampleManagerVersion ?? "", idempotencyKey: key }), body.data);
      store.audit({ actorId: request.user.id, action: "knowledge.product_documents.import", entityType: "product_document_batch", entityId: report.id, details: { ...report } });
      return reply.status(202).send(report);
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/product-docs", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query=request.query as Record<string,unknown>,store=getKnowledgeStore(),value=(key:string)=>queryValue(query,key);
    const input={userId:request.user.id,isAdmin:request.user.isAdmin,projectId:value("projectId"),environment:value("environment"),sampleManagerVersion:value("sampleManagerVersion"),product:value("product"),solution:value("solution"),module:value("module"),documentType:value("documentType"),language:value("language"),authority:value("authority"),limit:parseBoundedInt(query.limit,100,1,500),offset:parseBoundedInt(query.offset,0,0,1_000_000)};
    try {return reply.send(new MigrationController(store).activeProductProvider()==="weknora"?await listEngineProductBackend(store,input):{documents:await searchProductBackend(store,input)});}
    catch(error){return sendError(reply,error,error instanceof WeKnoraError?503:403);}
  });

  app.get("/api/knowledge/product-docs/search", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>; const store = getKnowledgeStore();
    if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const value = (key: string) => queryValue(query, key);
    const results = await searchProductBackend(store, {userId:request.user.id,isAdmin:request.user.isAdmin,projectId:value("projectId"),environment:value("environment"), query: value("q") ?? value("query"), sampleManagerVersion: value("sampleManagerVersion"), product: value("product"), solution: value("solution"), module: value("module"), documentType: value("documentType"), language: value("language"), authority: value("authority"), limit: parseBoundedInt(query.limit, 50, 1, 500), includeDeprecated: value("includeDeprecated") === "true" });
    return reply.send({ query: value("q") ?? value("query") ?? "", results });
  });

  app.get("/api/knowledge/product-docs/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    try {
      const query=request.query as Record<string,unknown>;
      const document=await getProductBackend(getKnowledgeStore(),{documentId:String((request.params as {id:string}).id),userId:request.user.id,isAdmin:request.user.isAdmin,projectId:queryValue(query,"projectId"),environment:queryValue(query,"environment")});
      return reply.send({document,sections:document.sections??[]});
    }catch(error){return sendError(reply,error,error instanceof WeKnoraError?503:404);}
  });

  app.get("/api/knowledge/product-docs/:id/diff", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id); const against = queryValue(request.query as Record<string, unknown>, "against"); if (!against) return reply.status(400).send({ error: "against is required" });
    const store = getKnowledgeStore(); const exists = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_product_documents WHERE id IN (?,?)").get(id, against) as { count?: number }; if (Number(exists.count) !== 2) return reply.status(404).send({ error: "Product document not found" });
    if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    try {return reply.send(await diffProductBackend(store,{leftId:id,rightId:against,userId:request.user.id,isAdmin:request.user.isAdmin,projectId:queryValue(request.query as Record<string,unknown>,"projectId"),environment:queryValue(request.query as Record<string,unknown>,"environment")}));}catch(error){return sendError(reply,error,error instanceof WeKnoraError?503:404);}
  });

  app.patch("/api/knowledge/product-docs/:id/lifecycle", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id); const body = z.object({ lifecycle: z.enum(["approved", "deprecated"]), reason: z.string().trim().min(1).max(2000) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid product document lifecycle change", details: body.error.issues });
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    try {
      const store = getKnowledgeStore(); const result = replayOrRun(store, request.user.id, "product-documents:lifecycle", idempotencyKey(request), () => {
        const updated = updateProductDocumentLifecycle(store, id, body.data.lifecycle);
        store.audit({ actorId: request.user.id, action: `knowledge.product_document.${body.data.lifecycle}`, entityType: "product_document", entityId: id, details: { reason: body.data.reason, ...updated } });
        return updated;
      }, body.data);
      return reply.send(result);
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.patch("/api/knowledge/product-docs/metadata", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(500), module: z.string().max(200).nullable().optional(), documentType: z.string().max(80).nullable().optional(), language: z.string().max(20).nullable().optional(), authority: z.string().max(80).nullable().optional(), reason: z.string().trim().min(1).max(2000) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid metadata correction", details: body.error.issues });
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    try {
      const store = getKnowledgeStore(); const result = replayOrRun(store, request.user.id, "product-documents:metadata-correction", idempotencyKey(request), () => {
        const now = new Date().toISOString();
        const response = correctProductMetadata(store,body.data,now);
        store.audit({ actorId: request.user.id, action: "knowledge.product_document.metadata_corrected", entityType: "product_document_batch", entityId: `batch-${now}`, details: { ...response, ids: body.data.ids, reason: body.data.reason } });
        return response;
      }, body.data);
      return reply.send(result);
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.post("/api/knowledge/product-docs/:id/diff-review", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id);
    const body = z.object({ against: z.string().min(1), status: z.enum(["accepted", "rejected", "needs_review"]), reason: z.string().trim().min(1).max(2000) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid diff review", details: body.error.issues });
    try {
      const store = getKnowledgeStore();
      const row = store.db.prepare("SELECT project_id FROM knowledge_documents WHERE id = ? AND kind = 'product_document'").get(id) as { project_id?: string } | undefined;
      if (!row) return reply.status(404).send({ error: "Product document not found" });
      const acl = row.project_id ? store.db.prepare("SELECT can_review FROM knowledge_acl WHERE project_id = ? AND user_id = ?").get(row.project_id, request.user.id) as { can_review?: number } | undefined : undefined;
      if (!request.user.isAdmin && acl?.can_review !== 1) return reply.status(403).send({ error: "Reviewer access required" });
      const result = replayOrRun(store, request.user.id, "product-documents:diff-review", idempotencyKey(request), () => {
        const now = new Date().toISOString();
        store.db.prepare("UPDATE knowledge_product_documents SET diff_review_status = ?, diff_reviewed_by = ?, diff_reviewed_at = ?, updated_at = ? WHERE id = ?").run(body.data.status, request.user.id, now, now, id);
        const response = { ok: true, id, against: body.data.against, status: body.data.status, reviewedAt: now };
        store.audit({ actorId: request.user.id, projectId: row.project_id, action: "knowledge.product_document.diff_review", entityType: "product_document", entityId: id, details: { ...response, reason: body.data.reason } });
        return response;
      }, body.data);
      return reply.send(result);
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.post("/api/knowledge/artifact-sets/import", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ source: z.string().min(1), name: z.string().min(1), kind: z.string().optional(), version: z.string().optional(), solution: z.string().optional(), storageUri: z.string().optional(), asynchronous: z.boolean().optional().default(true) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid artifact import request", details: body.error.issues });
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    try { const store = getKnowledgeStore(); if (body.data.asynchronous) return reply.status(202).send(enqueueArtifactImport(store, body.data)); const report = ingestArtifactSet(store, body.data); return reply.send(report); } catch (error) { return sendError(reply, error, 400); }
  });
  app.get("/api/knowledge/artifact-sets", { onRequest: [app.authenticate] }, async (request, reply) => {
    const accessStore = getKnowledgeStore(); if (!request.user.isAdmin && !knowledgeReadAllowed(accessStore, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const store = accessStore; const q = request.query as Record<string, unknown>; const limit = parseBoundedInt(q.limit, 100, 1, 500);
    const sets = store.db.prepare("SELECT s.*, (SELECT COUNT(*) FROM knowledge_artifacts a WHERE a.set_id=s.id) AS file_count FROM knowledge_artifact_sets s ORDER BY s.created_at DESC LIMIT ?").all(limit);
    return reply.send({ sets });
  });
  app.post("/api/knowledge/artifact-sets/:id/publish", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore(); const exists = store.db.prepare("SELECT id FROM knowledge_artifact_sets WHERE id=?").get(id);
    if (!exists) return reply.status(404).send({ error: "Artifact set not found" });
    const now = new Date().toISOString(); store.db.transaction(() => { store.db.prepare("UPDATE knowledge_artifact_sets SET status='published',updated_at=? WHERE id=?").run(now, id); store.db.prepare("INSERT INTO knowledge_artifact_publications(artifact_set_id,status,published_by,published_at) VALUES(?,?,?,?) ON CONFLICT(artifact_set_id) DO UPDATE SET status='published',published_by=excluded.published_by,published_at=excluded.published_at,retired_at=NULL").run(id, "published", request.user.id, now); })();
    store.audit({ actorId: request.user.id, action: "knowledge.artifact_set.publish", entityType: "artifact_set", entityId: id }); return reply.send({ ok: true, id, status: "published", publishedAt: now });
  });
  app.post("/api/knowledge/artifact-sets/:id/retire", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore(); const now = new Date().toISOString(); const result = store.db.prepare("UPDATE knowledge_artifact_sets SET status='retired',updated_at=? WHERE id=?").run(now, id);
    if (!result.changes) return reply.status(404).send({ error: "Artifact set not found" }); store.db.prepare("UPDATE knowledge_artifact_publications SET status='retired',retired_at=? WHERE artifact_set_id=?").run(now, id); store.audit({ actorId: request.user.id, action: "knowledge.artifact_set.retire", entityType: "artifact_set", entityId: id }); return reply.send({ ok: true, id, status: "retired" });
  });
  app.post("/api/knowledge/project-snapshots/import", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ source: z.string().min(1), name: z.string().min(1), projectId: z.string().optional(), version: z.string().optional(), storageUri: z.string().optional() }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid project snapshot request", details: body.error.issues });
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    try { return reply.send(ingestProjectSnapshot(getKnowledgeStore(), body.data)); } catch (error) { return sendError(reply, error, 400); }
  });
  app.get("/api/knowledge/source-search", { onRequest: [app.authenticate] }, async (request, reply) => {
    const q = request.query as Record<string, unknown>; const query = queryValue(q, "query") ?? queryValue(q, "q"); if (!query) return reply.status(400).send({ error: "query is required" }); const store = getKnowledgeStore(); if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" }); const baselineId = queryValue(q, "baselineId"); const snapshotId = queryValue(q, "projectSnapshotId");
    if (!baselineId && !snapshotId) return reply.status(400).send({ error: "baselineId or projectSnapshotId is required" }); if (baselineId) { const published = store.db.prepare("SELECT 1 FROM knowledge_source_baselines b JOIN knowledge_artifact_publications p ON p.artifact_set_id=b.artifact_set_id AND p.status='published' WHERE b.id=?").get(baselineId); if (!published) return reply.status(409).send({ error: "Source baseline is not published" }); }
    if (snapshotId) { const snapshot = store.db.prepare("SELECT project_id FROM knowledge_project_snapshots WHERE id=?").get(snapshotId) as { project_id?: string } | undefined; if (!snapshot) return reply.status(404).send({ error: "Project snapshot not found" }); if (snapshot.project_id && !store.canRead(request.user.id, snapshot.project_id)) return reply.status(403).send({ error: "Knowledge access denied" }); }
    const limit = parseBoundedInt(q.limit, 10, 1, 50); const where = ["knowledge_source_chunks_fts MATCH ?"]; const params: unknown[] = [query]; if (baselineId) { where.push("c.baseline_id=?"); params.push(baselineId); } if (snapshotId) { where.push("c.snapshot_id=?"); params.push(snapshotId); }
    const rows = store.db.prepare(`SELECT c.id,c.relative_path,c.symbol,c.line_start,c.line_end,c.content,c.content_sha256,c.parser_version,b.solution,b.version FROM knowledge_source_chunks_fts f JOIN knowledge_source_chunks c ON c.id=f.chunk_id LEFT JOIN knowledge_source_baselines b ON b.id=c.baseline_id WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`).all(...params, limit);
    return reply.send({ results: rows, page: { limit, total: rows.length } });
  });
  app.get("/api/knowledge/source-baselines/:id/files", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore(); if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const baseline = store.db.prepare("SELECT * FROM knowledge_source_baselines WHERE id=?").get(id); if (!baseline) return reply.status(404).send({ error: "Source baseline not found" });
    return reply.send({ baseline, files: store.db.prepare("SELECT relative_path AS path,sha256,size_bytes AS size,language,storage_uri FROM knowledge_source_files WHERE baseline_id=? ORDER BY relative_path").all(id) });
  });
  app.post("/api/knowledge/source-baselines/compare", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ oldBaselineId: z.string(), projectSnapshotId: z.string(), newBaselineId: z.string() }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid baseline comparison request", details: body.error.issues });
    const store = getKnowledgeStore(); if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const published = store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_source_baselines b JOIN knowledge_artifact_publications p ON p.artifact_set_id=b.artifact_set_id AND p.status='published' WHERE b.id IN (?,?)").get(body.data.oldBaselineId, body.data.newBaselineId) as { n?: number };
    if (Number(published.n ?? 0) !== 2) return reply.status(409).send({ error: "Both source baselines must be published" });
    const snapshot = store.db.prepare("SELECT project_id FROM knowledge_project_snapshots WHERE id=?").get(body.data.projectSnapshotId) as { project_id?: string } | undefined;
    if (!snapshot) return reply.status(404).send({ error: "Project snapshot not found" }); if (snapshot.project_id && !store.canRead(request.user.id, snapshot.project_id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const manifest = (table: string, id: string): SourceManifest => {
      const rows = store.db.prepare(`SELECT relative_path AS path,sha256,size_bytes AS size,language FROM ${table} WHERE ${table === "knowledge_project_snapshot_files" ? "snapshot_id" : "baseline_id"}=? ORDER BY relative_path`).all(id) as Array<{ path: string; sha256: string; size: number; language?: string }>;
      if (!rows.length) throw new Error("Source snapshot not found or empty"); return { root: id, files: rows, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
    };
    try {
      const changes = compareSourceBaselines(manifest("knowledge_source_files", body.data.oldBaselineId), manifest("knowledge_project_snapshot_files", body.data.projectSnapshotId), manifest("knowledge_source_files", body.data.newBaselineId));
      const ids = (table: string, key: string, id: string) => new Map((store.db.prepare(`SELECT relative_path,id FROM ${table} WHERE ${key}=?`).all(id) as Array<{ relative_path: string; id: string }>).map((row) => [row.relative_path, row.id]));
      const oldIds = ids("knowledge_source_files", "baseline_id", body.data.oldBaselineId); const projectIds = ids("knowledge_project_snapshot_files", "snapshot_id", body.data.projectSnapshotId); const newIds = ids("knowledge_source_files", "baseline_id", body.data.newBaselineId);
      return reply.send({ changes: changes.map((change) => ({ ...change, evidenceRefs: { old: oldIds.get(change.path), project: projectIds.get(change.path), next: newIds.get(change.path) } })) });
    } catch (error) { return sendError(reply, error, 404); }
  });

  // Logical Product Knowledge topics. These sit above the legacy
  // product-document APIs: one topic can bind the same immutable revision to
  // multiple product versions without duplicating its content.
  app.get("/api/knowledge/product-topics", { onRequest: [app.authenticate] }, async (request, reply) => {
    const store = getKnowledgeStore();
    if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const query = request.query as Record<string, unknown>;
    const limit = parseBoundedInt(query.limit, 100, 1, 500);
    const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    const version = queryValue(query, "productVersion") ?? queryValue(query, "sampleManagerVersion");
    const search = queryValue(query, "q");
    let visibility;
    try { visibility = await productCatalogVisibility(store, { userId: request.user.id, isAdmin: request.user.isAdmin, projectId: queryValue(query, "projectId"), environment: queryValue(query, "environment") }); }
    catch (error) { return sendError(reply, error, error instanceof WeKnoraError ? 503 : 403); }
    const where = ["EXISTS (SELECT 1 FROM json_each(?) visible WHERE json_extract(visible.value,'$.documentId')=d.id AND (?='relay_local' OR json_extract(visible.value,'$.productVersion') IS b.product_version))"];
    const params: unknown[] = [JSON.stringify(visibility.documents), visibility.provider];
    if (version) { where.push("b.product_version = ?"); params.push(version); }
    if (search) { where.push("(lower(t.canonical_title) LIKE ? OR lower(t.canonical_key) LIKE ?)"); params.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`); }
    const rows = store.db.prepare(`SELECT t.id,t.canonical_key,t.canonical_title,t.kind,t.domain,t.metadata_json,
      COUNT(DISTINCT b.product_version) AS version_count, COUNT(DISTINCT COALESCE(json_extract(p.metadata_json, '$.normalizedContentSha256'), b.document_id)) AS revision_count,
      MAX(b.updated_at) AS updated_at,
      GROUP_CONCAT(DISTINCT b.product_version) AS versions
      FROM knowledge_topics t JOIN knowledge_product_document_bindings b ON b.topic_id=t.id JOIN knowledge_product_documents p ON p.id=b.document_id JOIN knowledge_documents d ON d.id=b.document_id
      WHERE ${where.join(" AND ")} GROUP BY t.id ORDER BY t.canonical_title LIMIT ? OFFSET ?`).all(...params, limit, offset) as KnowledgeRow[];
    const total = store.db.prepare(`SELECT COUNT(*) AS count FROM (SELECT t.id FROM knowledge_topics t JOIN knowledge_product_document_bindings b ON b.topic_id=t.id JOIN knowledge_documents d ON d.id=b.document_id WHERE ${where.join(" AND ")} GROUP BY t.id)`).get(...params) as { count?: number };
    return reply.send({ topics: rows.map((row) => ({ ...row, versions: String(row.versions ?? "").split(",").filter(Boolean), versionCount: Number(row.version_count ?? 0), revisionCount: Number(row.revision_count ?? 0), metadata: safeRows(() => JSON.parse(String(row.metadata_json ?? "{}")), {}) })), page: { limit, offset, total: Number(total.count ?? 0) } });
  });

  app.get("/api/knowledge/product-topics/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id);
    const store = getKnowledgeStore();
    if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const topic = store.db.prepare("SELECT * FROM knowledge_topics WHERE id=?").get(id) as KnowledgeRow | undefined;
    if (!topic) return reply.status(404).send({ error: "Product topic not found" });
    const query = request.query as Record<string, unknown>;
    let visibility;
    try { visibility = await productCatalogVisibility(store, { userId: request.user.id, isAdmin: request.user.isAdmin, projectId: queryValue(query, "projectId"), environment: queryValue(query, "environment") }); }
    catch (error) { return sendError(reply, error, error instanceof WeKnoraError ? 503 : 403); }
    const rows = store.db.prepare(`SELECT b.*,d.title,d.body,d.lifecycle,d.source_locator,d.source_sha256,d.project_id AS document_project_id,d.updated_at AS document_updated_at,
      p.document_family_id,p.document_type,p.language,p.authority,p.sections_json,p.metadata_json
      FROM knowledge_product_document_bindings b JOIN knowledge_documents d ON d.id=b.document_id
      JOIN knowledge_product_documents p ON p.id=d.id WHERE b.topic_id=? AND EXISTS (SELECT 1 FROM json_each(?) visible WHERE json_extract(visible.value,'$.documentId')=d.id AND (?='relay_local' OR json_extract(visible.value,'$.productVersion') IS b.product_version)) ORDER BY b.product_version`).all(id, JSON.stringify(visibility.documents), visibility.provider) as KnowledgeRow[];
    const bindings = request.user.isAdmin ? rows : rows.filter((row) => canReadTopicBinding(store, request.user.id, row.document_project_id));
    if (!request.user.isAdmin && !bindings.length) return reply.status(403).send({ error: "Knowledge access denied" });
    if(visibility.provider==="weknora") {
      const versions=await Promise.all(bindings.map(async row=>({topic_id:row.topic_id,document_id:row.document_id,product_version:row.product_version,match_method:row.match_method,match_confidence:row.match_confidence,...await getProductBackend(store,{documentId:String(row.document_id),userId:request.user.id,isAdmin:request.user.isAdmin,projectId:row.document_project_id?String(row.document_project_id):undefined,environment:queryValue(request.query as Record<string,unknown>,"environment")})})));
      return reply.send({topic,versions});
    }
    return reply.send({ topic: { ...topic, metadata: safeRows(() => JSON.parse(String(topic.metadata_json ?? "{}")), {}) }, versions: bindings.map(({ document_project_id: _project, ...row }) => ({ ...row, metadata: safeRows(() => JSON.parse(String(row.metadata_json ?? "{}")), {}), sections: safeRows(() => JSON.parse(String(row.sections_json ?? "[]")), []) })) });
  });

  // Stable Product Knowledge API names. Keep /product-docs above as a
  // backwards-compatible alias for existing clients.
  app.get("/api/knowledge/product-documents", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>; const store = getKnowledgeStore();
    if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    if(new MigrationController(store).activeProductProvider()==="weknora") {
      const value=(key:string)=>queryValue(query,key),limit=parseBoundedInt(query.limit,100,1,500),offset=parseBoundedInt(query.offset,0,0,1_000_000);
      return reply.send(await listEngineProductBackend(store,{userId:request.user.id,isAdmin:request.user.isAdmin,projectId:value("projectId"),environment:value("environment"),sampleManagerVersion:value("sampleManagerVersion"),product:value("product"),solution:value("solution"),module:value("module"),documentType:value("documentType"),language:value("language"),authority:value("authority"),limit,offset}));
    }
    const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000); const params: unknown[] = []; const where = ["d.kind='product_document'"];
    const filters: Array<[string, string]> = [["d.project_name_snapshot", "product"], ["d.samplemanager_version", "sampleManagerVersion"], ["d.solution", "solution"], ["d.module", "module"], ["p.document_type", "documentType"], ["p.language", "language"], ["p.authority", "authority"], ["p.document_family_id", "documentFamilyId"]];
    for (const [column, key] of filters) { const value = queryValue(query, key); if (value) { where.push(`${column} = ?`); params.push(value); } }
    const status = queryValue(query, "status"); if (status) { where.push("d.lifecycle = ?"); params.push(status); }
    const requestedProject=queryValue(query,"projectId"),requestedEnvironment=queryValue(query,"environment");
    if(requestedProject){if(!request.user.isAdmin&&!store.canRead(request.user.id,requestedProject))return reply.status(403).send({error:"Knowledge access denied"});where.push("(d.project_id IS NULL OR d.project_id=?)");params.push(requestedProject);}
    if(!request.user.isAdmin){where.push("(d.project_id IS NULL OR EXISTS (SELECT 1 FROM knowledge_acl a WHERE a.project_id=d.project_id AND a.user_id=? AND a.can_read=1))");params.push(request.user.id);}
    where.push("(d.environment IS NULL OR d.environment IS ?)");params.push(requestedEnvironment??null);
    const sortColumn = ({ updatedAt: "d.updated_at", title: "d.title", version: "p.version", sourcePath: "p.source_path" } as Record<string, string>)[queryValue(query, "sort") ?? "updatedAt"] ?? "d.updated_at";
    const order = String(queryValue(query, "order") ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const rows = store.db.prepare(`SELECT d.id,d.title,d.body,d.lifecycle,d.project_id,d.project_name_snapshot,d.samplemanager_version,d.solution,d.module,d.environment,d.source_locator,d.source_commit,d.source_sha256,d.created_at,d.updated_at,p.document_family_id,p.document_type,p.language,p.authority,p.source_path,p.version,p.sections_json,p.metadata_json,p.diff_review_status,p.diff_reviewed_at,(SELECT COUNT(*) FROM knowledge_chunks c WHERE c.document_id=d.id) AS chunk_count FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE ${where.join(" AND ")} ORDER BY ${sortColumn} ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as KnowledgeRow[];
    const total = store.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE ${where.join(" AND ")}`).get(...params) as { count?: number };
    return reply.send({ documents: rows.map((row) => ({ ...safeDocument(row, false, undefined, store.getScopeBinding(String(row.id))), chunkCount: Number(row.chunk_count ?? 0), lastIndexedAt: row.updated_at })), page: { limit, offset, total: Number(total.count ?? 0) } });
  });

  app.get("/api/knowledge/product-documents/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    try {
      const query=request.query as Record<string,unknown>;
      const document=await getProductBackend(getKnowledgeStore(),{documentId:String((request.params as {id:string}).id),userId:request.user.id,isAdmin:request.user.isAdmin,projectId:queryValue(query,"projectId"),environment:queryValue(query,"environment")});
      return reply.send({document,sections:document.sections??[]});
    }catch(error){return sendError(reply,error,error instanceof WeKnoraError?503:404);}
  });

  app.post("/api/knowledge/product-documents/import", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ root: z.string().min(1).optional(), projectId: z.number().int().positive().optional(), path: z.string().min(1).optional(), product: z.string().max(200).optional(), sampleManagerVersion: z.string().max(80).optional(), solution: z.string().max(200).optional(), module: z.string().max(200).optional(), language: z.string().max(20).optional(), authority: z.string().max(80).optional(), documentFamilyId: z.string().max(200).optional(), manifestPath: z.string().min(1).optional() }).refine((value) => Boolean(value.root || (value.projectId && value.path)), "root or projectId/path is required").safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid product document import", details: body.error.issues });
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    try {
      const root = body.data.root ?? (() => { const project = db.select().from(projects).where(and(eq(projects.id, body.data.projectId!), eq(projects.userId, request.user.id))).get(); if (!project) throw new Error("Project not found"); return resolveWorkspacePath(project.workspacePath, body.data.path!, { mustExist: true }); })();
      if (!existsSync(root)) return reply.status(403).send({ error: "An existing source directory or ZIP is required" });
      const store = getKnowledgeStore(); const key = idempotencyKey(request);
      const report = replayOrRun(store, request.user.id, "product-documents:import", key, () => enqueueProductImport(store, { ...body.data, root, sampleManagerVersion: body.data.sampleManagerVersion ?? "", idempotencyKey: key }), body.data);
      store.audit({ actorId: request.user.id, action: "knowledge.product_documents.import", entityType: "product_document_batch", entityId: report.id, details: { ...report } });
      return reply.status(202).send(report);
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/product-documents/imports", { onRequest: [app.authenticate] }, async (request, reply) => {
    const store = getKnowledgeStore(); if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" }); const query = request.query as Record<string, unknown>; const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    const rows = store.db.prepare("SELECT id,source_locator,status,imported,skipped,failed,started_at,finished_at,error,operation_idempotency_key,batch_metadata_json,source_root,source_commit,source_sha256 FROM knowledge_ingest_runs ORDER BY started_at DESC LIMIT ? OFFSET ?").all(limit, offset);
    const total = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_ingest_runs").get() as { count?: number };
    return reply.send({ runs: rows, page: { limit, offset, total: Number(total.count ?? 0) } });
  });

  app.get("/api/knowledge/product-documents/imports/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore(); if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const run = store.db.prepare("SELECT id,source_locator,status,imported,skipped,failed,started_at,finished_at,error,operation_idempotency_key,batch_metadata_json,source_root,source_commit,source_sha256 FROM knowledge_ingest_runs WHERE id=?").get(id) as KnowledgeRow | undefined;
    if (!run) return reply.status(404).send({ error: "Ingest run not found" });
    const items = safeRows(() => store.db.prepare("SELECT id,relative_path,document_id,status,source_sha256,metadata_json,warning,error,created_at,updated_at FROM knowledge_product_document_items WHERE run_id=? ORDER BY relative_path").all(id), []);
    return reply.send({ run, items });
  });
  app.get("/api/knowledge/ingest-jobs/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore(); const row = store.db.prepare("SELECT id,kind,status,attempts,available_at,started_at,finished_at,result_json,error,created_at,updated_at FROM knowledge_ingest_jobs WHERE id=?").get(id) as KnowledgeRow | undefined;
    if (!row) return reply.status(404).send({ error: "Ingest job not found" });
    if (row.kind === "product_migration" && !request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    return reply.send({ job: { ...row, result: row.result_json ? safeRows(() => JSON.parse(String(row.result_json)), undefined) : undefined } });
  });

  app.post("/api/knowledge/product-documents/imports/:id/retry", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore();
    const run = store.db.prepare("SELECT source_root,batch_metadata_json FROM knowledge_ingest_runs WHERE id=?").get(id) as KnowledgeRow | undefined;
    if (!run?.source_root) return reply.status(404).send({ error: "Retry source is unavailable" });
    try {
      const metadata = safeRows(() => JSON.parse(String(run.batch_metadata_json ?? "{}")), {}) as Record<string, unknown>;
      const key = idempotencyKey(request) ?? `retry:${id}`;
      const report = replayOrRun(store, request.user.id, "product-documents:retry", key, () => enqueueProductImport(store, { root: String(run.source_root), sampleManagerVersion: String(metadata.sampleManagerVersion ?? ""), product: metadata.product ? String(metadata.product) : undefined, solution: metadata.solution ? String(metadata.solution) : undefined, module: metadata.module ? String(metadata.module) : undefined, language: metadata.language ? String(metadata.language) : undefined, authority: metadata.authority ? String(metadata.authority) : undefined, documentFamilyId: metadata.documentFamilyId ? String(metadata.documentFamilyId) : undefined, manifestPath: metadata.manifestPath ? String(metadata.manifestPath) : undefined, idempotencyKey: key }), { id });
      store.audit({ actorId: request.user.id, action: "knowledge.product_documents.retry", entityType: "product_document_batch", entityId: id, details: { retryRunId: report.id } });
      return reply.status(202).send(report);
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/product-documents/versions", { onRequest: [app.authenticate] }, async (_request, reply) => {
    const store = getKnowledgeStore(); if (!_request.user.isAdmin && !knowledgeReadAllowed(store, _request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const query = _request.query as Record<string, unknown>; const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    let visibility;
    try { visibility = await productCatalogVisibility(store, { userId: _request.user.id, isAdmin: _request.user.isAdmin, projectId: queryValue(query, "projectId"), environment: queryValue(query, "environment") }); }
    catch (error) { return sendError(reply, error, error instanceof WeKnoraError ? 503 : 403); }
    const where = "EXISTS (SELECT 1 FROM json_each(?) visible WHERE json_extract(visible.value,'$.documentId')=p.id AND (?='relay_local' OR json_extract(visible.value,'$.productVersion') IS p.version))";
    const params = [JSON.stringify(visibility.documents), visibility.provider];
    const rows = store.db.prepare(`SELECT document_family_id,version,COUNT(*) AS documents,MAX(updated_at) AS updated_at FROM knowledge_product_documents p WHERE ${where} GROUP BY document_family_id,version ORDER BY document_family_id,version LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = store.db.prepare(`SELECT COUNT(*) AS count FROM (SELECT document_family_id,version FROM knowledge_product_documents p WHERE ${where} GROUP BY document_family_id,version)`).get(...params) as { count?: number };
    return reply.send({ versions: rows, page: { limit, offset, total: Number(total.count ?? 0) } });
  });

  app.get("/api/knowledge/product-documents/diffs", { onRequest: [app.authenticate] }, async (request, reply) => {
    const store = getKnowledgeStore(); if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" }); const query = request.query as Record<string, unknown>; const left = queryValue(query, "left"); const right = queryValue(query, "right");
    if (left && right) {
      const exists = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_product_documents WHERE id IN (?,?)").get(left, right) as { count?: number };
      if (Number(exists.count) !== 2) return reply.status(404).send({ error: "Product document not found" });
      try {return reply.send({diff:await diffProductBackend(store,{leftId:left,rightId:right,userId:request.user.id,isAdmin:request.user.isAdmin,projectId:queryValue(query,"projectId"),environment:queryValue(query,"environment")})});}catch(error){return sendError(reply,error,error instanceof WeKnoraError?503:404);}
    }
    const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    const rows = store.db.prepare("SELECT id,document_id,against_document_id,report_json,review_status,reviewed_by,reviewed_at,created_at,updated_at FROM knowledge_product_document_revisions ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(limit, offset).flatMap((row: any) => {
      const allowed=(id:string)=>{const doc=store.db.prepare("SELECT project_id,environment FROM knowledge_documents WHERE id=?").get(id) as {project_id?:string;environment?:string}|undefined;return doc&&(!doc.project_id||request.user.isAdmin||store.canRead(request.user.id,doc.project_id))&&(!doc.environment||doc.environment===queryValue(query,"environment"));};
      if(!allowed(row.document_id)||!allowed(row.against_document_id))return [];
      const {report_json,...metadata}=row;
      return [{...metadata,...(new MigrationController(store).activeProductProvider()==="relay_local"?{report:safeRows(()=>JSON.parse(String(report_json)),undefined)}:{requiresRefresh:true})}];
    });
    const total = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_product_document_revisions").get() as { count?: number };
    return reply.send({ diffs: rows, page: { limit, offset, total: Number(total.count ?? 0) } });
  });

  app.get("/api/knowledge/product-documents/search", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>; const store = getKnowledgeStore(); const value = (key: string) => queryValue(query, key);
    if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const limit = parseBoundedInt(query.limit, 50, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    const allResults = await searchProductBackend(store, {userId:request.user.id,isAdmin:request.user.isAdmin,projectId:value("projectId"),environment:value("environment"), query: value("q") ?? value("query"), sampleManagerVersion: value("sampleManagerVersion"), product: value("product"), solution: value("solution"), module: value("module"), documentType: value("documentType"), language: value("language"), authority: value("authority"), limit: 500, includeDeprecated: value("includeDeprecated") === "true" });
    return reply.send({ query: value("q") ?? value("query") ?? "", results: allResults.slice(offset, offset + limit), page: { limit, offset, total: allResults.length } });
  });

  // Operations plane: these endpoints deliberately return summaries and
  // provenance, never raw credentials or complete event payloads.
  app.get("/api/knowledge/operations/capture", { onRequest: [app.authenticate] }, async (request, reply) => {
    try {
      const query = request.query as Record<string, unknown>; const store = getKnowledgeStore(); const projectId = query.projectId ? resolveProject(request.user.id, query.projectId).projectId : undefined;
      const health = knowledgeHealth(store); const backlog = safeRows(() => store.consumerBacklog("knowledge-capture"), { count: 0 }); const deadLetters = readDeadLetters(store, 100); const stateRoot = store.evidenceRoot ? store.evidenceRoot.replace(/[\\/]evidence[\\/]?$/, "") : ".relay-mcp"; const deadLetterPaths = [`${stateRoot}/knowledge-event-spool.jsonl.dead-letter`, `${stateRoot}/knowledge-capture-dead-letter.jsonl`];
      const heartbeat = health.captureWorker;
      const status = health.database.status !== "available" ? "Unavailable" : health.spool.degraded || heartbeat.status !== "running" ? "Degraded" : "Available";
      return reply.send({ status, projectId, checkedAt: new Date().toISOString(), capture: { lastSuccessAt: heartbeat.lastSeenAt, lastError: health.spool.lastError ?? health.spool.lastDeadLetterError, lastErrorAt: health.spool.lastDrainErrorAt, consecutiveFailures: Number(health.spool.failedWrites ?? 0) + Number(health.spool.drainFailures ?? 0) }, backlog, spool: { ...health.spool, deadLetterPaths }, deadLetterCount: deadLetters.length, deadLetters: deadLetters.slice(-50), diagnostics: [heartbeat.status !== "running" ? "remote-ops-mcp heartbeat is stale or not seen" : undefined, projectId ? undefined : "Project filter not selected; showing shared capture state"].filter(Boolean) });
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/operations/capture/events", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>; const store = getKnowledgeStore(); const projectId = query.projectId ? resolveProject(request.user.id, query.projectId).projectId : undefined; const limit = parseBoundedInt(query.limit, 100, 1, 500); const params: unknown[] = [];
    const where = ["1=1"]; if (projectId) { where.push("project_id=?"); params.push(projectId); } else if (!request.user.isAdmin) {
      const owned = db.select({ id: projects.id }).from(projects).where(eq(projects.userId, request.user.id)).all().map((row) => String(row.id));
      if (!owned.length) return reply.send({ events: [], page: { limit, offset: 0, total: 0 } });
      where.push(`project_id IN (${owned.map(() => "?").join(",")})`); params.push(...owned);
    }
    const offset = parseBoundedInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const total = Number((store.db.prepare(`SELECT COUNT(*) AS count FROM relay_domain_events WHERE ${where.join(" AND ")}`).get(...params) as { count: number }).count);
    const rows = store.db.prepare(`SELECT id,type,occurred_at,project_id,project_name_snapshot,job_id,deployment_id,event_key,payload_json FROM relay_domain_events WHERE ${where.join(" AND ")} ORDER BY occurred_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as KnowledgeRow[];
    return reply.send({ page: { limit, offset, total }, events: rows.map((row) => ({ id: row.id, type: row.type, occurredAt: row.occurred_at, projectId: row.project_id, projectName: row.project_name_snapshot, jobId: row.job_id, deploymentId: row.deployment_id, eventKey: row.event_key, payloadKeys: safeRows(() => Object.keys(JSON.parse(String(row.payload_json ?? "{}"))), []) })) });
  });

  app.get("/api/knowledge/operations/capture/queue", { onRequest: [app.authenticate] }, async (request, reply) => {
    const store = getKnowledgeStore(); const query = request.query as Record<string, unknown>; const limit = parseBoundedInt(query.limit, 20, 1, 100);
    const rows = store.db.prepare("SELECT c.event_id, c.attempts, c.available_at, c.claimed_until, c.last_error, e.type, e.occurred_at, e.project_id, e.job_id, e.deployment_id FROM knowledge_outbox_claims c JOIN relay_domain_events e ON e.id = c.event_id WHERE c.consumer_name = ? AND c.consumed_at IS NULL ORDER BY c.available_at ASC LIMIT ?").all("knowledge-capture", limit) as KnowledgeRow[];
    const backlog = store.consumerBacklog("knowledge-capture");
    return reply.send({ consumer: "knowledge-capture", pending: backlog.count, oldestAvailableAt: backlog.oldestAvailableAt, entries: rows.map((row) => ({ eventId: row.event_id, type: row.type, occurredAt: row.occurred_at, projectId: row.project_id, jobId: row.job_id, deploymentId: row.deployment_id, attempts: row.attempts, availableAt: row.available_at, claimedUntil: row.claimed_until, lastError: row.last_error })) });
  });

  app.post("/api/knowledge/operations/capture/replay", { onRequest: [app.authenticate] }, async (request, reply) => {
    const store = getKnowledgeStore();
    if (!request.user.isAdmin && !knowledgeReviewAllowed(store, request.user.id)) return reply.status(403).send({ error: "Reviewer access required" });
    const body = z.object({
      eventIds: z.array(z.string().min(1)).max(5000).optional(),
      projectId: z.number().int().positive().optional(),
      type: z.string().min(1).max(100).optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
      dryRun: z.boolean().optional(),
    }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid capture replay request", details: body.error.issues });
    const projectId = body.data.projectId ? String(resolveProject(request.user.id, body.data.projectId).projectId) : undefined;
    if (!body.data.eventIds?.length && !projectId && !body.data.type && !body.data.from && !body.data.to) return reply.status(400).send({ error: "At least one replay filter is required" });
    const result = replayOrRun(store, request.user.id, "operations:capture-replay", idempotencyKey(request), () => store.replayCaptureEvents({ ...body.data, projectId }), body.data);
    store.audit({ actorId: request.user.id, projectId, action: "knowledge.operations.capture_replay", entityType: "capture", entityId: `replay:${Date.now()}`, details: { ...result, dryRun: Boolean(body.data.dryRun) } });
    return reply.send({ ok: true, ...result, dryRun: Boolean(body.data.dryRun), queuedFor: "knowledge-capture", note: body.data.dryRun ? "No events were changed." : "Events are queued for the Capture Worker." });
  });

  app.get("/api/knowledge/operations/capture/dead-letter", { onRequest: [app.authenticate] }, async (request, reply) => {
    const store = getKnowledgeStore();
    if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const query = request.query as Record<string, unknown>;
    const limit = parseBoundedInt(query.limit, 10, 1, 100);
    const offset = parseBoundedInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const stateRoot = store.evidenceRoot ? store.evidenceRoot.replace(/[\\/]evidence[\\/]?$/, "") : ".relay-mcp";
    const owned = request.user.isAdmin ? undefined : db.select({ id: projects.id }).from(projects).where(eq(projects.userId, request.user.id)).all().map((row) => String(row.id));
    return reply.send(await readDeadLetterPage([`${stateRoot}/knowledge-event-spool.jsonl.dead-letter`, `${stateRoot}/knowledge-capture-dead-letter.jsonl`], limit, offset, owned));
  });

  app.post("/api/knowledge/operations/capture/smoke-test", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin && !knowledgeReviewAllowed(getKnowledgeStore(), request.user.id)) return reply.status(403).send({ error: "Reviewer access required" });
    const body = z.object({ projectId: z.number().int().positive().optional(), eventId: z.string().min(1).optional() }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid smoke-test request" });
    const store = getKnowledgeStore(); const projectId = body.data.projectId ? resolveProject(request.user.id, body.data.projectId).projectId : undefined;
    const result = replayOrRun(store, request.user.id, "operations:capture-smoke-test", idempotencyKey(request), () => {
      const event = body.data.eventId ? store.db.prepare("SELECT id,type,project_id,project_name_snapshot,job_id,deployment_id,event_key,occurred_at,payload_json FROM relay_domain_events WHERE id=?").get(body.data.eventId) : store.db.prepare("SELECT id,type,project_id,project_name_snapshot,job_id,deployment_id,event_key,occurred_at,payload_json FROM relay_domain_events ORDER BY occurred_at DESC LIMIT 1").get();
      const payload = event ? safeRows(() => JSON.parse(String((event as KnowledgeRow).payload_json ?? "{}")), {}) as Record<string, unknown> : {};
      const classified = event ? classifyRelayEvent({ id: String((event as KnowledgeRow).id), type: String((event as KnowledgeRow).type) as any, projectId: (event as KnowledgeRow).project_id ? String((event as KnowledgeRow).project_id) : undefined, projectNameSnapshot: (event as KnowledgeRow).project_name_snapshot ? String((event as KnowledgeRow).project_name_snapshot) : undefined, jobId: (event as KnowledgeRow).job_id ? String((event as KnowledgeRow).job_id) : undefined, deploymentId: (event as KnowledgeRow).deployment_id ? String((event as KnowledgeRow).deployment_id) : undefined, occurredAt: String((event as KnowledgeRow).occurred_at), eventKey: String((event as KnowledgeRow).event_key), payload }) : undefined;
      const eventProjectId = projectId ?? (event as KnowledgeRow | undefined)?.project_id;
      const candidateCount = eventProjectId ? Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents WHERE kind='candidate' AND project_id=?").get(eventProjectId) as { count?: number }).count ?? 0) : 0;
      const evidenceCount = eventProjectId ? Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_evidence WHERE project_id=? AND deleted_at IS NULL").get(eventProjectId) as { count?: number }).count ?? 0) : 0;
      const candidateForEvent = eventProjectId && event ? Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_candidates WHERE project_id=? AND (event_id=? OR job_id=? OR deployment_id=?)").get(eventProjectId, (event as KnowledgeRow).id, (event as KnowledgeRow).job_id ?? null, (event as KnowledgeRow).deployment_id ?? null) as { count?: number }).count ?? 0) : 0;
      const evidenceForEvent = eventProjectId && event ? Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_evidence WHERE project_id=? AND deleted_at IS NULL AND (source_locator LIKE ? OR source_locator LIKE ? OR source_locator LIKE ?)").get(eventProjectId, `%${String((event as KnowledgeRow).id)}%`, `%${String((event as KnowledgeRow).job_id ?? "__no_job__")}%`, `%${String((event as KnowledgeRow).deployment_id ?? "__no_deployment__")}%`) as { count?: number }).count ?? 0) : 0;
      const eventSummary = event ? { id: (event as KnowledgeRow).id, type: (event as KnowledgeRow).type, occurredAt: (event as KnowledgeRow).occurred_at, projectId: (event as KnowledgeRow).project_id, jobId: (event as KnowledgeRow).job_id, deploymentId: (event as KnowledgeRow).deployment_id } : undefined;
      return { ok: Boolean(event) && (!classified?.captureCandidate || candidateForEvent > 0), readOnly: true, event: eventSummary, classification: classified, checks: { knowledgeDb: true, eventStore: Boolean(event), candidateProjection: candidateCount, evidenceProjection: evidenceCount, candidateForEvent, evidenceForEvent, pipelineComplete: Boolean(event) && (!classified?.captureCandidate || candidateForEvent > 0), spool: relayEventSpoolHealth() } };
    }, body.data);
    store.audit({ actorId: request.user.id, projectId, action: "knowledge.operations.capture_smoke_test", entityType: "capture", entityId: String((result as any).event?.id ?? "none"), details: { readOnly: true } });
    return reply.send(result);
  });

  app.get("/api/knowledge/operations/ingest-runs", { onRequest: [app.authenticate] }, async (request, reply) => {
    const store = getKnowledgeStore(); if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" }); const query = request.query as Record<string, unknown>; const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    const runs = store.db.prepare("SELECT id,source_locator,status,imported,skipped,failed,started_at,finished_at,error,operation_idempotency_key,batch_metadata_json,source_root,source_commit,source_sha256 FROM knowledge_ingest_runs ORDER BY started_at DESC LIMIT ? OFFSET ?").all(limit, offset); const total = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_ingest_runs").get() as { count?: number }; return reply.send({ runs, page: { limit, offset, total: Number(total.count ?? 0) } });
  });

  app.get("/api/knowledge/operations/ingest-runs/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore(); if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" }); const run = store.db.prepare("SELECT * FROM knowledge_ingest_runs WHERE id=?").get(id) as KnowledgeRow | undefined; if (!run) return reply.status(404).send({ error: "Ingest run not found" });
    return reply.send({ run, items: safeRows(() => store.db.prepare("SELECT * FROM knowledge_product_document_items WHERE run_id=? ORDER BY relative_path").all(id), []), diffs: safeRows(() => store.db.prepare("SELECT * FROM knowledge_product_document_revisions WHERE document_id IN (SELECT document_id FROM knowledge_product_document_items WHERE run_id=?) OR against_document_id IN (SELECT document_id FROM knowledge_product_document_items WHERE run_id=?)").all(id, id), []) });
  });

  app.post("/api/knowledge/operations/ingest-runs/:id/retry", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore(); const run = store.db.prepare("SELECT source_root,batch_metadata_json FROM knowledge_ingest_runs WHERE id=?").get(id) as KnowledgeRow | undefined; if (!run?.source_root) return reply.status(404).send({ error: "Retry source is unavailable" });
    const metadata = safeRows(() => JSON.parse(String(run.batch_metadata_json ?? "{}")), {}) as Record<string, unknown>; const key = idempotencyKey(request) ?? `retry:${id}`;
    const report = replayOrRun(store, request.user.id, "operations:ingest-retry", key, () => enqueueProductImport(store, { root: String(run.source_root), sampleManagerVersion: String(metadata.sampleManagerVersion ?? ""), product: metadata.product ? String(metadata.product) : undefined, solution: metadata.solution ? String(metadata.solution) : undefined, module: metadata.module ? String(metadata.module) : undefined, language: metadata.language ? String(metadata.language) : undefined, authority: metadata.authority ? String(metadata.authority) : undefined, documentFamilyId: metadata.documentFamilyId ? String(metadata.documentFamilyId) : undefined, manifestPath: metadata.manifestPath ? String(metadata.manifestPath) : undefined, idempotencyKey: key }), { id });
    store.audit({ actorId: request.user.id, action: "knowledge.operations.ingest_retry", entityType: "ingest_run", entityId: id, details: { retryRunId: report.id } }); return reply.status(202).send(report);
  });

  app.get("/api/knowledge/operations/index", { onRequest: [app.authenticate] }, async (_request, reply) => {
    const store = getKnowledgeStore(); const health = knowledgeHealth(store); const coverage = safeRows(() => store.db.prepare("SELECT (SELECT COUNT(*) FROM knowledge_documents) AS documents,(SELECT COUNT(DISTINCT document_id) FROM knowledge_fts) AS indexedDocuments,(SELECT COUNT(*) FROM knowledge_facts) AS facts,(SELECT COUNT(DISTINCT fact_id) FROM knowledge_facts_fts) AS indexedFacts").get() as Record<string, unknown>, { documents: 0, indexedDocuments: 0, facts: 0, indexedFacts: 0 }) as Record<string, unknown>;
    return reply.send({ index: { ...coverage, stale: Number((coverage as any).documents) !== Number((coverage as any).indexedDocuments) || Number((coverage as any).facts) !== Number((coverage as any).indexedFacts), lastRebuild: safeRows(() => store.db.prepare("SELECT occurred_at,details_json FROM knowledge_audit WHERE action IN ('knowledge.reindex','knowledge.operations.index_rebuild') ORDER BY occurred_at DESC LIMIT 1").get(), undefined) }, providers: knowledgeProviderSummary(store), health });
  });

  app.get("/api/knowledge/operations/providers", { onRequest: [app.authenticate] }, async (_request, reply) => reply.send({ providers: knowledgeProviderSummary(getKnowledgeStore()) }));

  app.post("/api/knowledge/operations/providers/test", { onRequest: [app.authenticate] }, async (request, reply) => {
    const store = getKnowledgeStore(); if (!request.user.isAdmin && !knowledgeReviewAllowed(store, request.user.id)) return reply.status(403).send({ error: "Reviewer access required" });
    const body = z.object({ provider: z.string().trim().min(1).max(100).optional() }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid provider test request" });
    const result = replayOrRun(store, request.user.id, "operations:provider-test", idempotencyKey(request), () => {
      const providers = knowledgeProviderSummary(store); const selected = body.data.provider ? providers.filter((item) => String(item.name).toLowerCase() === body.data.provider!.toLowerCase()) : providers;
      if (body.data.provider && selected.length === 0) throw new Error(`Provider '${body.data.provider}' is not registered`);
      return { ok: true, readOnly: true, testedAt: new Date().toISOString(), providers: selected.map((item) => ({ ...item, probe: item.status === "ready" ? "available" : item.status === "disabled" ? "not_configured" : "degraded" })) };
    }, body.data);
    store.audit({ actorId: request.user.id, action: "knowledge.operations.provider_test", entityType: "provider", entityId: body.data.provider ?? "all", details: result });
    return reply.send(result);
  });

  app.post("/api/knowledge/operations/index/rebuild", { onRequest: [app.authenticate] }, async (request, reply) => {
    const store = getKnowledgeStore(); if (!request.user.isAdmin && !knowledgeReviewAllowed(store, request.user.id)) return reply.status(403).send({ error: "Reviewer access required" });
    const body = z.object({ projectId: z.number().int().positive().optional() }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid rebuild request" });
    const projectId = body.data.projectId ? resolveProject(request.user.id, body.data.projectId).projectId : undefined;
    const result = replayOrRun(store, request.user.id, "operations:index-rebuild", idempotencyKey(request), () => ({ ok: true, ...(rebuildKnowledgeIndexes(store, projectId)), projectId, completedAt: new Date().toISOString() }), body.data);
    store.audit({ actorId: request.user.id, projectId, action: "knowledge.operations.index_rebuild", entityType: "index", entityId: projectId ? `project:${projectId}` : "global", details: result }); return reply.send(result);
  });

  app.post("/api/knowledge/operations/index/invalidate-embeddings", { onRequest: [app.authenticate] }, async (request, reply) => {
    const store = getKnowledgeStore(); if (!request.user.isAdmin && !knowledgeReviewAllowed(store, request.user.id)) return reply.status(403).send({ error: "Reviewer access required" });
    const body = z.object({ projectId: z.number().int().positive().optional() }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid embedding invalidation request" });
    const projectId = body.data.projectId ? resolveProject(request.user.id, body.data.projectId).projectId : undefined;
    const result = replayOrRun(store, request.user.id, "operations:index-invalidate-embeddings", idempotencyKey(request), () => { const deleted = projectId ? store.db.prepare("DELETE FROM knowledge_embeddings WHERE document_id IN (SELECT id FROM knowledge_documents WHERE project_id=?)").run(projectId).changes : store.db.prepare("DELETE FROM knowledge_embeddings").run().changes; return { ok: true, deleted, projectId, completedAt: new Date().toISOString() }; }, body.data);
    store.audit({ actorId: request.user.id, projectId, action: "knowledge.operations.index_invalidate_embeddings", entityType: "index", entityId: projectId ? `project:${projectId}` : "global", details: result }); return reply.send(result);
  });

  // Integrated Knowledge control-plane endpoints (#44-#56). These are
  // additive and deliberately return safe metadata only.
  app.post("/api/knowledge/sessions", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ idempotencyKey: z.string().trim().min(1).max(300), intent: z.unknown(), summary: z.string().max(8_000).optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid Work Session request", details: body.error.issues });
    try { const store = getKnowledgeStore(); const intent = validateIntentEnvelope({ ...(body.data.intent as Record<string, unknown>), actorId: request.user.id }); const session = new WorkSessionService(store).open({ actorId: request.user.id, idempotencyKey: body.data.idempotencyKey, intent, summary: body.data.summary }); return reply.status(201).send({ session }); } catch (error) { return sendError(reply, error, 403); }
  });
  app.get("/api/knowledge/sessions", { onRequest: [app.authenticate] }, async (request, reply) => {
    const limit = parseBoundedInt((request.query as Record<string, unknown>).limit, 50, 1, 200); const sessions = new WorkSessionService(getKnowledgeStore()).list({ actorId: request.user.id, limit }); return reply.send({ sessions });
  });
  app.get("/api/knowledge/sessions/:id", { onRequest: [app.authenticate] }, async (request, reply) => { try { const session = new WorkSessionService(getKnowledgeStore()).get({ actorId: request.user.id, sessionId: String((request.params as { id: string }).id) }); return reply.send({ session }); } catch (error) { return sendError(reply, error, 404); } });
  app.patch("/api/knowledge/sessions/:id", { onRequest: [app.authenticate] }, async (request, reply) => { const body = z.object({ idempotencyKey: z.string().trim().max(300).optional(), patch: z.record(z.unknown()) }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid Work Session update", details: body.error.issues }); try { const session = new WorkSessionService(getKnowledgeStore()).update({ actorId: request.user.id, sessionId: String((request.params as { id: string }).id), idempotencyKey: body.data.idempotencyKey, patch: body.data.patch as never }); return reply.send({ session }); } catch (error) { return sendError(reply, error, 403); } });
  app.post("/api/knowledge/sessions/:id/close", { onRequest: [app.authenticate] }, async (request, reply) => { const body = z.object({ idempotencyKey: z.string().trim().max(300).optional(), result: z.object({ summary: z.string().max(8_000).optional(), unknowns: z.array(z.string().max(2_000)).max(100).optional(), acceptanceResults: z.record(z.union([z.boolean(), z.string().max(500)])).optional() }).optional() }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid Work Session close", details: body.error.issues }); try { const session = new WorkSessionService(getKnowledgeStore()).close({ actorId: request.user.id, sessionId: String((request.params as { id: string }).id), idempotencyKey: body.data.idempotencyKey, result: body.data.result }); return reply.send({ session }); } catch (error) { return sendError(reply, error, 403); } });
  app.get("/api/knowledge/sessions/:id/events", { onRequest: [app.authenticate] }, async (request, reply) => { try { const events = new WorkSessionService(getKnowledgeStore()).listEvents({ actorId: request.user.id, sessionId: String((request.params as { id: string }).id) }); return reply.send({ events }); } catch (error) { return sendError(reply, error, 404); } });

  app.get("/api/knowledge/providers/managed", { onRequest: [app.authenticate] }, async (_request, reply) => reply.send({ providers: managedProviderRegistry().list() }));
  const providerTokenSchema = z.string().trim().min(1).max(8192).refine((value) => !/[\r\n\0]/.test(value));
  const providerConnectionSchema = z.object({ baseUrl: z.string().trim().min(1).max(2048), token: providerTokenSchema });
  const providerSetupError = (reply: FastifyReply, error: unknown) => {
    reply.header("Cache-Control", "no-store");
    if (error instanceof ManagedProviderError) {
      // Generate our own correlation ID; never trust a caller-supplied ID or log
      // the request/error object, which could contain provider credentials.
      const requestId = randomUUID();
      reply.request.log.warn({ event: "provider_setup_failed", requestId, code: error.code, diagnostics: error.diagnostics }, "Managed provider setup failed");
      return reply.status(502).send({ error: `${error.message}; Relay request ID: ${requestId}`, code: error.code, requestId, diagnostics: error.diagnostics });
    }
    return reply.status(400).send({ error: "Unable to configure provider. Check the Base URL, token, selected model and server credential key." });
  };
  app.post("/api/knowledge/providers/managed/models", { onRequest: [app.authenticate], bodyLimit: 16384 }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const body = providerConnectionSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Base URL and token are required" });
    reply.header("Cache-Control", "no-store");
    try { return reply.send(await new ProviderSetupService(getKnowledgeStore()).models(body.data)); }
    catch (error) { return providerSetupError(reply, error); }
  });
  app.post("/api/knowledge/providers/managed/:id/configure", { onRequest: [app.authenticate], bodyLimit: 16384 }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const body = providerConnectionSchema.extend({
      kind: z.enum(["embedding", "rerank", "wiki_llm", "candidate_llm"]),
      provider: z.string().trim().min(1).max(100), modelId: z.string().min(1).max(200),
    }).safeParse(request.body);
    const id = z.string().trim().min(1).max(200).safeParse((request.params as { id: string }).id);
    if (!body.success || !id.success) return reply.status(400).send({ error: "Invalid provider configuration" });
    reply.header("Cache-Control", "no-store");
    try { return reply.send(await new ProviderSetupService(getKnowledgeStore()).configure({ ...body.data, id: id.data, actorId: request.user.id })); }
    catch (error) { return providerSetupError(reply, error); }
  });
  app.post("/api/knowledge/providers/managed/:id/token", { onRequest: [app.authenticate], bodyLimit: 16384 }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const body = z.object({ token: providerTokenSchema.nullable() }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Enter a replacement token, or null to clear it" });
    reply.header("Cache-Control", "no-store");
    try { return reply.send(await new ProviderSetupService(getKnowledgeStore()).updateToken(String((request.params as { id: string }).id), body.data.token, request.user.id)); }
    catch (error) { return providerSetupError(reply, error); }
  });
  app.get("/api/knowledge/providers/managed/reindex", { onRequest: [app.authenticate] }, async (_request, reply) => reply.send({ jobs: managedProviderRegistry().pendingReindex() }));
  app.put("/api/knowledge/providers/managed/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const body = z.object({ kind: z.enum(["embedding", "rerank", "wiki_llm", "candidate_llm"]), provider: z.string().min(1).max(100), baseUrl: z.string().url().optional(), modelId: z.string().min(1).max(200), dimensions: z.number().int().positive().optional(), batchSize: z.number().int().positive().optional(), timeoutMs: z.number().int().min(100).max(120000).optional(), concurrency: z.number().int().min(1).max(100).optional(), maxRetries: z.number().int().min(0).max(10).optional(), dataResidency: z.string().max(100).optional(), secretRef: z.string().max(500).optional(), quota: z.object({ maxCalls: z.number().int().min(1).max(1_000_000), windowMs: z.number().int().min(1_000).max(86_400_000) }).optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid provider configuration", details: body.error.issues });
    try { const provider = managedProviderRegistry().upsert({ ...body.data, id: String((request.params as { id: string }).id), actorId: request.user.id }); return reply.send({ provider }); } catch (error) { return sendError(reply, error, 400); }
  });
  app.post("/api/knowledge/providers/managed/:id/test", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    try { return reply.send({ report: await managedProviderRegistry().probe(String((request.params as { id: string }).id), request.user.id) }); } catch (error) { return sendError(reply, error, 404); }
  });
  app.post("/api/knowledge/providers/managed/:id/rotate", { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); const body = z.object({ secretRef: z.string().min(1).max(500) }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid provider secret reference" }); try { return reply.send({ provider: managedProviderRegistry().rotateSecret(String((request.params as { id: string }).id), body.data.secretRef, request.user.id) }); } catch (error) { return sendError(reply, error, 400); } });
  app.post("/api/knowledge/providers/managed/:id/disable", { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); try { return reply.send({ provider: managedProviderRegistry().disable(String((request.params as { id: string }).id), request.user.id) }); } catch (error) { return sendError(reply, error, 404); } });
  app.post("/api/knowledge/providers/managed/reindex/:jobId/complete", { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); try { return reply.send({ job: completeVerifiedEngineReindex(getKnowledgeStore(), String((request.params as { jobId: string }).jobId), request.user.id) }); } catch (error) { return sendError(reply, error, 404); } });

  app.get("/api/knowledge/candidate-insights", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const body = z.object({ projectId: z.string().min(1), status: z.enum(["draft", "accepted", "edited", "rejected"]).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() }).safeParse(query);
    if (!body.success) return reply.status(400).send({ error: "projectId is required" });
    try { return reply.send({ insights: new CandidateInsightReviewService(getKnowledgeStore()).list({ actorId: request.user.id, ...body.data }) }); } catch (error) { return sendError(reply, error, 403); }
  });
  app.post("/api/knowledge/candidate-insights/compile", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ sessionId: z.string().min(1), evidenceRefs: z.array(z.string().min(1)).max(100), context: z.record(z.unknown()).default({}), providerId: z.string().optional(), async: z.boolean().optional(), retry: z.boolean().optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid Candidate Insight compile request", details: body.error.issues });
    const store = getKnowledgeStore();
    try {
      if (body.data.async) return reply.status(202).send(enqueueCandidateInsight(store, { actorId: request.user.id, sessionId: body.data.sessionId, evidenceRefs: body.data.evidenceRefs, context: body.data.context, providerId:body.data.providerId,retry:body.data.retry }));
      const provider = createCandidateInsightProvider(store,body.data.providerId);
      const insight = await new CandidateInsightCompiler(store, provider).compile({ actorId: request.user.id, sessionId: body.data.sessionId, evidenceRefs: body.data.evidenceRefs, context: body.data.context });
      return reply.status(insight.persisted ? 201 : 200).send({ insight });
    } catch (error) { return sendError(reply, error, 400); }
  });
  app.get("/api/knowledge/candidate-insight-jobs/:id", { onRequest: [app.authenticate] }, async (request, reply) => { try { return reply.send({job:getCandidateInsightJob(getKnowledgeStore(),{actorId:request.user.id,id:String((request.params as {id:string}).id)})}); } catch(error) {return sendError(reply,error,404);} });
  app.get("/api/knowledge/candidate-insights/:id", { onRequest: [app.authenticate] }, async (request, reply) => { try { return reply.send({ insight: new CandidateInsightReviewService(getKnowledgeStore()).get({ actorId: request.user.id, id: String((request.params as { id: string }).id) }) }); } catch (error) { return sendError(reply, error, 404); } });
  app.get("/api/knowledge/candidate-insights/:id/history", { onRequest: [app.authenticate] }, async (request, reply) => { try { return reply.send({ history: new CandidateInsightReviewService(getKnowledgeStore()).reviewHistory({ actorId: request.user.id, id: String((request.params as { id: string }).id) }) }); } catch (error) { return sendError(reply, error, 404); } });
  for (const action of ["confirm", "reject"] as const) {
    app.post(`/api/knowledge/candidate-insights/:id/${action}`, { onRequest: [app.authenticate] }, async (request, reply) => {
      const body = z.object({ reason: z.string().trim().min(1).max(2_000) }).safeParse(request.body ?? {});
      if (!body.success) return reply.status(400).send({ error: "A review reason is required" });
      const service = new CandidateInsightReviewService(getKnowledgeStore());
      try { return reply.send({ insight: action === "confirm" ? service.confirm({ actorId: request.user.id, id: String((request.params as { id: string }).id), reason: body.data.reason }) : service.reject({ actorId: request.user.id, id: String((request.params as { id: string }).id), reason: body.data.reason }) }); } catch (error) { return sendError(reply, error, 403); }
    });
  }
  app.patch("/api/knowledge/candidate-insights/:id", { onRequest: [app.authenticate] }, async (request, reply) => { const body = z.object({ patch: z.record(z.unknown()), reason: z.string().trim().min(1).max(2_000) }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid Candidate Insight edit" }); try { return reply.send({ insight: new CandidateInsightReviewService(getKnowledgeStore()).edit({ actorId: request.user.id, id: String((request.params as { id: string }).id), patch: body.data.patch as never, reason: body.data.reason }) }); } catch (error) { return sendError(reply, error, 403); } });
  app.post("/api/knowledge/candidate-insights/:id/review-scope", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ reason: z.string().trim().min(1).max(2_000), expectedSessionUpdatedAt: z.string().min(1).max(100) }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "A review reason and the displayed Session revision are required" });
    try { return reply.send({ insight: new CandidateInsightReviewService(getKnowledgeStore()).reviewScope({ actorId: request.user.id, id: String((request.params as { id: string }).id), ...body.data }) }); }
    catch (error) { return sendError(reply, error, 403); }
  });
  app.post("/api/knowledge/candidate-insights/:id/promote", { onRequest: [app.authenticate] }, async (request, reply) => { const body = z.object({ target: z.enum(["case", "decision"]), reason: z.string().trim().min(1).max(2_000), title: z.string().max(300).optional() }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid promotion request" }); try { return reply.send({ promotion: new CandidateInsightReviewService(getKnowledgeStore()).promote({ actorId: request.user.id, id: String((request.params as { id: string }).id), ...body.data }) }); } catch (error) { return sendError(reply, error, 403); } });

  app.get("/api/knowledge/wiki", { onRequest: [app.authenticate] }, async (request, reply) => { const query = request.query as Record<string, unknown>; const status = typeof query.status === "string" && WIKI_PAGE_STATUSES.includes(query.status as never) ? query.status as never : undefined; try { return reply.send(await activeWikiService(getKnowledgeStore()).list({ actorId: request.user.id, projectId: query.projectId ? String(query.projectId) : undefined, environment: query.environment ? String(query.environment) : undefined, status, productVersion: query.productVersion ? String(query.productVersion) : undefined, topicId: query.topicId ? String(query.topicId) : undefined, solution: query.solution ? String(query.solution) : undefined, module: query.module ? String(query.module) : undefined, search: query.search ? String(query.search) : undefined, limit: parseBoundedInt(query.limit, 50, 1, 200), offset: parseBoundedInt(query.offset, 0, 0, 1_000_000) })); } catch (error) { return sendError(reply, error, 403); } });
  app.post("/api/knowledge/wiki", { onRequest: [app.authenticate] }, async (request, reply) => { const body = z.object({ environment: z.string().optional(), pageKey: z.string().min(1).max(300), title: z.string().min(1).max(500), body: z.string().min(1), projectId: z.string().optional(), productVersion: z.string().optional(), topicId: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), sourceRefs: z.array(z.string()).max(100).optional(), reason: z.string().min(1).max(2_000) }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid Wiki page" }); try { return reply.status(201).send({ page: await activeWikiService(getKnowledgeStore()).create({ actorId: request.user.id, ...body.data }) }); } catch (error) { return sendError(reply, error, 403); } });
  app.get("/api/knowledge/wiki/:id", { onRequest: [app.authenticate] }, async (request, reply) => { try { return reply.send({ page: await activeWikiService(getKnowledgeStore()).get({ actorId: request.user.id, id: String((request.params as { id: string }).id), environment: queryValue(request.query as Record<string,unknown>, "environment") }) }); } catch (error) { return sendError(reply, error, 404); } });
  app.patch("/api/knowledge/wiki/:id", { onRequest: [app.authenticate] }, async (request, reply) => { const body = z.object({ environment: z.string().optional(), title: z.string().min(1).max(500).optional(), body: z.string().min(1).optional(), reason: z.string().min(1).max(2_000) }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid Wiki edit" }); try { return reply.send({ page: await activeWikiService(getKnowledgeStore()).edit({ actorId: request.user.id, id: String((request.params as { id: string }).id), ...body.data }) }); } catch (error) { return sendError(reply, error, 403); } });
  for (const action of ["publish", "deprecate"] as const) {
    app.post(`/api/knowledge/wiki/:id/${action}`, { onRequest: [app.authenticate] }, async (request, reply) => { const body = z.object({ environment: z.string().optional(), reason: z.string().min(1).max(2_000) }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "A reason is required" }); const service = activeWikiService(getKnowledgeStore()); try { const id = String((request.params as { id: string }).id); return reply.send({ page: action === "publish" ? await service.publish({ actorId: request.user.id, id, reason: body.data.reason, environment: body.data.environment }) : await service.deprecate({ actorId: request.user.id, id, reason: body.data.reason, environment: body.data.environment }) }); } catch (error) { return sendError(reply, error, 403); } });
  }
  app.get("/api/knowledge/wiki/:id/revisions", { onRequest: [app.authenticate] }, async (request, reply) => { try { return reply.send({ revisions: await activeWikiService(getKnowledgeStore()).listRevisions({ actorId: request.user.id, id: String((request.params as { id: string }).id), environment: queryValue(request.query as Record<string,unknown>, "environment") }) }); } catch (error) { return sendError(reply, error, 404); } });
  app.get("/api/knowledge/wiki/:id/diff", { onRequest: [app.authenticate] }, async (request, reply) => { const query = request.query as Record<string, unknown>; try { return reply.send({ diff: await activeWikiService(getKnowledgeStore()).diffRevisions({ actorId: request.user.id, id: String((request.params as { id: string }).id), environment: queryValue(query, "environment"), fromRevision: parseBoundedInt(query.fromRevision, 1, 1, 1_000_000), toRevision: parseBoundedInt(query.toRevision, 1, 1, 1_000_000) }) }); } catch (error) { return sendError(reply, error, 404); } });
  app.post("/api/knowledge/wiki/:id/rollback", { onRequest: [app.authenticate] }, async (request, reply) => { const body = z.object({ environment: z.string().optional(), revision: z.number().int().positive(), reason: z.string().min(1).max(2_000) }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid Wiki rollback" }); try { return reply.send({ page: await activeWikiService(getKnowledgeStore()).rollback({ actorId: request.user.id, id: String((request.params as { id: string }).id), ...body.data }) }); } catch (error) { return sendError(reply, error, 403); } });

  app.get("/api/knowledge/weknora/documents", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>; const projectId = query.projectId ? String(query.projectId) : undefined; const store = getKnowledgeStore();
    if (projectId && !store.canRead(request.user.id, projectId)) return reply.status(403).send({ error: "Knowledge access denied" });
    const conditions: string[] = query.environment ? [] : ["environment IS NULL"]; const params: unknown[] = [];
    for (const [key, column] of [["status", "status"], ["productVersion", "product_version"], ["solution", "solution"], ["module", "module"], ["projectId", "project_id"], ["environment","environment"]] as const) { if (query[key]) { conditions.push(`${column} = ?`); params.push(String(query[key])); } }
    if (!request.user.isAdmin && !projectId) conditions.push("(project_id IS NULL OR EXISTS(SELECT 1 FROM knowledge_acl a WHERE a.project_id=knowledge_weknora_documents.project_id AND a.user_id=? AND a.can_read=1))"), params.push(request.user.id);
    const limit = parseBoundedInt(query.limit, 50, 1, 200); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000); const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const documents = store.db.prepare(`SELECT id,external_document_id,title,normalized_content_sha256,raw_sha256,parser_version,product_version,solution,module,topic_id,source_path,language,project_id,environment,external_chunk_ids_json,upstream_parse_status,upstream_verified_at,model_provenance_json,status,failure_code,failure_message,attempt_count,created_at,updated_at,published_at FROM knowledge_weknora_documents ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = (store.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_weknora_documents ${where}`).get(...params) as { count: number }).count;
    return reply.send({ documents: (documents as Array<Record<string,unknown>>).map(row=>{
      const {model_provenance_json,external_chunk_ids_json,...safe}=row;
      const provenance=safeRows(()=>JSON.parse(String(model_provenance_json??"{}")),{}) as Record<string,unknown>;
      return {...safe,externalChunkIds:safeRows(()=>JSON.parse(String(external_chunk_ids_json??"[]")),[]),upstreamParseStatus:row.upstream_parse_status,upstreamVerifiedAt:row.upstream_verified_at,modelProvenance:{providerId:provenance.providerId,modelId:provenance.modelId,dimensions:provenance.dimensions,indexVersion:provenance.indexVersion}};
    }), page: { limit, offset, total } });
  });
  app.post("/api/knowledge/weknora/documents", { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); const body = z.object({ idempotencyKey: z.string().min(1).max(300), title: z.string().min(1).max(500), content: z.string().min(1), productVersion: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), topicId: z.string().optional(), sourcePath: z.string().optional(), environment: z.string().optional(), language: z.string().optional(), projectId: z.string().optional(), parserVersion: z.string().min(1).max(100).default("relay-normalizer-v1"), rawSha256: z.string().length(64).optional(), retry: z.boolean().optional() }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid WeKnora document" }); try { const document = await weknoraControlPlane().ingestor.stage(body.data, { retry: body.data.retry }); return reply.status(201).send({ document }); } catch (error) { return sendError(reply, error, error instanceof WeKnoraError ? 502 : 400); } });
  for (const action of ["publish", "deprecate"] as const) {
    app.post(`/api/knowledge/weknora/documents/:id/${action}`, { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); const writer = { upsertDocument: async () => ({ externalDocumentId: "unused" }) }; const ingestor = new WeKnoraIngestor(getKnowledgeStore(), writer); try { const id = String((request.params as { id: string }).id); return reply.send({ document: action === "publish" ? ingestor.publish(id, request.user.id) : ingestor.deprecate(id, request.user.id) }); } catch (error) { return sendError(reply, error, 400); } });
  }
  app.post("/api/knowledge/weknora/search", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ query: z.string().min(1), workSessionId: z.string().optional(), projectId: z.string().optional(), environment: z.string().optional(), productVersion: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), language: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid Product Knowledge search" });
    const store = getKnowledgeStore();
    try {
      const sessions = new WorkSessionService(store);
      const session = body.data.workSessionId ? sessions.assertSessionUsable({ actorId: request.user.id, sessionId: body.data.workSessionId, projectId: body.data.projectId, environment: body.data.environment }) : undefined;
      const projectId = resolveRetrievalProjectId({ projectId: body.data.projectId, sessionProjectId: session?.projectId });
      if (!store.canRead(request.user.id, projectId)) throw new Error("Knowledge access denied");
      const ingestor = new WeKnoraIngestor(store, { upsertDocument: async () => ({ externalDocumentId: "unused" }) });
      const environment=body.data.environment??session?.environment;
      const effectiveIntent={objective:"",actions:[] as string[],...session?.intent,projectId,environment,sampleManagerVersion:body.data.productVersion??session?.intent.sampleManagerVersion,solution:body.data.solution??session?.intent.solution,module:body.data.module??session?.intent.module};
      const knowledgeIds = ingestor.retrievalKnowledgeIds({ projectId, environment, productVersion: body.data.productVersion ?? session?.intent.sampleManagerVersion, solution: body.data.solution ?? session?.intent.solution, module: body.data.module ?? session?.intent.module, language: body.data.language });
      let relaySources = { confirmedKnowledge: [], candidates: [], currentFacts: [], degraded: undefined } as Awaited<ReturnType<typeof loadRelayContextSources>>;
      try { relaySources = await loadRelayContextSources({ store, userId: request.user.id, projectId, query: body.data.query, intent: effectiveIntent, limit: body.data.limit ?? 10 }); } catch { relaySources = { confirmedKnowledge: [], candidates: [], currentFacts: [], degraded: { relayMemory: "unavailable" } }; }
      if (!knowledgeIds.length) {
        const contextPack = new ContextPackService({ provider: "weknora" }).build({ intent: effectiveIntent, authoritativeDocs: [], confirmedKnowledge: relaySources.confirmedKnowledge, candidates: relaySources.candidates, currentFacts: relaySources.currentFacts, degraded: { ...relaySources.degraded, productKnowledge: "no_published_documents" }, acl: { documentIds: [] }, maxItemsPerSection: body.data.limit ?? 10 });
        return reply.send({ retrievalRunId: "local-scope-empty", references: [], degraded: contextPack.degraded, contextPack });
      }
      const result = await searchEngineProductReferences(store,{userId:request.user.id,projectId,environment,query:body.data.query,sampleManagerVersion:body.data.productVersion??session?.intent.sampleManagerVersion,solution:body.data.solution??session?.intent.solution,module:body.data.module??session?.intent.module,language:body.data.language,limit:body.data.limit});
      const visible = new Set(knowledgeIds);
      const references = result.references.filter((reference) => visible.has(reference.documentId));
      const pack = new ContextPackService({ provider: "weknora" }).build({ intent: effectiveIntent, authoritativeDocs: references, confirmedKnowledge: relaySources.confirmedKnowledge, candidates: relaySources.candidates, currentFacts: relaySources.currentFacts, degraded: { ...relaySources.degraded, ...result.degraded }, acl: { documentIds: knowledgeIds }, maxItemsPerSection: body.data.limit ?? 10 });
      return reply.send({ ...result, references: pack.authoritativeDocs, contextPack: pack });
    } catch (error) { return sendError(reply, error, error instanceof WeKnoraError ? 502 : 403); }
  });

  app.get("/api/knowledge/integrations/product-provider", { onRequest: [app.authenticate] }, async (_request, reply) => reply.send({ provider: new MigrationController(getKnowledgeStore()).activeProductProvider() }));
  app.post("/api/knowledge/integrations/product-provider", { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); const body = z.object({ provider: z.enum(["relay_local", "weknora"]), migrationId: z.string().optional() }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid product provider" }); try { return reply.send(new MigrationController(getKnowledgeStore()).setProductProvider(body.data.provider, request.user.id, { migrationId: body.data.migrationId })); } catch (error) { return sendError(reply, error, 400); } });
  app.post("/api/knowledge/migrations", { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); const body = z.object({ idempotencyKey: z.string().min(1).max(300), kind: z.string().max(100).optional(), sourceManifest: z.record(z.unknown()) }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid migration request", details: body.error.issues }); const migration = new MigrationController(getKnowledgeStore()).create({ actorId: request.user.id, ...body.data }); return reply.status(201).send({ migration }); });
  app.post("/api/knowledge/migrations/from-local", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const body = z.object({ idempotencyKey: z.string().trim().min(1).max(300), parserVersion: z.string().trim().min(1).max(100), productVersion: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), projectId: z.string().optional(), environment: z.string().optional(), limit: z.number().int().min(1).max(10_000).optional(), retry: z.boolean().optional(), asynchronous: z.boolean().default(false) }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid local migration request" });
    try {
      const { asynchronous, ...input } = body.data;
      const store = getKnowledgeStore();
      if (asynchronous) return reply.status(202).send(enqueueProductMigration(store, { actorId: request.user.id, ...input }));
      return reply.send({ migration: await new MigrationController(store).createFromLocal({ actorId: request.user.id, ...input }, weknoraControlPlane(store).ingestor) });
    } catch (error) {
      if (error instanceof MigrationQueueBusyError) return reply.header("Retry-After", String(error.retryAfterSeconds)).status(error.statusCode).send({ error: error.message, code: error.code });
      return sendError(reply, error, 400);
    }
  });
  app.get("/api/knowledge/migrations/:id", { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); const migration = new MigrationController(getKnowledgeStore()).get(String((request.params as { id: string }).id)); return migration ? reply.send({ migration }) : reply.status(404).send({ error: "Migration not found" }); });
  app.post("/api/knowledge/migrations/:id/stage", { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); const body = z.object({ report: z.record(z.unknown()) }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid migration report" }); try { return reply.send({ migration: new MigrationController(getKnowledgeStore()).markStaged(String((request.params as { id: string }).id), body.data.report, request.user.id) }); } catch (error) { return sendError(reply, error, 400); } });
  app.post("/api/knowledge/migrations/:id/publish", { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); try { return reply.send({ migration: new MigrationController(getKnowledgeStore()).validateAndPublish(String((request.params as { id: string }).id), request.user.id) }); } catch (error) { return sendError(reply, error, 400); } });
  app.post("/api/knowledge/migrations/:id/rollback", { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); const body = z.object({ reason: z.string().trim().min(1).max(2_000) }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Rollback reason is required" }); try { return reply.send({ migration: new MigrationController(getKnowledgeStore()).rollback(String((request.params as { id: string }).id), request.user.id, body.data.reason) }); } catch (error) { return sendError(reply, error, 400); } });
  app.get("/api/knowledge/migrations/:id/cleanup", { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); return reply.send(new MigrationController(getKnowledgeStore()).cleanupDryRun({ actorId: request.user.id, migrationId: String((request.params as { id: string }).id) })); });
  app.get("/api/knowledge/release-gates", { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); return reply.send(runReleaseGates(getKnowledgeStore())); });
}

