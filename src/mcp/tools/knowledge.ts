import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpUser } from "../register-tools.js";
import { z } from "zod";
import { importCasebook, importContextFacts } from "../../knowledge/importer.js";
import { queryRelations } from "../../knowledge/relations.js";
import { searchKnowledge } from "../../knowledge/retriever.js";
import type { KnowledgeStore } from "../../knowledge/store.js";
import { summarizeJson } from "../../shared/output.js";
import { EvidenceStore } from "../../knowledge/evidence-store.js";
import { compareSourceBaselines, type SourceManifest } from "../../knowledge/source-baseline.js";
import { WorkSessionService, validateIntentEnvelope } from "../../knowledge/work-session.js";
import { ProviderRegistry } from "../../knowledge/provider-registry.js";
import { MigrationController } from "../../knowledge/migration-control.js";
import { runReleaseGates } from "../../knowledge/release-gates.js";
import { WeKnoraClient, WeKnoraError } from "../../knowledge/weknora.js";
import { WeKnoraClientDocumentWriter, WeKnoraIngestor } from "../../knowledge/weknora-ingest.js";
import { ContextPackService } from "../../knowledge/context-pack.js";
import { loadRelayContextSources } from "../../knowledge/context-sources.js";
import { resolveRetrievalProjectId } from "../../knowledge/weknora-scope.js";
import { canReadTopicBinding } from "../../knowledge/topic-access.js";
import { CandidateInsightCompiler, type ManagedCandidateInsightProvider } from "../../knowledge/candidate-insight.js";
import { CandidateInsightReviewService } from "../../knowledge/candidate-review.js";
import { ConfirmedMemoryService, CONFIRMED_MEMORY_TYPES } from "../../knowledge/confirmed-memory.js";
import { enqueueCandidateInsight } from "../../knowledge/candidate-worker.js";
import { WikiService, WIKI_PAGE_STATUSES } from "../../knowledge/wiki.js";
import { EnvironmentSecretResolver } from "../../knowledge/provider-secret.js";

/**
 * P00 extension boundary. Knowledge tools arrive in P01 and must be registered
 * here, never from the HTTP composition root.
 */
export interface KnowledgeToolsContext { server: McpServer; user: McpUser; knowledge?: KnowledgeStore; knowledgeAvailable?: () => boolean; resolveProjectName?: (project?: string) => string; }
export function registerKnowledgeTools(context: McpServer | KnowledgeToolsContext): void {
  const ctx: KnowledgeToolsContext = ('user' in context && 'server' in context)
    ? context
    : { server: context as McpServer, user: { id: 0, username: "boundary" } };
  const { server, user, knowledge, resolveProjectName } = ctx;
  const requireKnowledge = () => { if (!knowledge) throw new Error("Knowledge Plane is unavailable"); return knowledge; };
  const managedRegistry = () => new ProviderRegistry(requireKnowledge(), undefined, { secrets: new EnvironmentSecretResolver() });
  const candidateProvider = (providerId?: string): ManagedCandidateInsightProvider => {
    if (!providerId) return { providerId: "unconfigured", modelId: "deterministic-fallback", complete: async () => { throw new Error("Candidate Insight provider is not configured"); } };
    const registry = managedRegistry();
    const config = registry.get(providerId);
    if (!config) throw new Error("Candidate Insight provider is not configured");
    const handle = registry.resolveCandidateProvider(providerId);
    return { providerId: config.id, modelId: config.modelId, complete: async (request) => (await handle.complete(request.prompt)).text };
  };
  const weknoraClient = () => {
    const baseUrl = process.env.WEKNORA_BASE_URL;
    if (!baseUrl) throw new WeKnoraError("unavailable", "WeKnora provider is not configured");
    return new WeKnoraClient({ baseUrl, secretResolver: async () => process.env.WEKNORA_API_TOKEN, timeoutMs: Number(process.env.WEKNORA_TIMEOUT_MS ?? 30_000) });
  };
  const retrievalScope = (input: { workSessionId?: string; projectId?: string; productVersion?: string; solution?: string; module?: string; language?: string }) => {
    const store = requireKnowledge();
    const session = input.workSessionId ? new WorkSessionService(store).assertSessionUsable({ actorId: user.id, sessionId: input.workSessionId, projectId: input.projectId }) : undefined;
    const projectId = resolveRetrievalProjectId({ projectId: input.projectId, sessionProjectId: session?.projectId, fallbackProjectId: user.defaultProjectId ? String(user.defaultProjectId) : undefined, fallbackProjectName: user.defaultProject });
    if (!store.canRead(user.id, projectId)) throw new Error("Knowledge access denied");
    const ingestor = new WeKnoraIngestor(store, { upsertDocument: async () => ({ externalDocumentId: "unused" }) });
    return { session, projectId, ingestor, knowledgeIds: ingestor.retrievalKnowledgeIds({ projectId, productVersion: input.productVersion ?? session?.intent.sampleManagerVersion, solution: input.solution ?? session?.intent.solution, module: input.module ?? session?.intent.module, language: input.language }) };
  };
  const sourceManifest = (store: KnowledgeStore, id: string, snapshot = false): SourceManifest => {
    const table = snapshot ? "knowledge_project_snapshot_files" : "knowledge_source_files"; const key = snapshot ? "snapshot_id" : "baseline_id";
    const rows = store.db.prepare(`SELECT relative_path AS path,sha256,size_bytes AS size,language FROM ${table} WHERE ${key}=? ORDER BY relative_path`).all(id) as SourceManifest["files"];
    if (!rows.length) throw new Error("Source baseline or project snapshot not found"); return { root: id, files: rows, sha256: id };
  };
  const assertPublishedBaseline = (store: KnowledgeStore, id: string) => {
    const row = store.db.prepare(`SELECT p.status FROM knowledge_source_baselines b JOIN knowledge_artifact_publications p ON p.artifact_set_id=b.artifact_set_id WHERE b.id=?`).get(id) as { status?: string } | undefined;
    if (row?.status !== "published") throw new Error("Source baseline is not published");
  };
  const project = (name?: string) => resolveProjectName?.(name) ?? user.defaultProject;
  const canReadDocument = (store: KnowledgeStore, row: Record<string, unknown>, targetProjectId?: string): boolean => {
    const sourceProjectId = row.project_id === null || row.project_id === undefined ? undefined : String(row.project_id);
    const target = targetProjectId ?? sourceProjectId;
    if (!target || !store.canRead(user.id, target)) {
      // Resource URIs do not carry a target Project. A verified global or
      // organization document may still be opened by a user who has read ACL
      // on any Project; its private source Evidence remains filtered elsewhere.
      const reusable = store.getScopeBinding(String(row.id));
      if (!(reusable && (reusable.visibility === "global" || reusable.visibility === "organization") && ["verified", "approved"].includes(String(row.lifecycle)) && store.db.prepare("SELECT 1 FROM knowledge_acl WHERE user_id = ? AND can_read = 1 LIMIT 1").get(user.id))) return false;
      return true;
    }
    if (sourceProjectId === target) return true;
    const scope = store.getScopeBinding(String(row.id));
    return Boolean(scope && (scope.visibility === "global" || scope.visibility === "organization") && ["verified", "approved"].includes(String(row.lifecycle)));
  };
  const provenance = (store: KnowledgeStore, row: Record<string, unknown>) => {
    const kind = String(row.kind);
    if (kind === "candidate") return store.db.prepare("SELECT event_id,event_id AS source_event_id,job_id,deployment_id,evidence_refs_json FROM knowledge_candidates WHERE id = ?").get(String(row.id)) as Record<string, unknown> | undefined;
    if (kind === "case") return store.db.prepare("SELECT event_id,job_id,deployment_id,source_candidate_id,evidence_refs_json FROM knowledge_cases WHERE id = ?").get(String(row.id)) as Record<string, unknown> | undefined;
    return undefined;
  };
  const evidenceRefs = (source?: Record<string, unknown>): string[] => {
    if (!source?.evidence_refs_json) return [];
    try {
      const parsed = JSON.parse(String(source.evidence_refs_json));
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch { return []; }
  };
  server.tool("knowledge_search", "Search ACL- and scope-filtered Confirmed Memory. Candidate Insights and Approved Operations require explicit tools or filters.", { project: z.string().optional(), query: z.string().min(1), limit: z.number().int().min(1).max(100).optional(), sampleManagerVersion: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), environment: z.string().optional(), scopeType: z.string().optional(), scopeKey: z.string().optional(), memoryTypes: z.array(z.enum(["Fact", "Decision", "Case", "Pattern"])).optional() }, async ({ project: projectName, query, limit, sampleManagerVersion, solution, module, environment, scopeType, scopeKey, memoryTypes }) => {
    const store = requireKnowledge();
    const projectNameResolved = project(projectName);
    if (!projectNameResolved) throw new Error("No project selected");
    const projectId = user.defaultProjectId && projectNameResolved === user.defaultProject ? String(user.defaultProjectId) : projectNameResolved;
    store.grantAcl(projectId, user.id, false);
    return { content: [{ type: "text", text: summarizeJson(await searchKnowledge(store, { userId: user.id, projectId, query, limit, sampleManagerVersion, solution, module, environment, scopeType, scopeKey, memoryTypes })) }] };
  });
  server.tool("knowledge_get", "Read a complete Knowledge document by id after project/scope ACL enforcement.", { documentId: z.string(), project: z.string().optional() }, async ({ documentId, project: projectName }) => {
    const store = requireKnowledge();
    const row = store.db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(documentId) as Record<string, unknown> | undefined;
    const name = project(projectName); const projectId = user.defaultProjectId && name === user.defaultProject ? String(user.defaultProjectId) : name;
    if (!row || !canReadDocument(store, row, projectId)) throw new Error("Knowledge access denied");
    const source = provenance(store, row);
    return { content: [{ type: "text", text: summarizeJson({ id: row.id, kind: row.kind, title: row.title, body: row.body, lifecycle: row.lifecycle, projectId: row.project_id, eventId: source?.event_id, jobId: source?.job_id, deploymentId: source?.deployment_id, sourceCandidateId: source?.source_candidate_id, evidenceRefs: evidenceRefs(source), scope: store.getScopeBinding(documentId), card: String(row.kind) === "candidate" ? store.getCandidateCard(documentId) : undefined, sourceLocator: row.source_locator, sourceSha256: row.source_sha256, updatedAt: row.updated_at }) }] };
  });
  server.tool("knowledge_playbook_get", "Read a draft, approved, or deprecated Playbook with its steps and proposed Skill diff.", { playbookId: z.string(), project: z.string().optional() }, async ({ playbookId, project: projectName }) => {
    const store = requireKnowledge();
    const row = store.db.prepare("SELECT d.*, p.steps_json, p.rollback, p.skill_diff FROM knowledge_documents d LEFT JOIN knowledge_playbooks p ON p.id = d.id WHERE d.id = ? AND d.kind = 'playbook'").get(playbookId) as Record<string, unknown> | undefined;
    const name = project(projectName); const projectId = user.defaultProjectId && name === user.defaultProject ? String(user.defaultProjectId) : name;
    if (!row || !canReadDocument(store, row, projectId)) throw new Error("Knowledge access denied");
    return { content: [{ type: "text", text: summarizeJson({ id: row.id, kind: row.kind, title: row.title, body: row.body, lifecycle: row.lifecycle, projectId: row.project_id, scope: store.getScopeBinding(playbookId), steps: row.steps_json ? JSON.parse(String(row.steps_json)) : [], rollback: row.rollback, skillDiff: row.skill_diff, sourceLocator: row.source_locator, sourceSha256: row.source_sha256 }) }] };
  });
  server.tool("knowledge_evidence_get", "Return metadata for Evidence; content is available through a bounded, audited read.", { evidenceId: z.string() }, async ({ evidenceId }) => {
    const store = requireKnowledge();
    const row = new EvidenceStore(store, store.evidenceRoot ?? "./data/evidence").metadata(user.id, evidenceId);
    return { content: [{ type: "text", text: summarizeJson(row) }] };
  });
  server.tool("knowledge_relation_query", "Query deterministic, source-backed SampleManager object relations.", { project: z.string().optional(), objectId: z.string().optional(), relationType: z.string().optional(), verifiedOnly: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() }, async ({ project: projectName, objectId, relationType, verifiedOnly, limit }) => {
    const store = requireKnowledge(); const name = project(projectName); if (!name) throw new Error("No project selected");
    const projectId = user.defaultProjectId && name === user.defaultProject ? String(user.defaultProjectId) : name; store.grantAcl(projectId, user.id, false);
    return { content: [{ type: "text", text: summarizeJson(queryRelations(store, { userId: user.id, projectId, objectId, relationType: relationType as never, verifiedOnly, limit })) }] };
  });
  server.tool("knowledge_feedback", "Record whether a Knowledge result was useful; this never mutates the source casebook.", { documentId: z.string(), helpful: z.boolean().optional(), comment: z.string().max(2_000).optional() }, async ({ documentId, helpful, comment }) => {
    const store = requireKnowledge(); const row = store.db.prepare("SELECT project_id FROM knowledge_documents WHERE id = ?").get(documentId) as { project_id?: string } | undefined;
    if (!row || !store.canRead(user.id, row.project_id)) throw new Error("Knowledge access denied");
    store.db.prepare("INSERT INTO knowledge_feedback(id,document_id,user_id,helpful,comment,created_at) VALUES (?,?,?,?,?,?)").run(`feedback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, documentId, user.id, helpful === undefined ? null : helpful ? 1 : 0, comment ?? null, new Date().toISOString());
    store.audit({ actorId: user.id, projectId: row.project_id, action: "knowledge.feedback", entityType: "document", entityId: documentId });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  });
  server.tool("knowledge_ingest", "Import Git-managed Casebook Markdown/YAML and legacy context JSONL idempotently.", { casebookRoot: z.string(), contextFiles: z.array(z.string()).optional(), project: z.string().optional() }, async ({ casebookRoot, contextFiles, project: projectName }) => {
    const store = requireKnowledge(); const name = project(projectName); if (!name) throw new Error("No project selected");
    const projectId = user.defaultProjectId && name === user.defaultProject ? String(user.defaultProjectId) : name; store.grantAcl(projectId, user.id, false);
    const report = importCasebook(store, { root: casebookRoot, projectId, projectNameSnapshot: name, evidenceRoot: store.evidenceRoot });
    const facts = contextFiles?.length ? importContextFacts(store, { files: contextFiles, userId: user.id, projectId, projectNameSnapshot: name }) : undefined;
    return { content: [{ type: "text", text: summarizeJson({ report, facts }) }] };
  });
  server.tool("knowledge_reindex", "Rebuild project-scoped FTS and invalidate cached embeddings after a controlled model or source change.", { project: z.string().optional(), invalidateEmbeddings: z.boolean().optional() }, async ({ project: projectName, invalidateEmbeddings }) => {
    const store = requireKnowledge(); const name = project(projectName); if (!name) throw new Error("No project selected");
    const projectId = user.defaultProjectId && name === user.defaultProject ? String(user.defaultProjectId) : name; store.grantAcl(projectId, user.id, false);
    const documents = Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents WHERE project_id = ?").get(projectId) as { count?: number } | undefined)?.count ?? 0);
    const facts = Number((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_facts WHERE project_id = ?").get(projectId) as { count?: number } | undefined)?.count ?? 0);
    store.db.transaction(() => {
      store.db.prepare("DELETE FROM knowledge_fts WHERE document_id IN (SELECT id FROM knowledge_documents WHERE project_id = ?)").run(projectId);
      store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) SELECT c.document_id, d.title, c.content FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id WHERE d.project_id = ?").run(projectId);
      store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) SELECT d.id, d.title, d.body FROM knowledge_documents d WHERE d.project_id = ? AND NOT EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.document_id = d.id)").run(projectId);
      store.db.prepare("DELETE FROM knowledge_facts_fts WHERE rowid IN (SELECT rowid FROM knowledge_facts WHERE project_id = ?)").run(projectId);
      store.db.prepare("INSERT INTO knowledge_facts_fts(rowid,fact_id,text,tags) SELECT rowid,id,text,tags_json FROM knowledge_facts WHERE project_id = ?").run(projectId);
      if (invalidateEmbeddings) store.db.prepare("DELETE FROM knowledge_embeddings WHERE document_id IN (SELECT id FROM knowledge_documents WHERE project_id = ?)").run(projectId);
    })();
    const result = { ok: true, projectId, documents, facts, embeddingsInvalidated: Boolean(invalidateEmbeddings), completedAt: new Date().toISOString() };
    store.audit({ actorId: user.id, projectId, action: "knowledge.reindex", entityType: "index", entityId: `project:${projectId}`, details: result });
    return { content: [{ type: "text", text: summarizeJson(result) }] };
  });
  server.tool("knowledge_source_search", "Search published Product/Solution source chunks with path, symbol, line and version provenance.", { query: z.string().min(1), baselineId: z.string().optional(), projectSnapshotId: z.string().optional(), solution: z.string().optional(), version: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }, async ({ query, baselineId, projectSnapshotId, solution, version, limit }) => {
    const store = requireKnowledge(); if (!baselineId && !projectSnapshotId) throw new Error("baselineId or projectSnapshotId is required");
    if (!user.isAdmin && !store.db.prepare("SELECT 1 FROM knowledge_acl WHERE user_id=? AND can_read=1 LIMIT 1").get(user.id)) throw new Error("Knowledge access denied");
    if (baselineId) assertPublishedBaseline(store, baselineId);
    if (projectSnapshotId) { const row = store.db.prepare("SELECT project_id FROM knowledge_project_snapshots WHERE id=?").get(projectSnapshotId) as { project_id?: string } | undefined; if (!row || (row.project_id && !store.canRead(user.id, row.project_id))) throw new Error("Knowledge access denied"); }
    const where = ["knowledge_source_chunks_fts MATCH ?"]; const params: unknown[] = [query];
    if (baselineId) { where.push("c.baseline_id=?"); params.push(baselineId); } if (projectSnapshotId) { where.push("c.snapshot_id=?"); params.push(projectSnapshotId); }
    if (solution) { where.push("b.solution=?"); params.push(solution); } if (version) { where.push("b.version=?"); params.push(version); }
    const rows = store.db.prepare(`SELECT c.id,c.relative_path,c.symbol,c.line_start,c.line_end,c.content,c.content_sha256,c.parser_version,b.solution,b.version FROM knowledge_source_chunks_fts f JOIN knowledge_source_chunks c ON c.id=f.chunk_id LEFT JOIN knowledge_source_baselines b ON b.id=c.baseline_id WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`).all(...params, limit ?? 10);
    return { content: [{ type: "text", text: summarizeJson({ query, results: rows }) }] };
  });
  server.tool("knowledge_source_read", "Read one bounded source chunk or file range from a published baseline/project snapshot.", { chunkId: z.string().optional(), baselineId: z.string().optional(), projectSnapshotId: z.string().optional(), path: z.string().optional(), lineStart: z.number().int().min(1).optional(), lineEnd: z.number().int().min(1).optional() }, async ({ chunkId, baselineId, projectSnapshotId, path, lineStart, lineEnd }) => {
    const store = requireKnowledge(); if (baselineId) assertPublishedBaseline(store, baselineId); if (!chunkId && (!path || (!baselineId && !projectSnapshotId))) throw new Error("chunkId or scoped path is required");
    if (!user.isAdmin && !store.db.prepare("SELECT 1 FROM knowledge_acl WHERE user_id=? AND can_read=1 LIMIT 1").get(user.id)) throw new Error("Knowledge access denied");
    const row = chunkId ? store.db.prepare("SELECT * FROM knowledge_source_chunks WHERE id=?").get(chunkId) as Record<string, unknown> | undefined : (store.db.prepare(`SELECT * FROM knowledge_source_chunks WHERE relative_path=? AND ${baselineId ? "baseline_id=?" : "snapshot_id=?"} AND line_end>=? ORDER BY line_start LIMIT 1`).get(path, baselineId ?? projectSnapshotId, lineStart ?? 1) as Record<string, unknown> | undefined);
    if (!row) throw new Error("Source chunk not found"); if (baselineId && row.baseline_id !== baselineId) throw new Error("Source scope mismatch"); if (projectSnapshotId && row.snapshot_id !== projectSnapshotId) throw new Error("Source scope mismatch");
    return { content: [{ type: "text", text: summarizeJson({ path: row.relative_path, symbol: row.symbol, lineStart: row.line_start, lineEnd: row.line_end, content: row.content, contentHash: row.content_sha256, parserVersion: row.parser_version, requestedRange: { lineStart, lineEnd } }) }] };
  });
  server.tool("knowledge_topic_get", "Read one logical Product Knowledge topic with all version bindings and revision content.", { topicId: z.string() }, async ({ topicId }) => {
    const store = requireKnowledge(); const topic = store.db.prepare("SELECT * FROM knowledge_topics WHERE id=?").get(topicId); if (!topic) throw new Error("Knowledge topic not found");
    const rows = store.db.prepare(`SELECT b.topic_id,b.product,b.product_version,b.source_path,b.match_method,b.match_confidence,d.id AS document_id,d.title,d.body,d.source_locator,d.source_sha256,d.project_id AS document_project_id FROM knowledge_product_document_bindings b JOIN knowledge_documents d ON d.id=b.document_id WHERE b.topic_id=? ORDER BY b.product_version`).all(topicId) as Array<Record<string, unknown>>;
    const visibleRows = user.isAdmin ? rows : rows.filter((row) => canReadTopicBinding(store, user.id, row.document_project_id));
    const bindings = visibleRows.map(({ document_project_id: _project, ...row }) => row);
    if (!user.isAdmin && !bindings.length) throw new Error("Knowledge access denied");
    return { content: [{ type: "text", text: summarizeJson({ topic, bindings }) }] };
  });
  server.tool("knowledge_topic_diff", "Compare the bound Product Knowledge revisions for two versions of one topic.", { topicId: z.string(), fromVersion: z.string(), toVersion: z.string() }, async ({ topicId, fromVersion, toVersion }) => {
    const store = requireKnowledge(); const rows = store.db.prepare("SELECT b.product_version,b.document_id,d.project_id AS document_project_id FROM knowledge_product_document_bindings b JOIN knowledge_documents d ON d.id=b.document_id WHERE b.topic_id=? AND b.product_version IN (?,?)").all(topicId, fromVersion, toVersion) as Array<{ product_version: string; document_id: string; document_project_id?: string }>;
    const readableRows = user.isAdmin ? rows : rows.filter((row) => canReadTopicBinding(store, user.id, row.document_project_id));
    const ids = new Map(readableRows.map((row) => [row.product_version, row.document_id])); const left = ids.get(fromVersion), right = ids.get(toVersion); if (!left || !right) throw new Error("Topic versions not found");
    const load = (id: string) => store.db.prepare("SELECT sections_json FROM knowledge_product_documents WHERE id=?").get(id) as { sections_json?: string };
    return { content: [{ type: "text", text: summarizeJson({ topicId, fromVersion, toVersion, from: load(left), to: load(right) }) }] };
  });
  server.tool("knowledge_solution_upgrade_analysis", "Run a published-baseline three-way upgrade comparison against a project snapshot.", { oldBaselineId: z.string(), currentProjectSnapshotId: z.string(), newBaselineId: z.string(), limit: z.number().int().min(1).max(1000).optional() }, async ({ oldBaselineId, currentProjectSnapshotId, newBaselineId, limit }) => {
    const store = requireKnowledge(); assertPublishedBaseline(store, oldBaselineId); assertPublishedBaseline(store, newBaselineId);
    if (!user.isAdmin && !store.db.prepare("SELECT 1 FROM knowledge_acl WHERE user_id=? AND can_read=1 LIMIT 1").get(user.id)) throw new Error("Knowledge access denied");
    const changes = compareSourceBaselines(sourceManifest(store, oldBaselineId), sourceManifest(store, currentProjectSnapshotId, true), sourceManifest(store, newBaselineId));
    const ids = (table: string, key: string, id: string) => new Map((store.db.prepare(`SELECT relative_path,id FROM ${table} WHERE ${key}=?`).all(id) as Array<{ relative_path: string; id: string }>).map((row) => [row.relative_path, row.id]));
    const oldIds = ids("knowledge_source_files", "baseline_id", oldBaselineId); const projectIds = ids("knowledge_project_snapshot_files", "snapshot_id", currentProjectSnapshotId); const newIds = ids("knowledge_source_files", "baseline_id", newBaselineId);
    const withEvidence = changes.map((change) => ({ ...change, evidenceRefs: { old: oldIds.get(change.path), project: projectIds.get(change.path), next: newIds.get(change.path) } }));
    return { content: [{ type: "text", text: summarizeJson({ oldBaselineId, currentProjectSnapshotId, newBaselineId, changes: withEvidence.slice(0, limit ?? 1000), counts: changes.reduce<Record<string, number>>((acc, item) => { acc[item.status] = (acc[item.status] ?? 0) + 1; return acc; }, {}) }) }] };
  });

  server.tool("knowledge_work_session_open", "Open an ACL-scoped Work Session with an IntentEnvelope for a multi-step task.", { idempotencyKey: z.string().min(1).max(300), intent: z.record(z.unknown()), summary: z.string().max(8000).optional() }, async ({ idempotencyKey, intent, summary }) => {
    const store = requireKnowledge(); const validated = validateIntentEnvelope({ ...intent, actorId: user.id }); const session = new WorkSessionService(store).open({ actorId: user.id, idempotencyKey, intent: validated, summary }); return { content: [{ type: "text", text: summarizeJson({ session }) }] };
  });
  server.tool("knowledge_work_session_update", "Update a Work Session phase or user-visible IntentEnvelope fields.", { sessionId: z.string(), patch: z.record(z.unknown()), idempotencyKey: z.string().max(300).optional() }, async ({ sessionId, patch, idempotencyKey }) => { const session = new WorkSessionService(requireKnowledge()).update({ actorId: user.id, sessionId, patch: patch as never, idempotencyKey }); return { content: [{ type: "text", text: summarizeJson({ session }) }] }; });
  server.tool("knowledge_work_session_close", "Close a Work Session with acceptance results and unknowns.", { sessionId: z.string(), result: z.object({ summary: z.string().max(8000).optional(), unknowns: z.array(z.string().max(2000)).max(100).optional(), acceptanceResults: z.record(z.union([z.boolean(), z.string().max(500)])).optional() }).optional(), idempotencyKey: z.string().max(300).optional() }, async ({ sessionId, result, idempotencyKey }) => { const session = new WorkSessionService(requireKnowledge()).close({ actorId: user.id, sessionId, result, idempotencyKey }); return { content: [{ type: "text", text: summarizeJson({ session }) }] }; });
  server.tool("knowledge_work_session_get", "Read a Work Session and its correlated event metadata after ACL enforcement.", { sessionId: z.string() }, async ({ sessionId }) => { const service = new WorkSessionService(requireKnowledge()); return { content: [{ type: "text", text: summarizeJson({ session: service.get({ actorId: user.id, sessionId }), events: service.listEvents({ actorId: user.id, sessionId }) }) }] }; });
  server.tool("knowledge_work_session_list", "List the caller's Work Sessions on projects they can still read, with time-ordered event aggregation.", { limit: z.number().int().min(1).max(200).optional(), sessionId: z.string().optional() }, async ({ limit, sessionId }) => {
    const service = new WorkSessionService(requireKnowledge());
    if (sessionId) return { content: [{ type: "text", text: summarizeJson(service.summarize({ actorId: user.id, sessionId })) }] };
    return { content: [{ type: "text", text: summarizeJson({ sessions: service.list({ actorId: user.id, limit }) }) }] };
  });
  server.tool("knowledge_provider_config_list", "List safe Relay provider metadata without returning secrets.", {}, async () => { return { content: [{ type: "text", text: summarizeJson({ providers: managedRegistry().list(), pendingReindex: managedRegistry().pendingReindex() }) }] }; });
  server.tool("knowledge_candidate_insight_compile", "Compile an Evidence-backed Candidate Insight for a Work Session, with deterministic fallback and no auto-approval.", { sessionId: z.string(), evidenceRefs: z.array(z.string().min(1)).max(100), context: z.record(z.unknown()).optional(), providerId: z.string().optional(), async: z.boolean().optional() }, async ({ sessionId, evidenceRefs, context, providerId, async: enqueue }) => {
    const store = requireKnowledge();
    if (enqueue) return { content: [{ type: "text", text: summarizeJson(enqueueCandidateInsight(store, { actorId: user.id, sessionId, evidenceRefs, context: context ?? {} })) }] };
    const insight = await new CandidateInsightCompiler(store, candidateProvider(providerId)).compile({ actorId: user.id, sessionId, evidenceRefs, context: context ?? {} });
    return { content: [{ type: "text", text: summarizeJson({ insight }) }] };
  });
  server.tool("knowledge_candidate_insight_list", "List ACL-scoped Candidate Insights pending or completed through human review.", { projectId: z.string(), status: z.enum(["draft", "accepted", "edited", "rejected"]).optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }, async (input) => {
    const insights = new CandidateInsightReviewService(requireKnowledge()).list({ actorId: user.id, ...input });
    return { content: [{ type: "text", text: summarizeJson({ insights }) }] };
  });
  server.tool("knowledge_candidate_insight_review", "Explicitly confirm, edit, reject, or promote a Candidate Insight; every action requires a reason.", { insightId: z.string(), action: z.enum(["confirm", "edit", "reject", "promote"]), reason: z.string().min(1).max(2000), patch: z.record(z.unknown()).optional(), target: z.enum(["fact", "decision", "case", "pattern"]).optional(), title: z.string().max(300).optional() }, async ({ insightId, action, reason, patch, target, title }) => {
    const service = new CandidateInsightReviewService(requireKnowledge());
    const result = action === "confirm" ? service.confirm({ actorId: user.id, id: insightId, reason })
      : action === "reject" ? service.reject({ actorId: user.id, id: insightId, reason })
      : action === "edit" ? service.edit({ actorId: user.id, id: insightId, patch: patch as never, reason })
      : service.promote({ actorId: user.id, id: insightId, target: target ?? "fact", title, reason });
    return { content: [{ type: "text", text: summarizeJson({ result }) }] };
  });
  server.tool("knowledge_confirmed_memory_list", "List ACL-scoped Confirmed Memory records; Candidate Insights and Playbooks are excluded by default.", { projectId: z.string(), type: z.enum(CONFIRMED_MEMORY_TYPES).optional(), environment: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }, async (input) => {
    const memories = new ConfirmedMemoryService(requireKnowledge()).list({ actorId: user.id, ...input });
    return { content: [{ type: "text", text: summarizeJson({ memories }) }] };
  });
  server.tool("knowledge_confirmed_memory_get", "Read one Confirmed Memory with Evidence, scope, source, confirmer and audit metadata.", { memoryId: z.string() }, async ({ memoryId }) => {
    const memory = new ConfirmedMemoryService(requireKnowledge()).get({ actorId: user.id, id: memoryId });
    return { content: [{ type: "text", text: summarizeJson({ memory }) }] };
  });
  server.tool("knowledge_wiki_search", "Search Relay-native Wiki pages with ACL, version, topic, solution and module filters.", { projectId: z.string().optional(), query: z.string().optional(), status: z.enum(WIKI_PAGE_STATUSES).optional(), productVersion: z.string().optional(), topicId: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }, async (input) => {
    const result = new WikiService(requireKnowledge()).list({ actorId: user.id, projectId: input.projectId, status: input.status, productVersion: input.productVersion, topicId: input.topicId, solution: input.solution, module: input.module, search: input.query, limit: input.limit, offset: input.offset });
    return { content: [{ type: "text", text: summarizeJson(result) }] };
  });
  server.tool("knowledge_wiki_get", "Read a Relay-native Wiki page and optionally its revision history or unified diff.", { pageId: z.string(), includeRevisions: z.boolean().optional(), fromRevision: z.number().int().positive().optional(), toRevision: z.number().int().positive().optional() }, async ({ pageId, includeRevisions, fromRevision, toRevision }) => {
    const wiki = new WikiService(requireKnowledge()); const page = wiki.get({ actorId: user.id, id: pageId });
    const revisions = includeRevisions ? wiki.listRevisions({ actorId: user.id, id: pageId }) : undefined;
    const diff = fromRevision && toRevision ? wiki.diffRevisions({ actorId: user.id, id: pageId, fromRevision, toRevision }) : undefined;
    return { content: [{ type: "text", text: summarizeJson({ page, revisions, diff }) }] };
  });
  server.tool("knowledge_wiki_write", "Create a page idempotently or append a reviewed edit; content is scanned before persistence.", { pageKey: z.string().max(300).optional(), pageId: z.string().optional(), title: z.string().min(1).max(500), body: z.string().min(1), projectId: z.string().optional(), productVersion: z.string().optional(), topicId: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), sourceRefs: z.array(z.string()).max(100).optional(), reason: z.string().min(1).max(2000) }, async (input) => {
    const wiki = new WikiService(requireKnowledge());
    const page = input.pageId ? wiki.edit({ actorId: user.id, id: input.pageId, title: input.title, body: input.body, reason: input.reason }) : wiki.create({ actorId: user.id, pageKey: input.pageKey ?? "", title: input.title, body: input.body, projectId: input.projectId, productVersion: input.productVersion, topicId: input.topicId, solution: input.solution, module: input.module, sourceRefs: input.sourceRefs, reason: input.reason });
    return { content: [{ type: "text", text: summarizeJson({ page }) }] };
  });
  server.tool("knowledge_wiki_review", "Publish, deprecate, or roll back a Wiki page with an explicit reason and audit trail.", { pageId: z.string(), action: z.enum(["publish", "deprecate", "rollback"]), revision: z.number().int().positive().optional(), reason: z.string().min(1).max(2000) }, async ({ pageId, action, revision, reason }) => {
    const wiki = new WikiService(requireKnowledge());
    const page = action === "publish" ? wiki.publish({ actorId: user.id, id: pageId, reason }) : action === "deprecate" ? wiki.deprecate({ actorId: user.id, id: pageId, reason }) : wiki.rollback({ actorId: user.id, id: pageId, revision: revision ?? 0, reason });
    return { content: [{ type: "text", text: summarizeJson({ page }) }] };
  });
  server.tool("knowledge_migration_create", "Create an idempotent staged Product Knowledge migration record.", { idempotencyKey: z.string().min(1).max(300), sourceManifest: z.record(z.unknown()), kind: z.string().max(100).optional() }, async ({ idempotencyKey, sourceManifest, kind }) => { if (!user.isAdmin) throw new Error("Administrator access is required"); const migration = new MigrationController(requireKnowledge()).create({ actorId: user.id, idempotencyKey, sourceManifest, kind }); return { content: [{ type: "text", text: summarizeJson({ migration }) }] }; });
  server.tool("knowledge_migration_from_local", "Stage local Product Knowledge into WeKnora with a metadata-only manifest and per-document report.", { idempotencyKey: z.string().min(1).max(300), parserVersion: z.string().min(1).max(100), productVersion: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), projectId: z.string().optional(), limit: z.number().int().min(1).max(10000).optional(), retry: z.boolean().optional() }, async (input) => {
    if (!user.isAdmin) throw new Error("Administrator access is required");
    const knowledgeBaseId = process.env.WEKNORA_KNOWLEDGE_BASE_ID;
    if (!knowledgeBaseId) throw new Error("WeKnora provider is not configured");
    const ingestor = new WeKnoraIngestor(requireKnowledge(), new WeKnoraClientDocumentWriter(weknoraClient(), knowledgeBaseId));
    const migration = await new MigrationController(requireKnowledge()).createFromLocal({ actorId: user.id, ...input }, ingestor);
    return { content: [{ type: "text", text: summarizeJson({ migration }) }] };
  });
  server.tool("knowledge_migration_publish", "Validate, publish and switch a staged Product Knowledge migration to WeKnora.", { migrationId: z.string() }, async ({ migrationId }) => { if (!user.isAdmin) throw new Error("Administrator access is required"); const migration = new MigrationController(requireKnowledge()).validateAndPublish(migrationId, user.id); return { content: [{ type: "text", text: summarizeJson({ migration }) }] }; });
  server.tool("knowledge_migration_rollback", "Rollback a Product Knowledge migration and restore Relay local retrieval with an audit reason.", { migrationId: z.string(), reason: z.string().min(1).max(2000) }, async ({ migrationId, reason }) => { if (!user.isAdmin) throw new Error("Administrator access is required"); const migration = new MigrationController(requireKnowledge()).rollback(migrationId, user.id, reason); return { content: [{ type: "text", text: summarizeJson({ migration }) }] }; });
  server.tool("knowledge_release_gates", "Run deterministic security, migration, provider, ACL and visibility release gates.", {}, async () => { if (!user.isAdmin) throw new Error("Administrator access is required"); return { content: [{ type: "text", text: summarizeJson(runReleaseGates(requireKnowledge())) }] }; });
  server.tool("knowledge_weknora_search", "Search published Product Knowledge through Relay's ACL-checked internal WeKnora boundary.", { query: z.string().min(1), workSessionId: z.string().optional(), projectId: z.string().optional(), productVersion: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), language: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }, async ({ query, workSessionId, projectId, productVersion, solution, module, language, limit }) => {
    const scope = retrievalScope({ workSessionId, projectId, productVersion, solution, module, language });
    let relaySources = { confirmedKnowledge: [], candidates: [], currentFacts: [], degraded: undefined } as Awaited<ReturnType<typeof loadRelayContextSources>>;
    try { relaySources = await loadRelayContextSources({ store: requireKnowledge(), userId: user.id, projectId: scope.projectId, query, intent: scope.session?.intent, limit: limit ?? 10 }); } catch { relaySources = { confirmedKnowledge: [], candidates: [], currentFacts: [], degraded: { relayMemory: "unavailable" } }; }
    if (!scope.knowledgeIds.length) {
      const contextPack = new ContextPackService({ provider: "weknora" }).build({ intent: scope.session?.intent, authoritativeDocs: [], confirmedKnowledge: relaySources.confirmedKnowledge, candidates: relaySources.candidates, currentFacts: relaySources.currentFacts, degraded: { ...relaySources.degraded, productKnowledge: "no_published_documents" }, acl: { documentIds: [] }, maxItemsPerSection: limit ?? 10 });
      return { content: [{ type: "text", text: summarizeJson({ retrievalRunId: "local-scope-empty", references: [], degraded: contextPack.degraded, contextPack }) }] };
    }
    const result = await weknoraClient().search({ query, knowledgeIds: scope.knowledgeIds, limit });
    const visible = new Set(scope.knowledgeIds);
    const references = result.references.filter((reference) => visible.has(reference.documentId));
    const contextPack = new ContextPackService({ provider: "weknora" }).build({ intent: scope.session?.intent, authoritativeDocs: references, confirmedKnowledge: relaySources.confirmedKnowledge, candidates: relaySources.candidates, currentFacts: relaySources.currentFacts, degraded: { ...relaySources.degraded, ...(result.degraded ? { productKnowledge: "degraded" } : {}) }, acl: { documentIds: scope.knowledgeIds }, maxItemsPerSection: limit ?? 10 });
    return { content: [{ type: "text", text: summarizeJson({ ...result, references: contextPack.authoritativeDocs, contextPack }) }] };
  });

  // Resource templates keep large document bodies out of search responses and
  // let MCP clients open provenance on demand. Evidence resources intentionally
  // expose metadata only; bytes remain behind the audited bounded download API.
  server.resource("knowledge-document", new ResourceTemplate("knowledge://{kind}/{id}", { list: undefined }), async (uri, variables) => {
    const store = requireKnowledge(); const kind = String(variables.kind); const id = String(variables.id);
    const row = store.db.prepare("SELECT * FROM knowledge_documents WHERE id = ? AND kind = ?").get(id, kind) as Record<string, unknown> | undefined;
    const name = project(); const projectId = user.defaultProjectId && name === user.defaultProject ? String(user.defaultProjectId) : name;
    if (!row || !canReadDocument(store, row, projectId)) throw new Error("Knowledge access denied");
    store.audit({ actorId: user.id, projectId: row.project_id ? String(row.project_id) : undefined, action: "knowledge.resource.read", entityType: kind, entityId: id });
    const source = provenance(store, row);
    return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify({ id: row.id, kind: row.kind, title: row.title, body: row.body, lifecycle: row.lifecycle, projectId: row.project_id, eventId: source?.event_id, jobId: source?.job_id, deploymentId: source?.deployment_id, sourceCandidateId: source?.source_candidate_id, evidenceRefs: evidenceRefs(source), scope: store.getScopeBinding(id), card: kind === "candidate" ? store.getCandidateCard(id) : undefined, sourceLocator: row.source_locator, sourceSha256: row.source_sha256, updatedAt: row.updated_at }) }] };
  });
}
