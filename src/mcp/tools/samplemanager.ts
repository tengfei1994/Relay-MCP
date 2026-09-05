import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpUser } from "../register-tools.js";
import { z } from "zod";
import { createHash, randomUUID } from "crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "fs";
import { basename } from "path";
import { ensureRemoteSuccess } from "../../shared/remote-runner.js";
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
} from "../../shared/samplemanager-tools.js";
import { persistQueryArtifact } from "../../shared/query-artifact-store.js";
import { compactText, compactTextWithMetadata, summarizeJson } from "../../shared/output.js";
import { resolveWorkspacePath } from "../../shared/workspace-path.js";
import { quotePosix, quotePowerShell } from "../../shared/shell-utils.js";
import {
  SampleManagerCapabilityRegistry,
  createSampleManagerInspectionEnvelope,
} from "../../shared/samplemanager-capabilities.js";
import type { ProjectRegistry } from "../project-registry.js";
import type { GetRunner, ResolveProjectName, SampleManagerDatabaseTarget } from "../tool-context.js";

const sampleManagerCapabilityRegistry = new SampleManagerCapabilityRegistry();

export interface SampleManagerToolsContext {
  server: McpServer;
  user: McpUser;
  resolveProjectName: ResolveProjectName;
  getRunner: GetRunner;
  registry: ProjectRegistry;
  executionForJob: (context?: JobContext) => Record<string, unknown>;
  getSampleManagerDatabaseTarget: (project?: string, environment?: string, database?: string) => SampleManagerDatabaseTarget;
}

/** SampleManager registration boundary. */
export function registerSampleManagerTools(context: SampleManagerToolsContext, legacy?: (context: SampleManagerToolsContext) => void): void {
  if (legacy) { legacy(context); return; }
  const { server, user, resolveProjectName, getRunner, registry, executionForJob, getSampleManagerDatabaseTarget } = context;

  function getSampleManagerTarget(
    projectName?: string,
    environment?: string,
    requestedInstance?: string,
    requestedDatabase?: string
  ) {
    const connection = getRunner(projectName, environment);
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

  async function withDeploymentStep<T>(
    deploymentId: string | undefined,
    projectName: string,
    name: string,
    work: () => Promise<T>
  ): Promise<T> {
    if (!deploymentId) return work();
    const deployment = getDeployment(deploymentId);
    if (!deployment || deployment.userId !== user.id || deployment.project !== projectName) {
      throw new Error(`Deployment '${deploymentId}' not found for project '${projectName}'`);
    }
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

  // ── SampleManager high-level tools ────────────────────────────────────────
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
    "samplemanager_deployment_start",
    "Create a SampleManager deploymentId that correlates SQL, build, deploy, restart, hashes, backups, logs, and rollback evidence.",
    {
      project: z.string().optional(),
      instance: z.string().optional().describe("Optional when the project environment is bound to a LIMS instance."),
      environment: z.string().optional(),
      label: z.string().optional(),
    },
    async ({ project: projectName, instance, environment, label }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, instanceName } = getSampleManagerTarget(projectName, environment, instance);
      const run = startDeployment({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        environment: ps.environment,
        host: ps.server.host || ps.server.agentId || ps.server.name,
        kind: "samplemanager-assembly",
        instance: instanceName,
        steps: [],
        artifacts: label ? { label } : {},
        rollbackRequested: false,
      });
      return { content: [{ type: "text", text: summarizeJson({ deploymentId: run.id, status: run.status }) }] };
    }
  );

  server.tool(
    "samplemanager_restart_instance",
    "Restart a SampleManager instance on a linked Windows server and stop stuck client task hosts",
    {
      project: z.string().optional(),
      instance: z.string().optional().describe("Optional when the project environment is bound to a LIMS instance."),
      environment: z.string().optional(),
      deploymentId: z.string().optional(),
      async: z.boolean().optional().describe("Run as an async job and return a jobId"),
    },
    async ({ project: projectName, instance, environment, deploymentId, async = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner, instance: target, instanceName } = getSampleManagerTarget(projectName, environment, instance);
      const work = (context?: JobContext) => withDeploymentStep(
        deploymentId,
        resolvedProjectName,
        "restart",
        () => restartSampleManagerInstance(runner, target, executionForJob(context))
      );
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_restart_instance", { instance: instanceName, environment, deploymentId }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
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
      async: z.boolean().optional().describe("Run as an async tracked job and return a jobId."),
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ project: projectName, instance, formName, environment, async = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner, instance: target, instanceName } = getSampleManagerTarget(projectName, environment, instance);
      const work = (context?: JobContext) => clearFormCache(
        runner,
        target,
        formName,
        executionForJob(context)
      );
      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "samplemanager_clear_form_cache",
        instance: instanceName,
        formName,
        environment,
        async,
      });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_clear_form_cache", {
          instance: instanceName,
          formName,
          environment,
        }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
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
      minutes: z.number().optional(),
      keywords: z.array(z.string()).optional(),
    },
    async ({ project: projectName, instance, environment, minutes = 30, keywords }) => {
      const { runner, instance: target } = getSampleManagerTarget(projectName, environment, instance);
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
    },
    async ({ project: projectName, database, table, environment }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner, database: targetDatabase, databaseHost } = getSampleManagerDatabaseTarget(projectName, environment, database);
      const text = await sampleManagerTableSchema(runner, targetDatabase, table, databaseHost);
      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "samplemanager_table_schema",
        database: targetDatabase,
        databaseHost,
        table,
      });
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "samplemanager_sql_query",
    "Run a compact SQL query against a SampleManager SQL Server database. Read-only by default.",
    {
      project: z.string().optional(),
      database: z.string().optional().describe("Optional when the bound LIMS instance has a configured database."),
      sql: z.string(),
      environment: z.string().optional(),
      allowMutation: z.boolean().optional(),
      maxRows: z.number().optional().describe("Maximum rows returned per result set, capped at 1000. Default 100."),
      offset: z.number().int().nonnegative().optional().describe("Zero-based result row offset for pagination. Use nextOffset from the previous response."),
      includeResultSets: z.boolean().optional().describe("Include full resultSets payload. Default false."),
      resultSet: z.union([z.string(), z.number().int().nonnegative()]).optional().describe("Return only one named result set or zero-based result-set index."),
      parameters: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Named SQL parameters without '@', referenced as @name in SQL."),
      identifiers: z.record(z.string()).optional().describe("Identifiers substituted into {{name}} placeholders and escaped with SQL Server brackets."),
    },
    async ({ project: projectName, database, sql, environment, allowMutation = false, maxRows, offset, includeResultSets, resultSet, parameters, identifiers }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const target = getSampleManagerDatabaseTarget(projectName, environment, database);
      const { runner, database: targetDatabase, databaseHost, configuredInstance, ps } = target;
      const queryId = `query-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const startedAt = new Date().toISOString();
      const mutationAttempted = allowMutation && sqlContainsMutation(sql);
      const provenance = {
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
        startedAt,
        readOnly: !allowMutation,
        mutationAttempted,
      };
      const text = await runSql(runner, targetDatabase, sql, { allowMutation, maxRows, offset, includeResultSets: true, parameters, identifiers, databaseHost });
      const finishedAt = new Date().toISOString();
      const artifact = persistQueryArtifact({
        queryId,
        rawResponse: text,
        provenance: { ...provenance, finishedAt },
      });
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(text) as Record<string, unknown>;
      } catch {
        raw = { ok: false, rawResponse: text };
      }
      const page = {
        offset: Number(offset ?? 0),
        maxRows: Number(maxRows ?? 100),
        rowCount: raw.rowCount,
        rowsReturned: raw.rowsReturned,
        nextOffset: raw.nextOffset,
        hasMore: raw.hasMore,
        truncated: raw.truncated,
        resultSetCount: raw.resultSetCount,
      };
      const allResultSets = Array.isArray(raw.resultSets) ? raw.resultSets : [];
      let selectedResultSets = allResultSets.slice(0, 1);
      if (resultSet !== undefined) {
        const selected = typeof resultSet === "number"
          ? allResultSets[resultSet]
          : allResultSets.find((item: any) => String(item?.name ?? item?.label ?? item?.__relay_phase ?? "").toLowerCase() === String(resultSet).toLowerCase());
        if (!selected) throw new Error(`Result set '${String(resultSet)}' was not found; available indexes: ${allResultSets.map((_item: unknown, index: number) => index).join(", ")}; available labels: ${allResultSets.map((item: any, index: number) => `${index}:${item?.rows?.[0]?.__relay_phase ?? "unnamed"}`).join(", ")}`);
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
        page,
        artifact,
        result: {
          ok: raw.ok,
          connection: raw.connection,
          columns: selectedResult[0]?.columns ?? [],
          rows: selectedResult[0]?.rows ?? [],
          rowCount: selectedResult[0]?.rowCount ?? 0,
          rowsReturned: selectedResult[0]?.rowsReturned ?? 0,
          hasMore: Boolean(selectedResult.some((item: any) => item?.hasMore)),
          continuationToken,
          resultSetCount: allResultSets.length,
          resultSets: includeResultSets ? selectedResult : undefined,
          recordsAffected: raw.recordsAffected,
          error: raw.error,
          sqlErrors: raw.sqlErrors,
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
      });
      return {
        structuredContent: response,
        content: [{ type: "text", text: summarizeJson({ queryId, provenance: response.provenance, page: response.page, result: { rowCount: response.result.rowCount, rowsReturned: response.result.rowsReturned, resultSetCount: response.result.resultSetCount, hasMore: response.result.hasMore, continuationToken: response.result.continuationToken }, artifact }) }],
      };
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
      allowMutation: z.boolean().optional(),
      maxRows: z.number().optional().describe("Maximum rows returned per result set, capped at 1000. Default 100."),
      offset: z.number().int().nonnegative().optional().describe("Zero-based result row offset for pagination. Use nextOffset from the previous response."),
      includeResultSets: z.boolean().optional().describe("Include full resultSets payload. Default false."),
      parameters: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Named SQL parameters without '@', referenced as @name in SQL."),
      identifiers: z.record(z.string()).optional().describe("Identifiers substituted into {{name}} placeholders and escaped with SQL Server brackets."),
    },
    async ({ project: projectName, database, path: relPath, environment, allowMutation = false, maxRows, offset, includeResultSets, parameters, identifiers }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const project = registry.getProject(user.id, resolvedProjectName);
      if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);

      const fullPath = resolveWorkspacePath(project.workspacePath, relPath, { mustExist: true });
      if (!existsSync(fullPath)) {
        throw new Error(`SQL file '${relPath}' does not exist in project '${resolvedProjectName}'`);
      }

      const { runner, database: targetDatabase, databaseHost } = getSampleManagerDatabaseTarget(projectName, environment, database);
      const sql = readFileSync(fullPath, "utf8");
      const text = await runSql(runner, targetDatabase, sql, { allowMutation, maxRows, offset, includeResultSets, parameters, identifiers, databaseHost });
      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "samplemanager_sql_execute_file",
        database: targetDatabase,
        databaseHost,
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
      deploymentId,
      timeoutMs = 300000,
      async = true,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner, instance: target, instanceName } = getSampleManagerTarget(projectName, environment, instance);
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
        )
      );
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_table_loader", instance: instanceName, remoteCsvPath, mode, deploymentId, async, mutationAttempted: true, mutationKind: "data" });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_table_loader", { instance: instanceName, username, remoteCsvPath, mode, environment, deploymentId, timeoutMs }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, deploymentId, status: job.status }) }] };
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
      deploymentId: requestedDeploymentId,
      backupSql,
      verifySql,
      timeoutMs = 300000,
      async = true,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { project, ps, runner, instance: target, instanceName } = getSampleManagerTarget(projectName, environment, instance);
      const run = requestedDeploymentId
        ? getDeployment(requestedDeploymentId)
        : startDeployment({
            userId: user.id,
            username: user.username,
            project: resolvedProjectName,
            environment: ps.environment,
            host: ps.server.host || ps.server.agentId || ps.server.name,
            kind: "samplemanager-assembly",
            instance: instanceName,
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
          });
          return { workspacePath: file.workspacePath, remotePath, bytes: localStat.size, localSha256 };
        };
        if (backupSql) {
          await withDeploymentStep(run.id, resolvedProjectName, "backup", async () => {
            const result = await runSql(runner, getSampleManagerDatabaseTarget(projectName, environment).database, backupSql, { allowMutation: true, includeResultSets: false, databaseHost: getSampleManagerDatabaseTarget(projectName, environment).databaseHost });
            writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_deploy_table_loader_package", deploymentId: run.id, mutationAttempted: true, mutationKind: "schema-or-data", phase: "backup" });
            return result;
          });
        }
        for (let index = 0; index < files.length; index++) {
          const staged = await stage(files[index], index);
          const loaded = await withDeploymentStep(run.id, resolvedProjectName, `load:${files[index].workspacePath}`, () => loadTableLoaderFile(runner, target, username, staged.remotePath, files[index].mode ?? "overwrite_table", timeoutMs, executionForJob(context)));
          results.push({ ...staged, mode: files[index].mode ?? "overwrite_table", load: loaded });
        }
        let verification: unknown;
        if (verifySql) {
          const dbTarget = getSampleManagerDatabaseTarget(projectName, environment);
          verification = await withDeploymentStep(run.id, resolvedProjectName, "verify", () => runSql(dbTarget.runner, dbTarget.database, verifySql, { allowMutation: false, includeResultSets: true, databaseHost: dbTarget.databaseHost }));
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
        const job = startJob(user, resolvedProjectName, "samplemanager_deploy_table_loader_package", { instance: instanceName, username, files, environment, deploymentId: run.id, timeoutMs }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, deploymentId: run.id, status: job.status }) }] };
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
      deploymentId,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner, database: targetDatabase, databaseHost } = getSampleManagerDatabaseTarget(projectName, environment, database);
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
      );
      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "samplemanager_sql_mutation",
        database: targetDatabase,
        databaseHost,
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
      deploymentId: z.string().optional(),
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
      })).min(1).max(50),
    },
    async ({ project: projectName, database, environment, deploymentId: requestedDeploymentId, dryRun = true, createBackup = true, maxRows, verifySql, changes }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const target = getSampleManagerDatabaseTarget(projectName, environment, database);
      let deploymentId = requestedDeploymentId;
      let run = deploymentId ? getDeployment(deploymentId) : undefined;
      if (deploymentId && (!run || run.userId !== user.id || run.project !== resolvedProjectName)) {
        throw new Error(`Deployment '${deploymentId}' not found for project '${resolvedProjectName}'`);
      }
      if (run?.status === "unknown") {
        throw new Error(`Deployment '${run.id}' has unknown execution state. Verify the database and call samplemanager_deployment_status before retrying.`);
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
          : await runSqlChangeSet(target.runner, target.database, runnable, { dryRun, createBackup, maxRows, databaseHost: target.databaseHost, verifySql });
        const completedAt = new Date().toISOString();
        for (const change of runnable) nextKeys[change.idempotencyKey] = { status: dryRun ? "dry_run" : "succeeded", at: completedAt, result: { dryRun } };
        const committed = dryRun ? (run.committedMutations ?? []) : [...(run.committedMutations ?? []), ...runnable.map((change) => change.idempotencyKey)];
        const dryOnly = dryRun ? [...new Set([...(run.dryRunOnlyMutations ?? []), ...runnable.map((change) => change.idempotencyKey)])] : (run.dryRunOnlyMutations ?? []);
        const updated = finishDeployment(run.id, {
          status: "succeeded",
          rollback: { ...run.rollback, status: dryRun ? "not-needed" : "not-needed" },
          idempotencyKeys: nextKeys,
          committedMutations: committed,
          dryRunOnlyMutations: dryOnly,
          lastCompletedPhase: "verify",
          pendingPhases: [],
          failedMutation: undefined,
          recommendedResumeAction: dryRun ? "Review dry-run evidence; rerun with the same idempotency keys and dryRun=false to commit." : "No resume required.",
          output: resultText,
          artifacts: { ...(run.artifacts ?? {}), changeCount: changes.length, skipped: changes.length - runnable.length },
        });
        writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_apply_change_set", deploymentId: run.id, database: target.database, databaseHost: target.databaseHost, dryRun, changeCount: changes.length, skipped: changes.length - runnable.length, mutationAttempted: true });
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
      restart: z.boolean().optional().describe("Restart SampleManager after deploy. Default true."),
      rollbackOnFailure: z.boolean().optional().describe("Restore the timestamped backup if a later phase fails. Default true."),
      environment: z.string().optional(),
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
      restart = true,
      rollbackOnFailure = true,
      environment,
      deploymentId: requestedDeploymentId,
      timeoutMs = 600000,
      async = true,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner, instance: instanceTarget, instanceName, configuredInstance } =
        getSampleManagerTarget(projectName, environment, instance);
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
        { name: "build", status: "pending" },
        { name: "deploy", status: "pending" },
        { name: "restart", status: restart ? "pending" : "succeeded", summary: restart ? undefined : "Skipped by request" },
      ];
      const run = requestedDeploymentId
        ? requireRunningDeployment(requestedDeploymentId, {
            userId: user.id,
            project: resolvedProjectName,
            environment: resolvedEnvironment,
            instance: instanceName,
          })
        : startDeployment({
            userId: user.id,
            username: user.username,
            project: resolvedProjectName,
            environment: resolvedEnvironment,
            host: ps.server.host || ps.server.agentId || ps.server.name,
            kind: "samplemanager-assembly",
            instance: instanceName,
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
            deploy: deployEvidence,
            restart: restartEvidence,
            rollback,
            error,
            errorCategory,
          }, deployEvidence ?? {});
        };
        try {
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
            executionForJob(context)
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
          environment,
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
      environment: z.string().optional(),
      deploymentId: z.string().optional(),
      async: z.boolean().optional().describe("Run as an async job"),
    },
    async ({ project: projectName, instance, sourcePath, area, targetRelativePath, backup = true, skipIfUnchanged = true, environment, deploymentId, async = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner, instance: target, instanceName } = getSampleManagerTarget(projectName, environment, instance);
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
          executionForJob(context)
        )
      );
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_deploy_file", instance: instanceName, sourcePath, area, targetRelativePath, backup, skipIfUnchanged, async });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_deploy_file", { instance: instanceName, sourcePath, area, targetRelativePath, backup, skipIfUnchanged, environment, deploymentId }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
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
