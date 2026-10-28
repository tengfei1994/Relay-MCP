import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpUser } from "../register-tools.js";
import { z } from "zod";
import type { KnowledgeStore } from "../../knowledge/store.js";
import { WorkSessionService, INTENT_ACTIONS, INTENT_PHASES } from "../../knowledge/work-session.js";
import { searchKnowledge } from "../../knowledge/retriever.js";
import { analyzeRelationImpact } from "../../knowledge/relations.js";
import { recentErrors, sampleManagerTableSchema } from "../../shared/samplemanager-tools.js";
import { createSampleManagerInspectionEnvelope } from "../../shared/samplemanager-capabilities.js";
import { validateSampleManagerFormTaskContract } from "../../shared/samplemanager-inspection-tools.js";
import type { GetRunner, ResolveProjectName } from "../tool-context.js";
import type { ProjectRegistry } from "../project-registry.js";
import { summarizeJson } from "../../shared/output.js";

/** Reserved P00 boundary for future read-only diagnostic compositions. */
export interface DiagnosticToolsContext { server: McpServer; user: McpUser; knowledge?: KnowledgeStore; resolveProjectName: ResolveProjectName; getRunner: GetRunner; registry: ProjectRegistry; }
export function registerDiagnosticTools(context: McpServer | DiagnosticToolsContext): void {
  const ctx: DiagnosticToolsContext = ('user' in context && 'server' in context)
    ? context
    : { server: context as McpServer, user: { id: 0, username: "boundary" }, knowledge: undefined, resolveProjectName: () => { throw new Error("diagnostic context unavailable"); }, getRunner: () => { throw new Error("diagnostic context unavailable"); }, registry: {} as ProjectRegistry };
  const { server, user, knowledge, resolveProjectName, getRunner } = ctx;
  const requireKnowledge = () => { if (!knowledge) throw new Error("Knowledge Plane is unavailable"); return knowledge; };
  const sessionCorrelationSchema = { workSessionId: z.string().min(1).max(200).optional(), intentStep: z.string().max(100).optional(), objectiveRef: z.string().max(200).optional(), acceptanceCriterionRef: z.string().max(200).optional() };
  const assertSession = (store: KnowledgeStore, workSessionId: string | undefined, projectId: string, environment?: string) => {
    if (!workSessionId) return undefined;
    // The caller must own the session and match its project/environment scope;
    // a forged or foreign session id fails here before any payload is written.
    const session = new WorkSessionService(store).assertSessionUsable({ actorId: user.id, sessionId: workSessionId, projectId, environment });
    if ((session.environment ?? "") !== (environment ?? "")) throw new Error("Work Session environment does not match caller");
    return workSessionId;
  };
  server.tool("samplemanager_diagnose", "Read-only SampleManager diagnosis combining version-scoped Knowledge retrieval with Form/Task/Assembly checks. It never deploys, restarts, clears cache, or mutates SQL.", { project: z.string().optional(), environment: z.string().optional(), query: z.string().min(1), formName: z.string().optional(), taskName: z.string().optional(), controlNames: z.array(z.string()).optional(), includeRecentErrors: z.boolean().optional(), recentErrorMinutes: z.number().int().min(1).max(1440).optional(), databaseTable: z.string().optional(), ...sessionCorrelationSchema }, async ({ project, environment, query, formName, taskName, controlNames, includeRecentErrors, recentErrorMinutes, databaseTable, workSessionId, intentStep, objectiveRef, acceptanceCriterionRef }) => {
    const name = resolveProjectName(project); const store = requireKnowledge(); const connection = getRunner(name, environment); const projectId = connection.project.id.toString();
    if (!workSessionId || !store.db.prepare("SELECT 1 FROM knowledge_acl WHERE project_id=? AND user_id=?").get(projectId,user.id)) store.grantAcl(projectId, user.id, false);
    const sessionRef = assertSession(store, workSessionId, projectId, connection.ps.environment);
    const knowledgeResult = await searchKnowledge(store, { userId: user.id, projectId, query, workSessionId: sessionRef, sampleManagerVersion: connection.ps.limsInstance?.version, environment: connection.ps.environment, limit: 10 });
    const unknowns: string[] = []; const evidence: unknown[] = []; const facts: unknown[] = []; const inferences: unknown[] = [];
    if (formName && taskName && connection.ps.limsInstance?.databaseName) {
      try {
        const raw = await validateSampleManagerFormTaskContract(connection.runner, { instance: connection.ps.limsInstance, databaseHost: connection.ps.limsInstance.databaseHost || "localhost", databaseName: connection.ps.limsInstance.databaseName, formName, taskName, controlNames });
        evidence.push({ capability: "samplemanager_form_task_contract", raw });
      } catch (error) { unknowns.push(`Form/Task read-only inspection failed: ${error instanceof Error ? error.message : String(error)}`); }
    } else unknowns.push("Form/Task check not run: bind an instance with databaseName and provide formName/taskName.");
    if (includeRecentErrors) {
      if (!connection.ps.limsInstance) unknowns.push("Recent error inspection not run: no LIMS instance is bound.");
      else {
        try {
          const raw = await recentErrors(connection.runner, connection.ps.limsInstance, recentErrorMinutes ?? 30);
          evidence.push({ capability: "samplemanager_recent_errors", raw });
        } catch (error) { unknowns.push(`Recent error inspection failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    if (databaseTable) {
      if (!connection.ps.limsInstance?.databaseName) unknowns.push("Schema check not run: no database is configured for the bound LIMS instance.");
      else {
        try {
          const raw = await sampleManagerTableSchema(connection.runner, connection.ps.limsInstance.databaseName, databaseTable, connection.ps.limsInstance.databaseHost || "localhost");
          evidence.push({ capability: "samplemanager_table_schema", table: databaseTable, raw });
        } catch (error) { unknowns.push(`Table schema inspection failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    facts.push({ target: { project: name, environment: connection.ps.environment, server: connection.ps.server.name, instance: connection.ps.limsInstance?.name, version: connection.ps.limsInstance?.version } });
    inferences.push(...knowledgeResult.results.map((result) => ({ from: result.id, statement: result.title, reasons: result.matchReasons })));
    return { content: [{ type: "text", text: summarizeJson(createSampleManagerInspectionEnvelope({ capability: "samplemanager_diagnose", provenance: { retrievalRunId: knowledgeResult.retrievalRunId, projectId, traceId: `trace-${Date.now()}`, ...(sessionRef ? { workSessionId: sessionRef, intentStep, objectiveRef, acceptanceCriterionRef } : {}) }, facts, inferences, unknowns, evidence })) }] };
  });
  server.tool("samplemanager_impact_analysis", "Compute a read-only, source-backed impact graph for a SampleManager Form/Task/Assembly/Menu object.", { project: z.string().optional(), environment: z.string().optional(), objectId: z.string(), relationType: z.string().optional(), verifiedOnly: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional(), maxDepth: z.number().int().min(0).max(20).optional(), direction: z.enum(["upstream", "downstream", "both"]).optional(), ...sessionCorrelationSchema }, async ({ project, environment, objectId, relationType, verifiedOnly, limit, maxDepth, direction, workSessionId, intentStep, objectiveRef, acceptanceCriterionRef }) => {
    const name = resolveProjectName(project); const store = requireKnowledge(); const connection = getRunner(name, environment); const projectId = connection.project.id.toString();
    if (!workSessionId || !store.db.prepare("SELECT 1 FROM knowledge_acl WHERE project_id=? AND user_id=?").get(projectId,user.id)) store.grantAcl(projectId, user.id, false);
    const sessionRef = assertSession(store, workSessionId, projectId, connection.ps.environment);
    const report = analyzeRelationImpact(store, { userId: user.id, projectId, objectId, relationType: relationType as never, verifiedOnly, limit, maxDepth, direction, sampleManagerVersion: connection.ps.limsInstance?.version, environment: connection.ps.environment });
    if (sessionRef) {
      // Re-read current token/target authorization after source analysis. A receipt
      // cannot upgrade the source graph into a domain event or Evidence grant.
      store.db.transaction(() => {
        const current = getRunner(name, connection.ps.environment);
        if (String(current.project.id) !== projectId || current.ps.environment !== connection.ps.environment) throw new Error("Work Session target scope changed during impact analysis");
        assertSession(store, sessionRef, projectId, current.ps.environment);
        const hash = (value:string) => createHash("sha256").update(value).digest("hex");
        const reference = (value:string|undefined) => value === undefined ? undefined : "sha256:"+hash(value);
        const eventId = "session-impact-"+hash(JSON.stringify({sessionId:sessionRef,projectId,environment:current.ps.environment,objectId,relationType,verifiedOnly,limit,maxDepth,direction,report,intentStep,objectiveRef,acceptanceCriterionRef}));
        new WorkSessionService(store).correlateEvent({actorId:user.id,sessionId:sessionRef,eventId,eventType:"samplemanager.impact_analysis",
          intentStep:intentStep && ([...INTENT_ACTIONS,...INTENT_PHASES] as readonly string[]).includes(intentStep) ? intentStep : reference(intentStep),
          objectiveRef:reference(objectiveRef),acceptanceCriterionRef:reference(acceptanceCriterionRef)});
      }).immediate();
    }
    return { content: [{ type: "text", text: summarizeJson(createSampleManagerInspectionEnvelope({ capability: "samplemanager_impact_analysis", provenance: { projectId, objectId, maxDepth, direction, ...(sessionRef ? { workSessionId: sessionRef, intentStep, objectiveRef, acceptanceCriterionRef } : {}) }, facts: report.relations, inferences: [{ affectedObjects: report.nodes.length, depth: report.depth }], unknowns: report.relations.length ? [] : ["No source-backed relations found"] })) }] };
  });
}
