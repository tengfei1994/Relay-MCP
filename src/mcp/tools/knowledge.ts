import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpUser } from "../register-tools.js";
import { z } from "zod";
import { importCasebook, importContextFacts } from "../../knowledge/importer.js";
import { queryRelations } from "../../knowledge/relations.js";
import { searchKnowledge } from "../../knowledge/retriever.js";
import type { KnowledgeStore } from "../../knowledge/store.js";
import { summarizeJson } from "../../shared/output.js";
import { EvidenceStore } from "../../knowledge/evidence-store.js";

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
  server.tool("knowledge_search", "Search ACL- and Scope-filtered Case, Pattern, Playbook, and Candidate knowledge.", { project: z.string().optional(), query: z.string().min(1), limit: z.number().int().min(1).max(100).optional(), sampleManagerVersion: z.string().optional(), solution: z.string().optional(), module: z.string().optional(), environment: z.string().optional(), scopeType: z.string().optional(), scopeKey: z.string().optional() }, async ({ project: projectName, query, limit, sampleManagerVersion, solution, module, environment, scopeType, scopeKey }) => {
    const store = requireKnowledge();
    const projectNameResolved = project(projectName);
    if (!projectNameResolved) throw new Error("No project selected");
    const projectId = user.defaultProjectId && projectNameResolved === user.defaultProject ? String(user.defaultProjectId) : projectNameResolved;
    store.grantAcl(projectId, user.id, false);
    return { content: [{ type: "text", text: summarizeJson(await searchKnowledge(store, { userId: user.id, projectId, query, limit, sampleManagerVersion, solution, module, environment, scopeType, scopeKey })) }] };
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
