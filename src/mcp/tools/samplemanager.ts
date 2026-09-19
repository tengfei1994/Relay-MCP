import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpUser } from "../register-tools.js";
import { z } from "zod";
import { createHash, randomUUID } from "crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "fs";
import { basename } from "path";
import { classifyRemoteError, ensureRemoteSuccess } from "../../shared/remote-runner.js";
import { startJob, writeAudit, type JobContext } from "../../shared/job-store.js";
import {
  appendDeploymentOperationArtifact,
  deploymentFailureDisposition,
  finishDeployment,
  getDeployment,
  requireRunningDeployment,
  startDeployment,
  updateDeployment,
} from "../../shared/deployment-store.js";
import { createDeploymentManifest } from "../../shared/deployment-manifest.js";
import { inspectSampleManagerAssemblyType, validateSampleManagerFormTaskContract } from "../../shared/samplemanager-inspection-tools.js";
import {
  clearFormCache,
  buildSampleManagerProject,
  convertSampleManagerTables,
  createEntityDefinition,
  deploySampleManagerFile,
  discoverBuildTools,
  inspectSampleManagerDeploymentBaseline,
  inspectSampleManagerInstance,
  instancePaths,
  loadTableLoaderFile,
  recentErrors,
  restoreSampleManagerBackup,
  restartSampleManagerInstance,
  runSampleManagerCommand,
  runSampleManagerUtility,
  runSql,
  runSqlChangeSet,
  runSqlMutation,
  sqlContainsMutation,
  sampleManagerTableSchema,
  buildSettingsMetadata,
  validateBuildEnvironmentVariables,
  validateBuildMsbuildProperties,
  type SampleManagerInstanceRef,
} from "../../shared/samplemanager-tools.js";
import { persistQueryArtifact, readQueryArtifact } from "../../shared/query-artifact-store.js";
import { compactText, compactTextWithMetadata, summarizeJson } from "../../shared/output.js";
import { resolveWorkspacePath } from "../../shared/workspace-path.js";
import { quotePosix, quotePowerShell } from "../../shared/shell-utils.js";
import {
  SampleManagerCapabilityRegistry,
  createSampleManagerInspectionEnvelope,
} from "../../shared/samplemanager-capabilities.js";
import {
  analyzeSampleManagerSemanticInspection,
  runSampleManagerSemanticInspection,
  type SampleManagerInspectionEntryPoint,
  type SampleManagerInspectionTarget,
  type SampleManagerPlatePlan,
} from "../../shared/samplemanager-semantic-inspection.js";
import {
  analyzeSampleManagerWorkflowSnapshot,
  runSampleManagerWorkflowSnapshot,
  type SampleManagerWorkflowBaseline,
  type SampleManagerWorkflowTarget,
} from "../../shared/samplemanager-workflow-inspection.js";
import { inspectSampleManagerDeploymentRuntime, type SampleManagerRuntimeInspectionOptions } from "../../shared/samplemanager-runtime-inspection.js";
import { analyzeSampleManagerEntitySchema, runSampleManagerEntitySchema } from "../../shared/samplemanager-entity-schema.js";
import {
  analyzeSampleManagerEnhInspection,
  runSampleManagerEnhInspection,
  type SampleManagerEnhTarget,
} from "../../shared/samplemanager-enh-inspection.js";
import { analyzeSampleManagerVglSource, readSampleManagerVglSource } from "../../shared/samplemanager-vgl-inspection.js";
import type { ProjectRegistry } from "../project-registry.js";
import type { GetRunner, ProjectSelector, ResolveProjectName, RunnerConnection, SampleManagerDatabaseTarget } from "../tool-context.js";

const sampleManagerCapabilityRegistry = new SampleManagerCapabilityRegistry();
const deploymentFileBaselineSchema = z.object({
  exists: z.boolean(),
  sha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).nullable(),
}).refine((file) => file.exists === (file.sha256 !== null), "File baseline must include a SHA-256 exactly when the file exists");
const deploymentBaselineSchema = z.object({
  target: deploymentFileBaselineSchema,
  assembly: deploymentFileBaselineSchema,
}).passthrough();
const sampleManagerInspectionTargetSchema = z.object({
  executionId: z.string().optional(),
  labMethodId: z.string().optional(),
  labMethodVersion: z.string().optional(),
  plateId: z.string().optional(),
  batchId: z.string().optional(),
  batchTemplateId: z.string().optional(),
  testNumber: z.string().optional(),
  sampleNumber: z.string().optional(),
}).strict().refine((target) => Object.values(target).some((value) => Boolean(value?.trim())), "At least one target identity is required");
const sampleManagerEntryPointSchema = z.enum([
  "execution_readiness",
  "plate_batch_integrity",
  "test_result_lineage",
  "lab_method_definition",
]);
const sampleManagerPlatePlanSchema = z.object({
  rows: z.number().int().min(1).max(64),
  columns: z.number().int().min(1).max(384),
  startPosition: z.string().max(32).optional(),
  fillDirection: z.enum(["row-major", "column-major"]).optional(),
  expectedEmptyPositions: z.array(z.string().max(32)).max(500).optional(),
  expectedEntries: z.array(z.object({
    name: z.string().max(128).optional(),
    entryType: z.string().max(128).optional(),
    count: z.number().int().nonnegative().max(100000).optional(),
    positions: z.array(z.string().max(32)).max(500).optional(),
  }).strict()).max(100).optional(),
}).strict();
const sampleManagerWorkflowTargetSchema = z.object({
  workflowId: z.string().max(256).optional(),
  workflowName: z.string().max(256).optional(),
  workflowVersion: z.string().max(256).optional(),
  nodeType: z.string().max(256).optional(),
}).strict().refine((target) => Object.values(target).some((value) => Boolean(value?.trim())), "At least one workflow target identity is required");
const sampleManagerWorkflowBaselineSchema = z.record(z.unknown()).superRefine((baseline, ctx) => {
  if (JSON.stringify(baseline).length > 200_000) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Workflow baseline must be at most 200000 JSON characters" });
});
const sampleManagerEnhTargetSchema = z.object({
  dashboardId: z.string().max(256).optional(),
  folderId: z.string().max(256).optional(),
  criteriaId: z.string().max(256).optional(),
  formConfigId: z.string().max(256).optional(),
  entity: z.string().max(256).optional(),
  name: z.string().max(256).optional(),
}).strict().refine((target) => Object.values(target).some((value) => Boolean(value?.trim())), "At least one ENH target identity is required");

export interface SampleManagerToolsContext {
  server: McpServer;
  user: McpUser;
  resolveProjectName: ResolveProjectName;
  getRunner: GetRunner;
  registry: ProjectRegistry;
  executionForJob: (context?: JobContext) => Record<string, unknown>;
  getSampleManagerDatabaseTarget: (project?: string, environment?: string, database?: string, selector?: ProjectSelector) => SampleManagerDatabaseTarget;
}

/** SampleManager registration boundary. */
export function registerSampleManagerTools(context: SampleManagerToolsContext, legacy?: (context: SampleManagerToolsContext) => void): void {
  if (legacy) { legacy(context); return; }
  const { server, user, resolveProjectName, getRunner, registry, executionForJob, getSampleManagerDatabaseTarget } = context;

  function getSampleManagerTarget(
    projectName?: string,
    environment?: string,
    requestedInstance?: string,
    requestedDatabase?: string,
    selector: ProjectSelector = {}
  ) {
    const connection = getRunner(projectName, environment, selector);
    const configured = connection.ps.limsInstance;
    if (configured && requestedInstance && configured.name.toLowerCase() !== requestedInstance.toLowerCase()) {
      throw new Error(
        `Project environment is bound to LIMS instance '${configured.name}', not '${requestedInstance}'`
      );
    }
    if (
      configured?.databaseName &&
      requestedDatabase &&
      configured.databaseName.toLowerCase() !== requestedDatabase.toLowerCase()
    ) {
      throw new Error(
        `LIMS instance '${configured.name}' is configured for database '${configured.databaseName}', not '${requestedDatabase}'`
      );
    }
    const instance = configured ?? requestedInstance;
    if (!instance) {
      throw new Error("No LIMS instance is bound to this project environment; select an instance in the management UI or pass instance");
    }
    return {
      ...connection,
      instance,
      instanceName: typeof instance === "string" ? instance : instance.name,
      database: configured?.databaseName || requestedDatabase,
      configuredInstance: configured,
    };
  }

  function deploymentTarget(connection: RunnerConnection) {
    const configured = connection.ps.limsInstance;
    return {
      projectServerId: connection.ps.id,
      serverId: connection.ps.server.id,
      serverName: connection.ps.server.name,
      connectionMode: connection.ps.connectionMode,
      instanceRoot: configured?.rootPath,
      databaseHost: configured?.databaseHost,
      databaseName: configured?.databaseName,
    };
  }

  async function withDeploymentStep<T>(
    deploymentId: string | undefined,
    projectName: string,
    name: string,
    work: () => Promise<T>,
    target?: { connection: RunnerConnection; instanceName: string }
  ): Promise<T> {
    if (!deploymentId) return work();
    const deployment = target
      ? requireRunningDeployment(deploymentId, {
          userId: user.id,
          project: projectName,
          environment: target.connection.ps.environment,
          instance: target.instanceName,
          projectServerId: target.connection.ps.id,
          serverId: target.connection.ps.server.id,
          databaseHost: target.connection.ps.limsInstance?.databaseHost,
          databaseName: target.connection.ps.limsInstance?.databaseName,
        })
      : getDeployment(deploymentId);
    if (!deployment || deployment.userId !== user.id || deployment.project !== projectName) throw new Error(`Deployment '${deploymentId}' not found for project '${projectName}'`);
    const steps = [...(deployment.steps ?? []), {
      name,
      status: "running" as const,
      startedAt: new Date().toISOString(),
    }];
    updateDeployment(deploymentId, { steps });
    try {
      const result = await work();
      steps[steps.length - 1] = {
        ...steps[steps.length - 1],
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        summary: compactText(typeof result === "string" ? result : JSON.stringify(result), 1500),
      };
      updateDeployment(deploymentId, { steps });
      return result;
    } catch (error) {
      const disposition = deploymentFailureDisposition(error, {
        rollbackRequested: deployment.rollback.requested,
        backupAvailable: false,
      });
      steps[steps.length - 1] = {
        ...steps[steps.length - 1],
        status: disposition.stepStatus,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      updateDeployment(deploymentId, {
        steps,
        status: disposition.status,
        error: steps[steps.length - 1].error,
        recommendedResumeAction: disposition.status === "unknown"
          ? "Remote completion is unknown. Inspect job and target state before retrying; do not roll back automatically."
          : undefined,
      });
      throw error;
    }
  }

  async function runSemanticCheck(
    toolName: string,
    entryPoint: SampleManagerInspectionEntryPoint,
    target: SampleManagerInspectionTarget,
    databaseTarget: SampleManagerDatabaseTarget,
    plan?: SampleManagerPlatePlan,
    maxRows = 200,
    context?: JobContext,
  ): Promise<string> {
    const queryId = `inspect-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const provenance = {
      queryId,
      project: databaseTarget.project.name,
      environment: databaseTarget.ps.environment,
      projectServerId: databaseTarget.ps.id,
      serverId: databaseTarget.ps.server.id,
      serverName: databaseTarget.ps.server.name,
      connectionMode: databaseTarget.ps.connectionMode,
      instance: databaseTarget.configuredInstance?.name,
      instanceVersion: databaseTarget.configuredInstance?.version,
      databaseHost: databaseTarget.databaseHost,
      databaseName: databaseTarget.database,
      entryPoint,
      readOnly: true,
      mutationAttempted: false,
    };
    try {
      context?.phase("inspecting");
      const raw = JSON.parse(await runSampleManagerSemanticInspection(databaseTarget.runner, {
        database: databaseTarget.database,
        databaseHost: databaseTarget.databaseHost,
        entryPoint,
        target,
        maxRows,
        execution: executionForJob(context),
      }));
      const finishedAt = new Date().toISOString();
      const envelope = analyzeSampleManagerSemanticInspection(raw, { entryPoint, queryId, startedAt, finishedAt, plan });
      envelope.target = { ...envelope.target, ...provenance };
      envelope.queryMetadata = { ...envelope.queryMetadata, ...provenance, finishedAt };
      writeAudit({ userId: user.id, username: user.username, tool: toolName, ...provenance, finishedAt, violationCount: envelope.violations.length, unknownCount: envelope.unknowns.length, partial: envelope.partial });
      context?.phase("completed");
      return JSON.stringify({ capability: toolName, ...envelope });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const classified = classifyRemoteError(error);
      const message = classified.message;
      const category = classified.category;
      const errorKind = classified.category;
      const response = {
        capability: toolName,
        target: { ...provenance },
        facts: [],
        inferences: [],
        unknowns: ["No semantic inspection result was received."],
        violations: [],
        evidence: [],
        recommendedNextChecks: [],
        errors: [{ kind: errorKind, category, message }],
        queryMetadata: { ...provenance, startedAt, finishedAt },
        partial: true,
      };
      writeAudit({ userId: user.id, username: user.username, tool: toolName, ...provenance, startedAt, finishedAt, errorKind, error: message });
      if (context) {
        const jobError = new Error(`Semantic inspection '${queryId}' failed (${errorKind}): ${message}`) as Error & { category?: string };
        jobError.category = category;
        throw jobError;
      }
      return JSON.stringify(response);
    }
  }

  async function runWorkflowCheck(
    toolName: string,
    action: "export" | "validate" | "compare",
    target: SampleManagerWorkflowTarget,
    databaseTarget: SampleManagerDatabaseTarget,
    maxRows: number,
    baseline?: SampleManagerWorkflowBaseline,
    context?: JobContext,
  ): Promise<string> {
    const queryId = `workflow-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const provenance = {
      queryId,
      project: databaseTarget.project.name,
      environment: databaseTarget.ps.environment,
      projectServerId: databaseTarget.ps.id,
      serverId: databaseTarget.ps.server.id,
      serverName: databaseTarget.ps.server.name,
      connectionMode: databaseTarget.ps.connectionMode,
      agentId: databaseTarget.ps.server.agentId,
      instance: databaseTarget.configuredInstance?.name,
      instanceVersion: databaseTarget.configuredInstance?.version,
      databaseHost: databaseTarget.databaseHost,
      databaseName: databaseTarget.database,
      workflowTarget: target,
      action,
      readOnly: true,
      mutationAttempted: false,
      startedAt,
    };
    try {
      context?.phase("exporting_workflow");
      const rawText = await runSampleManagerWorkflowSnapshot(databaseTarget.runner, {
        database: databaseTarget.database,
        databaseHost: databaseTarget.databaseHost,
        target,
        maxRows,
        execution: executionForJob(context),
      });
      const raw = JSON.parse(rawText) as Record<string, unknown>;
      const finishedAt = new Date().toISOString();
      const artifact = persistQueryArtifact({
        queryId,
        rawResponse: rawText,
        provenance: { ...provenance, finishedAt, ownerUserId: user.id },
      });
      const response = analyzeSampleManagerWorkflowSnapshot(raw, {
        action,
        target,
        baseline,
        queryId,
        startedAt,
        finishedAt,
      });
      response.target = { ...response.target, ...provenance };
      response.queryMetadata = { ...response.queryMetadata, ...provenance, finishedAt, artifact };
      writeAudit({
        userId: user.id,
        username: user.username,
        tool: toolName,
        ...provenance,
        finishedAt,
        artifactPath: artifact.path,
        artifactBytes: artifact.bytes,
        artifactSha256: artifact.sha256,
        violationCount: response.violations.length,
        unknownCount: response.unknowns.length,
        partial: response.partial,
      });
      context?.phase("completed");
      return JSON.stringify({ capability: toolName, artifact, ...response });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const classified = classifyRemoteError(error);
      const message = classified.message;
      const category = classified.category;
      const errorKind = classified.category;
      const artifact = persistQueryArtifact({
        queryId,
        rawResponse: JSON.stringify({ ok: false, errorKind, error: message }),
        provenance: { ...provenance, finishedAt, ownerUserId: user.id },
      });
      writeAudit({ userId: user.id, username: user.username, tool: toolName, ...provenance, finishedAt, errorKind, error: message, artifactPath: artifact.path, artifactBytes: artifact.bytes, artifactSha256: artifact.sha256 });
      if (context) {
        const jobError = new Error(`Workflow ${action} '${queryId}' failed (${errorKind}); artifact=${artifact.path}; ${message}`) as Error & { category?: string };
        jobError.category = category;
        throw jobError;
      }
      return JSON.stringify({
        capability: toolName,
        artifact,
        target: { ...provenance, finishedAt },
        snapshot: { workflow: null, nodes: [], links: [], parameters: [] },
        topology: { nodeCount: 0, linkCount: 0, graphComplete: false },
        facts: [],
        inferences: [],
        unknowns: ["No Workflow snapshot was received."],
        violations: [],
        evidence: [],
        errors: [{ kind: errorKind, category, message }],
        queryMetadata: { ...provenance, finishedAt, artifact },
        partial: true,
      });
    }
  }

  async function runRuntimeCheck(
    toolName: string,
    connection: RunnerConnection,
    instance: SampleManagerInstanceRef,
    options: Omit<SampleManagerRuntimeInspectionOptions, "instance" | "execution">,
    deploymentId?: string,
    context?: JobContext,
  ): Promise<string> {
    const queryId = `runtime-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const provenance = {
      queryId,
      project: connection.project.name,
      environment: connection.ps.environment,
      projectServerId: connection.ps.id,
      serverId: connection.ps.server.id,
      serverName: connection.ps.server.name,
      connectionMode: connection.ps.connectionMode,
      agentId: connection.ps.server.agentId,
      instance: typeof instance === "string" ? instance : instance.name,
      instanceVersion: connection.ps.limsInstance?.version,
      instanceRoot: typeof instance === "string" ? undefined : instance.rootPath,
      deploymentId,
      readOnly: true,
      mutationAttempted: false,
      startedAt,
    };
    try {
      context?.phase("inspecting_runtime");
      const rawText = await inspectSampleManagerDeploymentRuntime(connection.runner, { ...options, instance, execution: executionForJob(context) });
      const raw = JSON.parse(rawText) as Record<string, unknown>;
      const finishedAt = new Date().toISOString();
      const artifact = persistQueryArtifact({ queryId, rawResponse: rawText, provenance: { ...provenance, finishedAt, ownerUserId: user.id } });
      const rawSummary = raw.summary && typeof raw.summary === "object" ? raw.summary : {};
      const runtime = {
        ...raw,
        summary: rawSummary,
        artifact,
      };
      const response = {
        capability: toolName,
        deploymentId: deploymentId ?? null,
        provenance: { ...provenance, finishedAt },
        facts: [
          { type: "file_state", files: raw.files ?? [], assemblies: raw.assemblies ?? [] },
          { type: "service_state", services: raw.services ?? [] },
          { type: "process_state", processes: raw.processes ?? [] },
          { type: "loaded_modules", loadedModules: raw.loadedModules ?? [] },
          { type: "log_summary", logs: raw.logs ?? {} },
        ],
        inferences: [],
        unknowns: Array.isArray(raw.moduleErrors) && raw.moduleErrors.length > 0
          ? ["One or more process module lists could not be inspected; loaded-assembly evidence is incomplete."]
          : [],
        evidence: [{ artifact, summary: rawSummary }],
        errors: [],
        runtime,
        queryMetadata: { ...provenance, finishedAt, artifact },
        partial: Array.isArray(raw.moduleErrors) && raw.moduleErrors.length > 0,
      };
      writeAudit({ userId: user.id, username: user.username, tool: toolName, ...provenance, finishedAt, artifactPath: artifact.path, artifactBytes: artifact.bytes, artifactSha256: artifact.sha256, summary: rawSummary, partial: response.partial });
      context?.phase("completed");
      return JSON.stringify(response);
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const classified = classifyRemoteError(error);
      const message = classified.message;
      const category = classified.category;
      const errorKind = classified.category;
      const artifact = persistQueryArtifact({ queryId, rawResponse: JSON.stringify({ ok: false, errorKind, error: message }), provenance: { ...provenance, finishedAt, ownerUserId: user.id } });
      writeAudit({ userId: user.id, username: user.username, tool: toolName, ...provenance, finishedAt, errorKind, error: message, artifactPath: artifact.path, artifactBytes: artifact.bytes, artifactSha256: artifact.sha256 });
      if (context) {
        const jobError = new Error(`SampleManager runtime inspection '${queryId}' failed (${errorKind}); artifact=${artifact.path}; ${message}`) as Error & { category?: string };
        jobError.category = category;
        throw jobError;
      }
      return JSON.stringify({
        capability: toolName,
        deploymentId: deploymentId ?? null,
        provenance: { ...provenance, finishedAt },
        facts: [],
        inferences: [],
        unknowns: ["No runtime inspection result was received."],
        evidence: [{ artifact }],
        errors: [{ kind: errorKind, category, message }],
        runtime: null,
        queryMetadata: { ...provenance, finishedAt, artifact },
        partial: true,
      });
    }
  }

  async function runEntitySchemaCheck(
    table: string,
    entity: string | undefined,
    databaseTarget: SampleManagerDatabaseTarget,
    context?: JobContext,
  ): Promise<string> {
    const queryId = `entity-schema-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const provenance = {
      queryId,
      project: databaseTarget.project.name,
      environment: databaseTarget.ps.environment,
      projectServerId: databaseTarget.ps.id,
      serverId: databaseTarget.ps.server.id,
      serverName: databaseTarget.ps.server.name,
      connectionMode: databaseTarget.ps.connectionMode,
      instance: databaseTarget.configuredInstance?.name,
      instanceVersion: databaseTarget.configuredInstance?.version,
      databaseHost: databaseTarget.databaseHost,
      databaseName: databaseTarget.database,
      table,
      entity,
      readOnly: true,
      mutationAttempted: false,
      startedAt,
    };
    try {
      context?.phase("inspecting_entity_schema");
      const rawText = await runSampleManagerEntitySchema(databaseTarget.runner, {
        database: databaseTarget.database,
        databaseHost: databaseTarget.databaseHost,
        table,
        entity,
        execution: executionForJob(context),
      });
      const finishedAt = new Date().toISOString();
      const artifact = persistQueryArtifact({ queryId, rawResponse: rawText, provenance: { ...provenance, finishedAt, ownerUserId: user.id } });
      const analyzed = analyzeSampleManagerEntitySchema(JSON.parse(rawText) as Record<string, unknown>, { queryId, startedAt, finishedAt, instanceVersion: databaseTarget.configuredInstance?.version });
      const response = {
        ...analyzed,
        target: { ...analyzed.target, ...provenance },
        queryMetadata: { ...analyzed.queryMetadata, ...provenance, finishedAt, artifact },
      };
      writeAudit({ userId: user.id, username: user.username, tool: "samplemanager_entity_schema", ...provenance, finishedAt, artifactPath: artifact.path, artifactBytes: artifact.bytes, artifactSha256: artifact.sha256, logicalFieldCount: response.logical.rowCount, partial: response.partial });
      context?.phase("completed");
      return JSON.stringify({ capability: "samplemanager_entity_schema", artifact, ...response });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const classified = classifyRemoteError(error);
      const artifact = persistQueryArtifact({ queryId, rawResponse: JSON.stringify({ ok: false, errorKind: classified.category, error: classified.message }), provenance: { ...provenance, finishedAt, ownerUserId: user.id } });
      writeAudit({ userId: user.id, username: user.username, tool: "samplemanager_entity_schema", ...provenance, finishedAt, errorKind: classified.category, error: classified.message, artifactPath: artifact.path, artifactSha256: artifact.sha256 });
      if (context) {
        const jobError = new Error(`Entity schema '${queryId}' failed (${classified.category}); artifact=${artifact.path}; ${classified.message}`) as Error & { category?: string };
        jobError.category = classified.category;
        throw jobError;
      }
      return JSON.stringify({ capability: "samplemanager_entity_schema", artifact, target: provenance, physical: { columns: [], rowCount: 0 }, logical: { fields: [], rowCount: 0 }, entityDefinitions: [], facts: [], inferences: [], unknowns: ["No entity schema result was received."], evidence: [{ artifact }], errors: [{ kind: classified.category, message: classified.message }], queryMetadata: { ...provenance, finishedAt, artifact }, partial: true });
    }
  }

  async function runEnhCheck(
    toolName: string,
    mode: "dashboard" | "criteria" | "validate",
    target: SampleManagerEnhTarget,
    databaseTarget: SampleManagerDatabaseTarget,
    maxRows: number,
    context?: JobContext,
  ): Promise<string> {
    const queryId = `enh-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const provenance = {
      queryId,
      project: databaseTarget.project.name,
      environment: databaseTarget.ps.environment,
      projectServerId: databaseTarget.ps.id,
      serverId: databaseTarget.ps.server.id,
      serverName: databaseTarget.ps.server.name,
      connectionMode: databaseTarget.ps.connectionMode,
      instance: databaseTarget.configuredInstance?.name,
      instanceVersion: databaseTarget.configuredInstance?.version,
      databaseHost: databaseTarget.databaseHost,
      databaseName: databaseTarget.database,
      mode,
      readOnly: true,
      mutationAttempted: false,
      startedAt,
    };
    try {
      context?.phase("discovering_enh_configuration");
      const rawText = await runSampleManagerEnhInspection(databaseTarget.runner, {
        database: databaseTarget.database,
        databaseHost: databaseTarget.databaseHost,
        target,
        maxRows,
        execution: executionForJob(context),
      });
      const finishedAt = new Date().toISOString();
      const artifact = persistQueryArtifact({ queryId, rawResponse: rawText, provenance: { ...provenance, finishedAt, ownerUserId: user.id } });
      const analyzed = analyzeSampleManagerEnhInspection(JSON.parse(rawText) as Record<string, unknown>, { mode, target, queryId, startedAt, finishedAt, instanceVersion: databaseTarget.configuredInstance?.version });
      const response = {
        ...analyzed,
        target: { ...analyzed.target, ...provenance },
        queryMetadata: { ...analyzed.queryMetadata, ...provenance, finishedAt, artifact },
      };
      writeAudit({ userId: user.id, username: user.username, tool: toolName, ...provenance, target, finishedAt, artifactPath: artifact.path, artifactBytes: artifact.bytes, artifactSha256: artifact.sha256, componentCounts: response.componentCounts, violationCount: response.violations.length, partial: response.partial });
      context?.phase("completed");
      return JSON.stringify({ capability: toolName, artifact, ...response });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const classified = classifyRemoteError(error);
      const artifact = persistQueryArtifact({ queryId, rawResponse: JSON.stringify({ ok: false, errorKind: classified.category, error: classified.message }), provenance: { ...provenance, finishedAt, ownerUserId: user.id } });
      writeAudit({ userId: user.id, username: user.username, tool: toolName, ...provenance, target, finishedAt, errorKind: classified.category, error: classified.message, artifactPath: artifact.path, artifactSha256: artifact.sha256 });
      if (context) {
        const jobError = new Error(`ENH inspection '${queryId}' failed (${classified.category}); artifact=${artifact.path}; ${classified.message}`) as Error & { category?: string };
        jobError.category = classified.category;
        throw jobError;
      }
      return JSON.stringify({ capability: toolName, artifact, target: { ...target, ...provenance }, components: {}, componentCounts: {}, facts: [], inferences: [], unknowns: ["No ENH configuration result was received."], violations: [], evidence: [{ artifact }], errors: [{ kind: classified.category, message: classified.message }], queryMetadata: { ...provenance, finishedAt, artifact }, partial: true });
    }
  }

  async function runVglCheck(
    connection: RunnerConnection,
    sourcePath: string,
    entrypoint: string,
    maxCallDepth: number,
    context?: JobContext,
  ): Promise<string> {
    const queryId = `vgl-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const provenance = {
      queryId,
      project: connection.project.name,
      environment: connection.ps.environment,
      projectServerId: connection.ps.id,
      serverId: connection.ps.server.id,
      serverName: connection.ps.server.name,
      connectionMode: connection.ps.connectionMode,
      instance: connection.ps.limsInstance?.name,
      instanceVersion: connection.ps.limsInstance?.version,
      sourcePath,
      entrypoint,
      readOnly: true,
      mutationAttempted: false,
      startedAt,
    };
    try {
      context?.phase("reading_vgl_source");
      const rawText = await readSampleManagerVglSource(connection.runner, { sourcePath, execution: executionForJob(context) });
      const finishedAt = new Date().toISOString();
      const response = analyzeSampleManagerVglSource(JSON.parse(rawText) as Record<string, unknown>, { sourcePath, entrypoint, maxCallDepth, queryId, startedAt, finishedAt });
      const persisted = JSON.stringify({ capability: "samplemanager_vgl_inspect_entrypoint", ...response, target: { ...response.target, ...provenance }, queryMetadata: { ...response.queryMetadata, ...provenance, finishedAt } });
      const artifact = persistQueryArtifact({ queryId, rawResponse: persisted, provenance: { ...provenance, finishedAt, ownerUserId: user.id } });
      const result = { capability: "samplemanager_vgl_inspect_entrypoint", artifact, ...response, target: { ...response.target, ...provenance }, queryMetadata: { ...response.queryMetadata, ...provenance, finishedAt, artifact } };
      writeAudit({ userId: user.id, username: user.username, tool: "samplemanager_vgl_inspect_entrypoint", ...provenance, finishedAt, artifactPath: artifact.path, artifactBytes: artifact.bytes, artifactSha256: artifact.sha256, routineCount: response.routines.length, callCount: response.callChain.length, partial: response.partial });
      context?.phase("completed");
      return JSON.stringify(result);
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const classified = classifyRemoteError(error);
      const artifact = persistQueryArtifact({ queryId, rawResponse: JSON.stringify({ ok: false, errorKind: classified.category, error: classified.message }), provenance: { ...provenance, finishedAt, ownerUserId: user.id } });
      writeAudit({ userId: user.id, username: user.username, tool: "samplemanager_vgl_inspect_entrypoint", ...provenance, finishedAt, errorKind: classified.category, error: classified.message, artifactPath: artifact.path, artifactSha256: artifact.sha256 });
      if (context) {
        const jobError = new Error(`VGL inspection '${queryId}' failed (${classified.category}); artifact=${artifact.path}; ${classified.message}`) as Error & { category?: string };
        jobError.category = classified.category;
        throw jobError;
      }
      return JSON.stringify({ capability: "samplemanager_vgl_inspect_entrypoint", artifact, target: provenance, entrypoint: null, routines: [], constants: [], joins: [], callChain: [], facts: [], inferences: [], unknowns: ["No VGL source analysis was received."], evidence: [{ artifact }], errors: [{ kind: classified.category, message: classified.message }], queryMetadata: { ...provenance, finishedAt, artifact }, partial: true });
    }
  }

  // ── SampleManager high-level tools ────────────────────────────────────────
  server.tool(
    "samplemanager_vgl_inspect_entrypoint",
    "Statically inspect one bounded VGL source entrypoint, including parameters and VALUE/reference passing, constants, JOINs, CALL_ROUTINE edges, and source line evidence.",
    {
      project: z.string().optional(),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      sourcePath: z.string().min(1).max(4096).describe("Exact remote .rpf/.sxf source path."),
      entrypoint: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),
      maxCallDepth: z.number().int().min(1).max(10).optional().describe("Maximum in-file static call depth; default 6."),
      async: z.boolean().optional().describe("Run as a tracked job; default true."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project: projectName, environment, serverId, serverName, sourcePath, entrypoint, maxCallDepth = 6, async: runAsync = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const connection = getRunner(projectName, environment, { serverId, serverName });
      const work = (context?: JobContext) => runVglCheck(connection, sourcePath, entrypoint, maxCallDepth, context);
      if (runAsync) {
        const job = startJob(user, resolvedProjectName, "samplemanager_vgl_inspect_entrypoint", { sourcePath, entrypoint, maxCallDepth, environment: connection.ps.environment, serverId: connection.ps.server.id, projectServerId: connection.ps.id }, work);
        return { structuredContent: { jobId: job.id, status: job.status, sourcePath, entrypoint }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status, sourcePath, entrypoint }) }] };
      }
      const response = JSON.parse(await work()) as Record<string, unknown>;
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ target: response.target, entrypoint: response.entrypoint, callChain: response.callChain, unknowns: response.unknowns, errors: response.errors, artifact: response.artifact }) }] };
    },
  );

  server.tool(
    "samplemanager_inspect_assembly_type",
    "Inspect one .NET assembly type with bounded metadata reflection. Returns only flattened type, property, method, event, version, dependency, and SHA-256 evidence.",
    {
      project: z.string().optional(),
      environment: z.string().optional(),
      serverId: z.number().int().optional(),
      serverName: z.string().optional(),
      assemblyPath: z.string(),
      typeName: z.string(),
      memberFilter: z.string().optional(),
      includeInherited: z.boolean().optional(),
      includeNonPublic: z.boolean().optional(),
      maxMembers: z.number().int().min(1).max(500).optional(),
      async: z.boolean().optional().describe("Run as a tracked job. Default false."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project: projectName, environment, serverId, serverName, assemblyPath, typeName, memberFilter, includeInherited = true, includeNonPublic = false, maxMembers = 100, async = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner, ps } = getRunner(projectName, environment, { serverId, serverName });
      const work = (context?: JobContext) => inspectSampleManagerAssemblyType(runner, { assemblyPath, typeName, memberFilter, includeInherited, includeNonPublic, maxMembers, execution: executionForJob(context) });
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_inspect_assembly_type", environment: ps.environment, serverId: ps.server.id, assemblyPath, typeName, memberFilter, maxMembers, readOnly: true, mutationAttempted: false });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_inspect_assembly_type", { environment: ps.environment, serverId: ps.server.id, assemblyPath, typeName, memberFilter, includeInherited, includeNonPublic, maxMembers }, work);
        return { structuredContent: { jobId: job.id, status: job.status }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      const raw = await work();
      const response = JSON.parse(raw);
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson(response) }] };
    },
  );

  server.tool(
    "samplemanager_validate_form_task_contract",
    "Read-only Form Task preflight across FORM/TASK/MASTER_MENU, the exact form XML, requested controls, compiled cache, and an optional assembly type contract.",
    {
      project: z.string().optional(),
      environment: z.string().optional(),
      serverId: z.number().int().optional(),
      serverName: z.string().optional(),
      instance: z.string().optional(),
      database: z.string().optional(),
      formName: z.string(),
      taskName: z.string(),
      assemblyPath: z.string().optional(),
      typeName: z.string().optional(),
      controlNames: z.array(z.string()).max(100).optional(),
      maxMembers: z.number().int().min(1).max(500).optional(),
      async: z.boolean().optional().describe("Run as a tracked job. Default true."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project: projectName, environment, serverId, serverName, instance, database, formName, taskName, assemblyPath, typeName, controlNames, maxMembers = 100, async = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const connection = getRunner(projectName, environment, { serverId, serverName });
      const configured = connection.ps.limsInstance;
      if (configured && instance && configured.name.toLowerCase() !== instance.toLowerCase()) throw new Error(`Project link is bound to LIMS instance '${configured.name}', not '${instance}'`);
      if (configured?.databaseName && database && configured.databaseName.toLowerCase() !== database.toLowerCase()) throw new Error(`LIMS instance '${configured.name}' is configured for database '${configured.databaseName}', not '${database}'`);
      const instanceTarget = configured ?? instance;
      if (!instanceTarget) throw new Error("No LIMS instance is bound; select one in the management UI or pass instance");
      const databaseName = configured?.databaseName ?? database;
      if (!databaseName) throw new Error("No database is configured for the selected LIMS instance");
      const databaseHost = configured?.databaseHost ?? "localhost";
      const work = (context?: JobContext) => validateSampleManagerFormTaskContract(connection.runner, { instance: instanceTarget, databaseHost, databaseName, formName, taskName, assemblyPath, typeName, controlNames, maxMembers, execution: executionForJob(context) });
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_validate_form_task_contract", environment: connection.ps.environment, serverId: connection.ps.server.id, instance: typeof instanceTarget === "string" ? instanceTarget : instanceTarget.name, databaseHost, databaseName, formName, taskName, assemblyPath, typeName, controlNames, readOnly: true, mutationAttempted: false });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_validate_form_task_contract", { environment: connection.ps.environment, serverId: connection.ps.server.id, instance: typeof instanceTarget === "string" ? instanceTarget : instanceTarget.name, databaseName, formName, taskName, assemblyPath, typeName, controlNames, maxMembers }, work);
        return { structuredContent: { jobId: job.id, status: job.status }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      const response = JSON.parse(await work());
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson(response) }] };
    },
  );

  server.tool(
    "samplemanager_create_deployment_manifest",
    "Create a read-only deployment manifest in the Relay workspace with SHA-256 metadata for selected source files and explicit target provenance. Does not build or deploy.",
    {
      project: z.string().optional(),
      environment: z.string().optional(),
      serverId: z.number().int().optional(),
      serverName: z.string().optional(),
      instance: z.string().optional(),
      deploymentId: z.string().optional(),
      outputPath: z.string().describe("Relative workspace path, e.g. manifests/deploy-123.json"),
      sourceFiles: z.array(z.string()).max(500),
      label: z.string().optional(),
      notes: z.array(z.string()).max(100).optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ project: projectName, environment, serverId, serverName, instance, deploymentId, outputPath, sourceFiles, label, notes }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { project, ps } = getRunner(projectName, environment, { serverId, serverName });
      const boundInstance = ps.limsInstance?.name;
      if (boundInstance && instance && boundInstance.toLowerCase() !== instance.toLowerCase()) throw new Error(`Project link is bound to LIMS instance '${boundInstance}', not '${instance}'`);
      const result = createDeploymentManifest({
        workspaceRoot: project.workspacePath, outputPath, deploymentId, label, sourceFiles, notes,
        target: { project: resolvedProjectName, environment: ps.environment, serverId: ps.server.id, serverName: ps.server.name, connectionMode: ps.connectionMode, agentId: ps.server.agentId, instance: boundInstance ?? instance ?? null, databaseHost: ps.limsInstance?.databaseHost ?? null, databaseName: ps.limsInstance?.databaseName ?? null },
      });
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_create_deployment_manifest", environment: ps.environment, serverId: ps.server.id, deploymentId, outputPath, sourceFiles, label, mutationAttempted: false });
      return { structuredContent: result.manifest, content: [{ type: "text", text: summarizeJson({ path: result.path, manifest: result.manifest }) }] };
    },
  );

  server.tool(
    "samplemanager_capabilities",
    "Resolve the versioned SampleManager Capability Pack for a bound instance and list ready, planned, and unavailable semantic inspectors.",
    {
      project: z.string().optional(),
      environment: z.string().optional(),
      serverId: z.number().int().optional(),
      serverName: z.string().optional(),
      includeAdapters: z.boolean().optional().describe("Include every built-in version adapter. Default false."),
    },
    async ({ project: projectName, environment, serverId, serverName, includeAdapters = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps } = getRunner(projectName, environment, { serverId, serverName });
      const instance = ps.limsInstance;
      if (!instance) {
        throw new Error(`No SampleManager instance is bound to project '${resolvedProjectName}' environment '${ps.environment}'`);
      }
      const pack = sampleManagerCapabilityRegistry.resolve({
        id: instance.id,
        name: instance.name,
        version: instance.version,
        runtimeKind: instance.runtimeKind,
        rootPath: instance.rootPath,
        databaseHost: instance.databaseHost,
        databaseName: instance.databaseName,
      });
      const provenance = {
        project: resolvedProjectName,
        environment: ps.environment,
        serverId: ps.server.id,
        serverName: ps.server.name,
        connectionMode: ps.connectionMode,
        agentId: ps.server.agentId,
        instance: instance.name,
        instanceVersion: instance.version,
        runtimeKind: instance.runtimeKind,
        databaseHost: instance.databaseHost,
        databaseName: instance.databaseName,
        adapterId: pack.adapterId,
        instanceFingerprint: pack.instanceFingerprint,
      };
      const envelope = createSampleManagerInspectionEnvelope({
        capability: "instance.inspect",
        provenance,
        facts: [
          { path: "instance.name", value: instance.name, source: "project_server_link" },
          { path: "instance.version", value: instance.version, source: "lims_instance_metadata" },
          { path: "instance.runtimeKind", value: instance.runtimeKind, source: "lims_instance_metadata" },
          { path: "instance.database", value: `${instance.databaseHost}/${instance.databaseName}`, source: "lims_instance_metadata" },
        ],
        unknowns: pack.adapterId === "samplemanager-generic"
          ? ["No version-specific semantic adapter is available for this SampleManager version."]
          : [],
        evidence: [{ type: "capability_pack", packId: pack.packId, schemaProfile: pack.schemaProfile }],
      });
      const response = {
        ...envelope,
        capabilityPack: pack,
        adapters: includeAdapters ? sampleManagerCapabilityRegistry.listAdapters() : undefined,
      };
      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "samplemanager_capabilities",
        environment: ps.environment,
        serverId: ps.server.id,
        instance: instance.name,
        instanceVersion: instance.version,
        adapterId: pack.adapterId,
        readOnly: true,
        mutationAttempted: false,
      });
      return {
        structuredContent: response,
        content: [{ type: "text", text: summarizeJson({
          provenance,
          packId: pack.packId,
          adapterId: pack.adapterId,
          cache: pack.cache,
          ready: pack.capabilities.filter((item) => item.status === "ready").map((item) => item.id),
          planned: pack.capabilities.filter((item) => item.status === "planned").map((item) => item.id),
          unavailable: pack.capabilities.filter((item) => item.status === "unavailable").map((item) => item.id),
        }) }],
      };
    }
  );

  server.tool(
    "samplemanager_instance_preflight",
    "Run one bounded, read-only instance preflight for paths, selected files, XML validity, FormsBin entries, services, processes, and recent error summaries.",
    {
      project: z.string().optional(),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      instance: z.string().optional().describe("Optional when the project environment is bound to a LIMS instance."),
      filePaths: z.array(z.string()).max(200).optional().describe("Exact remote files to check for existence, SHA-256, version, and XML validity."),
      formNames: z.array(z.string()).max(100).optional().describe("Exact form identities whose recursive FormsBin entries should be listed."),
      logMinutes: z.number().int().min(1).max(1440).optional().describe("Recent log window in minutes; default 30."),
      maxErrors: z.number().int().min(1).max(200).optional().describe("Maximum compact error lines; default 20."),
      async: z.boolean().optional().describe("Run as a tracked job; default true."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project: projectName, environment, serverId, serverName, instance, filePaths, formNames, logMinutes, maxErrors, async = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const target = getSampleManagerTarget(projectName, environment, instance, undefined, { serverId, serverName });
      const provenance = {
        project: resolvedProjectName,
        environment: target.ps.environment,
        projectServerId: target.ps.id,
        serverId: target.ps.server.id,
        serverName: target.ps.server.name,
        connectionMode: target.ps.connectionMode,
        instance: target.instanceName,
        instanceRoot: instancePaths(target.instance).root,
        databaseHost: target.configuredInstance?.databaseHost,
        databaseName: target.configuredInstance?.databaseName,
      };
      const work = async (context?: JobContext) => inspectSampleManagerInstance(target.runner, target.instance, {
        filePaths,
        formNames,
        logMinutes,
        maxErrors,
        execution: executionForJob(context),
      });
      writeAudit({
        userId: user.id,
        username: user.username,
        tool: "samplemanager_instance_preflight",
        ...provenance,
        fileCount: filePaths?.length ?? 0,
        formCount: formNames?.length ?? 0,
        logMinutes: logMinutes ?? 30,
        readOnly: true,
        mutationAttempted: false,
      });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_instance_preflight", { ...provenance, filePaths, formNames, logMinutes, maxErrors }, work);
        return { structuredContent: { jobId: job.id, status: job.status, target: provenance }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status, target: provenance }) }] };
      }
      const evidence = JSON.parse(await work()) as Record<string, unknown>;
      const response = { provenance, evidence };
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson(response) }] };
    }
  );

  server.tool(
    "samplemanager_inspect_deployment_runtime",
    "Run a bounded, read-only post-deployment runtime inspection for exact files, assembly versions, loaded modules, instance services, processes, and recent errors.",
    {
      project: z.string().optional(),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      instance: z.string().optional().describe("Optional when the selected project environment is bound to a LIMS instance."),
      filePaths: z.array(z.string().max(4096)).max(100).optional().describe("Exact remote files to hash and inspect."),
      assemblyPaths: z.array(z.string().max(4096)).max(50).optional().describe("Exact DLL/EXE paths whose disk and loaded-module state should be checked."),
      logMinutes: z.number().int().min(1).max(1440).optional().describe("Log timestamp window in minutes; default 30."),
      maxErrors: z.number().int().min(1).max(200).optional().describe("Maximum compact error entries; default 20."),
      deploymentId: z.string().optional().describe("Optional deployment ID used to correlate the runtime evidence."),
      async: z.boolean().optional().describe("Run as a tracked job; default true."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project: projectName, environment, serverId, serverName, instance, filePaths, assemblyPaths, logMinutes, maxErrors, deploymentId, async: runAsync = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const target = getSampleManagerTarget(projectName, environment, instance, undefined, { serverId, serverName });
      if (deploymentId) {
        const deployment = getDeployment(deploymentId);
        if (!deployment || deployment.userId !== user.id || deployment.project !== resolvedProjectName) throw new Error(`Deployment '${deploymentId}' not found for project '${resolvedProjectName}'`);
      }
      const runtimeOptions = { filePaths, assemblyPaths, logMinutes, maxErrors };
      const work = (context?: JobContext) => runRuntimeCheck("samplemanager_inspect_deployment_runtime", target, target.instance, runtimeOptions, deploymentId, context);
      const targetSummary = { project: resolvedProjectName, environment: target.ps.environment, projectServerId: target.ps.id, serverId: target.ps.server.id, serverName: target.ps.server.name, instance: target.instanceName, deploymentId: deploymentId ?? null };
      if (runAsync) {
        const job = startJob(user, resolvedProjectName, "samplemanager_inspect_deployment_runtime", { ...targetSummary, filePaths, assemblyPaths, logMinutes, maxErrors }, work);
        return { structuredContent: { jobId: job.id, status: job.status, target: targetSummary }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status, target: targetSummary }) }] };
      }
      const response = JSON.parse(await work()) as Record<string, unknown>;
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ capability: response.capability, provenance: response.provenance, runtime: response.runtime && typeof response.runtime === "object" ? { summary: (response.runtime as Record<string, unknown>).summary } : null, unknowns: response.unknowns, errors: response.errors }) }] };
    },
  );

  server.tool(
    "samplemanager_entity_inspect",
    "Run one bounded, read-only SampleManager semantic inspection for Execution readiness, Plate/Batch integrity, Test/Result lineage, or Lab Method definition.",
    {
      project: z.string().optional(),
      database: z.string().optional().describe("Optional when the selected LIMS instance has a configured database."),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      entryPoint: sampleManagerEntryPointSchema,
      target: sampleManagerInspectionTargetSchema,
      maxRows: z.number().int().min(1).max(500).optional().describe("Maximum rows per discovered table; default 200."),
      async: z.boolean().optional().describe("Run as a tracked job; default true."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project: projectName, database, environment, serverId, serverName, entryPoint, target, maxRows = 200, async: runAsync = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const databaseTarget = getSampleManagerDatabaseTarget(projectName, environment, database, { serverId, serverName });
      const work = (context?: JobContext) => runSemanticCheck("samplemanager_entity_inspect", entryPoint, target, databaseTarget, undefined, maxRows, context);
      if (runAsync) {
        const job = startJob(user, resolvedProjectName, "samplemanager_entity_inspect", { entryPoint, target, environment: databaseTarget.ps.environment, serverId: databaseTarget.ps.server.id, projectServerId: databaseTarget.ps.id, database: databaseTarget.database, maxRows }, work);
        return { structuredContent: { jobId: job.id, status: job.status, entryPoint, target: { project: resolvedProjectName, environment: databaseTarget.ps.environment, serverId: databaseTarget.ps.server.id, serverName: databaseTarget.ps.server.name, database: databaseTarget.database } }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status, entryPoint }) }] };
      }
      const response = JSON.parse(await work()) as Record<string, unknown>;
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ capability: response.capability, target: response.target, violations: response.violations, unknowns: response.unknowns, errors: response.errors, queryMetadata: response.queryMetadata }) }] };
    },
  );

  server.tool(
    "samplemanager_lab_method_lint",
    "Lint one SampleManager Lab Method version for identity, reference, formula, type, default, placeholder, and Instruction Blob risks without changing the database.",
    {
      project: z.string().optional(),
      database: z.string().optional().describe("Optional when the selected LIMS instance has a configured database."),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      labMethodId: z.string(),
      labMethodVersion: z.string().optional(),
      maxRows: z.number().int().min(1).max(500).optional(),
      async: z.boolean().optional().describe("Run as a tracked job; default true."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project: projectName, database, environment, serverId, serverName, labMethodId, labMethodVersion, maxRows = 200, async: runAsync = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const databaseTarget = getSampleManagerDatabaseTarget(projectName, environment, database, { serverId, serverName });
      const target = { labMethodId, labMethodVersion };
      const work = async (context?: JobContext) => {
        const response = JSON.parse(await runSemanticCheck("samplemanager_lab_method_lint", "lab_method_definition", target, databaseTarget, undefined, maxRows, context)) as Record<string, unknown>;
        return JSON.stringify({ ...response, lint: { ruleCount: Array.isArray(response.violations) ? response.violations.length : 0, violations: response.violations ?? [] } });
      };
      if (runAsync) {
        const job = startJob(user, resolvedProjectName, "samplemanager_lab_method_lint", { labMethodId, labMethodVersion, environment: databaseTarget.ps.environment, serverId: databaseTarget.ps.server.id, projectServerId: databaseTarget.ps.id, database: databaseTarget.database, maxRows }, work);
        return { structuredContent: { jobId: job.id, status: job.status, target }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status, target }) }] };
      }
      const response = JSON.parse(await work()) as Record<string, unknown>;
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ target: response.target, lint: response.lint, unknowns: response.unknowns, errors: response.errors }) }] };
    },
  );

  server.tool(
    "samplemanager_plate_plan_validate",
    "Compare a Plate or Batch state with a bounded declarative layout plan and report wells, counts, Test links, and integrity differences without mutation.",
    {
      project: z.string().optional(),
      database: z.string().optional().describe("Optional when the selected LIMS instance has a configured database."),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      target: sampleManagerInspectionTargetSchema,
      plan: sampleManagerPlatePlanSchema.optional().describe("Expected rows, columns, empty positions, and entry counts."),
      maxRows: z.number().int().min(1).max(500).optional(),
      async: z.boolean().optional().describe("Run as a tracked job; default true."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project: projectName, database, environment, serverId, serverName, target, plan, maxRows = 200, async: runAsync = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const databaseTarget = getSampleManagerDatabaseTarget(projectName, environment, database, { serverId, serverName });
      const work = (context?: JobContext) => runSemanticCheck("samplemanager_plate_plan_validate", "plate_batch_integrity", target, databaseTarget, plan, maxRows, context);
      if (runAsync) {
        const job = startJob(user, resolvedProjectName, "samplemanager_plate_plan_validate", { target, plan, environment: databaseTarget.ps.environment, serverId: databaseTarget.ps.server.id, projectServerId: databaseTarget.ps.id, database: databaseTarget.database, maxRows }, work);
        return { structuredContent: { jobId: job.id, status: job.status, target }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status, target }) }] };
      }
      const response = JSON.parse(await work()) as Record<string, unknown>;
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ target: response.target, violations: response.violations, unknowns: response.unknowns, errors: response.errors }) }] };
    },
  );

  server.tool(
    "samplemanager_entity_schema",
    "Return combined SQL physical schema, SampleManager logical field metadata, Entity Definition mapping, and serialization-risk evidence for one table/entity.",
    {
      project: z.string().optional(),
      database: z.string().optional().describe("Optional when the selected LIMS instance has a configured database."),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      table: z.string().min(1).max(256),
      entity: z.string().min(1).max(256).optional(),
      async: z.boolean().optional().describe("Run as a tracked job; default true."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project: projectName, database, environment, serverId, serverName, table, entity, async: runAsync = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const databaseTarget = getSampleManagerDatabaseTarget(projectName, environment, database, { serverId, serverName });
      const work = (context?: JobContext) => runEntitySchemaCheck(table, entity, databaseTarget, context);
      if (runAsync) {
        const job = startJob(user, resolvedProjectName, "samplemanager_entity_schema", { table, entity, environment: databaseTarget.ps.environment, serverId: databaseTarget.ps.server.id, projectServerId: databaseTarget.ps.id, database: databaseTarget.database }, work);
        return { structuredContent: { jobId: job.id, status: job.status, target: { table, entity: entity ?? null } }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status, table, entity: entity ?? null }) }] };
      }
      const response = JSON.parse(await work()) as Record<string, unknown>;
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ target: response.target, physical: response.physical, logical: response.logical, unknowns: response.unknowns, errors: response.errors, artifact: response.artifact }) }] };
    },
  );

  server.tool(
    "samplemanager_enh_inspect",
    "Inspect one ENH dashboard or criteria configuration as a bounded graph of folders, criteria, templates, form configs, grids, columns, grouping, procedures, actions, and navigation.",
    {
      project: z.string().optional(),
      database: z.string().optional().describe("Optional when the selected LIMS instance has a configured database."),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      mode: z.enum(["dashboard", "criteria"]).optional().describe("Inspection focus; default dashboard."),
      target: sampleManagerEnhTargetSchema,
      maxRows: z.number().int().min(1).max(500).optional(),
      async: z.boolean().optional().describe("Run as a tracked job; default true."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project: projectName, database, environment, serverId, serverName, mode = "dashboard", target, maxRows = 200, async: runAsync = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const databaseTarget = getSampleManagerDatabaseTarget(projectName, environment, database, { serverId, serverName });
      const work = (context?: JobContext) => runEnhCheck("samplemanager_enh_inspect", mode, target, databaseTarget, maxRows, context);
      if (runAsync) {
        const job = startJob(user, resolvedProjectName, "samplemanager_enh_inspect", { mode, target, environment: databaseTarget.ps.environment, serverId: databaseTarget.ps.server.id, projectServerId: databaseTarget.ps.id, database: databaseTarget.database, maxRows }, work);
        return { structuredContent: { jobId: job.id, status: job.status, mode, target }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status, mode, target }) }] };
      }
      const response = JSON.parse(await work()) as Record<string, unknown>;
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ target: response.target, componentCounts: response.componentCounts, violations: response.violations, unknowns: response.unknowns, errors: response.errors, artifact: response.artifact }) }] };
    },
  );

  server.tool(
    "samplemanager_enh_validate_configuration",
    "Validate one existing or staged ENH configuration for entity keys, field references, grid/template presence, duplicate sequence values, dangling ENH references, and XML/JSON storage formats without mutation.",
    {
      project: z.string().optional(),
      database: z.string().optional().describe("Optional when the selected LIMS instance has a configured database."),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      target: sampleManagerEnhTargetSchema,
      maxRows: z.number().int().min(1).max(500).optional(),
      async: z.boolean().optional().describe("Run as a tracked job; default true."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project: projectName, database, environment, serverId, serverName, target, maxRows = 200, async: runAsync = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const databaseTarget = getSampleManagerDatabaseTarget(projectName, environment, database, { serverId, serverName });
      const work = (context?: JobContext) => runEnhCheck("samplemanager_enh_validate_configuration", "validate", target, databaseTarget, maxRows, context);
      if (runAsync) {
        const job = startJob(user, resolvedProjectName, "samplemanager_enh_validate_configuration", { target, environment: databaseTarget.ps.environment, serverId: databaseTarget.ps.server.id, projectServerId: databaseTarget.ps.id, database: databaseTarget.database, maxRows }, work);
        return { structuredContent: { jobId: job.id, status: job.status, target }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status, target }) }] };
      }
      const response = JSON.parse(await work()) as Record<string, unknown>;
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ target: response.target, componentCounts: response.componentCounts, violations: response.violations, unknowns: response.unknowns, errors: response.errors, artifact: response.artifact }) }] };
    },
  );

  server.tool(
    "samplemanager_workflow_export",
    "Export one bounded, version-aware SampleManager Workflow snapshot with normalized nodes, links, parameters, topology, provenance, and a complete query artifact.",
    {
      project: z.string().optional(),
      database: z.string().optional().describe("Optional when the bound LIMS instance has a configured database."),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      target: sampleManagerWorkflowTargetSchema,
      maxRows: z.number().int().min(1).max(500).optional().describe("Maximum rows per discovered Workflow table; default 200."),
      async: z.boolean().optional().describe("Run as a tracked job; default true."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project: projectName, database, environment, serverId, serverName, target, maxRows = 200, async: runAsync = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const databaseTarget = getSampleManagerDatabaseTarget(projectName, environment, database, { serverId, serverName });
      const work = (context?: JobContext) => runWorkflowCheck("samplemanager_workflow_export", "export", target, databaseTarget, maxRows, undefined, context);
      if (runAsync) {
        const job = startJob(user, resolvedProjectName, "samplemanager_workflow_export", { target, environment: databaseTarget.ps.environment, serverId: databaseTarget.ps.server.id, projectServerId: databaseTarget.ps.id, database: databaseTarget.database, maxRows }, work);
        return { structuredContent: { jobId: job.id, status: job.status, target: { ...target, project: resolvedProjectName, environment: databaseTarget.ps.environment, serverId: databaseTarget.ps.server.id, database: databaseTarget.database } }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status, target }) }] };
      }
      const response = JSON.parse(await work()) as Record<string, unknown>;
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ capability: response.capability, queryMetadata: response.queryMetadata, topology: response.topology, unknowns: response.unknowns, errors: response.errors }) }] };
    },
  );

  server.tool(
    "samplemanager_workflow_validate",
    "Validate one SampleManager Workflow snapshot for node contracts, unresolved links, unreachable nodes, cycles, callbacks, return properties, and evidence gaps.",
    {
      project: z.string().optional(),
      database: z.string().optional().describe("Optional when the bound LIMS instance has a configured database."),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      target: sampleManagerWorkflowTargetSchema,
      maxRows: z.number().int().min(1).max(500).optional().describe("Maximum rows per discovered Workflow table; default 200."),
      async: z.boolean().optional().describe("Run as a tracked job; default true."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project: projectName, database, environment, serverId, serverName, target, maxRows = 200, async: runAsync = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const databaseTarget = getSampleManagerDatabaseTarget(projectName, environment, database, { serverId, serverName });
      const work = (context?: JobContext) => runWorkflowCheck("samplemanager_workflow_validate", "validate", target, databaseTarget, maxRows, undefined, context);
      if (runAsync) {
        const job = startJob(user, resolvedProjectName, "samplemanager_workflow_validate", { target, environment: databaseTarget.ps.environment, serverId: databaseTarget.ps.server.id, projectServerId: databaseTarget.ps.id, database: databaseTarget.database, maxRows }, work);
        return { structuredContent: { jobId: job.id, status: job.status, target: { ...target, project: resolvedProjectName, environment: databaseTarget.ps.environment, serverId: databaseTarget.ps.server.id, database: databaseTarget.database } }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status, target }) }] };
      }
      const response = JSON.parse(await work()) as Record<string, unknown>;
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ capability: response.capability, topology: response.topology, violations: response.violations, unknowns: response.unknowns, errors: response.errors }) }] };
    },
  );

  server.tool(
    "samplemanager_workflow_compare",
    "Compare the current bounded SampleManager Workflow snapshot with a caller-provided export baseline and return normalized node, link, contract, and metadata differences.",
    {
      project: z.string().optional(),
      database: z.string().optional().describe("Optional when the bound LIMS instance has a configured database."),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      target: sampleManagerWorkflowTargetSchema,
      baseline: sampleManagerWorkflowBaselineSchema.describe("Snapshot object returned by samplemanager_workflow_export, or its workflow/nodes/links/parameters subset."),
      maxRows: z.number().int().min(1).max(500).optional().describe("Maximum rows per discovered Workflow table; default 200."),
      async: z.boolean().optional().describe("Run as a tracked job; default true."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project: projectName, database, environment, serverId, serverName, target, baseline, maxRows = 200, async: runAsync = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const databaseTarget = getSampleManagerDatabaseTarget(projectName, environment, database, { serverId, serverName });
      const workflowBaseline = baseline as SampleManagerWorkflowBaseline;
      const work = (context?: JobContext) => runWorkflowCheck("samplemanager_workflow_compare", "compare", target, databaseTarget, maxRows, workflowBaseline, context);
      if (runAsync) {
        const job = startJob(user, resolvedProjectName, "samplemanager_workflow_compare", { target, baseline, environment: databaseTarget.ps.environment, serverId: databaseTarget.ps.server.id, projectServerId: databaseTarget.ps.id, database: databaseTarget.database, maxRows }, work);
        return { structuredContent: { jobId: job.id, status: job.status, target: { ...target, project: resolvedProjectName, environment: databaseTarget.ps.environment, serverId: databaseTarget.ps.server.id, database: databaseTarget.database } }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status, target }) }] };
      }
      const response = JSON.parse(await work()) as Record<string, unknown>;
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ capability: response.capability, diff: response.diff, violations: response.violations, unknowns: response.unknowns, errors: response.errors }) }] };
    },
  );

  server.tool(
    "samplemanager_deployment_start",
    "Create a SampleManager deploymentId that correlates SQL, build, deploy, restart, hashes, backups, logs, and rollback evidence.",
    {
      project: z.string().optional(),
      instance: z.string().optional().describe("Optional when the project environment is bound to a LIMS instance."),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      label: z.string().optional(),
    },
    async ({ project: projectName, instance, environment, serverId, serverName, label }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const target = getSampleManagerTarget(projectName, environment, instance, undefined, { serverId, serverName });
      const { ps, instanceName } = target;
      const run = startDeployment({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        environment: ps.environment,
        host: ps.server.host || ps.server.agentId || ps.server.name,
        kind: "samplemanager-assembly",
        instance: instanceName,
        target: deploymentTarget(target),
        steps: [],
        artifacts: label ? { label } : {},
        rollbackRequested: false,
      });
      return { structuredContent: { ...run }, content: [{ type: "text", text: summarizeJson({ deploymentId: run.id, status: run.status, target: run.target }) }] };
    }
  );

  server.tool(
    "samplemanager_restart_instance",
    "Restart a SampleManager instance on a linked Windows server and stop stuck client task hosts",
    {
      project: z.string().optional(),
      instance: z.string().optional().describe("Optional when the project environment is bound to a LIMS instance."),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      deploymentId: z.string().optional(),
      async: z.boolean().optional().describe("Run as an async job and return a jobId; default true."),
    },
    async ({ project: projectName, instance, environment, serverId, serverName, deploymentId, async = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const connection = getSampleManagerTarget(projectName, environment, instance, undefined, { serverId, serverName });
      const { runner, instance: target, instanceName } = connection;
      const work = (context?: JobContext) => withDeploymentStep(
        deploymentId,
        resolvedProjectName,
        "restart",
        () => restartSampleManagerInstance(runner, target, executionForJob(context)),
        { connection, instanceName }
      );
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_restart_instance", { instance: instanceName, environment: connection.ps.environment, serverId: connection.ps.server.id, projectServerId: connection.ps.id, deploymentId }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, deploymentId, status: job.status, target: deploymentTarget(connection) }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_clear_form_cache",
    "Recursively clear and verify compiled FormsBin cache entries for one exact SampleManager form identity, including Translation subdirectories.",
    {
      project: z.string().optional(),
      instance: z.string().optional().describe("Optional when the project environment is bound to a LIMS instance."),
      formName: z.string(),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      deploymentId: z.string().optional().describe("Correlate cache cleanup with a running deployment."),
      async: z.boolean().optional().describe("Run as an async tracked job and return a jobId; default true."),
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ project: projectName, instance, formName, environment, serverId, serverName, deploymentId, async = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const connection = getSampleManagerTarget(projectName, environment, instance, undefined, { serverId, serverName });
      const { runner, instance: target, instanceName } = connection;
      const work = (context?: JobContext) => withDeploymentStep(
        deploymentId,
        resolvedProjectName,
        `clear-form-cache:${formName}`,
        () => clearFormCache(runner, target, formName, executionForJob(context)),
        { connection, instanceName }
      );
      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "samplemanager_clear_form_cache",
        instance: instanceName,
        formName,
        environment: connection.ps.environment,
        serverId: connection.ps.server.id,
        projectServerId: connection.ps.id,
        deploymentId,
        async,
      });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_clear_form_cache", {
          instance: instanceName,
          formName,
          environment: connection.ps.environment,
          serverId: connection.ps.server.id,
          projectServerId: connection.ps.id,
          deploymentId,
        }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, deploymentId, status: job.status, target: deploymentTarget(connection) }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_recent_errors",
    "Search recent SampleManager logs and return a compact error-focused result",
    {
      project: z.string().optional(),
      instance: z.string().optional().describe("Optional when the project environment is bound to a LIMS instance."),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      minutes: z.number().optional(),
      keywords: z.array(z.string()).optional(),
    },
    async ({ project: projectName, instance, environment, serverId, serverName, minutes = 30, keywords }) => {
      const { runner, instance: target } = getSampleManagerTarget(projectName, environment, instance, undefined, { serverId, serverName });
      return { content: [{ type: "text", text: await recentErrors(runner, target, minutes, keywords) }] };
    }
  );

  server.tool(
    "samplemanager_table_schema",
    "Return SQL Server column, type, primary key, identity, computed, default, and physical mapping metadata for a SampleManager table.",
    {
      project: z.string().optional(),
      database: z.string().optional().describe("Optional when the bound LIMS instance has a configured database."),
      table: z.string().describe("Table name, optionally schema-qualified, e.g. dbo.TEST_INSTRUMENT_USAGE_RECORD"),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
    },
    async ({ project: projectName, database, table, environment, serverId, serverName }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const target = getSampleManagerDatabaseTarget(projectName, environment, database, { serverId, serverName });
      const { runner, database: targetDatabase, databaseHost, ps } = target;
      const queryId = `schema-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const startedAt = new Date().toISOString();
      const baseProvenance = {
        queryId,
        project: resolvedProjectName,
        environment: ps.environment,
        projectServerId: ps.id,
        serverId: ps.server.id,
        serverName: ps.server.name,
        connectionMode: ps.connectionMode,
        agentId: ps.server.agentId,
        instance: target.configuredInstance?.name,
        instanceVersion: target.configuredInstance?.version,
        databaseHost,
        databaseName: targetDatabase,
        table,
        readOnly: true,
        mutationAttempted: false,
        startedAt,
      };
      try {
        const text = await sampleManagerTableSchema(runner, targetDatabase, table, databaseHost);
        const finishedAt = new Date().toISOString();
        const artifact = persistQueryArtifact({ queryId, rawResponse: text, provenance: { ...baseProvenance, finishedAt, ownerUserId: user.id } });
        let raw: Record<string, unknown>;
        try {
          const parsed = JSON.parse(text) as unknown;
          raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        } catch {
          raw = {};
        }
        const schemaRows = Array.isArray(raw.columns) ? raw.columns : [];
        const schemaColumns = schemaRows.length && typeof schemaRows[0] === "object" && schemaRows[0] !== null
          ? Object.keys(schemaRows[0] as Record<string, unknown>)
          : [];
        const response = {
          queryId,
          provenance: { ...baseProvenance, finishedAt, connection: raw.connection ?? null },
          queryMetadata: { ...baseProvenance, finishedAt, connection: raw.connection ?? null },
          page: { offset: 0, maxRows: schemaRows.length, rowCount: schemaRows.length, rowsReturned: schemaRows.length, nextOffset: null, hasMore: false, truncated: false, resultSetCount: 1 },
          artifact,
          result: {
            ok: Boolean(raw.qualifiedTable),
            errorKind: raw.qualifiedTable ? null : "result_parse",
            connection: raw.connection ?? null,
            columns: schemaColumns,
            rows: schemaRows,
            rowCount: schemaRows.length,
            rowsReturned: schemaRows.length,
            hasMore: false,
            continuationToken: undefined,
            resultSetCount: 1,
            resultSets: [{ name: "schema", columns: schemaColumns, rows: schemaRows, rowCount: schemaRows.length, rowsReturned: schemaRows.length, hasMore: false, nextOffset: null }],
            schema: { requestedTable: raw.requestedTable ?? table, qualifiedTable: raw.qualifiedTable ?? null, objectId: raw.objectId ?? null, mapping: raw.mapping ?? null },
            error: raw.qualifiedTable ? null : "Schema response did not contain a qualifiedTable",
            sqlErrors: [],
            transportError: null,
          },
        };
        writeAudit({ userId: user.id, username: user.username, tool: "samplemanager_table_schema", ...baseProvenance, finishedAt, artifactPath: artifact.path, artifactBytes: artifact.bytes, artifactSha256: artifact.sha256, connection: raw.connection ?? null, rowCount: schemaRows.length });
        return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ queryId, provenance: response.provenance, page: response.page, result: { ...response.result, rows: undefined }, artifact }) }] };
      } catch (error) {
        const finishedAt = new Date().toISOString();
        const classified = classifyRemoteError(error);
        const message = classified.message;
        const errorKind = classified.category;
        const rawResponse = JSON.stringify({ ok: false, errorKind, error: message });
        const artifact = persistQueryArtifact({ queryId, rawResponse, provenance: { ...baseProvenance, finishedAt, ownerUserId: user.id } });
        const response = {
          queryId,
          provenance: { ...baseProvenance, finishedAt },
          queryMetadata: { ...baseProvenance, finishedAt },
          page: { offset: 0, maxRows: 0, rowCount: 0, rowsReturned: 0, nextOffset: null, hasMore: false, truncated: false, resultSetCount: 0 },
          artifact,
          result: { ok: false, errorKind, columns: [], rows: [], rowCount: 0, rowsReturned: 0, hasMore: false, continuationToken: undefined, resultSetCount: 0, resultSets: [], schema: null, error: message, sqlErrors: [], transportError: { message } },
        };
        writeAudit({ userId: user.id, username: user.username, tool: "samplemanager_table_schema", ...baseProvenance, finishedAt, errorKind, error: message, artifactPath: artifact.path, artifactBytes: artifact.bytes, artifactSha256: artifact.sha256 });
        return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ queryId, provenance: response.provenance, result: response.result, artifact }) }] };
      }
    }
  );

  server.tool(
    "samplemanager_read_query_artifact",
    "Read a bounded page of a persisted SampleManager SQL response without re-running the query.",
    {
      queryId: z.string().describe("queryId returned by samplemanager_sql_query"),
      offset: z.number().int().nonnegative().optional().describe("Character offset; use page.nextOffset for the next page."),
      maxCharacters: z.number().int().min(1000).max(1000000).optional().describe("Maximum response characters; default 100000."),
    },
    async ({ queryId, offset, maxCharacters }) => {
      const artifact = readQueryArtifact(queryId, { offset, maxCharacters });
      if (Number(artifact.provenance.ownerUserId) !== user.id) {
        throw new Error(`Query artifact '${queryId}' not found`);
      }
      const response = {
        queryId: artifact.queryId,
        artifact: {
          path: artifact.path,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          createdAt: artifact.createdAt,
          rawResponseSha256: artifact.rawResponseSha256,
        },
        provenance: Object.fromEntries(Object.entries(artifact.provenance).filter(([key]) => key !== "ownerUserId")),
        rawResponse: artifact.rawResponse,
        rawResponseLength: artifact.rawResponseLength,
        page: artifact.page,
      };
      writeAudit({ userId: user.id, username: user.username, tool: "samplemanager_read_query_artifact", queryId, offset: artifact.page.offset, maxCharacters: artifact.page.maxCharacters, artifactPath: artifact.path, artifactSha256: artifact.sha256, readOnly: true, mutationAttempted: false });
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ ...response, rawResponse: undefined }) }] };
    },
  );

  server.tool(
    "samplemanager_sql_query",
    "Run a compact SQL query against a SampleManager SQL Server database. Read-only by default.",
    {
      project: z.string().optional(),
      database: z.string().optional().describe("Optional when the bound LIMS instance has a configured database."),
      sql: z.string(),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      allowMutation: z.boolean().optional(),
      maxRows: z.number().optional().describe("Maximum rows returned per result set, capped at 1000. Default 100."),
      offset: z.number().int().nonnegative().optional().describe("Zero-based result row offset for pagination. Use nextOffset from the previous response."),
      includeResultSets: z.boolean().optional().describe("Include full resultSets payload. Default false."),
      resultSet: z.union([z.string(), z.number().int().nonnegative()]).optional().describe("Return only one named result set or zero-based result-set index."),
      parameters: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Named SQL parameters without '@', referenced as @name in SQL."),
      identifiers: z.record(z.string()).optional().describe("Identifiers substituted into {{name}} placeholders and escaped with SQL Server brackets."),
      async: z.boolean().optional().describe("Run as a tracked job; recommended for long-running queries. Default false."),
    },
    async ({ project: projectName, database, sql, environment, serverId, serverName, allowMutation = false, maxRows, offset, includeResultSets, resultSet, parameters, identifiers, async: runAsync = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const target = getSampleManagerDatabaseTarget(projectName, environment, database, { serverId, serverName });
      const { runner, database: targetDatabase, databaseHost, configuredInstance, ps } = target;
      const queryId = `query-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const mutationAttempted = allowMutation && sqlContainsMutation(sql);
      const baseProvenance = {
        queryId,
        project: resolvedProjectName,
        environment: ps.environment,
        serverId: ps.server.id,
        serverName: ps.server.name,
        connectionMode: ps.connectionMode,
        agentId: ps.server.agentId,
        instance: configuredInstance?.name,
        instanceVersion: configuredInstance?.version,
        databaseHost,
        databaseName: targetDatabase,
        readOnly: !allowMutation,
        mutationAttempted,
      };
      const execute = async (context?: JobContext): Promise<string> => {
        const startedAt = new Date().toISOString();
        const provenance = { ...baseProvenance, startedAt };
        try {
          context?.phase("querying");
          // Full result sets are collected only when the caller requests them or
          // needs a named result set. The default path keeps the remote payload small.
          const text = await runSql(runner, targetDatabase, sql, {
            allowMutation,
            maxRows,
            offset,
            includeResultSets: Boolean(includeResultSets || resultSet !== undefined),
            preserveFullResponse: true,
            parameters,
            identifiers,
            databaseHost,
          });
          const finishedAt = new Date().toISOString();
          const artifact = persistQueryArtifact({
            queryId,
            rawResponse: text,
            provenance: { ...provenance, finishedAt, ownerUserId: user.id },
          });
          let raw: Record<string, unknown>;
          let parseError: string | undefined;
          try {
            const parsed = JSON.parse(text) as unknown;
            raw = parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? parsed as Record<string, unknown>
              : { rawResponse: text };
            if (raw.ok === undefined) parseError = "SQL response JSON did not contain an ok field";
          } catch {
            raw = { rawResponse: text };
            parseError = "SQL response was not valid JSON";
          }
          const page = {
            offset: Number(offset ?? 0),
            maxRows: Number(maxRows ?? 100),
            rowCount: raw.rowCount ?? 0,
            rowsReturned: raw.rowsReturned ?? 0,
            nextOffset: raw.nextOffset ?? null,
            hasMore: Boolean(raw.hasMore),
            truncated: Boolean(raw.truncated),
            resultSetCount: Number(raw.resultSetCount ?? 0),
          };
          const allResultSets = Array.isArray(raw.resultSets) ? raw.resultSets : [];
          let selectedResultSets = includeResultSets ? allResultSets : allResultSets.slice(0, 1);
          if (resultSet !== undefined) {
            const labelOf = (item: any) => String(item?.name ?? item?.label ?? item?.rows?.[0]?.__relay_phase ?? "");
            const selected = typeof resultSet === "number"
              ? allResultSets[resultSet]
              : allResultSets.find((item: any) => labelOf(item).toLowerCase() === String(resultSet).toLowerCase());
            if (!selected) {
              throw new Error(`Result set '${String(resultSet)}' was not found; available indexes: ${allResultSets.map((_item: unknown, index: number) => index).join(", ")}; available labels: ${allResultSets.map((item: any, index: number) => `${index}:${labelOf(item) || "unnamed"}`).join(", ")}`);
            }
            selectedResultSets = [selected];
          }
          const selectedResult = selectedResultSets.length > 0
            ? selectedResultSets
            : (Array.isArray(raw.rows) ? [{ columns: raw.rows[0] && typeof raw.rows[0] === "object" ? Object.keys(raw.rows[0] as Record<string, unknown>) : [], rows: raw.rows, rowCount: raw.rowCount, rowsReturned: raw.rowsReturned, offset: raw.offset, hasMore: raw.hasMore, nextOffset: raw.nextOffset, truncated: raw.truncated }] : []);
          const continuationToken = selectedResult.some((item: any) => item?.hasMore)
            ? Buffer.from(JSON.stringify({ queryId, resultSet: resultSet ?? null, offset: selectedResult[0]?.nextOffset ?? null }), "utf8").toString("base64url")
            : undefined;
          const response = {
            queryId,
            provenance: { ...provenance, finishedAt },
            queryMetadata: { ...provenance, finishedAt, connection: raw.connection ?? null },
            page,
            artifact,
            result: {
              ok: raw.ok === true,
              errorKind: parseError ? "result_parse" : raw.ok === false ? "sql" : null,
              connection: raw.connection ?? null,
              columns: selectedResult[0]?.columns ?? [],
              rows: selectedResult[0]?.rows ?? [],
              rowCount: selectedResult[0]?.rowCount ?? 0,
              rowsReturned: selectedResult[0]?.rowsReturned ?? 0,
              hasMore: Boolean(selectedResult.some((item: any) => item?.hasMore)),
              continuationToken,
              resultSetCount: page.resultSetCount || allResultSets.length,
              resultSets: (includeResultSets || resultSet !== undefined) ? selectedResult : undefined,
              recordsAffected: raw.recordsAffected,
              error: raw.error ?? parseError ?? null,
              sqlErrors: Array.isArray(raw.sqlErrors) ? raw.sqlErrors : [],
              transportError: null,
            },
          };
          writeAudit({
            userId: user.id,
            username: user.username,
            project: resolvedProjectName,
            tool: "samplemanager_sql_query",
            database: targetDatabase,
            databaseHost,
            allowMutation,
            maxRows,
            offset,
            includeResultSets: Boolean(includeResultSets),
            resultSet,
            parameterNames: Object.keys(parameters ?? {}),
            identifiers,
            queryId,
            startedAt,
            finishedAt,
            artifactPath: artifact.path,
            artifactBytes: artifact.bytes,
            artifactSha256: artifact.sha256,
            mutationAttempted,
            errorKind: response.result.errorKind,
          });
          context?.phase("completed");
          return JSON.stringify(response);
        } catch (error) {
          const finishedAt = new Date().toISOString();
          const classified = classifyRemoteError(error);
          const message = classified.message;
          const category = classified.category;
          const errorKind = classified.category;
          const artifact = persistQueryArtifact({
            queryId,
            rawResponse: JSON.stringify({ ok: false, errorKind, transportError: { category, message } }),
            provenance: { ...provenance, finishedAt, ownerUserId: user.id },
          });
          const response = {
            queryId,
            provenance: { ...provenance, finishedAt },
            queryMetadata: { ...provenance, finishedAt },
            page: { offset: Number(offset ?? 0), maxRows: Number(maxRows ?? 100), rowCount: 0, rowsReturned: 0, nextOffset: null, hasMore: false, truncated: false, resultSetCount: 0 },
            artifact,
            result: {
              ok: false,
              errorKind,
              columns: [],
              rows: [],
              rowCount: 0,
              rowsReturned: 0,
              hasMore: false,
              continuationToken: undefined,
              resultSetCount: 0,
              sqlErrors: [],
              transportError: { category, message },
              error: message,
            },
          };
          writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_sql_query", database: targetDatabase, databaseHost, queryId, startedAt, finishedAt, errorKind, error: message, artifactPath: artifact.path, artifactBytes: artifact.bytes, artifactSha256: artifact.sha256, mutationAttempted });
          if (context) {
            const jobError = new Error(`SQL query '${queryId}' failed (${errorKind}); artifact=${artifact.path}; ${message}`) as Error & { category?: string };
            jobError.category = category;
            throw jobError;
          }
          return JSON.stringify(response);
        }
      };
      if (runAsync) {
        const job = startJob(user, resolvedProjectName, "samplemanager_sql_query", { ...baseProvenance, sqlLength: sql.length, maxRows, offset, includeResultSets, resultSet }, execute);
        return { structuredContent: { jobId: job.id, queryId, status: job.status, target: baseProvenance }, content: [{ type: "text", text: summarizeJson({ jobId: job.id, queryId, status: job.status, target: baseProvenance }) }] };
      }
      const response = JSON.parse(await execute()) as Record<string, unknown>;
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson({ queryId, provenance: response.provenance, page: response.page, result: response.result, artifact: response.artifact }) }] };
    }
  );

  server.tool(
    "samplemanager_sql_execute_file",
    "Run a SQL file from the relay project workspace against a SampleManager SQL Server database. Mutations require allowMutation=true.",
    {
      project: z.string().optional(),
      database: z.string().optional().describe("Optional when the bound LIMS instance has a configured database."),
      path: z.string().describe("Relative SQL file path within the relay project workspace"),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      allowMutation: z.boolean().optional(),
      maxRows: z.number().optional().describe("Maximum rows returned per result set, capped at 1000. Default 100."),
      offset: z.number().int().nonnegative().optional().describe("Zero-based result row offset for pagination. Use nextOffset from the previous response."),
      includeResultSets: z.boolean().optional().describe("Include full resultSets payload. Default false."),
      parameters: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Named SQL parameters without '@', referenced as @name in SQL."),
      identifiers: z.record(z.string()).optional().describe("Identifiers substituted into {{name}} placeholders and escaped with SQL Server brackets."),
    },
    async ({ project: projectName, database, path: relPath, environment, serverId, serverName, allowMutation = false, maxRows, offset, includeResultSets, parameters, identifiers }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const project = registry.getProject(user.id, resolvedProjectName);
      if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);

      const fullPath = resolveWorkspacePath(project.workspacePath, relPath, { mustExist: true });
      if (!existsSync(fullPath)) {
        throw new Error(`SQL file '${relPath}' does not exist in project '${resolvedProjectName}'`);
      }

      const { runner, database: targetDatabase, databaseHost, ps } = getSampleManagerDatabaseTarget(projectName, environment, database, { serverId, serverName });
      const sql = readFileSync(fullPath, "utf8");
      const text = await runSql(runner, targetDatabase, sql, { allowMutation, maxRows, offset, includeResultSets, parameters, identifiers, databaseHost });
      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "samplemanager_sql_execute_file",
        database: targetDatabase,
        databaseHost,
        serverId: ps.server.id,
        projectServerId: ps.id,
        path: relPath,
        allowMutation,
        maxRows,
        offset,
        includeResultSets,
        parameterNames: Object.keys(parameters ?? {}),
        identifiers,
      });
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "samplemanager_run_command",
    "Run SampleManagerCommand.exe from the instance Exe folder with structured arguments.",
    {
      project: z.string().optional(),
      instance: z.string().optional().describe("Optional when the project environment is bound to a LIMS instance."),
      username: z.string().describe("SampleManager username used by SampleManagerCommand.exe"),
      task: z.string().describe("SampleManager command task, e.g. VGL"),
      args: z.array(z.string()).optional().describe("Additional arguments, e.g. ['-report', '$table_loader', '-prompts', '(C:\\\\file.csv,overwrite_table)']"),
      environment: z.string().optional(),
      timeoutMs: z.number().optional().describe("Command timeout in milliseconds. Default 120000."),
      async: z.boolean().optional().describe("Run as an async job and return a jobId."),
    },
    async ({
      project: projectName,
      instance,
      username,
      task,
      args = [],
      environment,
      timeoutMs = 120000,
      async = false,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner, instance: target, instanceName } = getSampleManagerTarget(projectName, environment, instance);
      const work = (context?: JobContext) => runSampleManagerCommand(runner, target, {
        username,
        task,
        args,
        timeoutMs,
        execution: executionForJob(context),
      });
      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "samplemanager_run_command",
        instance: instanceName,
        commandUsername: username,
        task,
        async,
      });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_run_command", { instance: instanceName, username, task, args, environment }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_create_entity_definition",
    "Run CreateEntityDefinition.exe for a SampleManager instance after controlled structure source changes.",
    {
      project: z.string().optional(),
      instance: z.string().optional().describe("Optional when the project environment is bound to a LIMS instance."),
      environment: z.string().optional(),
      timeoutMs: z.number().positive().optional().describe("Default 600000"),
      async: z.boolean().optional().describe("Run as an async job; recommended"),
    },
    async ({ project: projectName, instance, environment, timeoutMs = 600000, async = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner, instance: target, instanceName } = getSampleManagerTarget(projectName, environment, instance);
      const work = (context?: JobContext) => createEntityDefinition(
        runner,
        target,
        timeoutMs,
        executionForJob(context)
      );
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_create_entity_definition", instance: instanceName, async });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_create_entity_definition", { instance: instanceName, environment, timeoutMs }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_convert_tables",
    "Run convert_table.exe once per SampleManager table using structured, validated table names.",
    {
      project: z.string().optional(),
      instance: z.string().optional().describe("Optional when the project environment is bound to a LIMS instance."),
      tables: z.array(z.string()).min(1),
      environment: z.string().optional(),
      timeoutMs: z.number().positive().optional().describe("Timeout per table; default 600000"),
      async: z.boolean().optional().describe("Run as an async job; recommended"),
    },
    async ({ project: projectName, instance, tables, environment, timeoutMs = 600000, async = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner, instance: target, instanceName } = getSampleManagerTarget(projectName, environment, instance);
      const work = (context?: JobContext) => convertSampleManagerTables(
        runner,
        target,
        tables,
        timeoutMs,
        executionForJob(context)
      );
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_convert_tables", instance: instanceName, tables, async });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_convert_tables", { instance: instanceName, tables, environment, timeoutMs }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_table_loader",
    "Load a remote table-loader CSV through SampleManagerCommand.exe and the built-in $table_loader VGL report.",
    {
      project: z.string().optional(),
      instance: z.string().optional().describe("Optional when the project environment is bound to a LIMS instance."),
      username: z.string(),
      remoteCsvPath: z.string(),
      mode: z.string().optional().describe("Table-loader mode; default overwrite_table"),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      deploymentId: z.string().optional().describe("Correlate upload, load, verification, and audit evidence."),
      timeoutMs: z.number().positive().optional().describe("Default 300000"),
      async: z.boolean().optional().describe("Run as an async job; recommended"),
    },
    async ({
      project: projectName,
      instance,
      username,
      remoteCsvPath,
      mode = "overwrite_table",
      environment,
      serverId,
      serverName,
      deploymentId,
      timeoutMs = 300000,
      async = true,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const connection = getSampleManagerTarget(projectName, environment, instance, undefined, { serverId, serverName });
      const { runner, instance: target, instanceName } = connection;
      const work = (context?: JobContext) => withDeploymentStep(
        deploymentId,
        resolvedProjectName,
        `table-loader:${remoteCsvPath}`,
        () => loadTableLoaderFile(
          runner,
          target,
          username,
          remoteCsvPath,
          mode,
          timeoutMs,
          executionForJob(context)
        ),
        { connection, instanceName }
      );
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_table_loader", environment: connection.ps.environment, serverId: connection.ps.server.id, projectServerId: connection.ps.id, instance: instanceName, remoteCsvPath, mode, deploymentId, async, mutationAttempted: true, mutationKind: "data" });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_table_loader", { instance: instanceName, username, remoteCsvPath, mode, environment: connection.ps.environment, serverId: connection.ps.server.id, projectServerId: connection.ps.id, deploymentId, timeoutMs }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, deploymentId, status: job.status, target: deploymentTarget(connection) }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_deploy_table_loader_package",
    "Upload, hash-verify, preflight, optionally back up, and sequentially load table-loader CSV files under one deploymentId.",
    {
      project: z.string().optional(),
      instance: z.string().optional(),
      username: z.string(),
      files: z.array(z.object({
        workspacePath: z.string().describe("Relative file path in the Relay workspace"),
        remotePath: z.string().optional().describe("Optional remote path; defaults to the stable Relay staging directory"),
        mode: z.string().optional().describe("Table-loader mode; default overwrite_table"),
      })).min(1),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      deploymentId: z.string().optional().describe("Existing deploymentId. If omitted, one is created."),
      backupSql: z.string().optional().describe("Optional explicit backup SQL supplied by the caller; executed as a mutation and recorded."),
      verifySql: z.string().optional().describe("Optional verification SQL executed after all loads."),
      timeoutMs: z.number().positive().optional().describe("Timeout per upload/load step; default 300000"),
      async: z.boolean().optional().describe("Return a jobId immediately; default true"),
    },
    async ({
      project: projectName,
      instance,
      username,
      files,
      environment,
      serverId,
      serverName,
      deploymentId: requestedDeploymentId,
      backupSql,
      verifySql,
      timeoutMs = 300000,
      async = true,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const connection = getSampleManagerTarget(projectName, environment, instance, undefined, { serverId, serverName });
      const { project, ps, runner, instance: target, instanceName } = connection;
      const run = requestedDeploymentId
        ? requireRunningDeployment(requestedDeploymentId, {
            userId: user.id,
            project: resolvedProjectName,
            environment: ps.environment,
            instance: instanceName,
            projectServerId: ps.id,
            serverId: ps.server.id,
            databaseHost: connection.configuredInstance?.databaseHost,
            databaseName: connection.configuredInstance?.databaseName,
          })
        : startDeployment({
            userId: user.id,
            username: user.username,
            project: resolvedProjectName,
            environment: ps.environment,
            host: ps.server.host || ps.server.agentId || ps.server.name,
            kind: "samplemanager-assembly",
            instance: instanceName,
            target: deploymentTarget(connection),
            rollbackRequested: false,
          });
      if (!run || run.userId !== user.id || run.project !== resolvedProjectName) {
        throw new Error(`Deployment '${requestedDeploymentId}' was not found for project '${resolvedProjectName}'`);
      }
      const work = async (context?: JobContext) => {
        try {
          const results: Array<Record<string, unknown>> = [];
        const stagingRoot = ps.server.os === "windows"
          ? `C:\\ProgramData\\RelayMcpAgent\\staging\\${run.id}`
          : `/var/lib/relay-mcp/staging/${run.id}`;
        const stage = async (file: typeof files[number], index: number) => {
          const fullLocal = resolveWorkspacePath(project.workspacePath, file.workspacePath, { mustExist: true });
          const localStat = statSync(fullLocal);
          if (!localStat.isFile()) throw new Error(`Workspace path is not a file: ${file.workspacePath}`);
          const localHash = createHash("sha256");
          for await (const chunk of createReadStream(fullLocal)) localHash.update(chunk);
          const localSha256 = localHash.digest("hex");
          const remotePath = file.remotePath ?? `${stagingRoot}${ps.server.os === "windows" ? "\\" : "/"}${index.toString().padStart(3, "0")}-${basename(fullLocal)}`;
          if (basename(fullLocal).toLowerCase().endsWith(".csv")) {
            const sample = readFileSync(fullLocal).subarray(0, Math.min(localStat.size, 64 * 1024));
            if (sample.includes(0)) throw new Error(`CSV preflight failed: ${file.workspacePath} contains NUL bytes`);
          }
          await withDeploymentStep(run.id, resolvedProjectName, `stage:${file.workspacePath}`, async () => {
            await runner.uploadFile(fullLocal, remotePath);
            const hashResult = ps.server.os === "windows"
              ? await runner.execPowerShell(`[Console]::Write((Get-FileHash -LiteralPath ${quotePowerShell(remotePath)} -Algorithm SHA256).Hash.ToLowerInvariant())`, 60000, executionForJob(context))
              : await runner.exec(`sha256sum -- ${quotePosix(remotePath)} | awk '{print $1}'`, 60000, executionForJob(context));
            ensureRemoteSuccess(hashResult);
            const remoteSha256 = hashResult.stdout.trim().toLowerCase();
            if (remoteSha256 !== localSha256) throw new Error(`SHA-256 mismatch for ${file.workspacePath}: local=${localSha256}, remote=${remoteSha256}`);
          }, { connection, instanceName });
          return { workspacePath: file.workspacePath, remotePath, bytes: localStat.size, localSha256 };
        };
        if (backupSql) {
          await withDeploymentStep(run.id, resolvedProjectName, "backup", async () => {
            const databaseTarget = getSampleManagerDatabaseTarget(projectName, environment, undefined, { serverId: ps.server.id });
            const result = await runSql(runner, databaseTarget.database, backupSql, { allowMutation: true, includeResultSets: false, databaseHost: databaseTarget.databaseHost });
            writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_deploy_table_loader_package", deploymentId: run.id, mutationAttempted: true, mutationKind: "schema-or-data", phase: "backup" });
            return result;
          }, { connection, instanceName });
        }
        for (let index = 0; index < files.length; index++) {
          const staged = await stage(files[index], index);
          const loaded = await withDeploymentStep(run.id, resolvedProjectName, `load:${files[index].workspacePath}`, () => loadTableLoaderFile(runner, target, username, staged.remotePath, files[index].mode ?? "overwrite_table", timeoutMs, executionForJob(context)), { connection, instanceName });
          results.push({ ...staged, mode: files[index].mode ?? "overwrite_table", load: loaded });
        }
        let verification: unknown;
        if (verifySql) {
          const dbTarget = getSampleManagerDatabaseTarget(projectName, environment, undefined, { serverId: ps.server.id });
          verification = await withDeploymentStep(run.id, resolvedProjectName, "verify", () => runSql(dbTarget.runner, dbTarget.database, verifySql, { allowMutation: false, includeResultSets: true, databaseHost: dbTarget.databaseHost }), { connection, instanceName });
        }
        updateDeployment(run.id, { artifacts: { files: results, stagingRoot, verification, backupSqlProvided: Boolean(backupSql) } });
        finishDeployment(run.id, { status: "succeeded", rollback: run.rollback, artifacts: { files: results, stagingRoot, verification, backupSqlProvided: Boolean(backupSql) } });
          return summarizeJson({ deploymentId: run.id, stagingRoot, files: results, verification });
        } catch (error) {
          const disposition = deploymentFailureDisposition(error, {
            rollbackRequested: false,
            backupAvailable: false,
          });
          updateDeployment(run.id, {
            status: disposition.status,
            error: error instanceof Error ? error.message : String(error),
            recommendedResumeAction: disposition.status === "unknown"
              ? "Remote completion is unknown. Inspect the current deployment step and target state before retrying."
              : undefined,
          });
          throw error;
        }
      };
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_deploy_table_loader_package", { instance: instanceName, username, files, environment: ps.environment, serverId: ps.server.id, projectServerId: ps.id, deploymentId: run.id, timeoutMs }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, deploymentId: run.id, status: job.status, target: deploymentTarget(connection) }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_run_utility",
    "Run an allowlisted SampleManager utility with structured arguments. Use dedicated tools for CreateEntityDefinition and convert_table.",
    {
      project: z.string().optional(),
      instance: z.string().optional().describe("Optional when the project environment is bound to a LIMS instance."),
      utility: z.enum(["FormImport.exe", "BuildFormDefinition.exe", "DeployPackageTask.exe"]),
      args: z.array(z.string()).optional(),
      environment: z.string().optional(),
      timeoutMs: z.number().positive().optional().describe("Default 300000"),
      async: z.boolean().optional().describe("Run as an async job"),
    },
    async ({ project: projectName, instance, utility, args = [], environment, timeoutMs = 300000, async = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner, instance: target, instanceName } = getSampleManagerTarget(projectName, environment, instance);
      const work = (context?: JobContext) => runSampleManagerUtility(runner, target, utility, {
        args,
        timeoutMs,
        execution: executionForJob(context),
      });
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_run_utility", instance: instanceName, utility, args, async });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_run_utility", { instance: instanceName, utility, args, environment, timeoutMs }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_discover_build_tools",
    "Discover compatible MSBuild installations in VS2022, VS2019, .NET Framework, then PATH priority order.",
    {
      project: z.string().optional(),
      environment: z.string().optional(),
    },
    async ({ project: projectName, environment }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner } = getRunner(projectName, environment);
      const text = await discoverBuildTools(runner);
      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "samplemanager_discover_build_tools",
      });
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "samplemanager_sql_mutation",
    "Run a structured parameterized SQL mutation with before/after result sets, dry-run rollback, and optional backup table.",
    {
      project: z.string().optional(),
      database: z.string().optional().describe("Optional when the bound LIMS instance has a configured database."),
      operation: z.enum(["insert", "update", "delete"]),
      table: z.string().describe("Schema-qualified table name when possible"),
      values: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      where: z.string().optional().describe("Single SQL predicate without WHERE keyword; required for update/delete"),
      parameters: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      dryRun: z.boolean().optional().describe("Execute inside a transaction and roll back. Default true."),
      createBackup: z.boolean().optional().describe("Create a timestamped RELAY_BACKUP table before update/delete. Default true."),
      maxRows: z.number().int().positive().max(1000).optional(),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      deploymentId: z.string().optional(),
    },
    async ({
      project: projectName,
      database,
      operation,
      table,
      values,
      where,
      parameters,
      dryRun = true,
      createBackup = true,
      maxRows,
      environment,
      serverId,
      serverName,
      deploymentId,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const target = getSampleManagerDatabaseTarget(projectName, environment, database, { serverId, serverName });
      const { runner, database: targetDatabase, databaseHost, ps, configuredInstance } = target;
      const text = await withDeploymentStep(
        deploymentId,
        resolvedProjectName,
        `sql:${operation}:${table}`,
        () => runSqlMutation(runner, targetDatabase, {
          operation,
          table,
          values,
          where,
          parameters,
          dryRun,
          createBackup,
          maxRows,
          databaseHost,
        })
        ,
        configuredInstance ? { connection: target, instanceName: configuredInstance.name } : undefined
      );
      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "samplemanager_sql_mutation",
        database: targetDatabase,
        databaseHost,
        serverId: ps.server.id,
        projectServerId: ps.id,
        operation,
        table,
        where,
        valueColumns: Object.keys(values ?? {}),
        parameterNames: Object.keys(parameters ?? {}),
        dryRun,
        createBackup,
        deploymentId,
        mutationAttempted: true,
        mutationKind: dryRun ? "transactional-data" : "data",
      });
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "samplemanager_apply_change_set",
    "Apply multiple SQL changes atomically with dry-run, rollback, verification, idempotency, and deployment recovery state.",
    {
      project: z.string().optional(),
      database: z.string().optional(),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      deploymentId: z.string().optional(),
      expectedInstance: z.string().min(1).max(256).optional().describe("Abort unless the selected LIMS instance has this exact name."),
      expectedDatabaseHost: z.string().min(1).max(512).optional().describe("Abort unless the resolved database host matches exactly."),
      expectedDatabase: z.string().min(1).max(256).optional().describe("Abort unless the resolved database name matches exactly."),
      expectedLabMethodId: z.string().min(1).max(512).optional().describe("Assert that dbo.LAB_METHOD contains this identity before changes."),
      expectedLabMethodVersion: z.string().min(1).max(512).optional().describe("Optional Lab Method version paired with expectedLabMethodId."),
      dryRun: z.boolean().optional().describe("Execute and roll back by default. Set false to commit."),
      createBackup: z.boolean().optional(),
      maxRows: z.number().int().positive().max(1000).optional(),
      verifySql: z.string().optional().describe("Read-only verification SQL executed in the same transaction."),
      changes: z.array(z.object({
        idempotencyKey: z.string().min(1).max(200),
        operation: z.enum(["insert", "update", "delete"]),
        table: z.string().min(1),
        values: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
        where: z.string().optional(),
        parameters: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
        readbackKey: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Stable post-mutation primary/composite key for one row. Unlike where, this must describe the row after the change."),
        expectedAffectedRows: z.number().int().nonnegative().max(1_000_000).optional().describe("Abort the transaction unless this mutation changes exactly this many rows."),
      })).min(1).max(50),
    },
    async ({ project: projectName, database, environment, serverId, serverName, deploymentId: requestedDeploymentId, expectedInstance, expectedDatabaseHost, expectedDatabase, expectedLabMethodId, expectedLabMethodVersion, dryRun = true, createBackup = true, maxRows, verifySql, changes }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const target = getSampleManagerDatabaseTarget(projectName, environment, database, { serverId, serverName });
      const actualInstance = target.configuredInstance?.name;
      const assertTarget = (label: string, expected: string | undefined, actual: string | undefined) => {
        if (expected !== undefined && (!actual || actual.localeCompare(expected, undefined, { sensitivity: "accent" }) !== 0)) {
          throw new Error(`Change-set target assertion failed for ${label}: expected '${expected}', resolved '${actual ?? "unspecified"}'`);
        }
      };
      assertTarget("instance", expectedInstance, actualInstance);
      assertTarget("database host", expectedDatabaseHost, target.databaseHost);
      assertTarget("database", expectedDatabase, target.database);
      if (expectedLabMethodVersion !== undefined && expectedLabMethodId === undefined) {
        throw new Error("expectedLabMethodVersion requires expectedLabMethodId");
      }
      const duplicateKeys = changes.map((change) => change.idempotencyKey).filter((key, index, all) => all.indexOf(key) !== index);
      if (duplicateKeys.length) throw new Error(`Duplicate idempotency key(s): ${[...new Set(duplicateKeys)].join(", ")}`);
      let deploymentId = requestedDeploymentId;
      let run = deploymentId ? getDeployment(deploymentId) : undefined;
      if (deploymentId && (!run || run.userId !== user.id || run.project !== resolvedProjectName)) {
        throw new Error(`Deployment '${deploymentId}' not found for project '${resolvedProjectName}'`);
      }
      if (run?.status === "unknown") {
        throw new Error(`Deployment '${run.id}' has unknown execution state. Verify the database and call samplemanager_deployment_status before retrying.`);
      }
      if (run?.status === "running" && target.configuredInstance) {
        run = requireRunningDeployment(run.id, {
          userId: user.id,
          project: resolvedProjectName,
          environment: target.ps.environment,
          instance: target.configuredInstance.name,
          projectServerId: target.ps.id,
          serverId: target.ps.server.id,
          databaseHost: target.databaseHost,
          databaseName: target.database,
        });
      }
      if (!run) {
        run = startDeployment({
          userId: user.id,
          username: user.username,
          project: resolvedProjectName,
          environment: target.ps.environment,
          host: target.ps.server.host || target.ps.server.agentId || target.ps.server.name,
          kind: "samplemanager-change-set",
          instance: target.configuredInstance?.name,
          target: deploymentTarget(target),
          steps: [{ name: "change-set", status: "pending" }, { name: "verify", status: verifySql ? "pending" : "succeeded" }],
          artifacts: { database: target.database, databaseHost: target.databaseHost },
          rollbackRequested: true,
        });
        deploymentId = run.id;
      }

      const existingKeys = run.idempotencyKeys ?? {};
      const runnable = changes.filter((change) => {
        const previous = existingKeys[change.idempotencyKey];
        if (!previous) return true;
        if (previous.status === "succeeded") return false;
        if (previous.status === "unknown" || previous.status === "running") {
          throw new Error(`Idempotency key '${change.idempotencyKey}' has status '${previous.status}'. Verify deployment '${run!.id}' before retrying.`);
        }
        return true;
      });
      const nextKeys = { ...existingKeys };
      for (const change of runnable) nextKeys[change.idempotencyKey] = { status: "running", at: new Date().toISOString() };
      updateDeployment(run.id, {
        status: "running",
        idempotencyKeys: nextKeys,
        pendingPhases: ["change-set", ...(verifySql ? ["verify"] : [])],
        recommendedResumeAction: "Do not retry while execution state is unknown; inspect deployment status and database evidence first.",
      });

      try {
        const resultText = runnable.length === 0
          ? JSON.stringify({ ok: true, skipped: changes.map((change) => change.idempotencyKey), reason: "already_succeeded" })
          : await runSqlChangeSet(target.runner, target.database, runnable, {
            dryRun,
            createBackup,
            maxRows,
            databaseHost: target.databaseHost,
            verifySql,
            assertions: {
              instance: expectedInstance,
              databaseHost: expectedDatabaseHost,
              database: expectedDatabase,
              labMethodId: expectedLabMethodId,
              labMethodVersion: expectedLabMethodVersion,
            },
          });
        const completedAt = new Date().toISOString();
        for (const change of runnable) nextKeys[change.idempotencyKey] = { status: dryRun ? "dry_run" : "succeeded", at: completedAt, result: { dryRun } };
        const committed = dryRun ? (run.committedMutations ?? []) : [...(run.committedMutations ?? []), ...runnable.map((change) => change.idempotencyKey)];
        const dryOnly = dryRun ? [...new Set([...(run.dryRunOnlyMutations ?? []), ...runnable.map((change) => change.idempotencyKey)])] : (run.dryRunOnlyMutations ?? []);
        let changeSetSummary: Record<string, unknown> = { changeCount: runnable.length };
        try {
          const parsed = JSON.parse(resultText) as Record<string, unknown>;
          changeSetSummary = {
            changeCount: parsed.changeCount ?? runnable.length,
            changes: parsed.changes ?? [],
            backupTables: parsed.backupTables ?? [],
            rollback: parsed.rollback ?? null,
            transaction: parsed.transaction ?? (dryRun ? "rolled_back" : "committed"),
            verification: parsed.verification ?? null,
          };
        } catch {
          // Keep the deployment record usable even if a legacy runner returned plain text.
        }
        const verificationFailed = !dryRun
          && typeof changeSetSummary.verification === "object"
          && changeSetSummary.verification !== null
          && (changeSetSummary.verification as Record<string, unknown>).status === "failed";
        const updated = finishDeployment(run.id, {
          status: verificationFailed ? "pending-validation" : "succeeded",
          rollback: { ...run.rollback, status: dryRun ? "not-needed" : "not-needed" },
          idempotencyKeys: nextKeys,
          committedMutations: committed,
          dryRunOnlyMutations: dryOnly,
          lastCompletedPhase: "verify",
          pendingPhases: [],
          failedMutation: undefined,
          recommendedResumeAction: dryRun
            ? "Review dry-run evidence; rerun with the same idempotency keys and dryRun=false to commit."
            : verificationFailed
              ? "The transaction committed, but stable-key readback failed. Inspect the recorded readback evidence; do not repeat the mutation."
              : "No resume required.",
          output: resultText,
          artifacts: { ...(run.artifacts ?? {}), changeCount: changes.length, skipped: changes.length - runnable.length, changeSet: changeSetSummary },
        });
        writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_apply_change_set", deploymentId: run.id, database: target.database, databaseHost: target.databaseHost, dryRun, createBackup, expectedInstance, expectedDatabaseHost, expectedDatabase, expectedLabMethodId, expectedLabMethodVersion, changeCount: changes.length, skipped: changes.length - runnable.length, expectedAffectedRows: runnable.map((change) => ({ idempotencyKey: change.idempotencyKey, expected: change.expectedAffectedRows })), changeSetSummary, mutationAttempted: true });
        return { structuredContent: { ...updated }, content: [{ type: "text", text: summarizeJson({ deploymentId: updated.id, status: updated.status, dryRun, skipped: changes.length - runnable.length, idempotencyKeys: Object.keys(nextKeys) }) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const change of runnable) nextKeys[change.idempotencyKey] = { status: "unknown", at: new Date().toISOString() };
        const failed = finishDeployment(run.id, {
          status: "unknown",
          rollback: { ...run.rollback, status: "failed", error: message },
          idempotencyKeys: nextKeys,
          failedMutation: runnable[0]?.idempotencyKey,
          pendingPhases: ["change-set", ...(verifySql ? ["verify"] : [])],
          recommendedResumeAction: "Inspect database state and deployment evidence before retrying any change.",
          error: message,
        });
        writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_apply_change_set", deploymentId: run.id, status: "unknown", error: message });
        throw new Error(`${message} Deployment '${failed.id}' is unknown; inspect it before retrying.`);
      }
    }
  );

  server.tool(
    "samplemanager_build_dotnet",
    "Build a classic SampleManager .NET project or solution with MSBuild on the linked Windows server.",
    {
      project: z.string().optional(),
      projectOrSolutionPath: z.string(),
      instance: z.string().optional().describe("Optional SampleManager instance used to derive build paths and properties."),
      configuration: z.string().optional().describe("Default Release"),
      msbuildPath: z.string().optional().describe("Optional explicit MSBuild.exe path"),
      msbuildProperties: z.record(z.string()).optional().describe("Additional validated MSBuild properties, passed as /p:name=value."),
      environmentVariables: z.record(z.string()).optional().describe("Nonsecret environment variables applied only to the remote build process. Preconfigure secrets on the target service account."),
      preflightOnly: z.boolean().optional().describe("Validate project, build tool, instance paths, and effective context without running a build."),
      expectedAssemblyPath: z.string().optional().describe("Expected output assembly path reported by preflight."),
      environment: z.string().optional(),
      deploymentId: z.string().optional(),
      timeoutMs: z.number().positive().optional().describe("Default 600000"),
      async: z.boolean().optional().describe("Run as an async job; recommended"),
    },
    async ({
      project: projectName,
      projectOrSolutionPath,
      instance,
      configuration = "Release",
      msbuildPath,
      msbuildProperties,
      environmentVariables,
      preflightOnly = false,
      expectedAssemblyPath,
      environment,
      deploymentId,
      timeoutMs = 600000,
      async: requestedAsync,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const connection = getRunner(projectName, environment);
      const target = instance || connection.ps.limsInstance
        ? getSampleManagerTarget(projectName, environment, instance)
        : undefined;
      const runner = target?.runner ?? connection.runner;
      const buildProfile = target?.configuredInstance?.buildProfile ?? connection.ps.limsInstance?.buildProfile ?? {};
      const instanceTarget = target?.instance;
      const async = requestedAsync ?? !preflightOnly;
      const validatedEnvironmentVariables = validateBuildEnvironmentVariables(environmentVariables);
      const validatedMsbuildProperties = validateBuildMsbuildProperties(msbuildProperties);
      const work = (context?: JobContext) => withDeploymentStep(
        deploymentId,
        resolvedProjectName,
        `${preflightOnly ? "build-preflight" : "build"}:${basename(projectOrSolutionPath)}`,
        () => buildSampleManagerProject(
          runner,
          projectOrSolutionPath,
          configuration,
          msbuildPath,
          buildProfile,
          timeoutMs,
          executionForJob(context),
          { instance: instanceTarget, msbuildProperties: validatedMsbuildProperties, environmentVariables: validatedEnvironmentVariables, preflightOnly, expectedAssemblyPath }
        )
      );
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_build_dotnet", projectOrSolutionPath, instance: target?.instanceName, configuration, msbuildProperties: buildSettingsMetadata(validatedMsbuildProperties), environmentVariables: buildSettingsMetadata(validatedEnvironmentVariables), preflightOnly, async });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_build_dotnet", { projectOrSolutionPath, instance: target?.instanceName, configuration, msbuildPath, msbuildProperties: buildSettingsMetadata(validatedMsbuildProperties), environmentVariables: buildSettingsMetadata(validatedEnvironmentVariables), preflightOnly, expectedAssemblyPath, environment, deploymentId, timeoutMs }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_build_deploy_assembly",
    "Build a .NET project, deploy one assembly with SHA-256 verification and backup, optionally restart the instance, and track every phase under a deploymentId.",
    {
      project: z.string().optional(),
      projectOrSolutionPath: z.string(),
      assemblyPath: z.string().describe("Absolute built DLL path on the linked server"),
      instance: z.string().optional().describe("Optional when the project environment is bound to a LIMS instance."),
      targetRelativePath: z.string().optional().describe("Destination under SolutionAssemblies; defaults to assembly filename"),
      configuration: z.string().optional().describe("Default Release"),
      msbuildPath: z.string().optional(),
      msbuildProperties: z.record(z.string()).optional().describe("Additional validated MSBuild properties, passed as /p:name=value."),
      environmentVariables: z.record(z.string()).optional().describe("Nonsecret environment variables applied only to the remote build process. Preconfigure secrets on the target service account."),
      preflightOnly: z.boolean().optional().describe("Validate build inputs and target context without building, deploying, or restarting."),
      expectedCurrentTargetSha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional().describe("Abort before backup/copy unless the currently deployed DLL has this SHA-256."),
      expectedBuiltAssemblySha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional().describe("Abort before copy unless the newly built DLL has this SHA-256."),
      expectedProjectSha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional().describe("Abort unless the project/solution file matches this source baseline hash."),
      expectedSourceCommit: z.string().regex(/^[A-Fa-f0-9]{7,64}$/).optional().describe("Abort unless the remote source Git HEAD starts with this commit."),
      restart: z.boolean().optional().describe("Restart SampleManager after deploy. Default true."),
      rollbackOnFailure: z.boolean().optional().describe("Restore the timestamped backup if a later phase fails. Default true."),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      deploymentId: z.string().optional().describe("Existing running deploymentId to reuse. If omitted, a new deployment is created."),
      timeoutMs: z.number().positive().optional().describe("Build timeout; default 600000"),
      async: z.boolean().optional().describe("Return jobId and deploymentId immediately. Default true."),
    },
    async ({
      project: projectName,
      projectOrSolutionPath,
      assemblyPath,
      instance,
      targetRelativePath,
      configuration = "Release",
      msbuildPath,
      msbuildProperties,
      environmentVariables,
      preflightOnly = false,
      expectedCurrentTargetSha256,
      expectedBuiltAssemblySha256,
      expectedProjectSha256,
      expectedSourceCommit,
      restart = true,
      rollbackOnFailure = true,
      environment,
      serverId,
      serverName,
      deploymentId: requestedDeploymentId,
      timeoutMs = 600000,
      async = true,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const connection = getSampleManagerTarget(projectName, environment, instance, undefined, { serverId, serverName });
      const { ps, runner, instance: instanceTarget, instanceName, configuredInstance } = connection;
      const resolvedEnvironment = ps.environment;
      const buildProfile = configuredInstance?.buildProfile ?? {};
      const validatedEnvironmentVariables = validateBuildEnvironmentVariables(environmentVariables);
      const validatedMsbuildProperties = validateBuildMsbuildProperties(msbuildProperties);
      const target = targetRelativePath ?? basename(assemblyPath);
      const operationSteps: Array<{
        name: string;
        status: "pending" | "running" | "succeeded" | "failed" | "rolled-back" | "unknown";
        startedAt?: string;
        finishedAt?: string;
        summary?: string;
        error?: string;
      }> = [
        { name: "baseline", status: "pending" },
        { name: "build", status: "pending" },
        { name: "artifact-guard", status: "pending" },
        { name: "deploy", status: "pending" },
        { name: "restart", status: restart ? "pending" : "succeeded", summary: restart ? undefined : "Skipped by request" },
      ];
      const run = requestedDeploymentId
        ? requireRunningDeployment(requestedDeploymentId, {
            userId: user.id,
            project: resolvedProjectName,
            environment: resolvedEnvironment,
            instance: instanceName,
            projectServerId: ps.id,
            serverId: ps.server.id,
            databaseHost: configuredInstance?.databaseHost,
            databaseName: configuredInstance?.databaseName,
          })
        : startDeployment({
            userId: user.id,
            username: user.username,
            project: resolvedProjectName,
            environment: resolvedEnvironment,
            host: ps.server.host || ps.server.agentId || ps.server.name,
            kind: "samplemanager-assembly",
            instance: instanceName,
            target: deploymentTarget(connection),
            steps: operationSteps,
            artifacts: { projectOrSolutionPath, assemblyPath, targetRelativePath: target },
            rollbackRequested: rollbackOnFailure,
          });
      const operationId = `assembly-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const operationStartedAt = new Date().toISOString();
      if (requestedDeploymentId && !Array.isArray(run.artifacts?.operations) && Object.keys(run.artifacts ?? {}).length > 0) {
        appendDeploymentOperationArtifact(run.id, {
          id: `legacy-${run.startedAt}`,
          kind: "legacy-artifacts",
          status: run.status,
          recordedAt: operationStartedAt,
          artifacts: run.artifacts,
          rollback: run.rollback,
        });
      }
      const existingStepCount = requestedDeploymentId ? (run.steps ?? []).length : 0;
      const steps = requestedDeploymentId
        ? [...(run.steps ?? []), ...operationSteps]
        : operationSteps;
      const operationStepIndexes = new Map(
        operationSteps.map((step, index) => [step.name, existingStepCount + index])
      );
      if (requestedDeploymentId) {
        const current = getDeployment(run.id)!;
        updateDeployment(run.id, {
          steps,
          artifacts: {
            projectOrSolutionPath,
            assemblyPath,
            targetRelativePath: target,
          },
          rollback: rollbackOnFailure
            ? { ...current.rollback, requested: true, status: current.rollback.status === "not-requested" ? "not-needed" : current.rollback.status }
            : current.rollback,
        });
      }

      const currentDeployment = () => {
        const current = getDeployment(run.id);
        if (!current) throw new Error(`Deployment '${run.id}' no longer exists`);
        return current;
      };

      const setStep = (
        name: string,
        status: "pending" | "running" | "succeeded" | "failed" | "rolled-back" | "unknown",
        summary?: string,
        error?: string
      ) => {
        const current = currentDeployment();
        const currentSteps = [...(current.steps ?? [])];
        const index = operationStepIndexes.get(name);
        if (index === undefined) throw new Error(`Deployment '${run.id}' has no current '${name}' step`);
        const previous = currentSteps[index];
        if (!previous) throw new Error(`Deployment '${run.id}' is missing its current '${name}' step`);
        currentSteps[index] = {
          ...previous,
          status,
          ...(status === "running" ? { startedAt: new Date().toISOString() } : {}),
          ...(["succeeded", "failed", "rolled-back"].includes(status) ? { finishedAt: new Date().toISOString() } : {}),
          summary,
          error,
        };
        updateDeployment(run.id, { steps: currentSteps });
      };

      const work = async (context?: JobContext) => {
        const output: string[] = [];
        let backupPath: string | undefined;
        let deployEvidence: Record<string, unknown> | undefined;
        let baselineEvidence: Record<string, unknown> | undefined;
        let effectiveCurrentTargetSha256 = expectedCurrentTargetSha256;
        let expectedTargetAbsent = false;
        let effectiveBuiltAssemblySha256 = expectedBuiltAssemblySha256;
        let restartEvidence: unknown;
        const appendOperation = (
          status: "succeeded" | "failed" | "unknown",
          rollback: typeof run.rollback,
          error?: string,
          errorCategory?: string
        ) => {
          const current = currentDeployment();
          const operationStepsSnapshot = [...operationStepIndexes.values()]
            .map((index) => current.steps?.[index])
            .filter(Boolean);
          appendDeploymentOperationArtifact(run.id, {
            id: operationId,
            kind: "samplemanager-assembly",
            status,
            startedAt: operationStartedAt,
            finishedAt: new Date().toISOString(),
            target: { projectOrSolutionPath, assemblyPath, targetRelativePath: target, instance: instanceName },
            steps: operationStepsSnapshot,
            baseline: baselineEvidence,
            deploy: deployEvidence,
            restart: restartEvidence,
            rollback,
            error,
            errorCategory,
          }, deployEvidence ?? {});
        };
        try {
          setStep("baseline", "running");
          const beforeBuildBaseline = await inspectSampleManagerDeploymentBaseline(runner, instanceTarget, {
            projectOrSolutionPath,
            assemblyPath,
            targetRelativePath: target,
            expectedCurrentTargetSha256,
            expectedProjectSha256,
            expectedSourceCommit,
            requireAssembly: false,
            execution: executionForJob(context),
          });
          const parsedBeforeBuild = deploymentBaselineSchema.parse(JSON.parse(beforeBuildBaseline));
          baselineEvidence = { beforeBuild: parsedBeforeBuild };
          expectedTargetAbsent = !parsedBeforeBuild.target.exists;
          effectiveCurrentTargetSha256 ??= parsedBeforeBuild.target.sha256 ?? undefined;
          setStep("baseline", "succeeded", compactText(beforeBuildBaseline, 1500));

          setStep("build", "running");
          const buildOutput = await buildSampleManagerProject(
            runner,
            projectOrSolutionPath,
            configuration,
            msbuildPath,
            buildProfile,
            timeoutMs,
            executionForJob(context),
            {
              instance: instanceTarget,
              msbuildProperties: validatedMsbuildProperties,
              environmentVariables: validatedEnvironmentVariables,
              preflightOnly,
              expectedAssemblyPath: assemblyPath,
            }
          );
          output.push(`build\n${buildOutput}`);
          setStep("build", "succeeded", compactText(buildOutput, 1500));

          setStep("artifact-guard", "running");
          const afterBuildBaseline = await inspectSampleManagerDeploymentBaseline(runner, instanceTarget, {
            projectOrSolutionPath,
            assemblyPath,
            targetRelativePath: target,
            expectedCurrentTargetSha256: effectiveCurrentTargetSha256,
            expectedTargetAbsent,
            expectedSourceSha256: preflightOnly ? undefined : expectedBuiltAssemblySha256,
            expectedProjectSha256,
            expectedSourceCommit,
            requireAssembly: !preflightOnly,
            execution: executionForJob(context),
          });
          const parsedAfterBuild = deploymentBaselineSchema.parse(JSON.parse(afterBuildBaseline));
          baselineEvidence = { ...(baselineEvidence ?? {}), afterBuild: parsedAfterBuild };
          effectiveBuiltAssemblySha256 ??= parsedAfterBuild.assembly.sha256 ?? undefined;
          if (!preflightOnly && !effectiveBuiltAssemblySha256) throw new Error("Built assembly baseline has no SHA-256; deployment stopped");
          updateDeployment(run.id, { artifacts: { ...(currentDeployment().artifacts ?? {}), baseline: baselineEvidence } });
          setStep("artifact-guard", "succeeded", compactText(afterBuildBaseline, 1500));

          if (preflightOnly) {
            setStep("deploy", "succeeded", "Skipped by preflight");
            setStep("restart", "succeeded", "Skipped by preflight");
            const current = currentDeployment();
            const compact = compactTextWithMetadata([current.output, ...output].filter(Boolean).join("\n\n"));
            appendOperation("succeeded", { requested: rollbackOnFailure, attempted: false, status: rollbackOnFailure ? "not-needed" : "not-requested" });
            finishDeployment(run.id, {
              status: "succeeded",
              rollback: current.rollback,
              output: compact.text,
              outputLength: compact.originalLength,
              outputTruncated: compact.truncated,
            });
            return summarizeJson(getDeployment(run.id));
          }

          setStep("deploy", "running");
          const deployOutput = await deploySampleManagerFile(
            runner,
            instanceTarget,
            assemblyPath,
            "solutionAssemblies",
            target,
            true,
            true,
            executionForJob(context),
            { expectedCurrentTargetSha256: effectiveCurrentTargetSha256, expectedSourceSha256: effectiveBuiltAssemblySha256, expectedTargetAbsent }
          );
          output.push(`deploy\n${deployOutput}`);
          try {
            const parsed = JSON.parse(deployOutput) as Record<string, unknown>;
            deployEvidence = parsed;
            backupPath = typeof parsed.backup === "string" ? parsed.backup : undefined;
            updateDeployment(run.id, {
              artifacts: {
                projectOrSolutionPath,
                assemblyPath,
                targetRelativePath: target,
                deployedTarget: parsed.target,
                sha256: parsed.sha256,
                backupPath,
                skipped: parsed.skipped,
              },
            });
          } catch {}
          setStep("deploy", "succeeded", compactText(deployOutput, 1500));

          if (restart) {
            setStep("restart", "running");
            const restartOutput = await restartSampleManagerInstance(runner, instanceTarget, executionForJob(context));
            output.push(`restart\n${restartOutput}`);
            try { restartEvidence = JSON.parse(restartOutput); } catch { restartEvidence = compactText(restartOutput, 1500); }
            setStep("restart", "succeeded", compactText(restartOutput, 1500));
          }

          const current = currentDeployment();
          const compact = compactTextWithMetadata([current.output, ...output].filter(Boolean).join("\n\n"));
          appendOperation("succeeded", { requested: rollbackOnFailure, attempted: false, status: rollbackOnFailure ? "not-needed" : "not-requested" });
          finishDeployment(run.id, {
            status: "succeeded",
            rollback: current.rollback,
            output: compact.text,
            outputLength: compact.originalLength,
            outputTruncated: compact.truncated,
          });
          return summarizeJson(getDeployment(run.id));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const current = currentDeployment();
          const disposition = deploymentFailureDisposition(error, {
            rollbackRequested: rollbackOnFailure,
            backupAvailable: Boolean(backupPath),
          });
          const runningStep = [...operationStepIndexes.entries()]
            .map(([name, index]) => ({ name, step: current.steps?.[index] }))
            .find(({ step }) => step?.status === "running");
          if (runningStep) setStep(runningStep.name, disposition.stepStatus, undefined, message);
          let rollback = currentDeployment().rollback;
          if (disposition.rollbackAllowed && backupPath) {
            rollback = { ...rollback, attempted: true };
            try {
              const targetPath = `${instancePaths(instanceTarget).solutionAssemblies}\\${target}`;
              await restoreSampleManagerBackup(runner, backupPath, targetPath, executionForJob(context));
              if (restart) await restartSampleManagerInstance(runner, instanceTarget, executionForJob(context));
              setStep("deploy", "rolled-back", `Restored ${backupPath}`);
              rollback = { ...rollback, status: "succeeded" };
            } catch (rollbackError) {
              rollback = {
                ...rollback,
                status: "failed",
                error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              };
            }
          }
          const completed = currentDeployment();
          appendOperation(disposition.status, rollback, message, disposition.category);
          finishDeployment(run.id, {
            status: disposition.status,
            rollback,
            output: compactText([completed.output, ...output].filter(Boolean).join("\n\n")),
            error: message,
            recommendedResumeAction: disposition.status === "unknown"
              ? "Remote completion is unknown. Inspect the job, deployed DLL hash, loaded assembly, and service state before any retry or rollback."
              : completed.recommendedResumeAction,
          });
          throw error;
        }
      };

      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "samplemanager_build_deploy_assembly",
        deploymentId: run.id,
        requestedDeploymentId,
        instance: instanceName,
        assemblyPath,
        target,
        msbuildProperties: buildSettingsMetadata(validatedMsbuildProperties),
        environmentVariables: buildSettingsMetadata(validatedEnvironmentVariables),
        preflightOnly,
        baselineGuard: {
          expectedCurrentTargetSha256: expectedCurrentTargetSha256 ?? null,
          expectedBuiltAssemblySha256: expectedBuiltAssemblySha256 ?? null,
          expectedProjectSha256: expectedProjectSha256 ?? null,
          expectedSourceCommit: expectedSourceCommit ?? null,
        },
        async,
      });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_build_deploy_assembly", {
          deploymentId: run.id,
          projectOrSolutionPath,
          assemblyPath,
          instance: instanceName,
          target,
          configuration,
          msbuildProperties: buildSettingsMetadata(validatedMsbuildProperties),
          environmentVariables: buildSettingsMetadata(validatedEnvironmentVariables),
          preflightOnly,
          expectedCurrentTargetSha256,
          expectedBuiltAssemblySha256,
          expectedProjectSha256,
          expectedSourceCommit,
          environment,
          serverId: ps.server.id,
          projectServerId: ps.id,
          timeoutMs,
        }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, deploymentId: run.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_deployment_status",
    "Return the current SampleManager deployment record, phase results, artifacts, hashes, backup, and rollback status.",
    {
      project: z.string().optional(),
      deploymentId: z.string(),
    },
    async ({ project: projectName, deploymentId }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const deployment = getDeployment(deploymentId);
      if (!deployment || deployment.userId !== user.id || deployment.project !== resolvedProjectName) {
        throw new Error(`Deployment '${deploymentId}' not found`);
      }
      return { content: [{ type: "text", text: summarizeJson(deployment) }] };
    }
  );

  server.tool(
    "samplemanager_deployment_finish",
    "Mark a manually orchestrated SampleManager deploymentId succeeded or failed after all linked operations complete.",
    {
      project: z.string().optional(),
      deploymentId: z.string(),
      status: z.enum(["succeeded", "failed"]),
      error: z.string().optional(),
    },
    async ({ project: projectName, deploymentId, status, error }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const deployment = getDeployment(deploymentId);
      if (!deployment || deployment.userId !== user.id || deployment.project !== resolvedProjectName) {
        throw new Error(`Deployment '${deploymentId}' not found`);
      }
      const finished = finishDeployment(deploymentId, {
        status,
        rollback: deployment.rollback,
        steps: deployment.steps,
        artifacts: deployment.artifacts,
        output: deployment.output,
        outputLength: deployment.outputLength,
        outputTruncated: deployment.outputTruncated,
        error,
      });
      return { content: [{ type: "text", text: summarizeJson(finished) }] };
    }
  );

  server.tool(
    "samplemanager_deploy_file",
    "Copy a staged remote file into a SampleManager instance area and create a timestamped backup of the replaced file.",
    {
      project: z.string().optional(),
      instance: z.string().optional().describe("Optional when the project environment is bound to a LIMS instance."),
      sourcePath: z.string().describe("Absolute source file path already present on the remote server"),
      area: z.enum(["exe", "solutionAssemblies", "forms", "resourceIcon", "data"]),
      targetRelativePath: z.string(),
      backup: z.boolean().optional().describe("Create backup before replacement; default true"),
      skipIfUnchanged: z.boolean().optional().describe("Skip the copy when source and target SHA-256 already match; default true"),
      expectedCurrentTargetSha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional().describe("Abort before backup/copy unless the current target has this SHA-256."),
      expectedSourceSha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional().describe("Abort before backup/copy unless the staged source has this SHA-256."),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      deploymentId: z.string().optional(),
      async: z.boolean().optional().describe("Run as an async job; default true."),
    },
    async ({ project: projectName, instance, sourcePath, area, targetRelativePath, backup = true, skipIfUnchanged = true, expectedCurrentTargetSha256, expectedSourceSha256, environment, serverId, serverName, deploymentId, async = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const connection = getSampleManagerTarget(projectName, environment, instance, undefined, { serverId, serverName });
      const { runner, instance: target, instanceName } = connection;
      const work = (context?: JobContext) => withDeploymentStep(
        deploymentId,
        resolvedProjectName,
        `deploy:${targetRelativePath}`,
        () => deploySampleManagerFile(
          runner,
          target,
          sourcePath,
          area,
          targetRelativePath,
          backup,
          skipIfUnchanged,
          executionForJob(context),
          { expectedCurrentTargetSha256, expectedSourceSha256 }
        ),
        { connection, instanceName }
      );
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_deploy_file", environment: connection.ps.environment, serverId: connection.ps.server.id, projectServerId: connection.ps.id, deploymentId, instance: instanceName, sourcePath, area, targetRelativePath, backup, skipIfUnchanged, expectedCurrentTargetSha256, expectedSourceSha256, async });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_deploy_file", { instance: instanceName, sourcePath, area, targetRelativePath, backup, skipIfUnchanged, expectedCurrentTargetSha256, expectedSourceSha256, environment: connection.ps.environment, serverId: connection.ps.server.id, projectServerId: connection.ps.id, deploymentId }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, deploymentId, status: job.status, target: deploymentTarget(connection) }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_restore_backup",
    "Restore a specific timestamped SampleManager backup file to an explicit remote target path.",
    {
      project: z.string().optional(),
      backupPath: z.string(),
      targetPath: z.string(),
      environment: z.string().optional(),
      async: z.boolean().optional(),
    },
    async ({ project: projectName, backupPath, targetPath, environment, async = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner } = getRunner(projectName, environment);
      const work = (context?: JobContext) => restoreSampleManagerBackup(
        runner,
        backupPath,
        targetPath,
        executionForJob(context)
      );
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_restore_backup", backupPath, targetPath, async });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_restore_backup", { backupPath, targetPath, environment }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );
}
