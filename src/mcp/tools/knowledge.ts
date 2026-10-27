import { createHash } from "node:crypto";
import { getProductBackend, searchEngineProductReferences, productCatalogVisibility } from "../../knowledge/product-backend.js";
import { managedControlPlane, activeWikiService } from "../../knowledge/engine-service.js";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpUser } from "../register-tools.js";
import { z } from "zod";
import { importCasebook, importContextFacts } from "../../knowledge/importer.js";
import { queryRelations } from "../../knowledge/relations.js";
import { searchKnowledge } from "../../knowledge/retriever.js";
import type { KnowledgeStore } from "../../knowledge/store.js";
import { serializeKnowledgeResult } from "../knowledge-output.js";
import { EvidenceStore } from "../../knowledge/evidence-store.js";
import { compareSourceBaselines, type SourceManifest } from "../../knowledge/source-baseline.js";
import { compareSourceUpgradeWithSymbols } from "../../knowledge/source-symbol.js";
import { WorkSessionService, validateIntentEnvelope } from "../../knowledge/work-session.js";
import { MigrationController } from "../../knowledge/migration-control.js";
import { runReleaseGates } from "../../knowledge/release-gates.js";

import { WeKnoraIngestor } from "../../knowledge/weknora-ingest.js";
import { ContextPackService } from "../../knowledge/context-pack.js";
import { loadRelayContextSources } from "../../knowledge/context-sources.js";
import { resolveRetrievalProjectId } from "../../knowledge/weknora-scope.js";
import { CandidateInsightCompiler } from "../../knowledge/candidate-insight.js";
import { createCandidateInsightProvider } from "../../knowledge/candidate-provider.js";
import { CandidateInsightReviewService } from "../../knowledge/candidate-review.js";
import { enqueueCandidateInsight, getCandidateInsightJob } from "../../knowledge/candidate-worker.js";
import { WIKI_PAGE_STATUSES } from "../../knowledge/wiki.js";
import { createManagedProviderRegistry } from "../../knowledge/provider-setup.js";

/**
 * P00 extension boundary. Knowledge tools arrive in P01 and must be registered
 * here, never from the HTTP composition root.
 */
export interface KnowledgeToolsContext { server: McpServer; user: McpUser; knowledge?: KnowledgeStore; knowledgeAvailable?: () => boolean; resolveProjectName?: (project?: string) => string; resolveProjectId?: (projectId: string) => string; resolveProjectNameToId?: (name: string) => string; }
export function registerKnowledgeTools(context: McpServer | KnowledgeToolsContext): void {
  const ctx: KnowledgeToolsContext = ('user' in context && 'server' in context)
    ? context
    : { server: context as McpServer, user: { id: 0, username: "boundary" } };
  const { server, user, knowledge, resolveProjectName, resolveProjectId, resolveProjectNameToId } = ctx;
  const requireKnowledge = () => { if (!knowledge) throw new Error("Knowledge Plane is unavailable"); return knowledge; };
  const workSessions = () => new WorkSessionService(requireKnowledge(), undefined, resolveProjectId ? (_actorId, projectId) => { resolveProjectId(projectId); } : undefined);
  const managedRegistry = () => createManagedProviderRegistry(requireKnowledge());
  const candidateProvider = (providerId?: string) => createCandidateInsightProvider(requireKnowledge(),providerId);
  const retrievalScope = (input: { workSessionId?: string; projectId?: string; productVersion?: string; solution?: string; module?: string; language?: string }) => {
    const store = requireKnowledge();
    const session = input.workSessionId ? workSessions().assertSessionUsable({ actorId: user.id, sessionId: input.workSessionId, projectId: input.projectId, environment: user.defaultEnvironment }) : undefined;
    const projectId = resolveRetrievalProjectId({ projectId: input.projectId, sessionProjectId: session?.projectId, fallbackProjectId: user.defaultProjectId ? String(user.defaultProjectId) : undefined, fallbackProjectName: user.defaultProject });
    if (!store.canRead(user.id, projectId)) throw new Error("Knowledge access denied");
    const ingestor = new WeKnoraIngestor(store, { upsertDocument: async () => ({ externalDocumentId: "unused" }) });
    return { session, projectId, ingestor, knowledgeIds: ingestor.retrievalKnowledgeIds({ projectId, environment:session?.environment??user.defaultEnvironment, productVersion: input.productVersion ?? session?.intent.sampleManagerVersion, solution: input.solution ?? session?.intent.solution, module: input.module ?? session?.intent.module, language: input.language }) };
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
  server.tool("knowledge_search", "Search ACL- and Scope-filtered Case, Pattern, Playbook, and Candidate knowledge.", { workSessionId:z.string().optional(), project: z.string().optional(), query: z.string().min(1), limit: z.number().int().min(1).max(100).optional(), sampleManagerVersion: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), environment: z.string().optional(), scopeType: z.string().optional(), scopeKey: z.string().optional() }, async ({ project: projectName, query, limit, sampleManagerVersion, solution, module, environment, scopeType, scopeKey, workSessionId }) => {
    const store = requireKnowledge();
    const session=workSessionId?workSessions().assertSessionUsable({actorId:user.id,sessionId:workSessionId,environment}):undefined;
    const projectNameResolved = session&&!projectName?session.projectId:project(projectName);
    if (!projectNameResolved) throw new Error("No project selected");
    const projectId = user.defaultProjectId && projectNameResolved === user.defaultProject ? String(user.defaultProjectId) : projectNameResolved;
    if(session && session.projectId!==projectId) throw new Error("Work Session project does not match caller");
    store.grantAcl(projectId, user.id, false);
    const result=await searchKnowledge(store, { userId: user.id, projectId, workSessionId, query, limit, sampleManagerVersion, solution, module, environment:environment??session?.environment, scopeType, scopeKey });
    if(session)workSessions().get({actorId:user.id,sessionId:session.id});
    return { content: [{ type: "text", text: serializeKnowledgeResult(result) }] };
  });
  server.tool("knowledge_get", "Read a complete Knowledge document by id after project/scope ACL enforcement.", { documentId: z.string(), project: z.string().optional(), workSessionId: z.string().optional() }, async ({ documentId, project: projectName, workSessionId }) => {
    const store = requireKnowledge();
    if (workSessionId && resolveProjectId) {
      const stored = store.db.prepare("SELECT actor_id,project_id FROM knowledge_work_sessions WHERE id=?").get(workSessionId) as {actor_id:number;project_id:string}|undefined;
      // Mirror a missing cold ACL only after current control-plane authorization.
      // An existing denied ACL or reviewer grant must remain unchanged.
      if (stored?.actor_id === user.id) {
        resolveProjectId(stored.project_id);
        if (!store.db.prepare("SELECT 1 FROM knowledge_acl WHERE project_id=? AND user_id=?").get(stored.project_id,user.id)) store.grantAcl(stored.project_id,user.id,false);
      }
    }
    const session = workSessionId ? workSessions().assertSessionUsable({actorId:user.id,sessionId:workSessionId,environment:user.defaultEnvironment}) : undefined;
    const environment = user.defaultEnvironment ?? session?.environment;
    if (session && (session.environment ?? "") !== (environment ?? "")) throw new Error("Work Session environment does not match caller");
    const name = session && !projectName ? undefined : project(projectName);
    const projectId = session && !projectName ? session.projectId : session && name && resolveProjectNameToId ? resolveProjectNameToId(name) : user.defaultProjectId && name === user.defaultProject ? String(user.defaultProjectId) : name;
    if (session && session.projectId !== projectId) throw new Error("Work Session project does not match caller");
    const row = store.db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(documentId) as Record<string, unknown> | undefined;
    let result: Record<string,unknown>;
    if(row?.kind==="product_document" || store.db.prepare("SELECT 1 FROM knowledge_weknora_documents WHERE id=? OR external_document_id=?").get(documentId,documentId)) {
      result = await getProductBackend(store,{documentId,userId:user.id,isAdmin:user.isAdmin,projectId,environment});
    } else {
      if (!row || !canReadDocument(store, row, projectId)) throw new Error("Knowledge access denied");
      if (session && row.environment && row.environment !== environment) throw new Error("Knowledge document environment does not match Work Session");
      const source = provenance(store, row);
      result = { id: row.id, kind: row.kind, title: row.title, body: row.body, lifecycle: row.lifecycle, projectId: row.project_id, eventId: source?.event_id, jobId: source?.job_id, deploymentId: source?.deployment_id, sourceCandidateId: source?.source_candidate_id, evidenceRefs: evidenceRefs(source), scope: store.getScopeBinding(documentId), card: String(row.kind) === "candidate" ? store.getCandidateCard(documentId) : undefined, sourceLocator: row.source_locator, sourceSha256: row.source_sha256, updatedAt: row.updated_at };
    }
    if (session) {
      const service = workSessions();
      service.assertSessionUsable({actorId:user.id,sessionId:session.id,projectId,environment});
      const hash = (value:string) => createHash("sha256").update(value).digest("hex");
      const revision = {documentId:result.externalDocumentId??result.id,sourceSha256:result.sourceSha256,version:result.version,parserVersion:result.parserVersion,bodySha256:hash(String(result.body??""))};
      service.recordRetrieval({actorId:user.id,sessionId:session.id,projectId:session.projectId,environment,query:"",sourceRunId:"document-read:"+hash(JSON.stringify(revision)),resultCount:1,degraded:false,operation:"document_read"});
    }
    return { content: [{ type: "text", text: serializeKnowledgeResult(result) }] };
  });
  server.tool("knowledge_playbook_get", "Read a draft, approved, or deprecated Playbook with its steps and proposed Skill diff.", { playbookId: z.string(), project: z.string().optional() }, async ({ playbookId, project: projectName }) => {
    const store = requireKnowledge();
    const row = store.db.prepare("SELECT d.*, p.steps_json, p.rollback, p.skill_diff FROM knowledge_documents d LEFT JOIN knowledge_playbooks p ON p.id = d.id WHERE d.id = ? AND d.kind = 'playbook'").get(playbookId) as Record<string, unknown> | undefined;
    const name = project(projectName); const projectId = user.defaultProjectId && name === user.defaultProject ? String(user.defaultProjectId) : name;
    if (!row || !canReadDocument(store, row, projectId)) throw new Error("Knowledge access denied");
    return { content: [{ type: "text", text: serializeKnowledgeResult({ id: row.id, kind: row.kind, title: row.title, body: row.body, lifecycle: row.lifecycle, projectId: row.project_id, scope: store.getScopeBinding(playbookId), steps: row.steps_json ? JSON.parse(String(row.steps_json)) : [], rollback: row.rollback, skillDiff: row.skill_diff, sourceLocator: row.source_locator, sourceSha256: row.source_sha256 }) }] };
  });
  server.tool("knowledge_evidence_get", "Return metadata for Evidence; content is available through a bounded, audited read.", { evidenceId: z.string() }, async ({ evidenceId }) => {
    const store = requireKnowledge();
    const row = new EvidenceStore(store, store.evidenceRoot ?? "./data/evidence").metadata(user.id, evidenceId);
    return { content: [{ type: "text", text: serializeKnowledgeResult(row) }] };
  });
  server.tool("knowledge_relation_query", "Query deterministic, source-backed SampleManager object relations.", { project: z.string().optional(), objectId: z.string().optional(), relationType: z.string().optional(), verifiedOnly: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() }, async ({ project: projectName, objectId, relationType, verifiedOnly, limit }) => {
    const store = requireKnowledge(); const name = project(projectName); if (!name) throw new Error("No project selected");
    const projectId = user.defaultProjectId && name === user.defaultProject ? String(user.defaultProjectId) : name; store.grantAcl(projectId, user.id, false);
    return { content: [{ type: "text", text: serializeKnowledgeResult(queryRelations(store, { userId: user.id, projectId, objectId, relationType: relationType as never, verifiedOnly, limit })) }] };
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
    return { content: [{ type: "text", text: serializeKnowledgeResult({ report, facts }) }] };
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
    return { content: [{ type: "text", text: serializeKnowledgeResult(result) }] };
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
    return { content: [{ type: "text", text: serializeKnowledgeResult({ query, results: rows }) }] };
  });
  server.tool("knowledge_source_read", "Read one bounded source chunk or file range from a published baseline/project snapshot.", { chunkId: z.string().optional(), baselineId: z.string().optional(), projectSnapshotId: z.string().optional(), path: z.string().optional(), lineStart: z.number().int().min(1).optional(), lineEnd: z.number().int().min(1).optional() }, async ({ chunkId, baselineId, projectSnapshotId, path, lineStart, lineEnd }) => {
    const store = requireKnowledge(); if (baselineId) assertPublishedBaseline(store, baselineId); if (!chunkId && (!path || (!baselineId && !projectSnapshotId))) throw new Error("chunkId or scoped path is required");
    if (!user.isAdmin && !store.db.prepare("SELECT 1 FROM knowledge_acl WHERE user_id=? AND can_read=1 LIMIT 1").get(user.id)) throw new Error("Knowledge access denied");
    const row = chunkId ? store.db.prepare("SELECT * FROM knowledge_source_chunks WHERE id=?").get(chunkId) as Record<string, unknown> | undefined : (store.db.prepare(`SELECT * FROM knowledge_source_chunks WHERE relative_path=? AND ${baselineId ? "baseline_id=?" : "snapshot_id=?"} AND line_end>=? ORDER BY line_start LIMIT 1`).get(path, baselineId ?? projectSnapshotId, lineStart ?? 1) as Record<string, unknown> | undefined);
    if (!row) throw new Error("Source chunk not found"); if (baselineId && row.baseline_id !== baselineId) throw new Error("Source scope mismatch"); if (projectSnapshotId && row.snapshot_id !== projectSnapshotId) throw new Error("Source scope mismatch");
    return { content: [{ type: "text", text: serializeKnowledgeResult({ path: row.relative_path, symbol: row.symbol, lineStart: row.line_start, lineEnd: row.line_end, content: row.content, contentHash: row.content_sha256, parserVersion: row.parser_version, requestedRange: { lineStart, lineEnd } }) }] };
  });
  server.tool("knowledge_topic_get", "Read one logical Product Knowledge topic with all version bindings and revision content.", { topicId: z.string() }, async ({ topicId }) => {
    const store = requireKnowledge(); const topic = store.db.prepare("SELECT * FROM knowledge_topics WHERE id=?").get(topicId); if (!topic) throw new Error("Knowledge topic not found");
    const rows = store.db.prepare(`SELECT b.topic_id,b.product,b.product_version,b.source_path,b.match_method,b.match_confidence,d.id AS document_id,d.title,d.body,d.source_locator,d.source_sha256,d.project_id AS document_project_id FROM knowledge_product_document_bindings b JOIN knowledge_documents d ON d.id=b.document_id WHERE b.topic_id=? ORDER BY b.product_version`).all(topicId) as Array<Record<string, unknown>>;
    const scope = { userId: user.id, isAdmin: user.isAdmin, projectId: user.defaultProjectId ? String(user.defaultProjectId) : project(), environment: user.defaultEnvironment };
    const visibility = await productCatalogVisibility(store, scope);
    const visibleRows = rows.filter(row => visibility.documents.some(document => document.documentId === row.document_id && (visibility.provider === "relay_local" || document.productVersion === row.product_version)));
    const bindings = await Promise.all(visibleRows.map(async ({ document_project_id: _project, ...row }) => visibility.provider === "weknora"
      ? { topic_id: row.topic_id, document_id: row.document_id, product_version: row.product_version, match_method: row.match_method, match_confidence: row.match_confidence,
          ...await getProductBackend(store, { ...scope, documentId: String(row.document_id) }) }
      : row));
    if (!user.isAdmin && !bindings.length) throw new Error("Knowledge access denied");
    return { content: [{ type: "text", text: serializeKnowledgeResult({ topic, bindings }) }] };
  });
  server.tool("knowledge_topic_diff", "Compare the bound Product Knowledge revisions for two versions of one topic.", { topicId: z.string(), fromVersion: z.string(), toVersion: z.string() }, async ({ topicId, fromVersion, toVersion }) => {
    const store = requireKnowledge(); const rows = store.db.prepare("SELECT b.product_version,b.document_id,d.project_id AS document_project_id FROM knowledge_product_document_bindings b JOIN knowledge_documents d ON d.id=b.document_id WHERE b.topic_id=? AND b.product_version IN (?,?)").all(topicId, fromVersion, toVersion) as Array<{ product_version: string; document_id: string; document_project_id?: string }>;
    const scope = { userId: user.id, isAdmin: user.isAdmin, projectId: user.defaultProjectId ? String(user.defaultProjectId) : project(), environment: user.defaultEnvironment };
    const visibility = await productCatalogVisibility(store, scope);
    const readableRows = rows.filter(row => visibility.documents.some(document => document.documentId === row.document_id && (visibility.provider === "relay_local" || document.productVersion === row.product_version)));
    const ids = new Map(readableRows.map((row) => [row.product_version, row.document_id])); const left = ids.get(fromVersion), right = ids.get(toVersion); if (!left || !right) throw new Error("Topic versions not found");
    const load = async (id: string) => visibility.provider==="weknora"
      ? getProductBackend(store,{...scope,documentId:id})
      : store.db.prepare("SELECT sections_json FROM knowledge_product_documents WHERE id=?").get(id) as { sections_json?: string };
    return { content: [{ type: "text", text: serializeKnowledgeResult({ topicId, fromVersion, toVersion, from: await load(left), to: await load(right) }) }] };
  });
  server.tool("knowledge_solution_upgrade_analysis", "Run a published-baseline three-way upgrade comparison against a project snapshot.", { oldBaselineId: z.string(), currentProjectSnapshotId: z.string(), newBaselineId: z.string(), limit: z.number().int().min(1).max(1000).optional() }, async ({ oldBaselineId, currentProjectSnapshotId, newBaselineId, limit }) => {
    const store = requireKnowledge(); assertPublishedBaseline(store, oldBaselineId); assertPublishedBaseline(store, newBaselineId);
    if (!user.isAdmin && !store.db.prepare("SELECT 1 FROM knowledge_acl WHERE user_id=? AND can_read=1 LIMIT 1").get(user.id)) throw new Error("Knowledge access denied");
    const snapshot = store.db.prepare("SELECT project_id FROM knowledge_project_snapshots WHERE id=?").get(currentProjectSnapshotId) as { project_id?: string } | undefined;
    if (!snapshot || (snapshot.project_id && !store.canRead(user.id, snapshot.project_id))) throw new Error("Knowledge access denied");
    const changes = compareSourceUpgradeWithSymbols(store, compareSourceBaselines(sourceManifest(store, oldBaselineId), sourceManifest(store, currentProjectSnapshotId, true), sourceManifest(store, newBaselineId)), oldBaselineId, currentProjectSnapshotId, newBaselineId);
    const ids = (table: string, key: string, id: string) => new Map((store.db.prepare(`SELECT relative_path,id FROM ${table} WHERE ${key}=?`).all(id) as Array<{ relative_path: string; id: string }>).map((row) => [row.relative_path, row.id]));
    const oldIds = ids("knowledge_source_files", "baseline_id", oldBaselineId); const projectIds = ids("knowledge_project_snapshot_files", "snapshot_id", currentProjectSnapshotId); const newIds = ids("knowledge_source_files", "baseline_id", newBaselineId);
    const withEvidence = changes.map((change) => ({ ...change, evidenceRefs: { old: oldIds.get(change.path), project: projectIds.get(change.path), next: newIds.get(change.path) } }));
    return { content: [{ type: "text", text: serializeKnowledgeResult({ oldBaselineId, currentProjectSnapshotId, newBaselineId, changes: withEvidence.slice(0, limit ?? 1000), counts: changes.reduce<Record<string, number>>((acc, item) => { acc[item.status] = (acc[item.status] ?? 0) + 1; return acc; }, {}) }) }] };
  });

  server.tool("knowledge_work_session_open", "Open an ACL-scoped Work Session with an IntentEnvelope for a multi-step task.", { idempotencyKey: z.string().min(1).max(300), intent: z.record(z.unknown()), summary: z.string().max(8000).optional() }, async ({ idempotencyKey, intent, summary }) => {
    const store = requireKnowledge();
    const validated = validateIntentEnvelope({ ...intent, actorId: user.id });
    if (resolveProjectId) {
      // Recheck the current token scope even when a prior request mirrored an ACL.
      validated.projectId = resolveProjectId(validated.projectId);
      store.grantAcl(validated.projectId, user.id, false);
    }
    const session = workSessions().open({ actorId: user.id, idempotencyKey, intent: validated, summary });
    // An idempotency key can resolve to an older session on a different project.
    if (session.projectId !== validated.projectId) resolveProjectId?.(session.projectId);
    return { content: [{ type: "text", text: serializeKnowledgeResult({ session }) }] };
  });
  server.tool("knowledge_work_session_update", "Update a Work Session phase or user-visible IntentEnvelope fields.", { sessionId: z.string(), patch: z.record(z.unknown()), idempotencyKey: z.string().max(300).optional() }, async ({ sessionId, patch, idempotencyKey }) => { const session = workSessions().update({ actorId: user.id, sessionId, patch: patch as never, idempotencyKey }); return { content: [{ type: "text", text: serializeKnowledgeResult({ session }) }] }; });
  server.tool("knowledge_work_session_close", "Close a Work Session with acceptance results and unknowns.", { sessionId: z.string(), result: z.object({ summary: z.string().max(8000).optional(), unknowns: z.array(z.string().max(2000)).max(100).optional(), acceptanceResults: z.record(z.union([z.boolean(), z.string().max(500)])).optional() }).optional(), idempotencyKey: z.string().max(300).optional() }, async ({ sessionId, result, idempotencyKey }) => { const session = workSessions().close({ actorId: user.id, sessionId, result, idempotencyKey }); return { content: [{ type: "text", text: serializeKnowledgeResult({ session }) }] }; });
  server.tool("knowledge_work_session_get", "Read a Work Session and its correlated event metadata after ACL enforcement.", { sessionId: z.string() }, async ({ sessionId }) => { const summary=workSessions().summarize({actorId:user.id,sessionId}); return { content: [{ type: "text", text: serializeKnowledgeResult({session:summary.session,events:summary.events,pagination:summary.pagination.events}) }] }; });
  server.tool("knowledge_work_session_list", "List the caller's Work Sessions on projects they can still read, with time-ordered event aggregation.", { limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).max(1000000).optional(), sessionId: z.string().optional() }, async ({ limit, offset, sessionId }) => {
    const service = workSessions();
    if (sessionId) return { content: [{ type: "text", text: serializeKnowledgeResult(service.summarize({ actorId: user.id, sessionId, limit, offset })) }] };
    return { content: [{ type: "text", text: serializeKnowledgeResult({ sessions: service.list({ actorId: user.id, limit }) }) }] };
  });
  server.tool("knowledge_provider_config_list", "List safe Relay provider metadata without returning secrets.", {}, async () => { return { content: [{ type: "text", text: serializeKnowledgeResult({ providers: managedRegistry().list(), pendingReindex: managedRegistry().pendingReindex() }) }] }; });
  server.tool("knowledge_candidate_insight_compile", "Compile an Evidence-backed Candidate Insight for a Work Session, with deterministic fallback and no auto-approval.", { sessionId: z.string(), evidenceRefs: z.array(z.string().min(1)).max(100), context: z.record(z.unknown()).optional(), providerId: z.string().optional(), async: z.boolean().optional(), retry:z.boolean().optional() }, async ({ sessionId, evidenceRefs, context, providerId, async: enqueue,retry }) => {
    const store = requireKnowledge();
    workSessions().get({ actorId: user.id, sessionId });
    if (enqueue) return { content: [{ type: "text", text: serializeKnowledgeResult(enqueueCandidateInsight(store, { actorId: user.id, sessionId, evidenceRefs, context: context ?? {},providerId,retry })) }] };
    const insight = await new CandidateInsightCompiler(store, candidateProvider(providerId)).compile({ actorId: user.id, sessionId, evidenceRefs, context: context ?? {} });
    return { content: [{ type: "text", text: serializeKnowledgeResult({ insight }) }] };
  });
  server.tool("knowledge_candidate_insight_job_get", "Read an asynchronous Candidate compilation job after Session ACL enforcement.", {id:z.string()}, async ({id})=>{const job=getCandidateInsightJob(requireKnowledge(),{actorId:user.id,id});workSessions().get({actorId:user.id,sessionId:job.workSessionId});return {content:[{type:"text",text:serializeKnowledgeResult({job})}]};});
  server.tool("knowledge_candidate_insight_list", "List ACL-scoped Candidate Insights pending or completed through human review.", { projectId: z.string(), status: z.enum(["draft", "accepted", "edited", "rejected"]).optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }, async (input) => {
    const insights = new CandidateInsightReviewService(requireKnowledge()).list({ actorId: user.id, ...input });
    return { content: [{ type: "text", text: serializeKnowledgeResult({ insights }) }] };
  });
  server.tool("knowledge_candidate_insight_review", "Explicitly confirm, edit, reject, or promote a Candidate Insight; every action requires a reason.", { insightId: z.string(), action: z.enum(["confirm", "edit", "reject", "promote"]), reason: z.string().min(1).max(2000), patch: z.record(z.unknown()).optional(), target: z.enum(["case", "decision"]).optional(), title: z.string().max(300).optional() }, async ({ insightId, action, reason, patch, target, title }) => {
    const service = new CandidateInsightReviewService(requireKnowledge());
    const result = action === "confirm" ? service.confirm({ actorId: user.id, id: insightId, reason })
      : action === "reject" ? service.reject({ actorId: user.id, id: insightId, reason })
      : action === "edit" ? service.edit({ actorId: user.id, id: insightId, patch: patch as never, reason })
      : service.promote({ actorId: user.id, id: insightId, target: target ?? "case", title, reason });
    return { content: [{ type: "text", text: serializeKnowledgeResult({ result }) }] };
  });
  server.tool("knowledge_wiki_search", "Search Relay-native Wiki pages with ACL, version, topic, solution and module filters.", { projectId: z.string().optional(), query: z.string().optional(), status: z.enum(WIKI_PAGE_STATUSES).optional(), productVersion: z.string().optional(), topicId: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }, async (input) => {
    const result = await activeWikiService(requireKnowledge()).list({ actorId: user.id, environment: user.defaultEnvironment, projectId: input.projectId, status: input.status, productVersion: input.productVersion, topicId: input.topicId, solution: input.solution, module: input.module, search: input.query, limit: input.limit, offset: input.offset });
    return { content: [{ type: "text", text: serializeKnowledgeResult(result) }] };
  });
  server.tool("knowledge_wiki_get", "Read a Relay-native Wiki page and optionally its revision history or unified diff.", { pageId: z.string(), includeRevisions: z.boolean().optional(), fromRevision: z.number().int().positive().optional(), toRevision: z.number().int().positive().optional() }, async ({ pageId, includeRevisions, fromRevision, toRevision }) => {
    const wiki = activeWikiService(requireKnowledge()); const page = await wiki.get({ actorId: user.id, environment: user.defaultEnvironment, id: pageId });
    const revisions = includeRevisions ? await wiki.listRevisions({ actorId: user.id, environment: user.defaultEnvironment, id: pageId }) : undefined;
    const diff = fromRevision && toRevision ? await wiki.diffRevisions({ actorId: user.id, environment: user.defaultEnvironment, id: pageId, fromRevision, toRevision }) : undefined;
    return { content: [{ type: "text", text: serializeKnowledgeResult({ page, revisions, diff }) }] };
  });
  server.tool("knowledge_wiki_write", "Create a page idempotently or append a reviewed edit; content is scanned before persistence.", { pageKey: z.string().max(300).optional(), pageId: z.string().optional(), title: z.string().min(1).max(500), body: z.string().min(1), projectId: z.string().optional(), productVersion: z.string().optional(), topicId: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), sourceRefs: z.array(z.string()).max(100).optional(), reason: z.string().min(1).max(2000) }, async (input) => {
    const wiki = activeWikiService(requireKnowledge());
    const page = input.pageId ? await wiki.edit({ actorId: user.id, environment: user.defaultEnvironment, id: input.pageId, title: input.title, body: input.body, reason: input.reason }) : await wiki.create({ actorId: user.id, environment: user.defaultEnvironment, pageKey: input.pageKey ?? "", title: input.title, body: input.body, projectId: input.projectId, productVersion: input.productVersion, topicId: input.topicId, solution: input.solution, module: input.module, sourceRefs: input.sourceRefs, reason: input.reason });
    return { content: [{ type: "text", text: serializeKnowledgeResult({ page }) }] };
  });
  server.tool("knowledge_wiki_review", "Publish, deprecate, or roll back a Wiki page with an explicit reason and audit trail.", { pageId: z.string(), action: z.enum(["publish", "deprecate", "rollback"]), revision: z.number().int().positive().optional(), reason: z.string().min(1).max(2000) }, async ({ pageId, action, revision, reason }) => {
    const wiki = activeWikiService(requireKnowledge());
    const page = action === "publish" ? await wiki.publish({ actorId: user.id, environment: user.defaultEnvironment, id: pageId, reason }) : action === "deprecate" ? await wiki.deprecate({ actorId: user.id, environment: user.defaultEnvironment, id: pageId, reason }) : await wiki.rollback({ actorId: user.id, environment: user.defaultEnvironment, id: pageId, revision: revision ?? 0, reason });
    return { content: [{ type: "text", text: serializeKnowledgeResult({ page }) }] };
  });
  server.tool("knowledge_migration_create", "Create an idempotent staged Product Knowledge migration record.", { idempotencyKey: z.string().min(1).max(300), sourceManifest: z.record(z.unknown()), kind: z.string().max(100).optional() }, async ({ idempotencyKey, sourceManifest, kind }) => { if (!user.isAdmin) throw new Error("Administrator access is required"); const migration = new MigrationController(requireKnowledge()).create({ actorId: user.id, idempotencyKey, sourceManifest, kind }); return { content: [{ type: "text", text: serializeKnowledgeResult({ migration }) }] }; });
  server.tool("knowledge_migration_from_local", "Stage local Product Knowledge into WeKnora with a metadata-only manifest and per-document report.", { idempotencyKey: z.string().min(1).max(300), parserVersion: z.string().min(1).max(100), productVersion: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), projectId: z.string().optional(), limit: z.number().int().min(1).max(10000).optional(), retry: z.boolean().optional() }, async (input) => {
    if (!user.isAdmin) throw new Error("Administrator access is required");
    const ingestor = managedControlPlane(requireKnowledge()).ingestor;
    const migration = await new MigrationController(requireKnowledge()).createFromLocal({ actorId: user.id, ...input }, ingestor);
    return { content: [{ type: "text", text: serializeKnowledgeResult({ migration }) }] };
  });
  server.tool("knowledge_migration_publish", "Validate, publish and switch a staged Product Knowledge migration to WeKnora.", { migrationId: z.string() }, async ({ migrationId }) => { if (!user.isAdmin) throw new Error("Administrator access is required"); const migration = new MigrationController(requireKnowledge()).validateAndPublish(migrationId, user.id); return { content: [{ type: "text", text: serializeKnowledgeResult({ migration }) }] }; });
  server.tool("knowledge_migration_rollback", "Rollback a Product Knowledge migration and restore Relay local retrieval with an audit reason.", { migrationId: z.string(), reason: z.string().min(1).max(2000) }, async ({ migrationId, reason }) => { if (!user.isAdmin) throw new Error("Administrator access is required"); const migration = new MigrationController(requireKnowledge()).rollback(migrationId, user.id, reason); return { content: [{ type: "text", text: serializeKnowledgeResult({ migration }) }] }; });
  server.tool("knowledge_release_gates", "Run deterministic security, migration, provider, ACL and visibility release gates.", {}, async () => { if (!user.isAdmin) throw new Error("Administrator access is required"); return { content: [{ type: "text", text: serializeKnowledgeResult(runReleaseGates(requireKnowledge())) }] }; });
  server.tool("knowledge_weknora_search", "Search published Product Knowledge through Relay's ACL-checked internal WeKnora boundary.", { query: z.string().min(1), workSessionId: z.string().optional(), projectId: z.string().optional(), productVersion: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), language: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }, async ({ query, workSessionId, projectId, productVersion, solution, module, language, limit }) => {
    const scope = retrievalScope({ workSessionId, projectId, productVersion, solution, module, language });
    const effectiveIntent={objective:"",actions:[] as string[],...scope.session?.intent,projectId:scope.projectId,environment:scope.session?.environment??user.defaultEnvironment,sampleManagerVersion:productVersion??scope.session?.intent.sampleManagerVersion,solution:solution??scope.session?.intent.solution,module:module??scope.session?.intent.module};
    let relaySources = { confirmedKnowledge: [], candidates: [], currentFacts: [], degraded: undefined } as Awaited<ReturnType<typeof loadRelayContextSources>>;
    try { relaySources = await loadRelayContextSources({ store: requireKnowledge(), userId: user.id, workSessionId:scope.session?.id, projectId: scope.projectId, query, intent: effectiveIntent, limit: limit ?? 10 }); } catch { relaySources = { confirmedKnowledge: [], candidates: [], currentFacts: [], degraded: { relayMemory: "unavailable" } }; }
    if (scope.session) workSessions().get({actorId:user.id,sessionId:scope.session.id});
    if (!scope.knowledgeIds.length) {
      const contextPack = new ContextPackService({ provider: "weknora" }).build({ intent: effectiveIntent, authoritativeDocs: [], confirmedKnowledge: relaySources.confirmedKnowledge, candidates: relaySources.candidates, currentFacts: relaySources.currentFacts, degraded: { ...relaySources.degraded, productKnowledge: "no_published_documents" }, acl: { documentIds: [] }, maxItemsPerSection: limit ?? 10 });
      return { content: [{ type: "text", text: serializeKnowledgeResult({ retrievalRunId: "local-scope-empty", references: [], degraded: contextPack.degraded, contextPack }) }] };
    }
    const result = await searchEngineProductReferences(requireKnowledge(),{userId:user.id,projectId:scope.projectId,environment:scope.session?.environment??user.defaultEnvironment,query,sampleManagerVersion:productVersion??scope.session?.intent.sampleManagerVersion,solution:solution??scope.session?.intent.solution,module:module??scope.session?.intent.module,language,limit});
    if (scope.session) workSessions().recordRetrieval({actorId:user.id,sessionId:scope.session.id,projectId:scope.projectId,environment:effectiveIntent.environment,query,sourceRunId:result.retrievalRunId,resultCount:result.references.length,degraded:Boolean(result.degraded)});
    const visible = new Set(scope.knowledgeIds);
    const references = result.references.filter((reference) => visible.has(reference.documentId));
    const contextPack = new ContextPackService({ provider: "weknora" }).build({ intent: effectiveIntent, authoritativeDocs: references, confirmedKnowledge: relaySources.confirmedKnowledge, candidates: relaySources.candidates, currentFacts: relaySources.currentFacts, degraded: { ...relaySources.degraded, ...result.degraded }, acl: { documentIds: scope.knowledgeIds }, maxItemsPerSection: limit ?? 10 });
    return { content: [{ type: "text", text: serializeKnowledgeResult({ ...result, references: contextPack.authoritativeDocs, contextPack }) }] };
  });

  // Resource templates keep large document bodies out of search responses and
  // let MCP clients open provenance on demand. Evidence resources intentionally
  // expose metadata only; bytes remain behind the audited bounded download API.
  server.resource("knowledge-document", new ResourceTemplate("knowledge://{kind}/{id}", { list: undefined }), async (uri, variables) => {
    const store = requireKnowledge(); const kind = String(variables.kind); const id = String(variables.id);
    const row = store.db.prepare("SELECT * FROM knowledge_documents WHERE id = ? AND kind = ?").get(id, kind) as Record<string, unknown> | undefined;
    const name = project(); const projectId = user.defaultProjectId && name === user.defaultProject ? String(user.defaultProjectId) : name;
    if(kind==="product_document") return {contents:[{uri:uri.toString(),mimeType:"application/json",text:JSON.stringify(await getProductBackend(store,{documentId:id,userId:user.id,isAdmin:user.isAdmin,projectId,environment:user.defaultEnvironment}))}]};
    if (!row || !canReadDocument(store, row, projectId)) throw new Error("Knowledge access denied");
    store.audit({ actorId: user.id, projectId: row.project_id ? String(row.project_id) : undefined, action: "knowledge.resource.read", entityType: kind, entityId: id });
    const source = provenance(store, row);
    return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify({ id: row.id, kind: row.kind, title: row.title, body: row.body, lifecycle: row.lifecycle, projectId: row.project_id, eventId: source?.event_id, jobId: source?.job_id, deploymentId: source?.deployment_id, sourceCandidateId: source?.source_candidate_id, evidenceRefs: evidenceRefs(source), scope: store.getScopeBinding(id), card: kind === "candidate" ? store.getCandidateCard(id) : undefined, sourceLocator: row.source_locator, sourceSha256: row.source_sha256, updatedAt: row.updated_at }) }] };
  });
}
