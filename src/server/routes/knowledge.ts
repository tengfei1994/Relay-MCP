import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { getKnowledgeStore } from "../knowledge-context.js";
import { EvidenceStore } from "../../knowledge/evidence-store.js";
import { importCasebook, importContextFacts } from "../../knowledge/importer.js";
import { analyzeRelationImpact, queryRelations } from "../../knowledge/relations.js";
import { searchKnowledge } from "../../knowledge/retriever.js";
import { importProductDocuments, productDocumentDiff } from "../../knowledge/product-docs.js";
import { existsSync, readFileSync } from "node:fs";
import { resolveWorkspacePath } from "../../shared/workspace-path.js";
import { relayEventSpoolHealth } from "../../knowledge/event-sink.js";
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
    eventId: row.event_id ? String(row.event_id) : undefined,
    sourceCandidateId: row.source_candidate_id ? String(row.source_candidate_id) : undefined,
    jobId: row.job_id ? String(row.job_id) : undefined,
    deploymentId: row.deployment_id ? String(row.deployment_id) : undefined,
    evidenceCount: row.evidence_count === undefined ? undefined : Number(row.evidence_count),
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
    const source = store.db.prepare("SELECT event_id,job_id,deployment_id,source_candidate_id,evidence_refs_json FROM knowledge_cases WHERE id = ?").get(String(row.id)) as KnowledgeRow | undefined;
    if (!source) return row;
    let evidenceCount: number | undefined;
    try {
      const refs = JSON.parse(String(source.evidence_refs_json ?? "[]"));
      evidenceCount = Array.isArray(refs) ? refs.length : undefined;
    } catch { /* malformed legacy metadata remains readable */ }
    return { ...row, ...source, ...(evidenceCount === undefined ? {} : { evidence_count: evidenceCount }) };
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
    locator: value.locator,
    retention: value.retention,
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

function safeRows<T>(work: () => T, fallback: T): T {
  try { return work(); } catch { return fallback; }
}

function knowledgeHealth(store: ReturnType<typeof getKnowledgeStore>) {
  const fts = safeRows(() => Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_fts").get() as { count?: number }).count ?? 0), 0);
  const vectors = safeRows(() => Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_embeddings").get() as { count?: number }).count ?? 0), 0);
  const spool = relayEventSpoolHealth();
  return {
    database: { status: "available", checkedAt: new Date().toISOString() },
    fts: { status: fts > 0 ? "ready" : "empty", indexedRows: fts },
    vectors: { status: vectors > 0 ? "ready" : "disabled_or_empty", indexedRows: vectors },
    captureWorker: { status: "managed_by_remote_ops_mcp", note: "Worker telemetry is reported by /mcp/diagnostics." },
    spool,
  };
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
      const row = loadDocumentForUser(store, request.user.id, id, targetProjectId);
      const evidenceRefs = documentEvidenceRefs(store, row, targetProjectId);
      const reviews = store.db.prepare("SELECT id,reviewer_id,action,reason,before_json,after_json,created_at FROM knowledge_reviews WHERE entity_id = ? ORDER BY created_at DESC").all(id);
      const enriched = enrichDocumentRow(store, row);
      return reply.send({ document: safeDocument(enriched, true, String(row.kind) === "candidate" ? store.getCandidateCard(id) : undefined, store.getScopeBinding(id)), evidenceRefs, reviews });
    } catch (error) { return sendError(reply, error, 404); }
  });

  app.get("/api/knowledge/evidence/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const store = getKnowledgeStore();
    try {
      resolveEvidenceProject(request.user.id, store, id);
      const evidence = new EvidenceStore(store, store.evidenceRoot ?? "./data/evidence").metadata(request.user.id, id);
      return reply.send({ evidence: safeEvidence(evidence as unknown as Record<string, unknown>) });
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
      const conditions = ["project_id = ?", "kind = 'candidate'"]; const params: unknown[] = [projectId];
      if (status) { conditions.push("lifecycle = ?"); params.push(status); } else conditions.push("lifecycle <> 'deprecated'");
      const rows = store.db.prepare(`SELECT * FROM knowledge_documents WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as KnowledgeRow[];
      const total = store.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_documents WHERE ${conditions.join(" AND ")}`).get(...params) as { count?: number };
      return reply.send({ candidates: rows.map((row) => { const enriched = enrichDocumentRow(store, row); return safeDocument(enriched, false, store.getCandidateCard(String(row.id)), store.getScopeBinding(String(row.id))); }), page: { limit, offset, total: Number(total.count ?? 0) } });
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
      card: z.object({ summary: z.string().max(2_000).optional(), problemStatement: z.string().max(10_000).optional(), facts: z.array(z.record(z.unknown())).max(50).optional(), symptoms: z.array(z.string().max(2_000)).max(50).optional(), hypothesis: z.string().max(10_000).optional(), verificationPlan: z.array(z.string().max(2_000)).max(50).optional(), verifiedConclusion: z.string().max(10_000).nullable().optional(), actions: z.array(z.string().max(2_000)).max(50).optional(), verification: z.array(z.string().max(2_000)).max(50).optional(), applicability: z.string().max(2_000).nullable().optional(), tags: z.array(z.string().max(200)).max(50).optional(), confidence: z.number().min(0).max(1).optional() }).optional(),
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

  app.get("/api/knowledge/diagnostics", { onRequest: [app.authenticate] }, async (request, reply) => {
    try {
      const { store, projectId } = resolveProject(request.user.id, (request.query as Record<string, unknown>).projectId);
      const spoolPath = `${store.evidenceRoot ? store.evidenceRoot.replace(/[\\/]evidence[\\/]?$/, "") : ".relay-mcp"}/knowledge-event-spool.jsonl.dead-letter`;
      const deadLetters = safeRows(() => readFileSync(spoolPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-20).map((line) => { try { return JSON.parse(line); } catch { return { raw: line }; } }), []);
      return reply.send({ projectId, health: knowledgeHealth(store), deadLetters, checkedAt: new Date().toISOString() });
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
    const body = z.object({ root: z.string().min(1).optional(), projectId: z.number().int().positive().optional(), path: z.string().min(1).optional(), product: z.string().max(200).optional(), sampleManagerVersion: z.string().min(1).max(80), solution: z.string().max(200).optional(), module: z.string().max(200).optional(), language: z.string().max(20).optional(), authority: z.string().max(80).optional(), documentFamilyId: z.string().max(200).optional() }).refine((value) => Boolean(value.root || (value.projectId && value.path)), "root or projectId/path is required").safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid product document import", details: body.error.issues });
    if (!request.user.isAdmin) return reply.status(403).send({ error: "Administrator access is required" });
    try {
      const root = body.data.root ?? (() => { const project = db.select().from(projects).where(and(eq(projects.id, body.data.projectId!), eq(projects.userId, request.user.id))).get(); if (!project) throw new Error("Project not found"); return resolveWorkspacePath(project.workspacePath, body.data.path!, { mustExist: true }); })();
      if (!existsSync(root)) return reply.status(403).send({ error: "An existing source directory is required" });
      const store = getKnowledgeStore(); const report = importProductDocuments(store, { ...body.data, root });
      store.audit({ actorId: request.user.id, action: "knowledge.product_documents.import", entityType: "product_document_batch", entityId: report.runId, details: { ...report } });
      return reply.send(report);
    } catch (error) { return sendError(reply, error, 400); }
  });

  app.get("/api/knowledge/product-docs", { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = request.query as Record<string, unknown>; const limit = parseBoundedInt(query.limit, 100, 1, 500); const params: unknown[] = []; const where = ["d.kind = 'product_document'"]; const add = (field: string, key: string) => { const value = queryValue(query, key); if (value) { where.push(`${field} = ?`); params.push(value); } };
    add("d.samplemanager_version", "sampleManagerVersion"); add("d.solution", "solution"); add("d.module", "module"); add("p.document_type", "documentType"); add("p.language", "language"); add("p.authority", "authority"); add("p.document_family_id", "documentFamilyId");
    const store = getKnowledgeStore();
    if (!store.db.prepare("SELECT 1 FROM knowledge_acl WHERE user_id = ? AND can_read = 1 LIMIT 1").get(request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    const rows = store.db.prepare(`SELECT d.id,d.title,d.body,d.lifecycle,d.project_id,d.project_name_snapshot,d.samplemanager_version,d.solution,d.module,d.environment,d.source_locator,d.source_commit,d.source_sha256,d.created_at,d.updated_at,p.document_family_id,p.document_type,p.language,p.authority,p.source_path,p.version,p.sections_json FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id = d.id WHERE ${where.join(" AND ")} ORDER BY d.updated_at DESC LIMIT ?`).all(...params, limit) as KnowledgeRow[];
    return reply.send({ documents: rows.map((row) => safeDocument(row, false, undefined, store.getScopeBinding(String(row.id)))) });
  });

  app.get("/api/knowledge/product-docs/:id", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id); const store = getKnowledgeStore();
    const row = store.db.prepare("SELECT d.*,p.document_family_id,p.document_type,p.language,p.authority,p.source_path,p.version,p.sections_json FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id = d.id WHERE d.id = ?").get(id) as KnowledgeRow | undefined;
    if (!row) return reply.status(404).send({ error: "Product document not found" });
    if (!store.db.prepare("SELECT 1 FROM knowledge_acl WHERE user_id = ? AND can_read = 1 LIMIT 1").get(request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    return reply.send({ document: safeDocument(row, true, undefined, store.getScopeBinding(id)), sections: (() => { try { return JSON.parse(String(row.sections_json ?? "[]")); } catch { return []; } })() });
  });

  app.get("/api/knowledge/product-docs/:id/diff", { onRequest: [app.authenticate] }, async (request, reply) => {
    const id = String((request.params as { id: string }).id); const against = queryValue(request.query as Record<string, unknown>, "against"); if (!against) return reply.status(400).send({ error: "against is required" });
    const store = getKnowledgeStore(); const exists = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_product_documents WHERE id IN (?,?)").get(id, against) as { count?: number }; if (Number(exists.count) !== 2) return reply.status(404).send({ error: "Product document not found" });
    if (!store.db.prepare("SELECT 1 FROM knowledge_acl WHERE user_id = ? AND can_read = 1 LIMIT 1").get(request.user.id)) return reply.status(403).send({ error: "Knowledge access denied" });
    return reply.send(productDocumentDiff(store, id, against));
  });
}

