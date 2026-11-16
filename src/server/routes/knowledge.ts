import { completeVerifiedEngineReindex } from "../../knowledge/engine-reindex.js";
import { assertProductScope, searchProductBackend, getProductBackend, listEngineProductBackend, diffProductBackend, productCatalogVisibility } from "../../knowledge/product-backend.js";
import { managedControlPlane, activeWikiService, getEngineManager } from "../../knowledge/engine-service.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db/index.js";
import { projects, users } from "../db/schema.js";
import { getKnowledgeStore } from "../knowledge-context.js";
import { EvidenceStore } from "../../knowledge/evidence-store.js";
import { KnowledgeRepository } from "../../knowledge/repository.js";
import { importCasebook, importContextFacts } from "../../knowledge/importer.js";
import { analyzeRelationImpact, queryRelations } from "../../knowledge/relations.js";
import { correctProductMetadata, updateProductDocumentLifecycle } from "../../knowledge/knowledge-products.js";
import { ingestArtifactSet, ingestProjectSnapshot } from "../../knowledge/artifact-ingest.js";
import { enqueueArtifactImport, enqueueProductImport, enqueueProductMigration, enqueueWikiGenerationDetailed, MigrationQueueBusyError } from "../../knowledge/ingest-worker.js";
import { controlWikiGenerationJob, WikiGenerationControlError } from "../../knowledge/ingest-controls.js";
import { normalizeWikiGenerationJob } from "../../knowledge/ingest-dispatch.js";
import { listWikiTopicGenerationStatuses } from "../../knowledge/wiki-generation.js";
import { ensureWikiDirectoryAssignments, WIKI_DIRECTORY_TAXONOMY_VERSION } from "../../knowledge/wiki-directory-assignments.js";
import { compareSourceBaselines, type SourceManifest } from "../../knowledge/source-baseline.js";
import { compareSourceUpgradeWithSymbols } from "../../knowledge/source-symbol.js";
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
import { CONFIRMED_MEMORY_TYPES } from "../../knowledge/confirmed-memory.js";
import { getConfirmedMemory, getMemorySubmission, legacyMemoryReviewQueue, listMemorySubmissions, reviewLegacyMemoryScope, reviewMemorySubmission, searchConfirmedMemories, submitMemory, type MemoryAccess } from "../../knowledge/memory-v2.js";
import { listLegacyCandidatesForReview, reviewLegacyCandidate } from "../../knowledge/legacy-candidate-review.js";
import { readPublicProduct, searchPublicProductChunks } from "../../knowledge/product-search-v2.js";
import { publicSourceLocation } from "../../knowledge/source-display.js";
import { enqueueCandidateInsight, getCandidateInsightJob } from "../../knowledge/candidate-worker.js";
import { WikiService, WIKI_PAGE_STATUSES } from "../../knowledge/wiki.js";
import { visibleWikiPageIds, wikiPageVisible, wikiRevisionVisible, wikiSourcesVisible } from "../../knowledge/wiki-access.js";
import { WeKnoraError } from "../../knowledge/weknora.js";
import { WeKnoraIngestor } from "../../knowledge/weknora-ingest.js";
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

function safeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) return value.map(item=>safeMetadata(item,depth+1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key,item]) => {
    if (/(?:storage.?path|source.?root|absolute.?path)/i.test(key)) return [];
    if (typeof item === "string" && /(?:source|file).*path|locator/i.test(key)) return [[key,publicSourceLocation(item)]];
    return [[key,safeMetadata(item,depth+1)]];
  }));
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
    sourcePath: publicSourceLocation(row.source_path),
    topicGroupId: row.topic_group_id ? String(row.topic_group_id) : undefined,
    ...(row.engine_status ? { engine: {
      status: String(row.engine_status), externalDocumentId: row.engine_external_document_id ? String(row.engine_external_document_id) : undefined,
      chunkIds: parseList(row.engine_chunk_ids_json).map(String),
      parseStatus: row.engine_parse_status ? String(row.engine_parse_status) : undefined, verifiedAt: row.engine_verified_at ? String(row.engine_verified_at) : undefined,
      modelProvenance: row.engine_model_provenance_json ? safeRows(() => JSON.parse(String(row.engine_model_provenance_json)), {}) : {},
      failureCode: row.engine_failure_code ? String(row.engine_failure_code) : undefined, failureMessage: row.engine_failure_message ? "Knowledge engine operation failed" : undefined,
      attemptCount: Number(row.engine_attempt_count ?? 0), publishedAt: row.engine_published_at ? String(row.engine_published_at) : undefined,
      deprecatedAt: row.engine_deprecated_at ? String(row.engine_deprecated_at) : undefined, updatedAt: row.engine_updated_at ? String(row.engine_updated_at) : undefined,
    } } : {}),
    metadata: row.metadata_json ? safeMetadata(safeRows(() => JSON.parse(String(row.metadata_json)), undefined)) : undefined,
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
    provenance: row.provenance_json ? safeMetadata(safeRows(() => JSON.parse(String(row.provenance_json)), undefined)) : safeMetadata(card?.provenance),
    sourceLocator: publicSourceLocation(row.source_locator) ?? "",
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

function canReadProject(userId: number, projectId: string): boolean {
  try { resolveProject(userId, projectId); return true; } catch { return false; }
}

function assertCurrentWikiAccess(userId: number, pageId: string, projectId?: string, returned?: {sourceRefs?:string[]; citations?:Array<{documentId:string}>}): void {
  if (projectId && !canReadProject(userId,projectId)) throw new Error("Project access denied");
  const store=getKnowledgeStore(), row=store.db.prepare("SELECT id,project_id,source_refs_json FROM knowledge_wiki_pages WHERE id=?").get(pageId) as KnowledgeRow|undefined;
  const canProduct=knowledgeUserEnabled(userId);
  if (!row || !wikiPageVisible(store,row,canProduct,projectId)) throw new Error("Wiki page is unavailable in this scope");
  if (returned && !wikiSourcesVisible(store,[...(returned.sourceRefs ?? []),...(returned.citations ?? []).map(item => item.documentId)],row.project_id ? String(row.project_id) : undefined,canProduct)) throw new Error("Wiki source access changed");
}

function userProjectIds(userId: number): string[] {
  return db.select({ id: projects.id }).from(projects).where(eq(projects.userId, userId)).all().map(row => String(row.id));
}

/** Import histories can mention private files even when the operator is an administrator. */
function canReadImportRun(store: ReturnType<typeof getKnowledgeStore>, userId:number, row:KnowledgeRow):boolean {
  const metadata=safeRows(()=>JSON.parse(String(row.batch_metadata_json ?? "{}")) as Record<string,unknown>,{});
  const sourceProjectId=metadata.sourceProjectId ? String(metadata.sourceProjectId) : undefined;
  if (sourceProjectId) return canReadProject(userId,sourceProjectId);
  if (metadata.classification === "project") return false;
  if (!knowledgeUserEnabled(userId)) return false;
  if (metadata.classification === "product") return true;
  // Older runs had no batch classification. Open them only once every
  // recorded source has an independently reviewed public classification.
  const counts=store.db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN d.id IS NOT NULL AND d.lifecycle IN ('approved','verified') AND c.classification='product' THEN 1 ELSE 0 END) AS allowed
    FROM knowledge_product_document_items i LEFT JOIN knowledge_documents d ON d.id=i.document_id LEFT JOIN knowledge_product_classifications c ON c.document_id=d.id WHERE i.run_id=?`).get(row.id) as {total:number;allowed:number|null};
  return counts.total>0 && counts.total===counts.allowed;
}

function listVisibleImportRuns(store:ReturnType<typeof getKnowledgeStore>,userId:number,limit:number,offset:number) {
  const rows=store.db.prepare("SELECT id,status,imported,skipped,failed,started_at,finished_at,source_commit,source_sha256,batch_metadata_json FROM knowledge_ingest_runs ORDER BY started_at DESC,id").all() as KnowledgeRow[];
  const visible=rows.filter(row=>canReadImportRun(store,userId,row));
  return {runs:visible.slice(offset,offset+limit).map(({batch_metadata_json:_metadata,...row})=>row),page:{limit,offset,total:visible.length}};
}

function scopedWorkSessions(store = getKnowledgeStore()): WorkSessionService {
  return new WorkSessionService(store, undefined, (actorId, projectId) => { resolveProject(actorId, projectId); });
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
  const { spoolPath:_spoolPath,drainingPath:_drainingPath,lastError:_lastError,lastDeadLetterError:_lastDeadLetterError,...spool } = relayEventSpoolHealth();
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

function knowledgeUserEnabled(userId: number): boolean {
  const row = db.select({ enabled: users.knowledgeEnabled }).from(users).where(eq(users.id, userId)).get();
  return row !== undefined && row.enabled === true;
}

function webMemoryAccess(user: { id: number; isAdmin?: boolean }): MemoryAccess {
  return { actorId: user.id, isAdmin: Boolean(user.isAdmin), canReadGeneral: () => knowledgeUserEnabled(user.id),
    assertProject: projectId => { resolveProject(user.id, projectId); } };
}

function knowledgeReadAllowed(store: ReturnType<typeof getKnowledgeStore>, userId: number): boolean {
  void store;
  return knowledgeUserEnabled(userId);
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
        eventId: event.id ?? parsed.eventId,
        type: event.type ?? parsed.type,
        projectId: event.projectId ?? parsed.projectId,
        jobId: event.jobId ?? parsed.jobId,
        deploymentId: event.deploymentId ?? parsed.deploymentId,
        payloadKeys: payload ? Object.keys(payload).slice(0, 100) : undefined,
        error: parsed.error ? "Event processing failed" : undefined,
        attempts: parsed.attempts,
        sha256: parsed.sha256,
        length: parsed.length ?? line.length,
      };
    } catch { return { error: "invalid dead-letter record", length: line.length }; }
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
      store.db.prepare("DELETE FROM knowledge_product_chunk_fts WHERE document_id IN (SELECT id FROM knowledge_documents WHERE project_id = ?)").run(projectId);
      store.db.prepare("DELETE FROM knowledge_facts_fts WHERE fact_id IN (SELECT id FROM knowledge_facts WHERE project_id = ?)").run(projectId);
      store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) SELECT c.document_id,d.title,c.content FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE d.project_id = ?").run(projectId);
      store.db.prepare("INSERT INTO knowledge_product_chunk_fts(chunk_id,document_id,title,body) SELECT c.id,c.document_id,d.title,c.content FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE d.kind='product_document' AND d.project_id=?").run(projectId);
      store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) SELECT d.id,d.title,d.body FROM knowledge_documents d WHERE d.project_id = ? AND NOT EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.document_id=d.id)").run(projectId);
      store.db.prepare("INSERT INTO knowledge_facts_fts(rowid,fact_id,text,tags) SELECT rowid,id,text,tags_json FROM knowledge_facts WHERE project_id = ?").run(projectId);
    } else {
      store.db.prepare("DELETE FROM knowledge_fts").run();
      store.db.prepare("DELETE FROM knowledge_product_chunk_fts").run();
      store.db.prepare("DELETE FROM knowledge_facts_fts").run();
      store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) SELECT c.document_id,d.title,c.content FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id").run();
      store.db.prepare("INSERT INTO knowledge_product_chunk_fts(chunk_id,document_id,title,body) SELECT c.id,c.document_id,d.title,c.content FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE d.kind='product_document'").run();
      store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) SELECT d.id,d.title,d.body FROM knowledge_documents d WHERE NOT EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.document_id=d.id)").run();
      store.db.prepare("INSERT INTO knowledge_facts_fts(rowid,fact_id,text,tags) SELECT rowid,id,text,tags_json FROM knowledge_facts").run();
    }
  })();
  return { documents: docs, facts };
}

function knowledgeProviderSummary(store: ReturnType<typeof getKnowledgeStore>): Array<Record<string, unknown>> {
  const vectorCount = safeRows(() => Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_embeddings").get() as { count?: number }).count ?? 0), 0);
  const configured = (name: string) => Boolean(process.env[name] && String(process.env[name]).trim());
  const builtIns = [
    { name: "FTS5", type: "lexical", model: "sqlite-fts5", status: "ready", configured: true, secretConfigured: false, lastCallAt: null, errorRate: null },
    { name: "Embeddings", type: "vector", model: process.env.KNOWLEDGE_EMBEDDING_MODEL ?? "local-deterministic-v1", status: vectorCount ? "ready" : "disabled_or_empty", configured: true, indexedRows: vectorCount, secretConfigured: false, lastCallAt: null, errorRate: null },
    { name: "Rerank", type: "rerank", model: process.env.KNOWLEDGE_RERANK_MODEL ?? "local-lexical-v1", status: "ready", configured: true, secretConfigured: false, lastCallAt: null, errorRate: null },
    { name: "Inference", type: "inference", model: process.env.KNOWLEDGE_INFERENCE_MODEL ?? "not configured", status: configured("KNOWLEDGE_INFERENCE_PROVIDER") ? "ready" : "disabled", configured: configured("KNOWLEDGE_INFERENCE_PROVIDER"), secretConfigured: configured("KNOWLEDGE_INFERENCE_SECRET_REF"), lastCallAt: null, errorRate: null },
    { name: "Redaction", type: "redaction", model: process.env.KNOWLEDGE_REDACTION_MODEL ?? "local-regex-v1", status: "ready", configured: true, secretConfigured: false, lastCallAt: null, errorRate: null },
  ];
  const managed = safeRows(() => managedProviderRegistry(store).list().map((provider) => ({
    name: provider.id,
    id: provider.id,
    kind: provider.kind,
    provider: provider.provider,
    type: provider.kind,
    model: provider.modelId,
    modelId: provider.modelId,
    baseUrl: provider.baseUrl,
    status: provider.status,
    configured: provider.tokenConfigured,
    secretConfigured: provider.tokenConfigured,
    lastCallAt: provider.lastTestAt ?? null,
    errorRate: null,
    reindexRequired: provider.reindexRequired,
    indexVersion: provider.indexVersion,
  })), []);
  return [...builtIns, ...managed];
}

function parseBoolean(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  return raw === true || String(raw).toLowerCase() === "true";
}

function canAccessDocument(store: ReturnType<typeof getKnowledgeStore>, userId: number, row: KnowledgeRow, targetProjectId?: string): boolean {
  const sourceProjectId = row.project_id === null || row.project_id === undefined ? undefined : String(row.project_id);
  const target = targetProjectId ?? sourceProjectId;
  if (!target || !canReadProject(userId, target)) return false;
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
  app.addHook("preHandler", async (request, reply) => {
    const path = request.routeOptions.url ?? request.url.split("?")[0];
    const productRoute = /^\/api\/knowledge\/(?:search$|product-docs(?:\/|$)|product-documents(?:\/|$)|product-topics(?:\/|$)|product-topic-bindings(?:\/|$)|weknora(?:\/|$))/.test(path);
    if (request.user && productRoute && !knowledgeUserEnabled(request.user.id)) {
      return reply.status(403).send({ error: "Product Knowledge and general Memory access is disabled for this user" });
    }
    if (request.user && !request.user.isAdmin && (/^\/api\/knowledge\/operations(?:\/|$)/.test(path) || /^\/api\/knowledge\/weknora(?:\/|$)/.test(path) || path === "/api/knowledge/ingest-runs")) {
      return reply.status(403).send({ error:"Administrator access is required" });
    }
    if (request.user && !request.user.isAdmin && (/^\/api\/knowledge\/product-documents\/imports(?:\/|$)/.test(path) || path === "/api/knowledge/ingest-jobs/:id")) return reply.status(403).send({error:"Administrator access is required"});
    if (request.user && /^\/api\/knowledge\/wiki(?:\/|$)/.test(path)) {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
      const projectId = queryValue(query, "projectId") ?? (typeof body.projectId === "string" ? body.projectId : undefined);
      const canProduct = knowledgeUserEnabled(request.user.id);
      if (projectId && !canReadProject(request.user.id, projectId)) return reply.status(403).send({ error: "Project access denied" });
      if (!projectId && !canProduct) return reply.status(403).send({ error: "Product Knowledge access denied" });
      const store = getKnowledgeStore(), params = request.params as Record<string, unknown>;
      const id = typeof params?.id === "string" ? params.id : undefined;
      const key = path.endsWith("/resolve") ? queryValue(query, "pageKey") : undefined;
      if (id || key) {
        const row = store.db.prepare(`SELECT id,project_id,source_refs_json FROM knowledge_wiki_pages WHERE ${id ? "id" : "page_key"}=?`).get(id ?? key) as KnowledgeRow | undefined;
        if (!row || !wikiPageVisible(store, row, canProduct, projectId)) return reply.status(404).send({ error: "Wiki page not found" });
      }
      if (path === "/api/knowledge/wiki" && request.method === "POST" && Array.isArray(body.sourceRefs) && !wikiSourcesVisible(store, body.sourceRefs.map(String), projectId, canProduct)) return reply.status(403).send({ error: "Wiki source is unavailable in the selected scope" });
    }
    if (request.user && /^\/api\/knowledge\/candidate-insights\/:id(?:\/|$)/.test(path)) {
      const id = String((request.params as {id:string}).id);
      const row = getKnowledgeStore().db.prepare("SELECT project_id FROM knowledge_candidate_insights WHERE id=?").get(id) as {project_id?:string} | undefined;
      if (!row || (!request.user.isAdmin && (!row.project_id || !canReadProject(request.user.id,row.project_id)))) return reply.status(404).send({ error:"Candidate Insight not found" });
      if (request.method !== "GET" && !request.user.isAdmin) return reply.status(403).send({ error:"Administrator access is required" });
    }
  });
  app.get("/api/memory/search", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    try {
      const scope = z.enum(["project", "general", "both"]).optional().parse(queryValue(query, "scope"));
      const type = z.enum(CONFIRMED_MEMORY_TYPES).optional().parse(queryValue(query, "type"));
      const result = searchConfirmedMemories(getKnowledgeStore(), webMemoryAccess(request.user), { query: queryValue(query, "q") ?? queryValue(query, "query"), scope, projectId: queryValue(query, "projectId"), type, environment: queryValue(query, "environment"), limit: parseBoundedInt(query.limit, 20, 1, 100), offset: parseBoundedInt(query.offset, 0, 0, 1000000) });
      return reply.send(result);
    } catch (error) { return sendError(reply, error, error instanceof Error && /access denied|Project not found/i.test(error.message) ? 403 : 400); }
  });

  app.get("/api/knowledge/documents/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const store = getKnowledgeStore();
      const query = request.query as Record<string, unknown>;
      const targetProjectId = query.projectId === undefined ? undefined : resolveProject(request.user.id, query.projectId).projectId;
      const product = store.db.prepare(`SELECT d.kind,COALESCE(d.project_id,(SELECT s.source_project_id FROM knowledge_scope_bindings s WHERE s.document_id=d.id AND s.source_project_id IS NOT NULL ORDER BY s.updated_at DESC LIMIT 1)) AS project_id FROM knowledge_documents d WHERE d.id=?`).get(id) as {kind?:string;project_id?:string|null}|undefined;
      if(product?.kind==="product_document" || store.db.prepare("SELECT 1 FROM knowledge_weknora_documents WHERE id=? OR external_document_id=?").get(id,id)) {
        const classification = store.db.prepare("SELECT classification FROM knowledge_product_classifications WHERE document_id=?").get(id) as { classification?: string } | undefined;
        const projectDocument = classification?.classification !== "product" && product?.project_id && targetProjectId === product.project_id;
        const document = projectDocument
          ? await getProductBackend(store,{documentId:id,userId:request.user.id,isAdmin:false,projectId:targetProjectId,environment:queryValue(query,"environment")})
          : (knowledgeUserEnabled(request.user.id) ? await readPublicProduct(store,{documentId:id}) : (() => { throw new Error("Product Knowledge access denied"); })());
        if (projectDocument) resolveProject(request.user.id, targetProjectId);
        else if (!knowledgeUserEnabled(request.user.id)) throw new Error("Product Knowledge access denied");
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
      if (!row || !row.project_id || !canReadProject(request.user.id, String(row.project_id))) throw new Error("Observation not found");
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
        if (!linkedProject) return false;
        return linkedProject === projectId || canReadProject(request.user.id, linkedProject);
      }).map((row) => ({ type: row.entity_type, id: row.entity_id, kind: row.kind, title: row.title, lifecycle: row.lifecycle, projectId: row.project_id }));
      const sharedProjectIds = store.db.prepare("SELECT project_id FROM knowledge_evidence_acl WHERE evidence_id=? ORDER BY project_id").all(id).map((row: any) => String(row.project_id)).filter((sharedId) => sharedId === projectId || canReadProject(request.user.id, sharedId));
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
      const store = getKnowledgeStore();
      const requestedProject = queryValue(query, "projectId");
      const projectIds = requestedProject ? [resolveProject(request.user.id, requestedProject).projectId] : userProjectIds(request.user.id);
      const limit = parseBoundedInt(query.limit, 50, 1, 200);
      const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
      const scope = JSON.stringify(projectIds);
      const rows = store.db.prepare(`${OBSERVATION_WITH_REVIEW} WHERE o.project_id IN (SELECT value FROM json_each(?)) ORDER BY o.updated_at DESC LIMIT ? OFFSET ?`).all(scope, limit, offset);
      const total = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_observations WHERE project_id IN (SELECT value FROM json_each(?))").get(scope) as { count?: number };
      return reply.send({ observations: (rows as KnowledgeRow[]).map(safeObservation), page: { limit, offset, total: Number(total.count ?? 0) } });
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
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
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
    const body = z.object({ documentId: z.string().min(1).optional(), memoryId: z.string().min(1).optional(), helpful: z.boolean().optional(), comment: z.string().max(2_000).optional() }).refine(value => Boolean(value.documentId) !== Boolean(value.memoryId), "Select a document or Memory").safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid feedback", details: body.error.issues });
    const store = getKnowledgeStore();
    try {
      const id = body.data.memoryId ?? body.data.documentId!;
      const local = store.db.prepare("SELECT kind,project_id FROM knowledge_documents WHERE id=?").get(id) as KnowledgeRow | undefined;
      let projectId: string | undefined;
      if (body.data.memoryId) { const memory=getConfirmedMemory(store,webMemoryAccess(request.user),id); projectId=memory.memoryScope === "project" && "projectId" in memory.scope ? memory.scope.projectId : undefined; }
      else if (local?.kind === "product_document" || store.db.prepare("SELECT 1 FROM knowledge_weknora_documents WHERE id=? OR external_document_id=?").get(id,id)) { if (!knowledgeUserEnabled(request.user.id)) throw new Error("Product Knowledge access denied"); await readPublicProduct(store,{documentId:id}); if (!knowledgeUserEnabled(request.user.id)) throw new Error("Product Knowledge access denied"); }
      else projectId=String(loadDocumentForUser(store,request.user.id,id).project_id);
      const result = replayOrRun(store, request.user.id, "feedback", idempotencyKey(request), () => {
        const feedbackId = `feedback-${randomUUID()}`; const createdAt = new Date().toISOString();
        store.db.prepare("INSERT INTO knowledge_feedback(id,document_id,entity_id,user_id,helpful,comment,created_at) VALUES (?,?,?,?,?,?,?)").run(feedbackId, !body.data.memoryId && local ? id : null, id, request.user.id, body.data.helpful === undefined ? null : body.data.helpful ? 1 : 0, body.data.comment ?? null, createdAt);
        store.audit({ actorId: request.user.id, projectId, action: "knowledge.feedback", entityType: body.data.memoryId ? "confirmed_memory" : "document", entityId: id, details: { helpful: body.data.helpful } });
        return { ok: true, id:feedbackId, entityId:id, createdAt };
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
      const globalProductCount = knowledgeUserEnabled(request.user.id) ? safeRows(() => Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents d JOIN knowledge_product_classifications c ON c.document_id=d.id WHERE d.kind='product_document' AND d.lifecycle IN ('approved','verified') AND c.classification='product'").get() as { count?: number }).count ?? 0), 0) : 0;
      const evidenceCount = safeRows(() => Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_evidence WHERE project_id = ? AND deleted_at IS NULL").get(projectId) as { count?: number }).count ?? 0), 0);
      const totals = kinds.map((kind) => ({ kind, count: kind === "product_document" ? globalProductCount : kind === "evidence" ? evidenceCount : counts.filter((item) => String(item.kind) === kind).reduce((sum, item) => sum + Number(item.count ?? 0), 0) }));
      const backlog = safeRows(() => store.consumerBacklog("knowledge-capture"), { count: 0 });
      const lastReview = safeRows(() => store.db.prepare("SELECT r.id,r.action,r.entity_type,r.entity_id,r.created_at FROM knowledge_reviews r JOIN knowledge_documents d ON d.id = r.document_id WHERE d.project_id = ? ORDER BY r.created_at DESC LIMIT 1").get(projectId), undefined);
      const lastIngest = request.user.isAdmin && knowledgeUserEnabled(request.user.id) ? safeRows(() => store.db.prepare("SELECT id,status,imported,skipped,failed,started_at,finished_at FROM knowledge_ingest_runs WHERE json_valid(batch_metadata_json) AND json_extract(batch_metadata_json,'$.classification')='product' ORDER BY started_at DESC LIMIT 1").get(), undefined) : undefined;
      const recentEvents = safeRows(() => store.db.prepare("SELECT id,type,occurred_at,job_id,deployment_id FROM relay_domain_events WHERE project_id = ? ORDER BY occurred_at DESC LIMIT 10").all(projectId), []);
      return reply.send({ projectId, totals, counts, scope: { globalProductDocuments: globalProductCount, projectDocuments: counts.reduce((sum, item) => sum + Number(item.count ?? 0), 0) }, recent: { lastReview, lastIngest, events: recentEvents }, health: request.user.isAdmin && knowledgeUserEnabled(request.user.id) ? knowledgeHealth(store) : undefined, capture: { backlog, workerManagedBy: "remote-ops-mcp", checkedAt: new Date().toISOString() } });
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
      } else {
        const projectIds = JSON.stringify(userProjectIds(request.user.id));
        where.push("(e.project_id IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM knowledge_evidence_acl a WHERE a.evidence_id=e.id AND a.project_id IN (SELECT value FROM json_each(?))))");
        params.push(projectIds, projectIds);
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
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    try {
      const { store, projectId } = resolveProject(request.user.id, (request.query as Record<string, unknown>).projectId);
      const stateRoot = store.evidenceRoot ? store.evidenceRoot.replace(/[\\/]evidence[\\/]?$/, "") : ".relay-mcp";
      const paths = [`${stateRoot}/knowledge-event-spool.jsonl.dead-letter`, `${stateRoot}/knowledge-capture-dead-letter.jsonl`];
      void paths;
      const deadLetters = readDeadLetters(store, 20).filter(item => String(item.projectId ?? "") === projectId).map(({ sourcePath: _sourcePath, ...item }) => item);
      return reply.send({ projectId, health: knowledgeHealth(store), deadLetters: deadLetters.slice(-50), checkedAt: new Date().toISOString() });
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/ingest-runs", { onRequest: [app.authenticate] }, async (request, reply) => {
    try {
      const { store } = resolveProject(request.user.id, (request.query as Record<string, unknown>).projectId);
      const limit = parseBoundedInt((request.query as Record<string, unknown>).limit, 50, 1, 200);
      return reply.send(listVisibleImportRuns(store,request.user.id,limit,0));
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.post("/api/knowledge/product-docs/import", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ root: z.string().min(1).optional(), projectId: z.number().int().positive().optional(), path: z.string().min(1).optional(), classification: z.enum(["product", "project"]), product: z.string().max(200).optional(), sampleManagerVersion: z.string().max(80).optional(), solution: z.string().max(200).optional(), module: z.string().max(200).optional(), language: z.string().max(20).optional(), authority: z.string().max(80).optional(), documentFamilyId: z.string().max(200).optional(), manifestPath: z.string().min(1).optional(), asynchronous: z.boolean().optional().default(true) }).refine((value) => Boolean(value.root || (value.projectId && value.path)), "root or projectId/path is required").refine(value => value.classification !== "project" || Boolean(value.projectId), "projectId is required for project material").safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid product document import", details: body.error.issues });
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    try {
      if (body.data.projectId) resolveProject(request.user.id,body.data.projectId);
      const root = body.data.root ?? (() => { const project = db.select().from(projects).where(and(eq(projects.id, body.data.projectId!), eq(projects.userId, request.user.id))).get(); if (!project) throw new Error("Project not found"); return resolveWorkspacePath(project.workspacePath, body.data.path!, { mustExist: true }); })();
      if (!existsSync(root)) return reply.status(403).send({ error: "An existing source file or directory is required" });
      const store = getKnowledgeStore(); const key = idempotencyKey(request);
      const report = replayOrRun(store, request.user.id, "product-documents:import", key, () => enqueueProductImport(store, { ...body.data, root, sourceProjectId: body.data.projectId ? String(body.data.projectId) : undefined, sampleManagerVersion: body.data.sampleManagerVersion ?? "", idempotencyKey: key }), body.data);
      store.audit({ actorId: request.user.id, action: "knowledge.product_documents.import", entityType: "product_document_batch", entityId: report.id, details: { ...report } });
      return reply.status(202).send(report);
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/product-docs", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query=request.query as Record<string,unknown>,store=getKnowledgeStore(),value=(key:string)=>queryValue(query,key);
    const input={userId:request.user.id,isAdmin:false,sampleManagerVersion:value("sampleManagerVersion"),product:value("product"),solution:value("solution"),module:value("module"),documentType:value("documentType"),language:value("language"),authority:value("authority"),status:value("status"),limit:parseBoundedInt(query.limit,100,1,500),offset:parseBoundedInt(query.offset,0,0,1_000_000)};
    try {const result=new MigrationController(store).activeProductProvider()==="weknora"?await listEngineProductBackend(store,input):{documents:await searchProductBackend(store,input)}; if(!knowledgeUserEnabled(request.user.id))return reply.status(403).send({error:"Product Knowledge access denied"}); return reply.send(result);}
    catch(error){return sendError(reply,error,error instanceof WeKnoraError?503:403);}
  });

  app.get("/api/knowledge/product-docs/search", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>; const store = getKnowledgeStore();
    const value = (key: string) => queryValue(query, key);
    const q = value("q") ?? value("query");
    if (!q) return reply.send({ query: "", results: [] });
    try { const found = await searchPublicProductChunks(store, { query:q, productVersion:value("sampleManagerVersion"), solution:value("solution"), module:value("module"), language:value("language"), limit:parseBoundedInt(query.limit,50,1,100) });
      if (!knowledgeUserEnabled(request.user.id)) return reply.status(403).send({ error:"Product Knowledge access denied" });
      return reply.send({ query:q, results:found.references.map(ref => ({ ...ref, id:ref.documentId, kind:"product_document", summary:ref.snippet })) });
    } catch(error) { return sendError(reply,error,503); }
  });

  app.get("/api/knowledge/product-docs/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    try {
      const document=await readPublicProduct(getKnowledgeStore(),{documentId:String((request.params as {id:string}).id)});
      if (!knowledgeUserEnabled(request.user.id)) return reply.status(403).send({ error:"Product Knowledge access denied" });
      return reply.send({document,sections:[]});
    }catch(error){return sendError(reply,error,error instanceof WeKnoraError?503:404);}
  });

  app.get("/api/knowledge/product-docs/:id/diff", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id); const against = queryValue(request.query as Record<string, unknown>, "against"); if (!against) return reply.status(400).send({ error: "against is required" });
    const store = getKnowledgeStore(); const exists = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_product_documents WHERE id IN (?,?)").get(id, against) as { count?: number }; if (Number(exists.count) !== 2) return reply.status(404).send({ error: "Product document not found" });
    try {const diff=await diffProductBackend(store,{leftId:id,rightId:against,userId:request.user.id,isAdmin:false}); if(!knowledgeUserEnabled(request.user.id))return reply.status(403).send({error:"Product Knowledge access denied"}); return reply.send(diff);}catch(error){return sendError(reply,error,error instanceof WeKnoraError?503:404);}
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
    const accessStore = getKnowledgeStore(); if (!knowledgeReadAllowed(accessStore, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const store = accessStore; const q = request.query as Record<string, unknown>; const limit = parseBoundedInt(q.limit, 100, 1, 500);
    const sets = store.db.prepare(`SELECT s.id,s.kind,s.name,s.version,s.sha256,s.status,s.created_at,s.updated_at, (SELECT COUNT(*) FROM knowledge_artifacts a WHERE a.set_id=s.id) AS file_count FROM knowledge_artifact_sets s ${request.user.isAdmin ? "" : "JOIN knowledge_artifact_publications p ON p.artifact_set_id=s.id AND p.status='published'"} ORDER BY s.created_at DESC LIMIT ?`).all(limit);
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
    const body = z.object({ source: z.string().min(1), name: z.string().min(1), projectId: z.string().min(1), version: z.string().optional(), storageUri: z.string().optional() }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid project snapshot request", details: body.error.issues });
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    try { resolveProject(request.user.id,body.data.projectId); return reply.send(ingestProjectSnapshot(getKnowledgeStore(), body.data)); } catch (error) { return sendError(reply, error, 400); }
  });
  app.get("/api/knowledge/source-baselines", { onRequest: [app.authenticate] }, async (request, reply) => {
    const store = getKnowledgeStore(); if (!knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const query = request.query as Record<string, unknown>; const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    const baselines = store.db.prepare(`SELECT b.id,b.solution,b.version,b.manifest_sha256,b.created_at,b.artifact_set_id,p.status FROM knowledge_source_baselines b JOIN knowledge_artifact_publications p ON p.artifact_set_id=b.artifact_set_id AND p.status='published' ORDER BY b.solution,b.version LIMIT ? OFFSET ?`).all(limit, offset);
    const total = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_source_baselines b JOIN knowledge_artifact_publications p ON p.artifact_set_id=b.artifact_set_id AND p.status='published'").get() as { count?: number };
    return reply.send({ baselines, page: { limit, offset, total: Number(total.count ?? 0) } });
  });
  app.get("/api/knowledge/project-snapshots", { onRequest: [app.authenticate] }, async (request, reply) => {
    const store = getKnowledgeStore();
    const query = request.query as Record<string, unknown>; const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    const access = { where: "WHERE s.project_id IN (SELECT value FROM json_each(?)) OR (s.project_id IS NULL AND ?=1)", params: [JSON.stringify(userProjectIds(request.user.id)), knowledgeUserEnabled(request.user.id) ? 1 : 0] as unknown[] };
    const snapshots = store.db.prepare(`SELECT s.id,s.project_id,s.name,s.version,s.manifest_sha256,s.created_at,COUNT(f.id) AS file_count FROM knowledge_project_snapshots s LEFT JOIN knowledge_project_snapshot_files f ON f.snapshot_id=s.id ${access.where} GROUP BY s.id ORDER BY s.created_at DESC LIMIT ? OFFSET ?`).all(...access.params, limit, offset);
    const total = store.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_project_snapshots s ${access.where}`).get(...access.params) as { count?: number };
    return reply.send({ snapshots, page: { limit, offset, total: Number(total.count ?? 0) } });
  });
  app.get("/api/knowledge/source-search", { onRequest: [app.authenticate] }, async (request, reply) => {
    const q = request.query as Record<string, unknown>; const query = queryValue(q, "query") ?? queryValue(q, "q"); if (!query) return reply.status(400).send({ error: "query is required" }); const store = getKnowledgeStore(); const baselineId = queryValue(q, "baselineId"); const snapshotId = queryValue(q, "projectSnapshotId");
    if (!baselineId && !snapshotId) return reply.status(400).send({ error: "baselineId or projectSnapshotId is required" }); if (baselineId) { if (!knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" }); const published = store.db.prepare("SELECT 1 FROM knowledge_source_baselines b JOIN knowledge_artifact_publications p ON p.artifact_set_id=b.artifact_set_id AND p.status='published' WHERE b.id=?").get(baselineId); if (!published) return reply.status(409).send({ error: "Source baseline is not published" }); }
    if (snapshotId) { const snapshot = store.db.prepare("SELECT project_id FROM knowledge_project_snapshots WHERE id=?").get(snapshotId) as { project_id?: string } | undefined; if (!snapshot) return reply.status(404).send({ error: "Project snapshot not found" }); if (snapshot.project_id ? !canReadProject(request.user.id, snapshot.project_id) : !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" }); }
    const limit = parseBoundedInt(q.limit, 10, 1, 50); const where = ["knowledge_source_chunks_fts MATCH ?"]; const params: unknown[] = [query]; if (baselineId) { where.push("c.baseline_id=?"); params.push(baselineId); } if (snapshotId) { where.push("c.snapshot_id=?"); params.push(snapshotId); }
    const rows = store.db.prepare(`SELECT c.id,c.relative_path,c.symbol,c.line_start,c.line_end,c.content,c.content_sha256,c.parser_version,b.solution,b.version FROM knowledge_source_chunks_fts f JOIN knowledge_source_chunks c ON c.id=f.chunk_id LEFT JOIN knowledge_source_baselines b ON b.id=c.baseline_id WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`).all(...params, limit);
    return reply.send({ results: rows, page: { limit, total: rows.length } });
  });
  app.get("/api/knowledge/source-baselines/:id/files", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore(); if (!knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const baseline = store.db.prepare("SELECT b.id,b.solution,b.version,b.manifest_sha256,b.created_at,b.artifact_set_id FROM knowledge_source_baselines b JOIN knowledge_artifact_publications p ON p.artifact_set_id=b.artifact_set_id AND p.status='published' WHERE b.id=?").get(id); if (!baseline) return reply.status(404).send({ error: "Source baseline not found" });
    const query = request.query as Record<string, unknown>; const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    const files = store.db.prepare("SELECT id,relative_path AS path,sha256,size_bytes AS size,language FROM knowledge_source_files WHERE baseline_id=? ORDER BY relative_path LIMIT ? OFFSET ?").all(id, limit, offset);
    const total = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_source_files WHERE baseline_id=?").get(id) as { count?: number };
    return reply.send({ baseline, files, page: { limit, offset, total: Number(total.count ?? 0) } });
  });
  app.post("/api/knowledge/source-baselines/compare", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ oldBaselineId: z.string(), projectSnapshotId: z.string(), newBaselineId: z.string() }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid baseline comparison request", details: body.error.issues });
    const store = getKnowledgeStore(); if (!knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const published = store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_source_baselines b JOIN knowledge_artifact_publications p ON p.artifact_set_id=b.artifact_set_id AND p.status='published' WHERE b.id IN (?,?)").get(body.data.oldBaselineId, body.data.newBaselineId) as { n?: number };
    if (Number(published.n ?? 0) !== 2) return reply.status(409).send({ error: "Both source baselines must be published" });
    const snapshot = store.db.prepare("SELECT project_id FROM knowledge_project_snapshots WHERE id=?").get(body.data.projectSnapshotId) as { project_id?: string } | undefined;
    if (!snapshot) return reply.status(404).send({ error: "Project snapshot not found" }); if (snapshot.project_id && !canReadProject(request.user.id, snapshot.project_id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const manifest = (table: string, id: string): SourceManifest => {
      const rows = store.db.prepare(`SELECT relative_path AS path,sha256,size_bytes AS size,language FROM ${table} WHERE ${table === "knowledge_project_snapshot_files" ? "snapshot_id" : "baseline_id"}=? ORDER BY relative_path`).all(id) as Array<{ path: string; sha256: string; size: number; language?: string }>;
      if (!rows.length) throw new Error("Source snapshot not found or empty"); return { root: id, files: rows, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
    };
    try {
      const changes = compareSourceUpgradeWithSymbols(store, compareSourceBaselines(manifest("knowledge_source_files", body.data.oldBaselineId), manifest("knowledge_project_snapshot_files", body.data.projectSnapshotId), manifest("knowledge_source_files", body.data.newBaselineId)), body.data.oldBaselineId, body.data.projectSnapshotId, body.data.newBaselineId);
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
    const query = request.query as Record<string, unknown>;
    const limit = parseBoundedInt(query.limit, 100, 1, 500);
    const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    const version = queryValue(query, "productVersion") ?? queryValue(query, "sampleManagerVersion");
    const search = queryValue(query, "q");
    const includeReview = request.user.isAdmin && queryValue(query, "includeReview") === "true";
    const requestedProject: string | undefined = undefined;
    const requestedEnvironment: string | undefined = undefined;
    let visibility;
    try {
      if (requestedEnvironment && !requestedProject) return reply.status(400).send({ error: "environment requires projectId" });
      const provider = new MigrationController(store).activeProductProvider();
      if (provider === "relay_local") {
        if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
        if (requestedProject && !request.user.isAdmin && !store.canRead(request.user.id, requestedProject)) return reply.status(403).send({ error: "Knowledge access denied" });
        visibility = { provider: "relay_local" as const, documents: [] };
      } else visibility = await productCatalogVisibility(store, { userId: request.user.id, isAdmin: request.user.isAdmin, projectId: requestedProject, environment: requestedEnvironment });
    }
    catch (error) { return sendError(reply, error, error instanceof WeKnoraError ? 503 : 403); }
    // The local provider has an explicit scope predicate, avoiding a JSON scan
    // over every binding. Engine visibility still carries product-version
    // mappings and therefore uses the authorized JSON projection.
    const documentKindWhere = "d.kind = 'product_document' AND d.lifecycle IN ('approved','verified')";
    const visibilityWhere = visibility.provider === "relay_local"
      ? `${documentKindWhere} AND EXISTS (SELECT 1 FROM knowledge_product_classifications pc WHERE pc.document_id=d.id AND pc.classification='product')`
      : `${documentKindWhere} AND EXISTS (SELECT 1 FROM json_each(?) visible WHERE json_extract(visible.value,'$.documentId')=d.id AND json_extract(visible.value,'$.productVersion') IS b.product_version)`;
    const visibilityParams: unknown[] = visibility.provider === "relay_local"
      ? []
      : [JSON.stringify(visibility.documents)];
    const where = [visibilityWhere];
    const params: unknown[] = [...visibilityParams];
    const aggregateWhere = [visibilityWhere];
    const aggregateParams: unknown[] = [...visibilityParams];
    if (!includeReview) {
      where.push("b.status = 'active'");
      aggregateWhere.push("b.status = 'active'");
    }
    if (version) {
      where.push("b.product_version = ?");
      params.push(version);
      aggregateWhere.push("b.product_version = ?");
      aggregateParams.push(version);
    }
    if (search) { where.push("(lower(t.canonical_title) LIKE ? OR lower(t.canonical_key) LIKE ?)"); params.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`); }
    let rows: KnowledgeRow[];
    let total = 0;
    if (visibility.provider === "relay_local") {
      // Walk the title index to find the requested page, then aggregate only
      // the bindings for those topic ids. The old grouped query had to join
      // and distinct all visible bindings before LIMIT could be applied.
      const matchingBinding = `EXISTS (
        SELECT 1
        FROM knowledge_product_document_bindings b INDEXED BY idx_product_bindings_topic_version_document
        JOIN knowledge_product_documents p ON p.id=b.document_id
        JOIN knowledge_documents d ON d.id=b.document_id
        WHERE b.topic_id=t.id AND ${where.join(" AND ")}
      )`;
      rows = store.db.prepare(`SELECT t.id,t.canonical_key,t.canonical_title,t.kind,t.domain,t.metadata_json
        FROM knowledge_topics t
        WHERE ${matchingBinding}
        ORDER BY t.canonical_title,t.id LIMIT ? OFFSET ?`).all(...params, limit, offset) as KnowledgeRow[];
      const count = store.db.prepare(`SELECT COUNT(*) AS count
        FROM knowledge_topics t
        WHERE ${matchingBinding}`).get(...params) as { count?: number };
      total = Number(count.count ?? 0);
      const topicIds = rows.map((row) => String(row.id));
      if (topicIds.length) {
        const placeholders = topicIds.map(() => "?").join(",");
        const aggregateRows = store.db.prepare(`SELECT b.topic_id,
          COUNT(DISTINCT b.product_version) AS version_count,
          COUNT(DISTINCT COALESCE(json_extract(p.metadata_json, '$.normalizedContentSha256'), b.document_id)) AS revision_count,
          MAX(b.updated_at) AS updated_at
          FROM knowledge_product_document_bindings b
          JOIN knowledge_product_documents p ON p.id=b.document_id
          JOIN knowledge_documents d ON d.id=b.document_id
          WHERE b.topic_id IN (${placeholders}) AND ${aggregateWhere.join(" AND ")}
          GROUP BY b.topic_id`).all(...topicIds, ...aggregateParams) as Array<{ topic_id: string; version_count?: number; revision_count?: number; updated_at?: string }>;
        const aggregatesByTopic = new Map(aggregateRows.map((row) => [row.topic_id, row]));
        rows = rows.map((row) => {
          const aggregate = aggregatesByTopic.get(String(row.id));
          return { ...row, version_count: aggregate?.version_count ?? 0, revision_count: aggregate?.revision_count ?? 0, updated_at: aggregate?.updated_at };
        });
      }
    } else {
      rows = store.db.prepare(`SELECT t.id,t.canonical_key,t.canonical_title,t.kind,t.domain,t.metadata_json,
        COUNT(DISTINCT b.product_version) AS version_count, COUNT(DISTINCT COALESCE(json_extract(p.metadata_json, '$.normalizedContentSha256'), b.document_id)) AS revision_count,
        MAX(b.updated_at) AS updated_at, COUNT(*) OVER() AS total_count
        FROM knowledge_topics t JOIN knowledge_product_document_bindings b ON b.topic_id=t.id JOIN knowledge_product_documents p ON p.id=b.document_id JOIN knowledge_documents d ON d.id=b.document_id
        WHERE ${where.join(" AND ")} GROUP BY t.id ORDER BY t.canonical_title,t.id LIMIT ? OFFSET ?`).all(...params, limit, offset) as KnowledgeRow[];
      total = Number(rows[0]?.total_count ?? 0);
      if (!rows.length && offset > 0) {
        const count = store.db.prepare(`SELECT COUNT(DISTINCT t.id) AS count FROM knowledge_topics t JOIN knowledge_product_document_bindings b ON b.topic_id=t.id JOIN knowledge_product_documents p ON p.id=b.document_id JOIN knowledge_documents d ON d.id=b.document_id WHERE ${where.join(" AND ")}`).get(...params) as { count?: number };
        total = Number(count.count ?? 0);
      }
    }
    const topicIds = rows.map((row) => String(row.id));
    const versionsByTopic = new Map<string, string[]>();
    if (topicIds.length) {
      const placeholders = topicIds.map(() => "?").join(",");
      const versionRows = store.db.prepare(`SELECT topic_id,product_version FROM (
        SELECT b.topic_id,b.product_version,ROW_NUMBER() OVER (PARTITION BY b.topic_id ORDER BY b.product_version) AS version_rank
        FROM knowledge_product_document_bindings b JOIN knowledge_documents d ON d.id=b.document_id JOIN knowledge_product_documents p ON p.id=b.document_id
        WHERE b.topic_id IN (${placeholders}) AND ${visibilityWhere}${version ? " AND b.product_version=?" : ""}${includeReview ? "" : " AND b.status='active'"}
      ) WHERE version_rank<=? ORDER BY topic_id,product_version`).all(...topicIds, ...visibilityParams, ...(version ? [version] : []), 100) as Array<{ topic_id: string; product_version: string }>;
      for (const row of versionRows) (versionsByTopic.get(row.topic_id) ?? (versionsByTopic.set(row.topic_id, []), versionsByTopic.get(row.topic_id)!)).push(row.product_version);
    }
    return reply.send({ topics: rows.map(({ total_count: _total, ...row }) => {
      const versionCount = Number(row.version_count ?? 0);
      return { ...row, versions: versionsByTopic.get(String(row.id)) ?? [], versionsTruncated: versionCount > 100, versionCount, revisionCount: Number(row.revision_count ?? 0), metadata: safeRows(() => JSON.parse(String(row.metadata_json ?? "{}")), {}) };
    }), page: { limit, offset, total } });
  });

  app.get("/api/knowledge/product-topics/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id);
    const store = getKnowledgeStore();
    const topic = store.db.prepare("SELECT * FROM knowledge_topics WHERE id=?").get(id) as KnowledgeRow | undefined;
    if (!topic) return reply.status(404).send({ error: "Product topic not found" });
    const query = request.query as Record<string, unknown>;
    const limit = parseBoundedInt(query.limit, 100, 1, 200);
    const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    const requestedProject: string | undefined = undefined;
    const requestedEnvironment: string | undefined = undefined;
    const includeReview = request.user.isAdmin && queryValue(query, "includeReview") === "true";
    let visibility;
    try {
      if (requestedEnvironment && !requestedProject) return reply.status(400).send({ error: "environment requires projectId" });
      const provider = new MigrationController(store).activeProductProvider();
      if (provider === "relay_local") {
        if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
        if (requestedProject && !request.user.isAdmin && !store.canRead(request.user.id, requestedProject)) return reply.status(403).send({ error: "Knowledge access denied" });
        visibility = { provider: "relay_local" as const, documents: [] };
      } else visibility = await productCatalogVisibility(store, { userId: request.user.id, isAdmin: request.user.isAdmin, projectId: requestedProject, environment: requestedEnvironment });
    }
    catch (error) { return sendError(reply, error, error instanceof WeKnoraError ? 503 : 403); }
    const documentKindWhere = "d.kind = 'product_document' AND d.lifecycle IN ('approved','verified')";
    const visibilityWhere = visibility.provider === "relay_local"
      ? `${documentKindWhere} AND EXISTS (SELECT 1 FROM knowledge_product_classifications pc WHERE pc.document_id=d.id AND pc.classification='product')`
      : `${documentKindWhere} AND EXISTS (SELECT 1 FROM json_each(?) visible WHERE json_extract(visible.value,'$.documentId')=d.id AND json_extract(visible.value,'$.productVersion') IS b.product_version)`;
    const visibilityParams: unknown[] = visibility.provider === "relay_local"
      ? []
      : [JSON.stringify(visibility.documents)];
    const statusWhere = includeReview ? "" : " AND b.status='active'";
    const rows = store.db.prepare(`SELECT b.*,d.title,d.body,d.lifecycle,d.source_locator,d.source_sha256,d.project_id AS document_project_id,d.updated_at AS document_updated_at,
      p.document_family_id,p.document_type,p.language,p.authority,p.sections_json,p.metadata_json,COUNT(*) OVER() AS total_count
      FROM knowledge_product_document_bindings b JOIN knowledge_documents d ON d.id=b.document_id
      JOIN knowledge_product_documents p ON p.id=d.id WHERE b.topic_id=? AND ${visibilityWhere}${statusWhere} ORDER BY b.product_version LIMIT ? OFFSET ?`).all(id, ...visibilityParams, limit, offset) as KnowledgeRow[];
    let total = Number(rows[0]?.total_count ?? 0);
    if (!rows.length && offset > 0) {
      const count = store.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_product_document_bindings b JOIN knowledge_documents d ON d.id=b.document_id JOIN knowledge_product_documents p ON p.id=b.document_id WHERE b.topic_id=? AND ${visibilityWhere}${statusWhere}`).get(id, ...visibilityParams) as { count?: number };
      total = Number(count.count ?? 0);
    }
    if (!request.user.isAdmin && !rows.length) return reply.status(403).send({ error: "Knowledge access denied" });
    if(visibility.provider==="weknora") {
      const versions=await Promise.all(rows.map(async ({ total_count: _total, ...row })=>({topic_id:row.topic_id,document_id:row.document_id,product_version:row.product_version,match_method:row.match_method,match_confidence:row.match_confidence,...await getProductBackend(store,{documentId:String(row.document_id),userId:request.user.id,isAdmin:request.user.isAdmin,projectId:requestedProject,environment:requestedEnvironment})})));
      return reply.send({topic,versions,page:{limit,offset,total}});
    }
    return reply.send({ topic: { ...topic, metadata: safeRows(() => JSON.parse(String(topic.metadata_json ?? "{}")), {}) }, versions: rows.map(({ document_project_id: _project, total_count: _total, ...row }) => ({ ...row, metadata: safeRows(() => JSON.parse(String(row.metadata_json ?? "{}")), {}), sections: safeRows(() => JSON.parse(String(row.sections_json ?? "[]")), []) })), page: { limit, offset, total } });
  });
  app.post("/api/knowledge/product-topic-bindings/:id/review", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const body = z.object({ status: z.enum(["active", "rejected"]), reason: z.string().trim().min(1).max(2000) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid topic binding review", details: body.error.issues });
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore();
    const binding = store.db.prepare("SELECT id,topic_id,document_id,product_version,status FROM knowledge_product_document_bindings WHERE id=?").get(id) as KnowledgeRow | undefined;
    if (!binding) return reply.status(404).send({ error: "Product topic binding not found" });
    const now = new Date().toISOString();
    store.db.prepare("UPDATE knowledge_product_document_bindings SET status=?,updated_at=? WHERE id=?").run(body.data.status, now, id);
    store.audit({ actorId: request.user.id, action: "knowledge.product_topic_binding.review", entityType: "product_topic_binding", entityId: id, details: { topicId: binding.topic_id, documentId: binding.document_id, productVersion: binding.product_version, previousStatus: binding.status, status: body.data.status, reason: body.data.reason } });
    return reply.send({ ok: true, id, status: body.data.status, reviewedAt: now });
  });

  // Stable Product Knowledge API names. Keep /product-docs above as a
  // backwards-compatible alias for existing clients.
  app.get("/api/knowledge/product-documents", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>; const store = getKnowledgeStore();
    if(new MigrationController(store).activeProductProvider()==="weknora") {
      const value=(key:string)=>queryValue(query,key),limit=parseBoundedInt(query.limit,100,1,500),offset=parseBoundedInt(query.offset,0,0,1_000_000);
      return reply.send(await listEngineProductBackend(store,{userId:request.user.id,isAdmin:false,sampleManagerVersion:value("sampleManagerVersion"),product:value("product"),solution:value("solution"),module:value("module"),documentType:value("documentType"),language:value("language"),authority:value("authority"),status:value("status"),limit,offset}));
    }
    const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000); const params: unknown[] = []; const where = ["d.kind='product_document'", "d.lifecycle IN ('approved','verified')"];
    const filters: Array<[string, string]> = [["d.project_name_snapshot", "product"], ["d.samplemanager_version", "sampleManagerVersion"], ["d.solution", "solution"], ["d.module", "module"], ["p.document_type", "documentType"], ["p.language", "language"], ["p.authority", "authority"], ["p.document_family_id", "documentFamilyId"]];
    for (const [column, key] of filters) { const value = queryValue(query, key); if (value) { where.push(`${column} = ?`); params.push(value); } }
    const status = queryValue(query, "status"); if (status) { where.push("d.lifecycle = ?"); params.push(status); }
    where.push("EXISTS (SELECT 1 FROM knowledge_product_classifications pc WHERE pc.document_id=d.id AND pc.classification='product')");
    const sortColumn = ({ updatedAt: "d.updated_at", title: "d.title", version: "p.version", sourcePath: "p.source_path" } as Record<string, string>)[queryValue(query, "sort") ?? "updatedAt"] ?? "d.updated_at";
    const order = String(queryValue(query, "order") ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const rows = store.db.prepare(`SELECT d.id,d.title,d.body,d.lifecycle,d.project_id,d.project_name_snapshot,d.samplemanager_version,d.solution,d.module,d.environment,d.source_locator,d.source_commit,d.source_sha256,d.created_at,d.updated_at,p.document_family_id,p.document_type,p.language,p.authority,p.source_path,p.version,p.sections_json,p.metadata_json,p.diff_review_status,p.diff_reviewed_at,p.topic_group_id,p.engine_external_document_id,p.engine_knowledge_base_id,p.engine_chunk_ids_json,p.engine_status,p.engine_parse_status,p.engine_verified_at,p.engine_model_provenance_json,p.engine_failure_code,p.engine_failure_message,p.engine_attempt_count,p.engine_published_at,p.engine_deprecated_at,p.engine_updated_at,(SELECT COUNT(*) FROM knowledge_chunks c WHERE c.document_id=d.id) AS chunk_count FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE ${where.join(" AND ")} ORDER BY ${sortColumn} ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as KnowledgeRow[];
    const total = store.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE ${where.join(" AND ")}`).get(...params) as { count?: number };
    return reply.send({ documents: rows.map((row) => ({ ...safeDocument(row, false, undefined, store.getScopeBinding(String(row.id))), chunkCount: Number(row.chunk_count ?? 0), lastIndexedAt: row.updated_at })), page: { limit, offset, total: Number(total.count ?? 0) } });
  });

  app.get("/api/knowledge/product-documents/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    try {
      const document=await readPublicProduct(getKnowledgeStore(),{documentId:String((request.params as {id:string}).id),chunkId:queryValue(request.query as Record<string,unknown>,"chunkId")});
      if (!knowledgeUserEnabled(request.user.id)) return reply.status(403).send({ error: "Product Knowledge access denied" });
      return reply.send({document,sections:[]});
    }catch(error){return sendError(reply,error,error instanceof WeKnoraError?503:404);}
  });

  app.post("/api/knowledge/product-documents/import", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ root: z.string().min(1).optional(), projectId: z.number().int().positive().optional(), path: z.string().min(1).optional(), classification: z.enum(["product", "project"]), product: z.string().max(200).optional(), sampleManagerVersion: z.string().max(80).optional(), solution: z.string().max(200).optional(), module: z.string().max(200).optional(), language: z.string().max(20).optional(), authority: z.string().max(80).optional(), documentFamilyId: z.string().max(200).optional(), manifestPath: z.string().min(1).optional() }).refine((value) => Boolean(value.root || (value.projectId && value.path)), "root or projectId/path is required").refine(value => value.classification !== "project" || Boolean(value.projectId), "projectId is required for project material").safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid product document import", details: body.error.issues });
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    try {
      if (body.data.projectId) resolveProject(request.user.id,body.data.projectId);
      const root = body.data.root ?? (() => { const project = db.select().from(projects).where(and(eq(projects.id, body.data.projectId!), eq(projects.userId, request.user.id))).get(); if (!project) throw new Error("Project not found"); return resolveWorkspacePath(project.workspacePath, body.data.path!, { mustExist: true }); })();
      if (!existsSync(root)) return reply.status(403).send({ error: "An existing source directory or ZIP is required" });
      const store = getKnowledgeStore(); const key = idempotencyKey(request);
      const report = replayOrRun(store, request.user.id, "product-documents:import", key, () => enqueueProductImport(store, { ...body.data, root, sourceProjectId: body.data.projectId ? String(body.data.projectId) : undefined, sampleManagerVersion: body.data.sampleManagerVersion ?? "", idempotencyKey: key }), body.data);
      store.audit({ actorId: request.user.id, action: "knowledge.product_documents.import", entityType: "product_document_batch", entityId: report.id, details: { ...report } });
      return reply.status(202).send(report);
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/product-documents/imports", { onRequest: [app.authenticate] }, async (request, reply) => {
    const store = getKnowledgeStore(); const query = request.query as Record<string, unknown>; const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    return reply.send(listVisibleImportRuns(store,request.user.id,limit,offset));
  });

  app.get("/api/knowledge/product-documents/imports/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore();
    const found = store.db.prepare("SELECT id,status,imported,skipped,failed,started_at,finished_at,source_commit,source_sha256,batch_metadata_json FROM knowledge_ingest_runs WHERE id=?").get(id) as KnowledgeRow | undefined;
    if (!found || !canReadImportRun(store,request.user.id,found)) return reply.status(404).send({ error: "Ingest run not found" });
    const {batch_metadata_json:_metadata,...run}=found;
    const items = safeRows(() => store.db.prepare("SELECT id,relative_path,document_id,status,source_sha256,warning,error,created_at,updated_at FROM knowledge_product_document_items WHERE run_id=? ORDER BY relative_path").all(id), []);
    return reply.send({ run, items });
  });
  app.get("/api/knowledge/ingest-jobs/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore(); const row = store.db.prepare("SELECT id,kind,status,attempts,available_at,started_at,finished_at,result_json,payload_json,error,created_at,updated_at FROM knowledge_ingest_jobs WHERE id=?").get(id) as KnowledgeRow | undefined;
    if (!row) return reply.status(404).send({ error: "Ingest job not found" });
    if (row.kind === "product_migration" && !request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const payload=safeRows(()=>JSON.parse(String(row.payload_json ?? "{}")) as Record<string,unknown>,{});
    const input=payload.input && typeof payload.input === "object" ? payload.input as Record<string,unknown> : {};
    const sourceProjectId=payload.sourceProjectId ?? payload.projectId ?? input.sourceProjectId ?? input.projectId;
    if (sourceProjectId ? !canReadProject(request.user.id,String(sourceProjectId)) : !knowledgeUserEnabled(request.user.id)) return reply.status(404).send({error:"Ingest job not found"});
    const {payload_json:_payload,...safeRow}=row;
    return reply.send({ job: { ...safeRow, result: row.result_json ? safeRows(() => JSON.parse(String(row.result_json)), undefined) : undefined } });
  });

  app.post("/api/knowledge/product-documents/imports/:id/retry", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore();
    const run = store.db.prepare("SELECT id,source_root,batch_metadata_json FROM knowledge_ingest_runs WHERE id=?").get(id) as KnowledgeRow | undefined;
    if (!run?.source_root || !canReadImportRun(store,request.user.id,run)) return reply.status(404).send({ error: "Retry source is unavailable" });
    try {
      const metadata = safeRows(() => JSON.parse(String(run.batch_metadata_json ?? "{}")), {}) as Record<string, unknown>;
      const key = idempotencyKey(request) ?? `retry:${id}`;
      const report = replayOrRun(store, request.user.id, "product-documents:retry", key, () => enqueueProductImport(store, { root: String(run.source_root), sampleManagerVersion: String(metadata.sampleManagerVersion ?? ""), product: metadata.product ? String(metadata.product) : undefined, solution: metadata.solution ? String(metadata.solution) : undefined, module: metadata.module ? String(metadata.module) : undefined, language: metadata.language ? String(metadata.language) : undefined, authority: metadata.authority ? String(metadata.authority) : undefined, documentFamilyId: metadata.documentFamilyId ? String(metadata.documentFamilyId) : undefined, manifestPath: metadata.manifestPath ? String(metadata.manifestPath) : undefined, classification: metadata.classification === "product" || metadata.classification === "project" ? metadata.classification : undefined, sourceProjectId: metadata.sourceProjectId ? String(metadata.sourceProjectId) : undefined, idempotencyKey: key }), { id });
      store.audit({ actorId: request.user.id, action: "knowledge.product_documents.retry", entityType: "product_document_batch", entityId: id, details: { retryRunId: report.id } });
      return reply.status(202).send(report);
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/product-documents/versions", { onRequest: [app.authenticate] }, async (_request, reply) => {
    const store = getKnowledgeStore();
    const query = _request.query as Record<string, unknown>; const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    const requestedProject: string | undefined = undefined, requestedEnvironment: string | undefined = undefined;
    if (requestedEnvironment && !requestedProject) return reply.status(400).send({ error: "environment requires projectId" });
    let provider: "relay_local" | "weknora", where: string, params: unknown[];
    try {
      provider = new MigrationController(store).activeProductProvider();
      if (provider === "relay_local") {
        if (!_request.user.isAdmin && !knowledgeReadAllowed(store, _request.user.id)) throw new Error("Knowledge access denied");
        assertProductScope(store, { userId: _request.user.id, isAdmin: _request.user.isAdmin, projectId: requestedProject, environment: requestedEnvironment });
        where = "d.kind='product_document' AND d.lifecycle IN ('approved','verified') AND EXISTS (SELECT 1 FROM knowledge_product_classifications pc WHERE pc.document_id=d.id AND pc.classification='product')";
        params = [];
      } else {
        const visibility = await productCatalogVisibility(store, { userId: _request.user.id, isAdmin: _request.user.isAdmin, projectId: requestedProject, environment: requestedEnvironment });
        where = "EXISTS (SELECT 1 FROM json_each(?) visible WHERE json_extract(visible.value,'$.documentId')=p.id AND json_extract(visible.value,'$.productVersion') IS p.version)";
        params = [JSON.stringify(visibility.documents)];
      }
    } catch (error) { return sendError(reply, error, error instanceof WeKnoraError ? 503 : 403); }
    const source = provider === "relay_local" ? "knowledge_product_documents p JOIN knowledge_documents d ON d.id=p.id" : "knowledge_product_documents p";
    const rows = store.db.prepare(`SELECT p.document_family_id,p.version,COUNT(*) AS documents,MAX(p.updated_at) AS updated_at FROM ${source} WHERE ${where} GROUP BY p.document_family_id,p.version ORDER BY p.document_family_id,p.version LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = store.db.prepare(`SELECT COUNT(*) AS count FROM (SELECT p.document_family_id,p.version FROM ${source} WHERE ${where} GROUP BY p.document_family_id,p.version)`).get(...params) as { count?: number };
    return reply.send({ versions: rows, page: { limit, offset, total: Number(total.count ?? 0) } });
  });

  app.get("/api/knowledge/product-documents/diffs", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>; const requestedProject: string | undefined = undefined; const requestedEnvironment: string | undefined = undefined; const left = queryValue(query, "left"); const right = queryValue(query, "right"); const store = getKnowledgeStore();
    if (requestedProject && !request.user.isAdmin && !store.canRead(request.user.id, requestedProject)) return reply.status(403).send({ error: "Knowledge access denied" });
    if (!requestedProject && requestedEnvironment) return reply.status(400).send({ error: "environment requires projectId" });
    if (left && right) {
      const exists = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_product_documents WHERE id IN (?,?)").get(left, right) as { count?: number };
      if (Number(exists.count) !== 2) return reply.status(404).send({ error: "Product document not found" });
      try {const diff=await diffProductBackend(store,{leftId:left,rightId:right,userId:request.user.id,isAdmin:false}); if(!knowledgeUserEnabled(request.user.id))return reply.status(403).send({error:"Product Knowledge access denied"}); return reply.send({diff});}catch(error){return sendError(reply,error,error instanceof WeKnoraError?503:404);}
    }
    const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    const rows = store.db.prepare("SELECT id,document_id,against_document_id,report_json,review_status,reviewed_by,reviewed_at,created_at,updated_at FROM knowledge_product_document_revisions ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(limit, offset).flatMap((row: any) => {
      const allowed=(id:string)=>Boolean(store.db.prepare("SELECT 1 FROM knowledge_documents d JOIN knowledge_product_classifications c ON c.document_id=d.id WHERE d.id=? AND d.lifecycle IN ('approved','verified') AND c.classification='product'").get(id));
      if(!allowed(row.document_id)||!allowed(row.against_document_id))return [];
      const {report_json,...metadata}=row;
      return [{...metadata,...(new MigrationController(store).activeProductProvider()==="relay_local"?{report:safeRows(()=>JSON.parse(String(report_json)),undefined)}:{requiresRefresh:true})}];
    });
    return reply.send({ diffs: rows, page: { limit, offset, total: rows.length } });
  });

  app.get("/api/knowledge/product-documents/search", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>; const value = (key: string) => queryValue(query, key), q = value("q") ?? value("query");
    if (!q) return reply.send({ query: "", results: [], page: { limit: 0, offset: 0, total: 0 } });
    const limit = parseBoundedInt(query.limit, 50, 1, 100), offset = parseBoundedInt(query.offset, 0, 0, 1000000);
    try {
      const found = await searchPublicProductChunks(getKnowledgeStore(), { query: q, productVersion: value("sampleManagerVersion") ?? value("productVersion"), solution: value("solution"), module: value("module"), language: value("language"), limit: Math.min(100, limit + offset) });
      if (!knowledgeUserEnabled(request.user.id)) return reply.status(403).send({ error: "Product Knowledge access denied" });
      const results = found.references.slice(offset, offset + limit).map(reference => ({ ...reference, id: reference.documentId, kind: "product_document", summary: reference.snippet, sampleManagerVersion: reference.version }));
      return reply.send({ query: q, results, page: { limit, offset, total: found.references.length } });
    } catch (error) { return sendError(reply, error, 503); }
  });

  // Operations plane: these endpoints deliberately return summaries and
  // provenance, never raw credentials or complete event payloads.
  app.get("/api/knowledge/operations/capture", { onRequest: [app.authenticate] }, async (request, reply) => {
    try {
      const query = request.query as Record<string, unknown>; const store = getKnowledgeStore(); const projectId = query.projectId ? resolveProject(request.user.id, query.projectId).projectId : undefined;
      const health = knowledgeHealth(store); const backlog = safeRows(() => store.consumerBacklog("knowledge-capture"), { count: 0 }); const owned=userProjectIds(request.user.id); const deadLetters = readDeadLetters(store, 100).filter(item=>owned.includes(String(item.projectId ?? "")));
      const heartbeat = health.captureWorker;
      const status = health.database.status !== "available" ? "Unavailable" : health.spool.degraded || heartbeat.status !== "running" ? "Degraded" : "Available";
      return reply.send({ status, projectId, checkedAt: new Date().toISOString(), capture: { lastSuccessAt: heartbeat.lastSeenAt, lastError: health.spool.lastDrainErrorClass, lastErrorAt: health.spool.lastDrainErrorAt, consecutiveFailures: Number(health.spool.failedWrites ?? 0) + Number(health.spool.drainFailures ?? 0) }, backlog, spool:health.spool, deadLetterCount: deadLetters.length, deadLetters: deadLetters.slice(-50), diagnostics: [heartbeat.status !== "running" ? "remote-ops-mcp heartbeat is stale or not seen" : undefined, projectId ? undefined : "Project filter not selected; showing shared capture status"].filter(Boolean) });
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/operations/capture/events", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>; const store = getKnowledgeStore(); const projectId = query.projectId ? resolveProject(request.user.id, query.projectId).projectId : undefined; const limit = parseBoundedInt(query.limit, 100, 1, 500); const params: unknown[] = [];
    const where = ["1=1"]; if (projectId) { where.push("project_id=?"); params.push(projectId); } else {
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
    const rows = store.db.prepare("SELECT c.event_id, c.attempts, c.available_at, c.claimed_until, c.last_error, e.type, e.occurred_at, e.project_id, e.job_id, e.deployment_id FROM knowledge_outbox_claims c JOIN relay_domain_events e ON e.id = c.event_id WHERE c.consumer_name = ? AND c.consumed_at IS NULL AND e.project_id IN (SELECT value FROM json_each(?)) ORDER BY c.available_at ASC LIMIT ?").all("knowledge-capture",JSON.stringify(userProjectIds(request.user.id)),limit) as KnowledgeRow[];
    const backlog = store.consumerBacklog("knowledge-capture");
    return reply.send({ consumer: "knowledge-capture", pending: backlog.count, oldestAvailableAt: backlog.oldestAvailableAt, entries: rows.map((row) => ({ eventId: row.event_id, type: row.type, occurredAt: row.occurred_at, projectId: row.project_id, jobId: row.job_id, deploymentId: row.deployment_id, attempts: row.attempts, availableAt: row.available_at, claimedUntil: row.claimed_until, lastError: row.last_error ? "Event processing failed" : undefined })) });
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
    const result = replayOrRun(store, request.user.id, "operations:capture-replay", idempotencyKey(request), () => store.replayCaptureEvents({ ...body.data, projectId,allowedProjectIds:userProjectIds(request.user.id) }), body.data);
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
    const owned = userProjectIds(request.user.id);
    const page=await readDeadLetterPage([`${stateRoot}/knowledge-event-spool.jsonl.dead-letter`, `${stateRoot}/knowledge-capture-dead-letter.jsonl`], limit, offset, owned);
    return reply.send({...page,deadLetters:page.deadLetters.map(({sourcePath:_sourcePath,error,...record})=>({...record,error:error ? "Event processing failed" : undefined}))});
  });

  app.post("/api/knowledge/operations/capture/smoke-test", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin && !knowledgeReviewAllowed(getKnowledgeStore(), request.user.id)) return reply.status(403).send({ error: "Reviewer access required" });
    const body = z.object({ projectId: z.number().int().positive().optional(), eventId: z.string().min(1).optional() }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid smoke-test request" });
    const store = getKnowledgeStore(); const projectId = body.data.projectId ? resolveProject(request.user.id, body.data.projectId).projectId : undefined;
    const result = replayOrRun(store, request.user.id, "operations:capture-smoke-test", idempotencyKey(request), () => {
      const allowed=JSON.stringify(projectId ? [projectId] : userProjectIds(request.user.id));
      const event = body.data.eventId ? store.db.prepare("SELECT id,type,project_id,project_name_snapshot,job_id,deployment_id,event_key,occurred_at,payload_json FROM relay_domain_events WHERE id=? AND project_id IN (SELECT value FROM json_each(?))").get(body.data.eventId,allowed) : store.db.prepare("SELECT id,type,project_id,project_name_snapshot,job_id,deployment_id,event_key,occurred_at,payload_json FROM relay_domain_events WHERE project_id IN (SELECT value FROM json_each(?)) ORDER BY occurred_at DESC LIMIT 1").get(allowed);
      const payload = event ? safeRows(() => JSON.parse(String((event as KnowledgeRow).payload_json ?? "{}")), {}) as Record<string, unknown> : {};
      const classified = event ? classifyRelayEvent({ id: String((event as KnowledgeRow).id), type: String((event as KnowledgeRow).type) as any, projectId: (event as KnowledgeRow).project_id ? String((event as KnowledgeRow).project_id) : undefined, projectNameSnapshot: (event as KnowledgeRow).project_name_snapshot ? String((event as KnowledgeRow).project_name_snapshot) : undefined, jobId: (event as KnowledgeRow).job_id ? String((event as KnowledgeRow).job_id) : undefined, deploymentId: (event as KnowledgeRow).deployment_id ? String((event as KnowledgeRow).deployment_id) : undefined, occurredAt: String((event as KnowledgeRow).occurred_at), eventKey: String((event as KnowledgeRow).event_key), payload }) : undefined;
      const eventProjectId = projectId ?? (event as KnowledgeRow | undefined)?.project_id;
      const candidateCount = eventProjectId ? Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents WHERE kind='candidate' AND project_id=?").get(eventProjectId) as { count?: number }).count ?? 0) : 0;
      const evidenceCount = eventProjectId ? Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_evidence WHERE project_id=? AND deleted_at IS NULL").get(eventProjectId) as { count?: number }).count ?? 0) : 0;
      const candidateForEvent = eventProjectId && event ? Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_candidates WHERE project_id=? AND (event_id=? OR job_id=? OR deployment_id=?)").get(eventProjectId, (event as KnowledgeRow).id, (event as KnowledgeRow).job_id ?? null, (event as KnowledgeRow).deployment_id ?? null) as { count?: number }).count ?? 0) : 0;
      const observationForEvent = eventProjectId && event ? Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_observations WHERE project_id=? AND event_id=?").get(eventProjectId,(event as KnowledgeRow).id) as {count?:number}).count ?? 0) : 0;
      const evidenceForEvent = eventProjectId && event ? Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_evidence WHERE project_id=? AND deleted_at IS NULL AND (source_locator LIKE ? OR source_locator LIKE ? OR source_locator LIKE ?)").get(eventProjectId, `%${String((event as KnowledgeRow).id)}%`, `%${String((event as KnowledgeRow).job_id ?? "__no_job__")}%`, `%${String((event as KnowledgeRow).deployment_id ?? "__no_deployment__")}%`) as { count?: number }).count ?? 0) : 0;
      const eventSummary = event ? { id: (event as KnowledgeRow).id, type: (event as KnowledgeRow).type, occurredAt: (event as KnowledgeRow).occurred_at, projectId: (event as KnowledgeRow).project_id, jobId: (event as KnowledgeRow).job_id, deploymentId: (event as KnowledgeRow).deployment_id } : undefined;
      const pipelineComplete=Boolean(event) && (!(classified?.captureCandidate || classified?.storeObservation) || observationForEvent>0);
      return { ok:pipelineComplete, readOnly: true, event: eventSummary, classification: classified, checks: { knowledgeDb: true, eventStore: Boolean(event), candidateProjection: candidateCount, evidenceProjection: evidenceCount, candidateForEvent, observationForEvent,evidenceForEvent,pipelineComplete, spool: knowledgeHealth(store).spool } };
    }, body.data);
    store.audit({ actorId: request.user.id, projectId, action: "knowledge.operations.capture_smoke_test", entityType: "capture", entityId: String((result as any).event?.id ?? "none"), details: { readOnly: true } });
    return reply.send(result);
  });

  app.get("/api/knowledge/operations/ingest-runs", { onRequest: [app.authenticate] }, async (request, reply) => {
    const store = getKnowledgeStore(); if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" }); const query = request.query as Record<string, unknown>; const limit = parseBoundedInt(query.limit, 100, 1, 500); const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    return reply.send(listVisibleImportRuns(store,request.user.id,limit,offset));
  });

  app.get("/api/knowledge/operations/ingest-runs/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore(); if (!request.user.isAdmin && !knowledgeReadAllowed(store, request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" }); const found = store.db.prepare("SELECT id,status,imported,skipped,failed,started_at,finished_at,source_commit,source_sha256,batch_metadata_json FROM knowledge_ingest_runs WHERE id=?").get(id) as KnowledgeRow | undefined; if (!found || !canReadImportRun(store,request.user.id,found)) return reply.status(404).send({ error: "Ingest run not found" }); const {batch_metadata_json:_metadata,...run}=found;
    return reply.send({ run, items: safeRows(() => store.db.prepare("SELECT id,relative_path,document_id,status,source_sha256,warning,error,created_at,updated_at FROM knowledge_product_document_items WHERE run_id=? ORDER BY relative_path").all(id), []), diffs: safeRows(() => store.db.prepare("SELECT id,document_id,against_document_id,review_status,reviewed_by,reviewed_at,created_at,updated_at FROM knowledge_product_document_revisions WHERE document_id IN (SELECT document_id FROM knowledge_product_document_items WHERE run_id=?) OR against_document_id IN (SELECT document_id FROM knowledge_product_document_items WHERE run_id=?)").all(id, id), []) });
  });

  app.post("/api/knowledge/operations/ingest-runs/:id/retry", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore(); const run = store.db.prepare("SELECT id,source_root,batch_metadata_json FROM knowledge_ingest_runs WHERE id=?").get(id) as KnowledgeRow | undefined; if (!run?.source_root || !canReadImportRun(store,request.user.id,run)) return reply.status(404).send({ error: "Retry source is unavailable" });
    const metadata = safeRows(() => JSON.parse(String(run.batch_metadata_json ?? "{}")), {}) as Record<string, unknown>; const key = idempotencyKey(request) ?? `retry:${id}`;
    const report = replayOrRun(store, request.user.id, "operations:ingest-retry", key, () => enqueueProductImport(store, { root: String(run.source_root), sampleManagerVersion: String(metadata.sampleManagerVersion ?? ""), product: metadata.product ? String(metadata.product) : undefined, solution: metadata.solution ? String(metadata.solution) : undefined, module: metadata.module ? String(metadata.module) : undefined, language: metadata.language ? String(metadata.language) : undefined, authority: metadata.authority ? String(metadata.authority) : undefined, documentFamilyId: metadata.documentFamilyId ? String(metadata.documentFamilyId) : undefined, manifestPath: metadata.manifestPath ? String(metadata.manifestPath) : undefined, classification: metadata.classification === "product" || metadata.classification === "project" ? metadata.classification : undefined, sourceProjectId: metadata.sourceProjectId ? String(metadata.sourceProjectId) : undefined, idempotencyKey: key }), { id });
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
    try {
      const intent = validateIntentEnvelope({ ...(body.data.intent as Record<string, unknown>), actorId: request.user.id });
      const { store, projectId } = resolveProject(request.user.id, intent.projectId);
      const session = scopedWorkSessions(store).open({ actorId: request.user.id, idempotencyKey: body.data.idempotencyKey, intent: { ...intent, projectId }, summary: body.data.summary });
      // Replays must still belong to a project the caller currently owns.
      if (session.projectId !== projectId) resolveProject(request.user.id, session.projectId);
      return reply.status(201).send({ session });
    } catch (error) { return sendError(reply, error, 403); }
  });
  app.get("/api/knowledge/sessions", { onRequest: [app.authenticate] }, async (request, reply) => {
    const limit = parseBoundedInt((request.query as Record<string, unknown>).limit, 50, 1, 200); const sessions = scopedWorkSessions().list({ actorId: request.user.id, limit }); return reply.send({ sessions });
  });
  app.get("/api/knowledge/sessions/:id", { onRequest: [app.authenticate] }, async (request, reply) => { try { const session = scopedWorkSessions().get({ actorId: request.user.id, sessionId: String((request.params as { id: string }).id) }); return reply.send({ session }); } catch (error) { return sendError(reply, error, 404); } });
  app.patch("/api/knowledge/sessions/:id", { onRequest: [app.authenticate] }, async (request, reply) => { const body = z.object({ idempotencyKey: z.string().trim().max(300).optional(), patch: z.record(z.unknown()) }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid Work Session update", details: body.error.issues }); try { const session = scopedWorkSessions().update({ actorId: request.user.id, sessionId: String((request.params as { id: string }).id), idempotencyKey: body.data.idempotencyKey, patch: body.data.patch as never }); return reply.send({ session }); } catch (error) { return sendError(reply, error, 403); } });
  app.post("/api/knowledge/sessions/:id/close", { onRequest: [app.authenticate] }, async (request, reply) => { const body = z.object({ idempotencyKey: z.string().trim().max(300).optional(), result: z.object({ summary: z.string().max(8_000).optional(), unknowns: z.array(z.string().max(2_000)).max(100).optional(), acceptanceResults: z.record(z.union([z.boolean(), z.string().max(500)])).optional() }).optional() }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid Work Session close", details: body.error.issues }); try { const session = scopedWorkSessions().close({ actorId: request.user.id, sessionId: String((request.params as { id: string }).id), idempotencyKey: body.data.idempotencyKey, result: body.data.result }); return reply.send({ session }); } catch (error) { return sendError(reply, error, 403); } });
  app.get("/api/knowledge/sessions/:id/summary", { onRequest: [app.authenticate] }, async (request, reply) => {
    try { const query=request.query as Record<string,unknown>; return reply.send(scopedWorkSessions().summarize({actorId:request.user.id,sessionId:String((request.params as {id:string}).id),limit:parseBoundedInt(query.limit,50,1,200),offset:parseBoundedInt(query.offset,0,0,1000000)})); }
    catch(error){return sendError(reply,error,404);}
  });
  app.get("/api/knowledge/sessions/:id/events", { onRequest: [app.authenticate] }, async (request, reply) => { try { const query=request.query as Record<string,unknown>; const summary=scopedWorkSessions().summarize({ actorId: request.user.id, sessionId: String((request.params as { id: string }).id),limit:parseBoundedInt(query.limit,50,1,200),offset:parseBoundedInt(query.offset,0,0,1000000) }); return reply.send({ events:summary.events,pagination:summary.pagination.events }); } catch (error) { return sendError(reply, error, 404); } });

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
  app.delete("/api/knowledge/providers/managed/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const store = getKnowledgeStore();
    try {
      const protectedProviderIds = new Set(getEngineManager(store).bindings().map((binding) => binding.providerId));
      return reply.send(await new ProviderSetupService(store).remove(String((request.params as { id: string }).id), request.user.id, protectedProviderIds));
    } catch (error) {
      const status = error instanceof Error && /bound to the active|active reindex job/i.test(error.message) ? 409 : 404;
      return sendError(reply, error, status);
    }
  });
  app.post("/api/knowledge/providers/managed/reindex/:jobId/complete", { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); try { return reply.send({ job: completeVerifiedEngineReindex(getKnowledgeStore(), String((request.params as { jobId: string }).jobId), request.user.id) }); } catch (error) { return sendError(reply, error, 404); } });

  app.get("/api/knowledge/candidate-insights", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const body = z.object({ projectId: z.string().min(1).optional(), status: z.enum(["draft", "accepted", "edited", "rejected"]).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() }).safeParse(query);
    if (!body.success) return reply.status(400).send({ error: "Invalid Candidate Insights query" });
    try { if (body.data.projectId && !request.user.isAdmin) resolveProject(request.user.id, body.data.projectId); return reply.send({ insights: new CandidateInsightReviewService(getKnowledgeStore(), undefined, Boolean(request.user.isAdmin)).list({ actorId: request.user.id, ...body.data, allowedProjectIds: request.user.isAdmin ? undefined : userProjectIds(request.user.id) }) }); } catch (error) { return sendError(reply, error, 403); }
  });
  app.post("/api/knowledge/candidate-insights/compile", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ sessionId: z.string().min(1), evidenceRefs: z.array(z.string().min(1)).max(100), context: z.record(z.unknown()).default({}), providerId: z.string().optional(), async: z.boolean().optional(), retry: z.boolean().optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid Candidate Insight compile request", details: body.error.issues });
    const store = getKnowledgeStore();
    try {
      scopedWorkSessions(store).get({ actorId: request.user.id, sessionId: body.data.sessionId });
      if (body.data.async) return reply.status(202).send(enqueueCandidateInsight(store, { actorId: request.user.id, sessionId: body.data.sessionId, evidenceRefs: body.data.evidenceRefs, context: body.data.context, providerId:body.data.providerId,retry:body.data.retry }));
      const provider = createCandidateInsightProvider(store,body.data.providerId);
      const insight = await new CandidateInsightCompiler(store, provider).compile({ actorId: request.user.id, sessionId: body.data.sessionId, evidenceRefs: body.data.evidenceRefs, context: body.data.context });
      return reply.status(insight.persisted ? 201 : 200).send({ insight });
    } catch (error) { return sendError(reply, error, 400); }
  });
  app.get("/api/knowledge/candidate-insight-jobs/:id", { onRequest: [app.authenticate] }, async (request, reply) => { try { const job=getCandidateInsightJob(getKnowledgeStore(),{actorId:request.user.id,id:String((request.params as {id:string}).id)});scopedWorkSessions().get({actorId:request.user.id,sessionId:job.workSessionId});return reply.send({job}); } catch(error) {return sendError(reply,error,404);} });
  app.get("/api/knowledge/candidate-insights/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    try {
      const store=getKnowledgeStore(), insight=new CandidateInsightReviewService(store,undefined,Boolean(request.user.isAdmin)).get({actorId:request.user.id,id:String((request.params as {id:string}).id)});
      const row=store.db.prepare("SELECT project_id,environment,intent_json,updated_at FROM knowledge_work_sessions WHERE id=? AND project_id=?").get(insight.workSessionId,insight.projectId) as KnowledgeRow|undefined;
      const intent=safeRows(() => JSON.parse(String(row?.intent_json ?? "{}")),{}) as KnowledgeRow;
      const sourceSession=row ? {projectId:row.project_id,environment:row.environment,updatedAt:row.updated_at,intent:{sampleManagerVersion:intent.sampleManagerVersion,solution:intent.solution,module:intent.module}} : undefined;
      return reply.send({insight,sourceSession});
    } catch(error) { return sendError(reply,error,404); }
  });
  app.get("/api/knowledge/candidate-insights/:id/history", { onRequest: [app.authenticate] }, async (request, reply) => { try { return reply.send({ history: new CandidateInsightReviewService(getKnowledgeStore(), undefined, Boolean(request.user.isAdmin)).reviewHistory({ actorId: request.user.id, id: String((request.params as { id: string }).id) }) }); } catch (error) { return sendError(reply, error, 404); } });
  app.get("/api/knowledge/candidate-insights/:id/evidence/:evidenceId", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({error:"Administrator access is required"});
    try { const store=getKnowledgeStore(), params=request.params as {id:string;evidenceId:string}; const content=new EvidenceStore(store,store.evidenceRoot ?? "./data/evidence").readForInsightReview(request.user.id,true,params.id,params.evidenceId); return reply.type("application/octet-stream").header("Content-Disposition","attachment").send(content); } catch(error) { return sendError(reply,error,404); }
  });
  for (const action of ["confirm", "reject"] as const) {
    app.post(`/api/knowledge/candidate-insights/:id/${action}`, { onRequest: [app.authenticate] }, async (request, reply) => {
      const body = z.object({ reason: z.string().trim().min(1).max(2_000) }).safeParse(request.body ?? {});
      if (!body.success) return reply.status(400).send({ error: "A review reason is required" });
      const service = new CandidateInsightReviewService(getKnowledgeStore(), undefined, Boolean(request.user.isAdmin));
      try { return reply.send({ insight: action === "confirm" ? service.confirm({ actorId: request.user.id, id: String((request.params as { id: string }).id), reason: body.data.reason }) : service.reject({ actorId: request.user.id, id: String((request.params as { id: string }).id), reason: body.data.reason }) }); } catch (error) { return sendError(reply, error, 403); }
    });
  }
  app.patch("/api/knowledge/candidate-insights/:id", { onRequest: [app.authenticate] }, async (request, reply) => { const body = z.object({ patch: z.record(z.unknown()), reason: z.string().trim().min(1).max(2_000) }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid Candidate Insight edit" }); try { return reply.send({ insight: new CandidateInsightReviewService(getKnowledgeStore(), undefined, Boolean(request.user.isAdmin)).edit({ actorId: request.user.id, id: String((request.params as { id: string }).id), patch: body.data.patch as never, reason: body.data.reason }) }); } catch (error) { return sendError(reply, error, 403); } });
  app.post("/api/knowledge/candidate-insights/:id/review-scope", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ reason: z.string().trim().min(1).max(2_000), expectedSessionUpdatedAt: z.string().min(1).max(100) }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "A review reason and the displayed Session revision are required" });
    try { return reply.send({ insight: new CandidateInsightReviewService(getKnowledgeStore(), undefined, Boolean(request.user.isAdmin)).reviewScope({ actorId: request.user.id, id: String((request.params as { id: string }).id), ...body.data }) }); }
    catch (error) { return sendError(reply, error, 403); }
  });
  app.post("/api/knowledge/candidate-insights/:id/promote", { onRequest: [app.authenticate] }, async (request, reply) => { const body = z.object({ target: z.enum(["fact", "decision", "case", "pattern"]), reason: z.string().trim().min(1).max(2_000), title: z.string().max(300).optional() }).safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid promotion request" }); try { return reply.send({ promotion: new CandidateInsightReviewService(getKnowledgeStore(), undefined, Boolean(request.user.isAdmin)).promote({ actorId: request.user.id, id: String((request.params as { id: string }).id), ...body.data }) }); } catch (error) { return sendError(reply, error, 403); } });

  app.get("/api/knowledge/confirmed-memories", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const body = z.object({ projectId: z.string().min(1).optional(), scope: z.enum(["project", "general", "both"]).optional(), q: z.string().optional(), type: z.enum(CONFIRMED_MEMORY_TYPES).optional(), environment: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).optional() }).safeParse(query);
    if (!body.success) return reply.status(400).send({ error: "Invalid confirmed Memory query" });
    try { const { q, ...input } = body.data; const found = searchConfirmedMemories(getKnowledgeStore(), webMemoryAccess(request.user), { ...input, query: q }); return reply.send({ memories: found.results, page: found.page, scope: found.scope, generalAccess: found.generalAccess }); } catch (error) { return sendError(reply, error, 403); }
  });
  app.get("/api/knowledge/confirmed-memories/scope-review", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query=request.query as Record<string,unknown>;
    try { return reply.send({ memories:legacyMemoryReviewQueue(getKnowledgeStore(),webMemoryAccess(request.user),{limit:parseBoundedInt(query.limit,50,1,200),offset:parseBoundedInt(query.offset,0,0,1000000)}) }); } catch(error) { return sendError(reply,error,403); }
  });
  app.post("/api/knowledge/confirmed-memories/:id/scope-review", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({error:"Administrator access is required"});
    const body=z.object({scope:z.enum(["project","general"]),reason:z.string().trim().min(1).max(2000),title:z.string().max(300).optional(),statement:z.string().max(8000).optional()}).strict().safeParse(request.body);
    if (!body.success) return reply.status(400).send({error:"Invalid scope review"});
    try { return reply.send(reviewLegacyMemoryScope(getKnowledgeStore(),webMemoryAccess(request.user),{id:String((request.params as {id:string}).id),...body.data})); } catch(error) { return sendError(reply,error,400); }
  });
  app.get("/api/knowledge/confirmed-memories/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    try { return reply.send({ memory: getConfirmedMemory(getKnowledgeStore(), webMemoryAccess(request.user), String((request.params as { id: string }).id)) }); } catch (error) { return sendError(reply, error, 404); }
  });

  app.get("/api/knowledge/memory-submissions", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    try { return reply.send(listMemorySubmissions(getKnowledgeStore(), webMemoryAccess(request.user), { status: queryValue(query, "status"), limit: parseBoundedInt(query.limit, 50, 1, 200), offset: parseBoundedInt(query.offset, 0, 0, 1000000) })); }
    catch (error) { return sendError(reply, error, 403); }
  });
  app.get("/api/knowledge/legacy-candidates/review", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({error:"Administrator access is required"});
    const query=request.query as Record<string,unknown>;
    try {return reply.send({candidates:listLegacyCandidatesForReview(getKnowledgeStore(),webMemoryAccess(request.user),{limit:parseBoundedInt(query.limit,50,1,200),offset:parseBoundedInt(query.offset,0,0,1000000)})});} catch(error) {return sendError(reply,error,403);}
  });
  app.post("/api/knowledge/legacy-candidates/:id/review", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({error:"Administrator access is required"});
    const body=z.object({action:z.enum(["approve","reject","needs_info"]),reason:z.string().trim().min(1).max(2000),scope:z.enum(["project","general"]).optional(),title:z.string().max(300).optional(),statement:z.string().max(8000).optional(),memoryType:z.enum(CONFIRMED_MEMORY_TYPES).optional(),evidenceRefs:z.array(z.string().min(1)).max(100).optional()}).strict().safeParse(request.body);
    if(!body.success) return reply.status(400).send({error:"Invalid historical candidate review"});
    try {return reply.send(reviewLegacyCandidate(getKnowledgeStore(),webMemoryAccess(request.user),{id:String((request.params as {id:string}).id),...body.data}));} catch(error) {return sendError(reply,error,400);}
  });
  app.get("/api/knowledge/legacy-candidates/:id/evidence/:evidenceId", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({error:"Administrator access is required"});
    try {const store=getKnowledgeStore(),params=request.params as {id:string;evidenceId:string};const content=new EvidenceStore(store,store.evidenceRoot ?? "./data/evidence").readForLegacyCandidateReview(request.user.id,true,params.id,params.evidenceId);return reply.type("application/octet-stream").header("Content-Disposition","attachment").send(content);} catch(error) {return sendError(reply,error,404);}
  });
  app.get("/api/knowledge/memory-submissions/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    try { return reply.send({ submission: getMemorySubmission(getKnowledgeStore(), webMemoryAccess(request.user), String((request.params as { id: string }).id)) }); }
    catch (error) { return sendError(reply, error, 404); }
  });
  app.get("/api/knowledge/memory-submissions/:id/evidence/:evidenceId", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({error:"Administrator access is required"});
    try { const store=getKnowledgeStore(), params=request.params as {id:string;evidenceId:string}; const content=new EvidenceStore(store,store.evidenceRoot ?? "./data/evidence").readForSubmissionReview(request.user.id,true,params.id,params.evidenceId); return reply.type("application/octet-stream").header("Content-Disposition","attachment").send(content); } catch(error) { return sendError(reply,error,404); }
  });
  app.post("/api/knowledge/memory-submissions", { onRequest: [app.authenticate] }, async (request, reply) => {
    const schema = z.object({ idempotencyKey: z.string().min(1).max(300), requestedScope: z.enum(["project", "general"]), projectId: z.string().optional(), title: z.string().min(1).max(300), memoryType: z.enum(CONFIRMED_MEMORY_TYPES), statement: z.string().min(1).max(8000), objective: z.string().max(4000).optional(), outcome: z.string().max(4000).optional(), applicability: z.string().max(2000).optional(), unknowns: z.array(z.string().max(1000)).max(50).optional(), evidenceRefs: z.array(z.string()).max(100).optional(),sourceRefs:z.array(z.string().trim().min(1).max(2000)).max(25).optional(),workSessionId: z.string().optional() }).strict();
    const body = schema.safeParse(request.body); if (!body.success) return reply.status(400).send({ error: "Invalid Memory submission" });
    try { return reply.status(201).send({ submission: submitMemory(getKnowledgeStore(), webMemoryAccess(request.user), body.data) }); }
    catch (error) { return sendError(reply, error, 403); }
  });
  app.post("/api/knowledge/memory-submissions/:id/review", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const schema = z.object({ action: z.enum(["approve", "reject", "needs_info"]), reason: z.string().trim().min(1).max(2000), scope: z.enum(["project", "general"]).optional(), title: z.string().max(300).optional(), statement: z.string().max(8000).optional(), details: z.record(z.unknown()).optional() }).strict();
    const body = schema.safeParse(request.body); if (!body.success) return reply.status(400).send({ error: "Invalid Memory review" });
    try { return reply.send({ submission: reviewMemorySubmission(getKnowledgeStore(), webMemoryAccess(request.user), { id: String((request.params as { id: string }).id), ...body.data }) }); }
    catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/product-classifications", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin || !knowledgeUserEnabled(request.user.id)) return reply.status(403).send({ error: "Authorized administrator access is required" });
    const query = request.query as Record<string, unknown>, limit = parseBoundedInt(query.limit, 50, 1, 200), offset = parseBoundedInt(query.offset, 0, 0, 1000000);
    const store = getKnowledgeStore();
    const documents = store.db.prepare(`SELECT d.id,d.title,COALESCE(d.project_id,(SELECT s.source_project_id FROM knowledge_scope_bindings s WHERE s.document_id=d.id AND s.source_project_id IS NOT NULL ORDER BY s.updated_at DESC LIMIT 1)) AS project_id,d.environment,d.lifecycle,d.source_locator,d.samplemanager_version,c.classification,c.reason,d.updated_at
      FROM knowledge_documents d LEFT JOIN knowledge_product_classifications c ON c.document_id=d.id
      WHERE d.kind='product_document' AND (c.classification IS NULL OR c.classification='pending')
      UNION ALL SELECT w.id,w.title,w.project_id,w.environment,w.status,w.source_path,w.product_version,c.classification,c.reason,w.updated_at
      FROM knowledge_weknora_documents w LEFT JOIN knowledge_product_classifications c ON c.document_id=w.id
      WHERE (c.classification IS NULL OR c.classification='pending') AND NOT EXISTS (SELECT 1 FROM knowledge_migration_documents m JOIN knowledge_documents d ON d.id=m.local_document_id WHERE m.document_id=w.id)
      ORDER BY 10 DESC,1 LIMIT ? OFFSET ?`).all(limit, offset);
    return reply.send({ documents:documents.map((doc:any)=>({...doc,source_locator:publicSourceLocation(doc.source_locator)})), page: { limit, offset } });
  });
  app.get("/api/knowledge/product-classifications/report", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin || !knowledgeUserEnabled(request.user.id)) return reply.status(403).send({ error: "Authorized administrator access is required" });
    const query = request.query as Record<string, unknown>;
    const limit = parseBoundedInt(query.limit, 50, 1, 200), offset = parseBoundedInt(query.offset, 0, 0, 1000000);
    const store = getKnowledgeStore();
    const sources = `SELECT d.id,d.title,COALESCE(d.project_id,(SELECT s.source_project_id FROM knowledge_scope_bindings s WHERE s.document_id=d.id AND s.source_project_id IS NOT NULL ORDER BY s.updated_at DESC LIMIT 1)) AS project_id,'relay_local' AS provider,d.lifecycle AS publication_status
      FROM knowledge_documents d WHERE d.kind='product_document'
      UNION ALL SELECT w.id,w.title,w.project_id,'weknora',w.status FROM knowledge_weknora_documents w
      WHERE NOT EXISTS (SELECT 1 FROM knowledge_migration_documents m JOIN knowledge_documents d ON d.id=m.local_document_id WHERE m.document_id=w.id)`;
    const from = `FROM (${sources}) source LEFT JOIN knowledge_product_classifications c ON c.document_id=source.id`;
    const report = store.db.transaction(() => {
      const counts = store.db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN c.classification IS NULL OR c.classification='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN c.classification='product' THEN 1 ELSE 0 END) AS product,
        SUM(CASE WHEN c.classification='project' THEN 1 ELSE 0 END) AS project ${from}`).get() as Record<string, number | null>;
      const documents = store.db.prepare(`SELECT source.id,source.title,source.project_id,source.provider,source.publication_status,
        COALESCE(c.classification,'pending') AS classification,c.reviewed_by,c.reason,c.updated_at AS classified_at ${from}
        ORDER BY CASE WHEN c.classification IS NULL OR c.classification='pending' THEN 0 ELSE 1 END,source.title,source.id LIMIT ? OFFSET ?`).all(limit, offset);
      return { totals: { total: counts.total ?? 0, pending: counts.pending ?? 0, product: counts.product ?? 0, project: counts.project ?? 0 }, documents };
    })();
    return reply.send({ ...report, page: { limit, offset, total: report.totals.total }, generatedAt: new Date().toISOString() });
  });
  app.get("/api/knowledge/product-classifications/:id/preview", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin || !knowledgeUserEnabled(request.user.id)) return reply.status(403).send({ error: "Authorized administrator access is required" });
    const store=getKnowledgeStore(), id=String((request.params as {id:string}).id), query=request.query as Record<string,unknown>;
    const offset=parseBoundedInt(query.offset,0,0,100_000_000), limit=20_000;
    const pending=()=>{
      const classification=store.db.prepare("SELECT classification FROM knowledge_product_classifications WHERE document_id=?").get(id) as {classification:string}|undefined;
      return !classification || classification.classification === "pending";
    };
    if (!pending()) return reply.status(404).send({error:"Document is not awaiting classification"});
    const local=store.db.prepare("SELECT title,body,project_id FROM knowledge_documents WHERE id=? AND kind='product_document'").get(id) as {title:string;body:string;project_id?:string}|undefined;
    let body:string, title:string, sourceProjectId:string|undefined;
    if (local) { body=local.body; title=local.title; sourceProjectId=local.project_id; }
    else {
      const engineRow=store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE id=? AND NOT EXISTS (SELECT 1 FROM knowledge_migration_documents m JOIN knowledge_documents d ON d.id=m.local_document_id WHERE m.document_id=knowledge_weknora_documents.id)").get(id) as KnowledgeRow|undefined;
      if (!engineRow) return reply.status(404).send({error:"Document not found"});
      try {
        const control=managedControlPlane(store);
        if (engineRow.status !== "published" || !engineRow.upstream_verified_at || engineRow.external_knowledge_base_id !== control.knowledgeBaseId) throw new Error("Source is not verified");
        const allowed=JSON.parse(String(engineRow.external_chunk_ids_json));
        if (!Array.isArray(allowed) || allowed.some(chunk=>typeof chunk!=="string")) throw new Error("Source mapping is invalid");
        const externalId=String(engineRow.external_document_id);
        const document=await control.client.readDocument(externalId,{expectedNormalizedSha256:String(engineRow.normalized_content_sha256)});
        if (document.documentId!==externalId || document.parseStatus!=="completed" || !document.chunks.length || document.chunks.some(chunk=>chunk.documentId!==externalId || !allowed.includes(chunk.chunkId) || chunk.isEnabled===false || (chunk.indexStatus && chunk.indexStatus!=="ready"))) throw new Error("Source is not verified");
        const current=store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE id=?").get(id) as KnowledgeRow|undefined;
        if (!current || ["status","upstream_verified_at","external_knowledge_base_id","external_document_id","external_chunk_ids_json","normalized_content_sha256","project_id"].some(key=>current[key]!==engineRow[key]) || !pending()) throw new Error("Classification source changed");
        const user=db.select({isAdmin:users.isAdmin,enabled:users.knowledgeEnabled}).from(users).where(eq(users.id,request.user.id)).get();
        if (!user?.isAdmin || !user.enabled) return reply.status(403).send({error:"Authorized administrator access is required"});
        body=document.content; title=String(engineRow.title ?? ""); sourceProjectId=engineRow.project_id ? String(engineRow.project_id) : undefined;
      } catch { return reply.status(503).send({error:"A verified preview is currently unavailable"}); }
    }
    store.audit({actorId:request.user.id,projectId:sourceProjectId,action:"knowledge.product.classification_previewed",entityType:"product_document",entityId:id,details:{offset}});
    return reply.send({document:{id,title,body:body.slice(offset,offset+limit)},page:{offset,limit,total:body.length}});
  });
  app.post("/api/knowledge/product-classifications/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin || !knowledgeUserEnabled(request.user.id)) return reply.status(403).send({ error: "Authorized administrator access is required" });
    const body = z.object({ classification: z.enum(["product", "project"]), reason: z.string().trim().min(1).max(2000) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Classification and reason are required" });
    const store = getKnowledgeStore(), id = String((request.params as { id: string }).id);
    const local = store.db.prepare(`SELECT COALESCE(d.project_id,(SELECT s.source_project_id FROM knowledge_scope_bindings s WHERE s.document_id=d.id AND s.source_project_id IS NOT NULL ORDER BY s.updated_at DESC LIMIT 1)) AS project_id FROM knowledge_documents d WHERE d.id=? AND d.kind='product_document'`).get(id) as { project_id?: string } | undefined;
    const engine = !local ? store.db.prepare(`SELECT w.project_id FROM knowledge_weknora_documents w WHERE w.id=? AND NOT EXISTS (SELECT 1 FROM knowledge_migration_documents m JOIN knowledge_documents d ON d.id=m.local_document_id WHERE m.document_id=w.id)`).get(id) as {project_id?:string}|undefined : undefined;
    const row = local ?? engine;
    if (!row) return reply.status(404).send({ error: "Product document not found" });
    const existing = store.db.prepare("SELECT classification FROM knowledge_product_classifications WHERE document_id=?").get(id) as {classification:string} | undefined;
    if (existing && existing.classification !== "pending") return reply.status(409).send({ error: "Document has already been classified" });
    if (body.data.classification === "project" && !row.project_id) return reply.status(400).send({ error: "Project material requires a source project" });
    const now = new Date().toISOString();
    store.db.transaction(() => {
      if (body.data.classification === "project" && local) {
        store.db.prepare("UPDATE knowledge_documents SET project_id=? WHERE id=?").run(row.project_id,id);
        store.db.prepare("UPDATE knowledge_scope_bindings SET visibility='project',source_project_id=? WHERE document_id=?").run(row.project_id,id);
      }
      store.db.prepare("INSERT INTO knowledge_product_classifications(document_id,classification,reviewed_by,reason,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET classification=excluded.classification,reviewed_by=excluded.reviewed_by,reason=excluded.reason,updated_at=excluded.updated_at").run(id, body.data.classification, request.user.id, body.data.reason, now);
      store.audit({ actorId: request.user.id, projectId: row.project_id, action: "knowledge.product.classified", entityType: "product_document", entityId: id, details: { classification: body.data.classification } });
    })();
    return reply.send({ ok: true, id, classification: body.data.classification });
  });

  app.get("/api/knowledge/wiki", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const projectId = queryValue(query, "projectId");
    const environment = queryValue(query, "environment");
    if (!projectId && environment) return reply.status(400).send({ error: "environment requires projectId" });
    const status = typeof query.status === "string" && WIKI_PAGE_STATUSES.includes(query.status as never) ? query.status as never : undefined;
    try {
      const store = getKnowledgeStore();
      const result=await activeWikiService(store).list({ actorId: request.user.id, isAdmin: request.user.isAdmin, visiblePageIds: visibleWikiPageIds(store, knowledgeUserEnabled(request.user.id), projectId), projectId, environment, status, productVersion: queryValue(query, "productVersion"), topicId: queryValue(query, "topicId"), topicGroupId: queryValue(query, "topicGroupId"), solution: queryValue(query, "solution"), module: queryValue(query, "module"), search: queryValue(query, "search"), limit: parseBoundedInt(query.limit, 50, 1, 200), offset: parseBoundedInt(query.offset, 0, 0, 1_000_000) });
      if (projectId && !canReadProject(request.user.id,projectId)) throw new Error("Project access denied");
      if (!projectId && !knowledgeUserEnabled(request.user.id)) throw new Error("Product Knowledge access denied");
      for (const item of result.items) assertCurrentWikiAccess(request.user.id,item.id,projectId,item);
      return reply.send(result);
    } catch (error) { return sendError(reply, error, 403); }
  });

  app.get("/api/knowledge/wiki/navigation", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const projectId = queryValue(query, "projectId"), environment = queryValue(query, "environment");
    if (!projectId && environment) return reply.status(400).send({ error: "environment requires projectId" });
    const status = typeof query.status === "string" && WIKI_PAGE_STATUSES.includes(query.status as never) ? query.status as never : undefined;
    try {
      const store = getKnowledgeStore();
      const assignmentExists = store.db.prepare("SELECT 1 FROM knowledge_wiki_directory_assignments WHERE scope_project_id=? AND scope_environment=? LIMIT 1").get(projectId ?? "", environment ?? "");
      if (!assignmentExists) ensureWikiDirectoryAssignments(store, { projectId, environment });
      return reply.send(new WikiService(store).listNavigation({
        actorId: request.user.id, isAdmin: request.user.isAdmin, visiblePageIds: visibleWikiPageIds(store, knowledgeUserEnabled(request.user.id), projectId), projectId, environment, path: queryValue(query, "path"),
        status, productVersion: queryValue(query, "productVersion"), topicId: queryValue(query, "topicId"), topicGroupId: queryValue(query, "topicGroupId"),
        solution: queryValue(query, "solution"), module: queryValue(query, "module"), search: queryValue(query, "search"),
        limit: parseBoundedInt(query.limit, 50, 1, 100), offset: parseBoundedInt(query.offset, 0, 0, 1_000_000),
      }));
    } catch (error) { return sendError(reply, error, 403); }
  });

  app.get("/api/knowledge/wiki/directory", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const projectId = queryValue(query, "projectId"), environment = queryValue(query, "environment");
    if (!projectId && environment) return reply.status(400).send({ error: "environment requires projectId" });
    const status = typeof query.status === "string" && WIKI_PAGE_STATUSES.includes(query.status as never) ? query.status as never : undefined;
    try {
      const store = getKnowledgeStore();
      const assignmentExists = store.db.prepare("SELECT 1 FROM knowledge_wiki_directory_assignments WHERE scope_project_id=? AND scope_environment=? LIMIT 1").get(projectId ?? "", environment ?? "");
      if (!assignmentExists) ensureWikiDirectoryAssignments(store, { projectId, environment });
      const navigation = new WikiService(store).listNavigation({
        actorId: request.user.id, isAdmin: request.user.isAdmin, visiblePageIds: visibleWikiPageIds(store, knowledgeUserEnabled(request.user.id), projectId), projectId, environment, path: queryValue(query, "path"),
        status, productVersion: queryValue(query, "productVersion"), topicId: queryValue(query, "topicId"), topicGroupId: queryValue(query, "topicGroupId"),
        solution: queryValue(query, "solution"), module: queryValue(query, "module"), search: queryValue(query, "search"),
        limit: parseBoundedInt(query.limit, 50, 1, 100), offset: parseBoundedInt(query.offset, 0, 0, 1_000_000),
      });
      return reply.send({
        ...navigation,
        items: navigation.pages,
        directoryVersion: WIKI_DIRECTORY_TAXONOMY_VERSION,
        directory: navigation.nodes,
      });
    } catch (error) { return sendError(reply, error, 403); }
  });

  app.get("/api/knowledge/wiki/generation", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>, projectId = queryValue(query, "projectId"), environment = queryValue(query, "environment");
    if (!projectId && environment) return reply.status(400).send({ error: "environment requires projectId" });
    const store = getKnowledgeStore();
    if (projectId && !request.user.isAdmin && !store.canRead(request.user.id, projectId)) return reply.status(403).send({ error: "Project access denied" });
    const scopeProject = projectId ?? "", scopeEnvironment = environment ?? "";
    const jobLimit = parseBoundedInt(query.limit, 20, 1, 100), jobOffset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    const topicLimit = parseBoundedInt(query.topicLimit, 25, 1, 100), topicOffset = parseBoundedInt(query.topicOffset, 0, 0, 1_000_000);
    const topicRecords = listWikiTopicGenerationStatuses(store, { projectId, environment,includePublic:knowledgeUserEnabled(request.user.id) });
    const topicStatuses = topicRecords.slice(topicOffset, topicOffset + topicLimit);
    const jobScope = "kind='wiki_generation' AND COALESCE(json_extract(payload_json,'$.projectId'),'')=? AND COALESCE(json_extract(payload_json,'$.environment'),'')=?";
    const jobTotal = Number((store.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_ingest_jobs WHERE ${jobScope}`).get(scopeProject, scopeEnvironment) as { count?: number } | undefined)?.count ?? 0);
    const jobs = (store.db.prepare(`SELECT * FROM knowledge_ingest_jobs WHERE ${jobScope} ORDER BY CASE WHEN status IN ('queued','running') THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(scopeProject, scopeEnvironment, jobLimit, jobOffset) as KnowledgeRow[]).map((row) => normalizeWikiGenerationJob(row));
    const activeJobs = (store.db.prepare(`SELECT * FROM knowledge_ingest_jobs WHERE ${jobScope} AND status IN ('queued','running') ORDER BY updated_at DESC, id DESC`).all(scopeProject, scopeEnvironment) as KnowledgeRow[]).map((row) => normalizeWikiGenerationJob(row));
    const states = topicRecords.map((topic) => ({
      topic_group_id: topic.topicGroupId,
      status: topic.generationStatus,
      generated_page_id: topic.generatedPageId ?? null,
      attempt_count: topic.attemptCount,
      source_fingerprint: topic.sourceFingerprint ?? null,
      last_error: topic.lastError ?? null,
      updated_at: topic.updatedAt ?? null,
      job_id: topic.jobId ?? null,
      trigger_kind: topic.triggerKind ?? null,
    }));
    const summary = topicRecords.reduce((result, topic) => {
      result.total += 1;
      if (topic.generationStatus === "succeeded") result.generated += 1;
      else if (topic.generationStatus === "failed") result.failed += 1;
      else if (topic.generationStatus === "queued" || topic.generationStatus === "running") result.inProgress += 1;
      else if (topic.generationStatus === "paused") result.paused += 1;
      else result.notStarted += 1;
      return result;
    }, { total: 0, generated: 0, failed: 0, inProgress: 0, paused: 0, notStarted: 0 });
    return reply.send({ states, jobs, activeJobs, jobsPage: { limit: jobLimit, offset: jobOffset, total: jobTotal }, topics: topicStatuses, topicsPage: { limit: topicLimit, offset: topicOffset, total: topicRecords.length }, summary });
  });
  app.post("/api/knowledge/ingest-jobs/:id/control", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator permission is required" });
    const body = z.object({ action: z.enum(["pause", "resume"]) }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "A pause or resume action is required" });
    const id = String((request.params as { id: string }).id);
    try {
      const row=getKnowledgeStore().db.prepare("SELECT payload_json FROM knowledge_ingest_jobs WHERE id=?").get(id) as {payload_json?:string}|undefined;
      if (!row) return reply.status(404).send({error:"Ingest job not found"});
      const payload=safeRows(()=>JSON.parse(String(row.payload_json ?? "{}")) as Record<string,unknown>,{}),projectId=payload.projectId ? String(payload.projectId) : undefined;
      if (projectId ? !canReadProject(request.user.id,projectId) : !knowledgeUserEnabled(request.user.id)) return reply.status(404).send({error:"Ingest job not found"});
      const job = controlWikiGenerationJob(getKnowledgeStore(), id, body.data.action, request.user.id);
      return reply.send({ job });
    } catch (error) {
      if (error instanceof WikiGenerationControlError) {
        const status = error.code === "not_found" ? 404 : error.code === "terminal" || error.code === "conflict" || error.code === "unsupported_kind" ? 409 : 400;
        return reply.status(status).send({ error: error.message, code: error.code });
      }
      return sendError(reply, error, 400);
    }
  });
  app.post("/api/knowledge/wiki/generation", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator permission required" });
    const body = z.object({ projectId: z.string().trim().min(1).optional(), environment: z.string().trim().min(1).optional(), retryFailed: z.boolean().optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid Wiki generation request" });
    if (body.data.environment && !body.data.projectId) return reply.status(400).send({ error: "environment requires projectId" });
    if (!knowledgeUserEnabled(request.user.id)) return reply.status(403).send({error:"Product Knowledge access is required to generate Wiki pages that may include public sources"});
    const store = getKnowledgeStore(), topics = listWikiTopicGenerationStatuses(store, body.data);
    const retryFailed = body.data.retryFailed === true;
    const eligible = topics.filter(topic => topic.generationStatus === "not_started" || (retryFailed && topic.generationStatus === "failed"));
    const result = enqueueWikiGenerationDetailed(store, { topicGroupIds: eligible.map(topic => topic.topicGroupId), projectId: body.data.projectId, environment: body.data.environment, triggerId: `manual-${randomUUID()}`, triggerKind: "manual" });
    const inProgress = topics.filter(topic => topic.generationStatus === "queued" || topic.generationStatus === "running" || topic.generationStatus === "paused").length;
    const generated = topics.filter(topic => topic.generationStatus === "succeeded").length;
    const skipped = Math.max(0, topics.length - result.queuedTopicGroupIds.length);
    if (!result.queuedTopicGroupIds.length && inProgress > 0) {
      return reply.status(409).send({ error: "Wiki generation is already in progress for the selected topics. Refresh the job to monitor it.", code: "generation_in_progress", job: result.job, queued: 0, total: topics.length, skipped, generated, inProgress });
    }
    return reply.status(result.job ? 202 : 200).send({ job: result.job, queued: result.queuedTopicGroupIds.length, total: topics.length, skipped, generated, inProgress });
  });

  app.post("/api/knowledge/wiki", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ environment: z.string().optional(), pageKey: z.string().min(1).max(300), title: z.string().min(1).max(500), body: z.string().min(1), projectId: z.string().optional(), productVersion: z.string().optional(), topicId: z.string().optional(), topicGroupId: z.string().optional(), supportedVersions: z.array(z.string()).max(20).optional(), solution: z.string().optional(), module: z.string().optional(), sourceRefs: z.array(z.string()).max(100).optional(), reason: z.string().min(1).max(2_000) }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid Wiki page" });
    if (body.data.environment && !body.data.projectId) return reply.status(400).send({ error: "environment requires projectId" });
    try { const page=await activeWikiService(getKnowledgeStore()).create({ actorId: request.user.id, isAdmin: request.user.isAdmin, ...body.data }); assertCurrentWikiAccess(request.user.id,page.id,body.data.projectId,page); return reply.status(201).send({ page }); } catch (error) { return sendError(reply, error, 403); }
  });
  // Resolve only an existing Relay binding. Never discover upstream content from
  // an untrusted link or use the visible list as an authorization decision.
  const assertWikiNavigationScope = (actorId: number, column: "id" | "page_key", identity: string, projectId?: string, environment?: string) => {
    const store = getKnowledgeStore();
    const row = store.db.prepare(`SELECT project_id,environment FROM knowledge_wiki_pages WHERE ${column}=?`).get(identity) as { project_id?: string | null; environment?: string | null } | undefined;
    const global = Boolean(row && row.project_id == null && row.environment == null);
    if (!row) throw new Error("Wiki page not found in the selected scope");
    if (!projectId && !environment) {
      if (!global) throw new Error("Wiki page not found in the selected scope");
      return;
    }
    if (!projectId || !canReadProject(actorId, projectId)) throw new Error("Wiki page not found in the selected scope");
    if (!global && (row.project_id !== projectId || (row.environment ?? undefined) !== environment)) throw new Error("Wiki page not found in the selected scope");
  };
  app.get("/api/knowledge/wiki/resolve", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = z.object({ pageKey: z.string().min(1).max(300).regex(/^(?:engine-wiki:[a-f0-9]{16}:)?[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u), projectId: z.string().trim().min(1).optional(), environment: z.string().trim().min(1).optional() }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "A valid Wiki key is required" });
    if (query.data.environment && !query.data.projectId) return reply.status(400).send({ error: "environment requires projectId" });
    try {
      const input = { actorId: request.user.id, isAdmin: request.user.isAdmin, ...query.data };
      assertWikiNavigationScope(input.actorId, "page_key", input.pageKey, input.projectId, input.environment);
      const page = await activeWikiService(getKnowledgeStore()).getByKey(input);
      assertWikiNavigationScope(input.actorId, "page_key", input.pageKey, input.projectId, input.environment);
      assertCurrentWikiAccess(input.actorId,page.id,input.projectId,page);
      return reply.send({ page });
    } catch (error) { return sendError(reply, error, 404); }
  });
  app.get("/api/knowledge/wiki/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const id = String((request.params as { id: string }).id);
    const projectId = queryValue(query, "projectId");
    const environment = queryValue(query, "environment");
    if (environment && !projectId) return reply.status(400).send({ error: "environment requires projectId" });
    try {
      assertWikiNavigationScope(request.user.id, "id", id, projectId, environment);
      const page = await activeWikiService(getKnowledgeStore()).get({ actorId: request.user.id, isAdmin: request.user.isAdmin, id, projectId, environment });
      assertWikiNavigationScope(request.user.id, "id", id, projectId, environment);
      assertCurrentWikiAccess(request.user.id,page.id,projectId,page);
      return reply.send({ page });
    } catch (error) { return sendError(reply, error, 404); }
  });
  app.patch("/api/knowledge/wiki/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ projectId: z.string().optional(), environment: z.string().optional(), title: z.string().min(1).max(500).optional(), body: z.string().min(1).optional(), reason: z.string().min(1).max(2_000) }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid Wiki edit" });
    if (body.data.environment && !body.data.projectId) return reply.status(400).send({ error: "environment requires projectId" });
    try { const page=await activeWikiService(getKnowledgeStore()).edit({ actorId: request.user.id, isAdmin: request.user.isAdmin, id: String((request.params as { id: string }).id), ...body.data }); assertCurrentWikiAccess(request.user.id,page.id,body.data.projectId,page); return reply.send({page}); } catch (error) { return sendError(reply, error, 403); }
  });
  for (const action of ["publish", "deprecate"] as const) {
    app.post(`/api/knowledge/wiki/:id/${action}`, { onRequest: [app.authenticate] }, async (request, reply) => {
      const body = z.object({ projectId: z.string().optional(), environment: z.string().optional(), reason: z.string().min(1).max(2_000) }).safeParse(request.body ?? {});
      if (!body.success) return reply.status(400).send({ error: "A reason is required" });
      if (body.data.environment && !body.data.projectId) return reply.status(400).send({ error: "environment requires projectId" });
      const service = activeWikiService(getKnowledgeStore());
      try {
        const id = String((request.params as { id: string }).id);
        const input = { actorId: request.user.id, isAdmin: request.user.isAdmin, id, ...body.data };
        const page=action === "publish" ? await service.publish(input) : await service.deprecate(input);
        assertCurrentWikiAccess(request.user.id,id,body.data.projectId,page);
        return reply.send({ page });
      } catch (error) { return sendError(reply, error, 403); }
    });
  }
  app.get("/api/knowledge/wiki/:id/revisions", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const projectId = queryValue(query, "projectId");
    const environment = queryValue(query, "environment");
    if (environment && !projectId) return reply.status(400).send({ error: "environment requires projectId" });
    try {
      const id=String((request.params as {id:string}).id), store=getKnowledgeStore();
      const all=await activeWikiService(store).listRevisions({ actorId:request.user.id,isAdmin:request.user.isAdmin,id,projectId,environment });
      assertCurrentWikiAccess(request.user.id,id,projectId);
      const revisions=all.filter(revision=>wikiRevisionVisible(store,id,revision.revision,knowledgeUserEnabled(request.user.id),projectId));
      return reply.send({ revisions, restrictedHistory:revisions.length!==all.length });
    } catch (error) { return sendError(reply, error, 404); }
  });
  app.get("/api/knowledge/wiki/:id/diff", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const projectId = queryValue(query, "projectId");
    const environment = queryValue(query, "environment");
    if (environment && !projectId) return reply.status(400).send({ error: "environment requires projectId" });
    try {
      const id=String((request.params as {id:string}).id),store=getKnowledgeStore(),fromRevision=parseBoundedInt(query.fromRevision,1,1,1_000_000),toRevision=parseBoundedInt(query.toRevision,1,1,1_000_000);
      const check=()=>{ assertCurrentWikiAccess(request.user.id,id,projectId); if (![fromRevision,toRevision].every(rev=>wikiRevisionVisible(store,id,rev,knowledgeUserEnabled(request.user.id),projectId))) throw new Error("Wiki revision source provenance is unavailable or access denied"); };
      check(); const diff=await activeWikiService(store).diffRevisions({actorId:request.user.id,isAdmin:request.user.isAdmin,id,projectId,environment,fromRevision,toRevision}); check();
      return reply.send({diff});
    } catch (error) { return sendError(reply, error, 404); }
  });
  app.post("/api/knowledge/wiki/:id/rollback", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ projectId: z.string().optional(), environment: z.string().optional(), revision: z.number().int().positive(), reason: z.string().min(1).max(2_000) }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid Wiki rollback" });
    if (body.data.environment && !body.data.projectId) return reply.status(400).send({ error: "environment requires projectId" });
    try {
      const id=String((request.params as {id:string}).id),store=getKnowledgeStore();
      assertCurrentWikiAccess(request.user.id,id,body.data.projectId);
      if(!wikiRevisionVisible(store,id,body.data.revision,knowledgeUserEnabled(request.user.id),body.data.projectId)) throw new Error("Wiki revision source provenance is unavailable or access denied");
      const page=await activeWikiService(store).rollback({actorId:request.user.id,isAdmin:request.user.isAdmin,id,...body.data});
      assertCurrentWikiAccess(request.user.id,id,body.data.projectId,page); return reply.send({page});
    } catch (error) { return sendError(reply, error, 403); }
  });

  app.get("/api/knowledge/weknora/documents", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const projectId = queryValue(query, "projectId");
    const environment = queryValue(query, "environment");
    const store = getKnowledgeStore();
    if (environment && !projectId) return reply.status(400).send({ error: "environment requires projectId" });
    if (projectId && !store.canRead(request.user.id, projectId)) return reply.status(403).send({ error: "Knowledge access denied" });
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (projectId) {
      conditions.push("((project_id IS NULL AND environment IS NULL) OR (project_id = ? AND environment IS ?))");
      params.push(projectId, environment ?? null);
    } else {
      conditions.push("project_id IS NULL AND environment IS NULL");
    }
    for (const [key, column] of [["status", "status"], ["productVersion", "product_version"], ["solution", "solution"], ["module", "module"]] as const) {
      const value = queryValue(query, key);
      if (value) { conditions.push(`${column} = ?`); params.push(value); }
    }
    const limit = parseBoundedInt(query.limit, 50, 1, 200);
    const offset = parseBoundedInt(query.offset, 0, 0, 1_000_000);
    const where = `WHERE ${conditions.join(" AND ")}`;
    const documents = store.db.prepare(`SELECT id,external_document_id,title,normalized_content_sha256,raw_sha256,parser_version,product_version,solution,module,topic_id,source_path,language,project_id,environment,external_chunk_ids_json,upstream_parse_status,upstream_verified_at,model_provenance_json,status,failure_code,failure_message,attempt_count,created_at,updated_at,published_at FROM knowledge_weknora_documents ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = (store.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_weknora_documents ${where}`).get(...params) as { count: number }).count;
    return reply.send({ documents: (documents as Array<Record<string, unknown>>).map(row => {
      const { model_provenance_json, external_chunk_ids_json, ...safe } = row;
      const provenance = safeRows(() => JSON.parse(String(model_provenance_json ?? "{}")), {}) as Record<string, unknown>;
      return { ...safe, externalChunkIds: safeRows(() => JSON.parse(String(external_chunk_ids_json ?? "[]")), []), upstreamParseStatus: row.upstream_parse_status, upstreamVerifiedAt: row.upstream_verified_at, modelProvenance: { providerId: provenance.providerId, modelId: provenance.modelId, dimensions: provenance.dimensions, indexVersion: provenance.indexVersion } };
    }), page: { limit, offset, total } });
  });
  app.post("/api/knowledge/weknora/documents", { onRequest: [app.authenticate] }, async (request, reply) => {
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    const schema = z.object({ idempotencyKey:z.string().min(1).max(300), title:z.string().min(1).max(500), content:z.string().min(1), classification:z.enum(["product","project"]), productVersion:z.string().optional(), solution:z.string().optional(), module:z.string().optional(), topicId:z.string().optional(), sourcePath:z.string().optional(), environment:z.string().optional(), language:z.string().optional(), projectId:z.string().optional(), parserVersion:z.string().min(1).max(100).default("relay-normalizer-v1"), rawSha256:z.string().length(64).optional(), retry:z.boolean().optional() }).refine(value => value.classification !== "project" || Boolean(value.projectId), "Project material requires a project");
    const body=schema.safeParse(request.body ?? {}); if (!body.success) return reply.status(400).send({ error: "Invalid WeKnora document" });
    try {
      if (body.data.projectId) resolveProject(request.user.id,body.data.projectId);
      const {classification,...input}=body.data;
      const document=await weknoraControlPlane().ingestor.stage(input,{retry:input.retry});
      const currentUser=db.select({isAdmin:users.isAdmin,enabled:users.knowledgeEnabled}).from(users).where(eq(users.id,request.user.id)).get();
      if (!currentUser?.isAdmin || !currentUser.enabled) return reply.status(403).send({error:"Authorized administrator access is required"});
      if (input.projectId) resolveProject(request.user.id,input.projectId);
      const store=getKnowledgeStore(), existing=store.db.prepare("SELECT classification FROM knowledge_product_classifications WHERE document_id=?").get(document.id) as {classification?:string}|undefined;
      if (existing && existing.classification !== classification) return reply.status(409).send({error:"Existing document has a different classification"});
      store.db.prepare("INSERT OR IGNORE INTO knowledge_product_classifications(document_id,classification,reviewed_by,reason,updated_at) VALUES(?,?,?,?,?)").run(document.id,classification,request.user.id,"Classified at import",new Date().toISOString());
      store.audit({actorId:request.user.id,projectId:input.projectId,action:"knowledge.product.classified",entityType:"product_document",entityId:document.id,details:{classification}});
      return reply.status(201).send({document});
    } catch(error) { return sendError(reply,error,error instanceof WeKnoraError ? 502 : 400); }
  });
  for (const action of ["publish", "deprecate"] as const) {
    app.post(`/api/knowledge/weknora/documents/:id/${action}`, { onRequest: [app.authenticate] }, async (request, reply) => { if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" }); const writer = { upsertDocument: async () => ({ externalDocumentId: "unused" }) }; const ingestor = new WeKnoraIngestor(getKnowledgeStore(), writer); try { const id = String((request.params as { id: string }).id); return reply.send({ document: action === "publish" ? ingestor.publish(id, request.user.id) : ingestor.deprecate(id, request.user.id) }); } catch (error) { return sendError(reply, error, 400); } });
  }
  app.post("/api/knowledge/search", { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ query: z.string().min(1), productVersion: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), language: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }).strict().safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid Product Knowledge search" });
    try {
      const result = await searchPublicProductChunks(getKnowledgeStore(), body.data);
      if (!knowledgeUserEnabled(request.user.id)) return reply.status(403).send({ error: "Product Knowledge access denied" });
      return reply.send(result);
    } catch (error) { return sendError(reply, error, 503); }
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

