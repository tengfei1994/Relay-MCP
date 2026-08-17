import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { ProjectRegistry } from "./project-registry.js";
import { ensureRemoteSuccess, RemoteRunner } from "../shared/remote-runner.js";
import { AgentRemoteRunner } from "../shared/agent-remote-runner.js";
import { selectProjectTarget } from "../shared/project-target-selection.js";
import { compactText, compactTextWithMetadata, sanitizeStructuredOutput, summarizeExec, summarizeJson } from "../shared/output.js";
import { cancelJob, getJob, listJobs, startJob, writeAudit, type JobContext } from "../shared/job-store.js";
import { recordFact, searchFacts } from "../shared/context-store.js";
import { finishDeployment, getDeployment, startDeployment, updateDeployment } from "../shared/deployment-store.js";
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
  runUnicodeCheck,
  sqlContainsMutation,
  sampleManagerTableSchema,
} from "../shared/samplemanager-tools.js";
import { persistQueryArtifact } from "../shared/query-artifact-store.js";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { basename, dirname, join, relative } from "path";
import { resolveWorkspacePath } from "../shared/workspace-path.js";
import { quotePosix, quotePowerShell, validateGitRef, validateServiceName } from "../shared/shell-utils.js";
import { createUploadSession, getUploadSession, publicUploadSession } from "../shared/upload-store.js";
import { createDownloadSession } from "../shared/download-store.js";
import { getAgentStore } from "../shared/agent-store.js";
import { TOOL_CATALOG_BY_NAME } from "../shared/tool-catalog.js";
import {
  SampleManagerCapabilityRegistry,
  createSampleManagerInspectionEnvelope,
} from "../shared/samplemanager-capabilities.js";
import "dotenv/config";

const MCP_PORT = Number(process.env.MCP_PORT ?? 3001);
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-in-production";
const DB_PATH = process.env.DB_PATH ?? "./data/app.db";
const RELAY_PUBLIC_URL = (process.env.RELAY_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
const RELAY_MCP_VERSION = process.env.RELAY_MCP_VERSION ?? "0.6.3";
const sampleManagerCapabilityRegistry = new SampleManagerCapabilityRegistry();

interface McpUser {
  id: number;
  username: string;
  isAdmin?: boolean;
  tokenId?: string;
  tokenDbId?: number;
  defaultProjectId?: number;
  defaultProject?: string;
  defaultEnvironment?: string;
  projectServerId?: number;
  defaultServerId?: number;
  allowAllProjects?: boolean;
  canCreateProjects?: boolean;
}

function auditArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(auditArguments);
  if (!value || typeof value !== "object") return value;
  const sensitive = /^(script|content|base64|token|password|sql|parameters)$/i;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (sensitive.test(key)) {
      const text = typeof item === "string" ? item : JSON.stringify(item);
      return [key, { redacted: true, length: text?.length ?? 0 }];
    }
    return [key, auditArguments(item)];
  }));
}

// ─── Auth middleware ───────────────────────────────────────────────────────────
function verifyToken(req: express.Request): McpUser {
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;

  let token: string | undefined;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (queryToken) {
    token = queryToken;
  } else {
    throw new Error("Missing or invalid authentication");
  }
  const payload = jwt.verify(token, JWT_SECRET) as McpUser;
  if (payload.tokenId) {
    const db = new Database(DB_PATH, { readonly: false });
    try {
      const row = db
        .prepare(`
          SELECT mt.id, mt.project_id, mt.project_server_id, mt.environment, mt.allow_all_projects, mt.can_create_projects, p.name AS project_name
          , mt.default_server_id
          FROM mcp_tokens mt
          LEFT JOIN projects p ON p.id = mt.project_id
          WHERE mt.token_id = ? AND mt.user_id = ? AND mt.active = 1
        `)
        .get(payload.tokenId, payload.id) as any;
      if (!row) throw new Error("MCP token is disabled or not found");
      db.prepare("UPDATE mcp_tokens SET last_used_at = datetime('now') WHERE token_id = ?").run(payload.tokenId);
      payload.tokenDbId = row.id;
      payload.defaultProjectId = row.project_id ?? undefined;
      payload.defaultProject = row.project_name ?? undefined;
      payload.defaultEnvironment = row.environment ?? "production";
      payload.projectServerId = row.project_server_id ?? undefined;
      payload.defaultServerId = row.default_server_id ?? undefined;
      payload.allowAllProjects = Boolean(row.allow_all_projects);
      payload.canCreateProjects = Boolean(row.can_create_projects);
    } finally {
      db.close();
    }
  }
  return payload;
}

// ─── Build MCP server for a given user ────────────────────────────────────────
function createMcpServer(user: McpUser) {
  const registry = new ProjectRegistry();
  const server = new McpServer({
    name: "remote-ops",
    version: RELAY_MCP_VERSION,
  });

  const relayRoute = (tool: string, extra: Record<string, unknown> = {}) => ({
    route: "relay_mcp",
    tool,
    transport: "mcp",
    ...extra,
  });

  // ── Helper: resolve project + runner ──────────────────────────────────────
  function listAllowedProjects() {
    const projects = registry.listScopedProjects(user.id, user.tokenDbId, user.allowAllProjects);
    if (projects.length === 0 && user.defaultProject) {
      const defaultProject = registry.getProject(user.id, user.defaultProject);
      return defaultProject ? [defaultProject] : [];
    }
    return projects;
  }

  function listAllowedServerIds() {
    return registry.listScopedServerIds(user.id, user.tokenDbId, user.allowAllProjects);
  }

  function assertServerAllowed(serverId: number) {
    const allowed = listAllowedServerIds();
    if (!allowed.includes(serverId)) {
      throw new Error(`Server '${serverId}' is not allowed for this MCP token`);
    }
  }

  function resolveProjectName(projectName?: string) {
    const allowedProjects = listAllowedProjects();
    const resolved = projectName || user.defaultProject || (allowedProjects.length === 1 ? allowedProjects[0].name : undefined);
    if (!resolved) {
      throw new Error(
        JSON.stringify({
          needsProjectSelection: true,
          message: "No project selected. Ask the user whether to create a new project or use an existing one, then pass the project name.",
          canCreateProjects: Boolean(user.canCreateProjects),
          projects: allowedProjects.map((project) => ({
            name: project.name,
            id: project.id,
            serverLinks: projectLinkSummaries(project.id),
          })),
        })
      );
    }
    if (!user.allowAllProjects && user.tokenDbId) {
      const allowed = allowedProjects.some((project) => project.name === resolved);
      if (!allowed) throw new Error(`Project '${resolved}' is not allowed for this MCP token`);
    }
    return resolved;
  }

  function getRunner(
    projectName?: string,
    environment?: string,
    selector: { serverId?: number; serverName?: string } = {}
  ) {
    const resolvedProjectName = resolveProjectName(projectName);
    const project = registry.getProject(user.id, resolvedProjectName);
    if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);

    const allProjectServers = registry.getProjectServers(project.id);
    const allowedServerIds = listAllowedServerIds();
    const ps = selectProjectTarget(resolvedProjectName, allProjectServers, {
      environment,
      defaultEnvironment: user.defaultEnvironment,
      serverId: selector.serverId,
      serverName: selector.serverName,
      projectServerId: user.projectServerId,
      defaultServerId: user.defaultServerId,
      allowedServerIds,
    });

    const runner = ps.connectionMode === "agent"
      ? (() => {
          if (!ps.server.agentId) {
            throw new Error(`Agent link exists for project '${resolvedProjectName}', but server '${ps.server.name}' has no Agent ID`);
          }
          return new AgentRemoteRunner(user.id, ps.server.agentId, ps.server.os);
        })()
      : (() => {
          if (ps.server.status !== "connected") {
            throw new Error(`SSH link exists for project '${resolvedProjectName}', but server '${ps.server.name}' status is '${ps.server.status}'`);
          }
          return new RemoteRunner({
            host: ps.server.host,
            port: ps.server.port,
            username: ps.server.sshUser,
            privateKeyPath: ps.server.privateKeyPath,
            os: ps.server.os,
          });
        })();
    return { project, ps, runner };
  }

  function getPlaywrightRunner(
    projectName?: string,
    environment?: string,
    selector: { serverId?: number; serverName?: string } = {}
  ) {
    const connection = getRunner(projectName, environment, selector);
    if (!(connection.runner instanceof AgentRemoteRunner)) {
      throw new Error(
        `Playwright tools require an Agent connection for project '${connection.project.name}' environment '${connection.ps.environment}'. ` +
        `Selected server '${connection.ps.server.name}' uses ${connection.ps.connectionMode}.`
      );
    }
    return {
      ...connection,
      runner: connection.runner as AgentRemoteRunner,
    };
  }

  async function dispatchPlaywright(
    runner: AgentRemoteRunner,
    payload: Record<string, unknown>,
    timeoutMs: number,
    context?: JobContext
  ) {
    const result = await runner.dispatchPlaywright(payload, timeoutMs, executionForJob(context));
    ensureRemoteSuccess(result);
    const text = result.stdout.trim();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Agent Playwright returned invalid JSON: ${compactText(text, 4000)}`);
    }
  }

  function playwrightSelectors() {
    return {
      project: z.string().optional().describe("Project name. Optional when the MCP token has a default project."),
      environment: z.string().optional().describe("Exact project environment key."),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server name."),
    };
  }

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

  function getSampleManagerDatabaseTarget(
    projectName?: string,
    environment?: string,
    requestedDatabase?: string
  ) {
    const connection = getRunner(projectName, environment);
    const configured = connection.ps.limsInstance;
    if (
      configured?.databaseName &&
      requestedDatabase &&
      configured.databaseName.toLowerCase() !== requestedDatabase.toLowerCase()
    ) {
      throw new Error(
        `LIMS instance '${configured.name}' is configured for database '${configured.databaseName}', not '${requestedDatabase}'`
      );
    }
    const database = configured?.databaseName || requestedDatabase;
    if (!database) {
      throw new Error("No database is configured for the bound LIMS instance; configure it in the management UI or pass database");
    }
    return {
      ...connection,
      database,
      databaseHost: configured?.databaseHost || "localhost",
      configuredInstance: configured,
    };
  }

  function executionForJob(context?: JobContext) {
    if (!context) return {};
    return {
      signal: context.signal,
      onStdout: (text: string) => {
        const value = text.trim();
        if (value) context.log(compactText(value, 2000), "stdout");
      },
      onStderr: (text: string) => {
        const value = text.trim();
        if (value) context.log(compactText(value, 2000), "stderr");
      },
      onPhase: (name: string) => context.phase(name),
    };
  }

  async function waitForTrackedJob(jobId: string, waitMs: number) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const current = getJob(jobId);
      if (!current || current.status !== "running") return current;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return getJob(jobId);
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
      steps[steps.length - 1] = {
        ...steps[steps.length - 1],
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      updateDeployment(deploymentId, { steps, status: "failed", error: steps[steps.length - 1].error });
      throw error;
    }
  }

  function projectLinkSummaries(projectId: number) {
    const allowedServerIds = listAllowedServerIds();
    return registry.getProjectServers(projectId)
      .filter((link) => allowedServerIds.includes(link.server.id))
      .map((link) => ({
        linkId: link.id,
        serverId: link.server.id,
        serverName: link.server.name,
        displayName: link.server.name,
        environment: link.environment,
        connectionMode: link.connectionMode,
        status: link.server.status,
        host: link.server.host || undefined,
        agentId: link.server.agentId,
        remotePath: link.remotePath,
        limsInstance: link.limsInstance ? {
          id: link.limsInstance.id,
          name: link.limsInstance.name,
          version: link.limsInstance.version,
          runtimeKind: link.limsInstance.runtimeKind,
          databaseHost: link.limsInstance.databaseHost,
          databaseName: link.limsInstance.databaseName,
        } : undefined,
      }));
  }

  // ── Tool: list_projects ────────────────────────────────────────────────────
  server.tool("list_projects", "List all projects for the current user", {}, async () => {
    const projects = listAllowedProjects().map((project) => ({
      ...project,
      serverLinks: projectLinkSummaries(project.id),
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
    };
  });

  server.tool(
    "project_server_links_list",
    "List selectable server links for one project or every allowed project, including exact environment keys and bound LIMS instances.",
    {
      project: z.string().optional().describe("Optional project name. Omit to list links for every allowed project."),
    },
    async ({ project: projectName }) => {
      const projects = projectName
        ? [registry.getProject(user.id, resolveProjectName(projectName))].filter(Boolean)
        : listAllowedProjects();
      return {
        content: [{
          type: "text",
          text: summarizeJson(projects.map((project) => ({
            projectId: project!.id,
            projectName: project!.name,
            serverLinks: projectLinkSummaries(project!.id),
          }))),
        }],
      };
    }
  );

  server.tool(
    "relay_mcp_info",
    "Return Relay MCP route metadata so clients can verify they are calling the Relay server rather than a local shell.",
    {},
    async () => ({
      content: [{
        type: "text",
        text: summarizeJson({
          ...relayRoute("relay_mcp_info"),
          namespace: "relay_",
          version: RELAY_MCP_VERSION,
          transport: "streamable-http",
          mcpPort: MCP_PORT,
          preferredTools: {
            routeCheck: "relay_route_check",
            projectLinks: "relay_project_server_links_list",
            powershell: "relay_exec_remote_powershell",
            script: "relay_exec_remote_script",
            playwrightRuntime: "playwright_runtime_status",
            playwrightRun: "playwright_run_suite",
            playwrightRunStatus: "playwright_run_status",
            jobStatus: "job_status",
            jobList: "job_list",
          },
          legacyAliases: {
            exec_remote: "relay_exec_remote",
            exec_remote_powershell: "relay_exec_remote_powershell",
            exec_remote_script: "relay_exec_remote_script",
            project_server_links_list: "relay_project_server_links_list",
          },
        }),
      }],
    })
  );

  server.tool(
    "relay_core_tools",
    "Return the stable preferred Relay MCP tools and legacy aliases. This tool is read-only and does not contact a remote server.",
    {},
    async () => ({
      content: [{
        type: "text",
        text: summarizeJson({
          ...relayRoute("relay_core_tools"),
          readOnly: true,
          instruction: "Use the preferred relay_* names below for new calls. Do not route remote work through a local shell.",
          preferredTools: {
            routeCheck: "relay_route_check",
            projectLinks: "relay_project_server_links_list",
            powershell: "relay_exec_remote_powershell",
            script: "relay_exec_remote_script",
            playwrightRuntime: "playwright_runtime_status",
            playwrightRun: "playwright_run_suite",
            playwrightRunStatus: "playwright_run_status",
            jobStatus: "job_status",
            jobList: "job_list",
          },
          legacyAliases: {
            exec_remote: "relay_exec_remote",
            exec_remote_powershell: "relay_exec_remote_powershell",
            exec_remote_script: "relay_exec_remote_script",
            project_server_links_list: "relay_project_server_links_list",
          },
        }),
      }],
    })
  );

  server.tool(
    "relay_route_check",
    "Check that the request is being handled by Relay MCP and optionally resolve a project/server target without executing a remote command.",
    {
      project: z.string().optional().describe("Optional project name."),
      environment: z.string().optional().describe("Optional exact environment key."),
      serverId: z.number().int().optional().describe("Optional exact linked server ID."),
      serverName: z.string().optional().describe("Optional exact linked server name."),
    },
    async ({ project: projectName, environment, serverId, serverName }) => {
      const projects = listAllowedProjects();
      const result: Record<string, unknown> = {
        ...relayRoute("relay_route_check"),
        readOnly: true,
        remoteExecutionAttempted: false,
        mcpServerVersion: RELAY_MCP_VERSION,
        mcpPort: MCP_PORT,
        user: user.username,
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          serverLinks: projectLinkSummaries(project.id),
        })),
        selected: null,
      };

      if (projectName || environment || serverId !== undefined || serverName) {
        try {
          const resolvedProjectName = resolveProjectName(projectName);
          const { ps } = getRunner(resolvedProjectName, environment, { serverId, serverName });
          result.selected = {
            project: resolvedProjectName,
            environment: ps.environment,
            serverId: ps.server.id,
            serverName: ps.server.name,
            connectionMode: ps.connectionMode,
            status: ps.server.status,
            agentId: ps.server.agentId,
            limsInstance: ps.limsInstance ? {
              id: ps.limsInstance.id,
              name: ps.limsInstance.name,
              version: ps.limsInstance.version,
              runtimeKind: ps.limsInstance.runtimeKind,
              databaseHost: ps.limsInstance.databaseHost,
              databaseName: ps.limsInstance.databaseName,
            } : undefined,
          };
        } catch (error) {
          result.selectionError = error instanceof Error ? error.message : String(error);
        }
      }

      return { content: [{ type: "text", text: summarizeJson(result) }] };
    }
  );

  server.tool(
    "project_create",
    "Create a Relay-MCP project workspace, optionally link it to a server and create the remote directory",
    {
      name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
      description: z.string().optional(),
      serverId: z.number().optional().describe("Optional existing server id to link"),
      remotePath: z.string().optional().describe("Remote project directory to create when serverId is supplied"),
      environment: z.string().optional().describe("Environment name for the server link, default production"),
    },
    async ({ name, description = "", serverId, remotePath, environment = "production" }) => {
      if (!user.canCreateProjects) throw new Error("This MCP token is not allowed to create projects");
      if (serverId && !remotePath) throw new Error("remotePath is required when serverId is supplied");
      if (serverId) assertServerAllowed(serverId);

      const project = registry.createProject(user.id, user.username, name, description);
      if (user.tokenDbId && !user.allowAllProjects) {
        registry.addTokenProjectScope(user.tokenDbId, project.id);
      }

      let remote: any = undefined;
      if (serverId && remotePath) {
        const linkedServer = registry.getServerForUser(user.id, serverId);
        if (!linkedServer) throw new Error(`Server '${serverId}' not found`);
        registry.linkProjectServer(project.id, serverId, remotePath, environment);
        const runner = new RemoteRunner({
          host: linkedServer.host,
          port: linkedServer.port,
          username: linkedServer.sshUser,
          privateKeyPath: linkedServer.privateKeyPath,
          os: linkedServer.os,
        });
        const mkdirResult = linkedServer.os === "windows"
          ? await runner.execPowerShell(`New-Item -ItemType Directory -Force -LiteralPath ${quotePowerShell(remotePath)} | Out-Null`)
          : await runner.exec(`mkdir -p -- ${quotePosix(remotePath)}`);
        remote = { serverId, remotePath, environment, mkdirExitCode: mkdirResult.code };
      }

      return { content: [{ type: "text", text: summarizeJson({ project, remote }) }] };
    }
  );

  // ── Tool: exec_remote ──────────────────────────────────────────────────────
  server.tool(
    "exec_remote",
    "LEGACY compatibility tool. Prefer relay_exec_remote for new calls; this tool still executes through Relay MCP.",
    {
      project: z.string().optional().describe("Project name. Optional when the MCP token has a default project."),
      command: z.string().describe("Shell command to run"),
      environment: z.string().optional().describe("Target environment (default: production)"),
      serverId: z.number().int().optional().describe("Exact linked server ID. Use project_server_links_list to discover it."),
      serverName: z.string().optional().describe("Exact linked server display name, matched case-insensitively."),
      timeoutMs: z.number().optional().describe("Command timeout in milliseconds (default 60000)"),
      async: z.boolean().optional().describe("Run as an async job and return a jobId."),
    },
    async ({ project: projectName, command, environment, serverId, serverName, timeoutMs = 60000, async = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getRunner(projectName, environment, { serverId, serverName });
      const targetLabel = ps.server.host || ps.server.agentId || ps.server.name;
      const work = async (context?: JobContext) => {
        const result = await runner.exec(command, timeoutMs, executionForJob(context));
        ensureRemoteSuccess(result);
        writeAudit({
          userId: user.id,
          username: user.username,
          project: resolvedProjectName,
          tool: "exec_remote",
          environment: ps.environment,
          serverId: ps.server.id,
          serverName: ps.server.name,
          host: targetLabel,
          command,
          async,
          exitCode: result.code,
        });
        return `[${targetLabel} | env=${ps.environment} | server=${ps.server.name}#${ps.server.id}]\n${summarizeExec(command, result)}`;
      };
      if (async) {
        const job = startJob(user, resolvedProjectName, "exec_remote", { command, environment, serverId, serverName, timeoutMs }, work);
        return {
          content: [{
            type: "text",
            text: summarizeJson({
              ...relayRoute("exec_remote"),
              legacyCompatibility: true,
              dispatch: "queued",
              jobId: job.id,
              status: job.status,
            }),
          }],
        };
      }
      return { content: [{ type: "text", text: `${JSON.stringify(relayRoute("exec_remote"))}\n${await work()}` }] };
    }
  );

  server.tool(
    "exec_remote_powershell",
    "LEGACY compatibility tool. Prefer relay_exec_remote_powershell for new calls; this tool still executes through Relay MCP using EncodedCommand.",
    {
      project: z.string().optional().describe("Project name. Optional when the MCP token has a default project."),
      script: z.string().describe("PowerShell script content to execute"),
      environment: z.string().optional().describe("Target environment (default: production)"),
      serverId: z.number().int().optional().describe("Exact linked server ID. Use project_server_links_list to discover it."),
      serverName: z.string().optional().describe("Exact linked server display name, matched case-insensitively."),
      timeoutMs: z.number().optional().describe("Command timeout in milliseconds (default 120000)"),
      outputFormat: z.enum(["text", "json"]).optional().describe("Output format. Use json when the script emits objects through ConvertTo-Json."),
      maxDepth: z.number().int().min(1).max(20).optional().describe("Maximum JSON object depth returned; default 6."),
      maxArrayItems: z.number().int().min(1).max(5000).optional().describe("Maximum items retained per JSON array; default 200."),
      maxStringLength: z.number().int().min(100).max(100000).optional().describe("Maximum characters retained per JSON string; default 8000."),
      async: z.boolean().optional().describe("Run as an async job and return a jobId."),
    },
    async ({
      project: projectName,
      script,
      environment,
      serverId,
      serverName,
      timeoutMs = 120000,
      outputFormat = "text",
      maxDepth,
      maxArrayItems,
      maxStringLength,
      async = false,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getRunner(projectName, environment, { serverId, serverName });
      const targetLabel = ps.server.host || ps.server.agentId || ps.server.name;
      const work = async (context?: JobContext) => {
        const result = await runner.execPowerShell(script, timeoutMs, executionForJob(context));
        ensureRemoteSuccess(result);
        writeAudit({
          userId: user.id,
          username: user.username,
          project: resolvedProjectName,
          tool: "exec_remote_powershell",
          environment: ps.environment,
          serverId: ps.server.id,
          serverName: ps.server.name,
          host: targetLabel,
          async,
          exitCode: result.code,
        });
        if (outputFormat === "json") {
          const output = result.stdout || result.stderr;
          try {
            const sanitized = sanitizeStructuredOutput(JSON.parse(output), {
              maxDepth,
              maxArrayItems,
              maxStringLength,
            });
            return summarizeJson({
              host: targetLabel,
              serverId: ps.server.id,
              serverName: ps.server.name,
              environment: ps.environment,
              exitCode: result.code,
              output: sanitized.value,
              outputDiagnostics: {
                originalCharacters: output.length,
                truncatedPaths: sanitized.truncatedPaths,
                largestFields: sanitized.largestFields,
              },
            });
          } catch {
            const compact = compactTextWithMetadata(output);
            return summarizeJson({
              host: targetLabel,
              serverId: ps.server.id,
              serverName: ps.server.name,
              environment: ps.environment,
              exitCode: result.code,
              outputFormat: "json",
              parseError: "PowerShell output was not valid JSON. End the script with ConvertTo-Json -Depth <n> -Compress.",
              output: compact.text,
              outputLength: compact.originalLength,
              truncated: compact.truncated,
              stderr: result.stderr || undefined,
            });
          }
        }
        return `[${targetLabel} | env=${ps.environment} | server=${ps.server.name}#${ps.server.id}]\n${summarizeExec("powershell -EncodedCommand <script>", result)}`;
      };
      if (async) {
        const job = startJob(user, resolvedProjectName, "exec_remote_powershell", {
          environment,
          serverId,
          serverName,
          timeoutMs,
          outputFormat,
          maxDepth,
          maxArrayItems,
          maxStringLength,
          scriptLength: script.length,
        }, work);
        return {
          content: [{
            type: "text",
            text: summarizeJson({
              ...relayRoute("exec_remote_powershell"),
              legacyCompatibility: true,
              dispatch: "queued",
              jobId: job.id,
              status: job.status,
            }),
          }],
        };
      }
      return { content: [{ type: "text", text: `${JSON.stringify(relayRoute("exec_remote_powershell"))}\n${await work()}` }] };
    }
  );

  server.tool(
    "exec_remote_script",
    "LEGACY compatibility tool. Prefer relay_exec_remote_script for new calls; this tool still executes through Relay MCP.",
    {
      project: z.string().optional().describe("Project name. Optional when the MCP token has a default project."),
      script: z.string().describe("PowerShell script content to write and execute"),
      environment: z.string().optional().describe("Target environment (default: production)"),
      serverId: z.number().int().optional().describe("Exact linked server ID. Use project_server_links_list to discover it."),
      serverName: z.string().optional().describe("Exact linked server display name, matched case-insensitively."),
      remotePath: z.string().optional().describe("Optional absolute remote .ps1 path; defaults to C:\\Windows\\Temp\\relay-mcp-*.ps1"),
      timeoutMs: z.number().optional().describe("Script timeout in milliseconds (default 120000)"),
      cleanup: z.boolean().optional().describe("Remove the remote script after execution. Default true."),
      preserveOnFailure: z.boolean().optional().describe("Keep the remote script when execution fails. Default false."),
      async: z.boolean().optional().describe("Run as an async job and return a jobId. Default true."),
    },
    async ({
      project: projectName,
      script,
      environment,
      serverId,
      serverName,
      remotePath,
      timeoutMs = 120000,
      cleanup = true,
      preserveOnFailure = false,
      async = true,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getRunner(projectName, environment, { serverId, serverName });
      const targetLabel = ps.server.host || ps.server.agentId || ps.server.name;
      const work = async (context?: JobContext) => {
        const result = await runner.execPowerShellScript(script, {
          remotePath,
          timeout: timeoutMs,
          cleanup,
          preserveOnFailure,
          execution: executionForJob(context),
        });
        ensureRemoteSuccess(result);
        writeAudit({
          userId: user.id,
          username: user.username,
          project: resolvedProjectName,
          tool: "exec_remote_script",
          environment: ps.environment,
          serverId: ps.server.id,
          serverName: ps.server.name,
          host: targetLabel,
          remotePath: result.remotePath,
          cleanedUp: result.cleanedUp,
          async,
          exitCode: result.code,
        });
        return [
          `[${targetLabel} | env=${ps.environment} | server=${ps.server.name}#${ps.server.id}]`,
          `remotePath=${result.remotePath}`,
          `cleanedUp=${result.cleanedUp}`,
          summarizeExec("powershell -File <remote script>", result),
        ].join("\n");
      };
      const job = startJob(user, resolvedProjectName, "exec_remote_script", {
        environment,
        serverId,
        serverName,
        remotePath,
        timeoutMs,
        cleanup,
        preserveOnFailure,
        scriptLength: script.length,
      }, work);
      if (async) {
        return {
          content: [{
            type: "text",
            text: summarizeJson({
              ...relayRoute("exec_remote_script"),
              legacyCompatibility: true,
              dispatch: "queued",
              jobId: job.id,
              status: job.status,
            }),
          }],
        };
      }
      const completed = await waitForTrackedJob(job.id, Math.min(90000, Math.max(1000, timeoutMs)));
      if (completed?.status === "succeeded") {
        return {
          content: [{
            type: "text",
            text: `${JSON.stringify(relayRoute("exec_remote_script"))}\n${completed.summary ?? summarizeJson(completed)}`,
          }],
        };
      }
      if (completed && completed.status !== "running") {
        return { content: [{ type: "text", text: summarizeJson(completed) }] };
      }
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            ...relayRoute("exec_remote_script"),
            jobId: job.id,
            status: completed?.status ?? "running",
            phase: completed?.phase,
            dispatch: "tracked",
            message: "Synchronous wait limit reached; the tracked job continues. Use job_status.",
          }),
        }],
      };
    }
  );

  // Explicit Relay aliases avoid collisions with generic host-provided tools.
  // Reuse the already validated handlers so old MCP clients remain compatible.
  const registeredTools = (server as any)._registeredTools as Record<string, {
    inputSchema: unknown;
    description?: string;
    annotations?: unknown;
    handler: (args: any) => Promise<any>;
  }>;
  const registerRelayAlias = (sourceName: string, aliasName: string, description: string) => {
    const source = registeredTools[sourceName];
    if (!source) throw new Error(`Cannot create Relay alias: source tool '${sourceName}' is not registered`);
    server.registerTool(aliasName, {
      description,
      inputSchema: source.inputSchema as any,
      annotations: source.annotations as any,
    }, async (args: any) => {
      const result = await source.handler(args);
      const routeText = JSON.stringify(relayRoute(aliasName));
      if (result?.content?.length && typeof result.content[0]?.text === "string") {
        return {
          ...result,
          content: [{ ...result.content[0], text: `${routeText}\n${result.content[0].text}` }, ...result.content.slice(1)],
        };
      }
      return result;
    });
  };
  registerRelayAlias("exec_remote", "relay_exec_remote", "PREFERRED: execute a shell command through Relay MCP on the selected linked server.");
  registerRelayAlias("exec_remote_powershell", "relay_exec_remote_powershell", "PREFERRED: execute EncodedCommand PowerShell through Relay MCP on the selected linked server.");
  registerRelayAlias("exec_remote_script", "relay_exec_remote_script", "PREFERRED: upload and execute a PowerShell script through Relay MCP on the selected linked server.");
  registerRelayAlias("project_server_links_list", "relay_project_server_links_list", "PREFERRED: list selectable project server links through Relay MCP.");

  // ── Tools: dedicated Playwright control plane ─────────────────────────────
  server.tool(
    "playwright_runtime_status",
    "Inspect the Agent-owned Node.js, Playwright, Chromium, cache, and installation state without using remote PowerShell.",
    {
      ...playwrightSelectors(),
      timeoutMs: z.number().int().positive().optional().describe("Agent dispatch timeout; default 30000."),
    },
    async ({ project: projectName, environment, serverId, serverName, timeoutMs = 30000 }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getPlaywrightRunner(projectName, environment, { serverId, serverName });
      const runtime = await dispatchPlaywright(runner, { action: "runtime_status" }, timeoutMs);
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            ...relayRoute("playwright_runtime_status"),
            project: resolvedProjectName,
            environment: ps.environment,
            serverId: ps.server.id,
            serverName: ps.server.name,
            connectionMode: ps.connectionMode,
            runtime,
          }),
        }],
      };
    }
  );

  server.tool(
    "relay_unicode_check",
    "Run a read-only SQL/PowerShell/Agent Unicode round-trip diagnostic for the selected LIMS database.",
    {
      project: z.string().optional().describe("Project name."),
      environment: z.string().optional().describe("Exact project environment key."),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      database: z.string().optional().describe("Optional database override; must match the bound instance when one is configured."),
    },
    async ({ project: projectName, environment, serverId, serverName, database }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const target = getSampleManagerDatabaseTarget(projectName, environment, database);
      if (serverId !== undefined || serverName) {
        const selected = getRunner(resolvedProjectName, environment, { serverId, serverName });
        if (selected.ps.server.id !== target.ps.server.id) {
          throw new Error("Unicode check target mismatch: database target and explicit server selector resolved differently");
        }
      }
      const queryId = `unicode-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const startedAt = new Date().toISOString();
      const result = await runUnicodeCheck(target.runner, target.database, target.databaseHost);
      const finishedAt = new Date().toISOString();
      const response = {
        queryId,
        startedAt,
        finishedAt,
        readOnly: true,
        mutationAttempted: false,
        provenance: {
          project: resolvedProjectName,
          environment: target.ps.environment,
          serverId: target.ps.server.id,
          serverName: target.ps.server.name,
          connectionMode: target.ps.connectionMode,
          agentId: target.ps.server.agentId,
          instance: target.configuredInstance?.name,
          instanceVersion: target.configuredInstance?.version,
          databaseHost: target.databaseHost,
          databaseName: target.database,
        },
        ...result,
        rawAgentStdout: undefined,
      };
      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "relay_unicode_check",
        environment: target.ps.environment,
        serverId: target.ps.server.id,
        serverName: target.ps.server.name,
        database: target.database,
        databaseHost: target.databaseHost,
        queryId,
        startedAt,
        finishedAt,
        readOnly: true,
        mutationAttempted: false,
      });
      return {
        structuredContent: response,
        content: [{ type: "text", text: summarizeJson(response) }],
      };
    }
  );

  server.tool(
    "playwright_suite_list",
    "List Playwright suites stored by the selected Relay Agent. This reads the Agent Playwright store directly.",
    {
      ...playwrightSelectors(),
      timeoutMs: z.number().int().positive().optional().describe("Agent dispatch timeout; default 30000."),
    },
    async ({ project: projectName, environment, serverId, serverName, timeoutMs = 30000 }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getPlaywrightRunner(projectName, environment, { serverId, serverName });
      const suites = await dispatchPlaywright(runner, { action: "suite_list" }, timeoutMs);
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            ...relayRoute("playwright_suite_list"),
            project: resolvedProjectName,
            environment: ps.environment,
            serverId: ps.server.id,
            serverName: ps.server.name,
            suites,
          }),
        }],
      };
    }
  );

  server.tool(
    "playwright_suite_upload",
    "Upload a Playwright test file and suite metadata to the selected Agent with a SHA-256 gate. The Agent writes the file into its service-owned Playwright tests directory.",
    {
      ...playwrightSelectors(),
      suite: z.object({
        id: z.string().max(160).optional(),
        name: z.string().min(1).max(200),
        baseUrl: z.string().url(),
        testFile: z.string().min(1).max(240),
        headless: z.boolean().optional().default(true),
        timeoutSeconds: z.number().int().min(10).max(3600).optional().default(120),
        retries: z.number().int().min(0).max(5).optional().default(0),
        enabled: z.boolean().optional().default(true),
      }),
      testFileContent: z.string().min(1).max(5_000_000).describe("UTF-8 Playwright test source."),
      sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe("Expected SHA-256 of the UTF-8 test source. If omitted, Relay calculates it."),
      timeoutMs: z.number().int().positive().optional().describe("Agent dispatch timeout; default 120000."),
    },
    async ({
      project: projectName,
      environment,
      serverId,
      serverName,
      suite,
      testFileContent,
      sha256,
      timeoutMs = 120000,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getPlaywrightRunner(projectName, environment, { serverId, serverName });
      const bytes = Buffer.from(testFileContent, "utf8");
      const calculatedSha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 && sha256.toLowerCase() !== calculatedSha256) {
        throw new Error(`Playwright test file SHA-256 mismatch: expected ${sha256.toLowerCase()}, calculated ${calculatedSha256}`);
      }
      const result = await dispatchPlaywright(
        runner,
        {
          action: "suite_upload",
          suiteJson: JSON.stringify(suite),
          testFileBase64: bytes.toString("base64"),
          expectedSha256: calculatedSha256,
        },
        timeoutMs
      );
      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "playwright_suite_upload",
        environment: ps.environment,
        serverId: ps.server.id,
        serverName: ps.server.name,
        testFile: suite.testFile,
        bytes: bytes.length,
        sha256: calculatedSha256,
      });
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            ...relayRoute("playwright_suite_upload"),
            project: resolvedProjectName,
            environment: ps.environment,
            serverId: ps.server.id,
            serverName: ps.server.name,
            bytes: bytes.length,
            sha256: calculatedSha256,
            suite: (result as any).suite,
            agentVerified: true,
          }),
        }],
      };
    }
  );

  server.tool(
    "playwright_run_suite",
    "Queue a dedicated Playwright test run on the selected Agent. It creates a formal run record for the Agent Client Test Runs page; it does not execute through PowerShell.",
    {
      ...playwrightSelectors(),
      suiteId: z.string().min(1).max(160),
      timeoutMs: z.number().int().positive().optional().describe("Agent queue dispatch timeout; default 120000."),
    },
    async ({ project: projectName, environment, serverId, serverName, suiteId, timeoutMs = 120000 }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getPlaywrightRunner(projectName, environment, { serverId, serverName });
      const requestedRunId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const job = startJob(
        user,
        resolvedProjectName,
        "playwright_run_suite",
        { environment, serverId, serverName, suiteId, timeoutMs, requestedRunId },
        async (context) => {
          const result = await dispatchPlaywright(
            runner,
            { action: "run_suite", suiteId, requestedRunId },
            timeoutMs,
            context
          );
          writeAudit({
            userId: user.id,
            username: user.username,
            project: resolvedProjectName,
            tool: "playwright_run_suite",
            environment: ps.environment,
            serverId: ps.server.id,
            serverName: ps.server.name,
            suiteId,
            runId: requestedRunId,
          });
          return summarizeJson({
            ...relayRoute("playwright_run_suite"),
            project: resolvedProjectName,
            environment: ps.environment,
            serverId: ps.server.id,
            serverName: ps.server.name,
            suiteId,
            runId: requestedRunId,
            status: "queued",
            agentDispatch: result,
          });
        }
      );
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            ...relayRoute("playwright_run_suite"),
            project: resolvedProjectName,
            environment: ps.environment,
            serverId: ps.server.id,
            serverName: ps.server.name,
            jobId: job.id,
            runId: requestedRunId,
            suiteId,
            status: "queued",
            message: "Dedicated Playwright run queued. Use playwright_run_status for the formal run record and job_status for dispatch diagnostics.",
          }),
        }],
      };
    }
  );

  server.tool(
    "playwright_run_status",
    "Read the formal Playwright run record created by the Agent, including pass/fail state, output, duration, and artifact directory.",
    {
      ...playwrightSelectors(),
      runId: z.string().min(1).max(200),
      timeoutMs: z.number().int().positive().optional().describe("Agent dispatch timeout; default 30000."),
    },
    async ({ project: projectName, environment, serverId, serverName, runId, timeoutMs = 30000 }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getPlaywrightRunner(projectName, environment, { serverId, serverName });
      const run = await dispatchPlaywright(runner, { action: "run_status", runId }, timeoutMs);
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            ...relayRoute("playwright_run_status"),
            project: resolvedProjectName,
            environment: ps.environment,
            serverId: ps.server.id,
            serverName: ps.server.name,
            run,
          }),
        }],
      };
    }
  );

  server.tool(
    "playwright_artifact_list",
    "List bounded Playwright artifact metadata on the selected Agent without returning the binary contents.",
    {
      ...playwrightSelectors(),
      maximum: z.number().int().min(1).max(5000).optional().describe("Maximum artifacts to list; default 250."),
      timeoutMs: z.number().int().positive().optional().describe("Agent dispatch timeout; default 30000."),
    },
    async ({ project: projectName, environment, serverId, serverName, maximum = 250, timeoutMs = 30000 }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getPlaywrightRunner(projectName, environment, { serverId, serverName });
      const artifacts = await dispatchPlaywright(runner, { action: "artifact_list", maximum }, timeoutMs);
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            ...relayRoute("playwright_artifact_list"),
            project: resolvedProjectName,
            environment: ps.environment,
            serverId: ps.server.id,
            serverName: ps.server.name,
            artifacts,
          }),
        }],
      };
    }
  );

  server.tool(
    "playwright_artifact_download",
    "Stream a Playwright artifact from the Agent through Relay into the project workspace with byte and SHA-256 verification, then return a short-lived download URL.",
    {
      ...playwrightSelectors(),
      artifactPath: z.string().min(1).describe("Relative path returned by playwright_artifact_list."),
      workspacePath: z.string().min(1).describe("Relative destination path in the Relay project workspace."),
      overwrite: z.boolean().optional().describe("Replace an existing workspace file. Default false."),
      ttlSeconds: z.number().int().min(60).max(3600).optional().describe("Download URL lifetime; default 900 seconds."),
      timeoutMs: z.number().int().positive().optional().describe("Agent transfer timeout; default 1800000."),
      async: z.boolean().optional().describe("Return a Relay job immediately; default true."),
    },
    async ({
      project: projectName,
      environment,
      serverId,
      serverName,
      artifactPath,
      workspacePath,
      overwrite = false,
      ttlSeconds,
      timeoutMs = 1_800_000,
      async = true,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { project, ps, runner } = getPlaywrightRunner(projectName, environment, { serverId, serverName });
      const destination = resolveWorkspacePath(project.workspacePath, workspacePath);
      if (existsSync(destination) && !overwrite) {
        throw new Error(`Relay workspace destination already exists: ${workspacePath}`);
      }
      const work = async (context?: JobContext) => {
        mkdirSync(dirname(destination), { recursive: true });
        const upload = createUploadSession({
          userId: user.id,
          projectId: project.id,
          project: project.name,
          path: workspacePath,
          maxBytes: Number(process.env.RELAY_ARTIFACT_MAX_BYTES ?? 4 * 1024 * 1024 * 1024),
          ttlMs: timeoutMs + 60_000,
        });
        const result = await dispatchPlaywright(
          runner,
          {
            action: "artifact_download",
            artifactPath,
            uploadPath: `/api/uploads/${upload.session.id}`,
            uploadToken: upload.token,
          },
          timeoutMs,
          context
        );
        const finalUpload = getUploadSession(upload.session.id);
        if (finalUpload?.status !== "completed") {
          throw new Error(
            `Playwright artifact upload did not complete; uploadStatus=${finalUpload?.status ?? "missing"}; ` +
            `error=${finalUpload?.error ?? "unknown"}`
          );
        }
        const staged = statSync(destination);
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(destination)) digest.update(chunk);
        const sha256 = digest.digest("hex");
        if (staged.size !== finalUpload.bytesWritten || sha256 !== finalUpload.sha256) {
          throw new Error(
            `Playwright artifact verification mismatch: bytes=${staged.size}/${finalUpload.bytesWritten}, sha256=${sha256}/${finalUpload.sha256}`
          );
        }
        const download = createDownloadSession({
          userId: user.id,
          projectId: project.id,
          project: project.name,
          path: workspacePath,
          bytes: staged.size,
          sha256,
          fileName: basename(destination),
          mtimeMs: staged.mtimeMs,
          ttlMs: ttlSeconds ? ttlSeconds * 1000 : undefined,
        });
        const downloadUrl = `${RELAY_PUBLIC_URL}/api/downloads/${download.session.id}`;
        return summarizeJson({
          ...relayRoute("playwright_artifact_download"),
          project: resolvedProjectName,
          environment: ps.environment,
          serverId: ps.server.id,
          serverName: ps.server.name,
          artifactPath,
          relayWorkspacePath: workspacePath,
          bytes: staged.size,
          sha256,
          sessionId: download.session.id,
          downloadUrl,
          token: download.token,
          expiresAt: download.session.expiresAt,
          agentResult: result,
        });
      };
      const job = startJob(
        user,
        resolvedProjectName,
        "playwright_artifact_download",
        { environment, serverId, serverName, artifactPath, workspacePath, overwrite, timeoutMs, async },
        work
      );
      if (async) {
        return {
          content: [{
            type: "text",
            text: summarizeJson({
              ...relayRoute("playwright_artifact_download"),
              jobId: job.id,
              status: job.status,
              artifactPath,
              relayWorkspacePath: workspacePath,
              message: "Artifact transfer queued. Use job_status to retrieve the verified download URL.",
            }),
          }],
        };
      }
      const completed = await waitForTrackedJob(job.id, Math.min(timeoutMs, 1_800_000));
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            ...relayRoute("playwright_artifact_download"),
            jobId: job.id,
            status: completed?.status ?? "running",
            summary: completed?.summary,
            error: completed?.error,
          }),
        }],
      };
    }
  );

  // ── Tool: deploy ───────────────────────────────────────────────────────────
  server.tool(
    "deploy",
    "Update a remote Git checkout and optionally restart PM2 or Docker workloads. Returns a deployment run record with commits and rollback status.",
    {
      project: z.string().optional().describe("Project name. Optional when the MCP token has a default project."),
      environment: z.string().optional(),
      branch: z.string().optional().describe("Git branch (default: main)"),
      rollbackOnFailure: z.boolean().optional().describe("Reset the checkout to its pre-deploy commit when deployment fails. Default false."),
    },
    async ({ project: projectName, environment, branch = "main", rollbackOnFailure = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getRunner(projectName, environment);
      const remotePath = ps.remotePath;
      const safeBranch = validateGitRef(branch);
      const run = startDeployment({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        environment: environment ?? "production",
        host: ps.server.host,
        branch: safeBranch,
        rollbackRequested: rollbackOnFailure,
      });
      const output: string[] = [];
      const execute = async (label: string, linux: string, windows: string) => {
        const result = ps.server.os === "windows"
          ? await runner.execPowerShell(windows, 120000)
          : await runner.exec(linux, 120000);
        output.push(`${label}\n${summarizeExec(label, result, 4000)}`);
        if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
        return result.stdout.trim();
      };
      const linuxInRepo = (command: string) => `cd -- ${quotePosix(remotePath)} && ${command}`;
      const windowsInRepo = (command: string) =>
        `$ErrorActionPreference = "Stop"\nSet-Location -LiteralPath ${quotePowerShell(remotePath)}\n${command}`;
      let commitBefore: string | undefined;
      let commitAfter: string | undefined;
      let rollback = run.rollback;

      try {
        commitBefore = await execute(
          "git rev-parse HEAD (before)",
          linuxInRepo("git rev-parse HEAD"),
          windowsInRepo("& git rev-parse HEAD\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }")
        );
        await execute(
          "git fetch origin",
          linuxInRepo("git fetch origin"),
          windowsInRepo("& git fetch origin\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }")
        );
        await execute(
          `git checkout ${safeBranch}`,
          linuxInRepo(`git checkout ${quotePosix(safeBranch)}`),
          windowsInRepo(`& git checkout ${quotePowerShell(safeBranch)}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`)
        );
        await execute(
          `git pull --ff-only origin ${safeBranch}`,
          linuxInRepo(`git pull --ff-only origin ${quotePosix(safeBranch)}`),
          windowsInRepo(`& git pull --ff-only origin ${quotePowerShell(safeBranch)}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`)
        );
        commitAfter = await execute(
          "git rev-parse HEAD (after)",
          linuxInRepo("git rev-parse HEAD"),
          windowsInRepo("& git rev-parse HEAD\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }")
        );
        await execute(
          "restart workload",
          linuxInRepo(
            "if command -v pm2 >/dev/null 2>&1; then pm2 restart all; elif [ -f docker-compose.yml ] || [ -f compose.yml ]; then docker compose up -d --build; else echo 'No PM2 or Docker workload found'; fi",
          ),
          windowsInRepo(`if (Get-Command pm2 -ErrorAction SilentlyContinue) { & pm2 restart all; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
elseif ((Test-Path -LiteralPath "docker-compose.yml") -or (Test-Path -LiteralPath "compose.yml")) { & docker compose up -d --build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
else { Write-Output "No PM2 or Docker workload found" }`)
        );
        const compact = compactTextWithMetadata(output.join("\n\n"));
        const record = finishDeployment(run.id, {
          status: "succeeded",
          commitBefore,
          commitAfter,
          rollback: rollbackOnFailure ? { ...rollback, status: "not-needed" } : rollback,
          output: compact.text,
          outputLength: compact.originalLength,
          outputTruncated: compact.truncated,
        });
        writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "deploy", deploymentId: record.id, status: record.status, commitBefore, commitAfter });
        return { content: [{ type: "text", text: summarizeJson(record) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rollbackOnFailure && commitBefore) {
          rollback = { ...rollback, attempted: true };
          const rollbackResult = ps.server.os === "windows"
            ? await runner.execPowerShell(windowsInRepo(`& git reset --hard ${quotePowerShell(commitBefore)}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`), 120000)
            : await runner.exec(linuxInRepo(`git reset --hard ${quotePosix(commitBefore)}`), 120000);
          output.push(`rollback\n${summarizeExec("git reset --hard <previous-commit>", rollbackResult, 4000)}`);
          rollback = rollbackResult.code === 0
            ? { ...rollback, status: "succeeded", commit: commitBefore }
            : { ...rollback, status: "failed", commit: commitBefore, error: rollbackResult.stderr || rollbackResult.stdout };
        }
        const compact = compactTextWithMetadata(output.join("\n\n"));
        const record = finishDeployment(run.id, {
          status: "failed",
          commitBefore,
          commitAfter,
          rollback,
          error: message,
          output: compact.text,
          outputLength: compact.originalLength,
          outputTruncated: compact.truncated,
        });
        writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "deploy", deploymentId: record.id, status: record.status, error: message });
        return { content: [{ type: "text", text: summarizeJson(record) }] };
      }
    }
  );

  // ── Tool: fetch_logs ───────────────────────────────────────────────────────
  server.tool(
    "fetch_logs",
    "Fetch recent file, Windows, systemd, PM2, or Docker logs from the linked server.",
    {
      project: z.string().optional(),
      environment: z.string().optional(),
      lines: z.number().optional().describe("Number of lines (default: 100)"),
      logPath: z.string().optional().describe("Custom log file path"),
      since: z.string().optional().describe("ISO-8601 start time. For file logs this filters files by modification time; journald supports line-level filtering."),
      until: z.string().optional().describe("Optional ISO-8601 end time."),
      deploymentId: z.string().optional().describe("Use the time window of a prior deploy run."),
    },
    async ({ project: projectName, environment, lines = 100, logPath, since, until, deploymentId }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getRunner(projectName, environment);
      const safeLines = Math.max(1, Math.min(Math.trunc(lines), 5000));
      let effectiveSince = since;
      let effectiveUntil = until;
      if (deploymentId) {
        const deployment = getDeployment(deploymentId);
        if (!deployment || deployment.userId !== user.id || deployment.project !== resolvedProjectName) {
          throw new Error(`Deployment '${deploymentId}' was not found for project '${resolvedProjectName}'`);
        }
        effectiveSince = deployment.startedAt;
        effectiveUntil = deployment.finishedAt ?? new Date().toISOString();
      }
      if (effectiveSince && Number.isNaN(Date.parse(effectiveSince))) throw new Error("since must be an ISO-8601 timestamp");
      if (effectiveUntil && Number.isNaN(Date.parse(effectiveUntil))) throw new Error("until must be an ISO-8601 timestamp");
      const windowsTimeFilter = effectiveSince || effectiveUntil
        ? ` | Where-Object { ${effectiveSince ? `$_.LastWriteTime -ge [datetime]${quotePowerShell(effectiveSince)}` : "$true"} -and ${effectiveUntil ? `$_.LastWriteTime -le [datetime]${quotePowerShell(effectiveUntil)}` : "$true"} }`
        : "";
      const journalWindow = [
        effectiveSince ? `--since ${quotePosix(effectiveSince)}` : "",
        effectiveUntil ? `--until ${quotePosix(effectiveUntil)}` : "",
      ].filter(Boolean).join(" ");
      const result = ps.server.os === "windows"
        ? await runner.execPowerShell(logPath
          ? `Get-Content -LiteralPath ${quotePowerShell(logPath)} -Tail ${safeLines} -ErrorAction Stop`
          : `
$root = ${quotePowerShell(ps.remotePath)}
$files = Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in ".log",".txt" }${windowsTimeFilter} |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 5
if ($files) {
  foreach ($file in $files) {
    "===== $($file.FullName) ====="
    Get-Content -LiteralPath $file.FullName -Tail ${safeLines} -ErrorAction SilentlyContinue
  }
}
elseif (Get-Command pm2 -ErrorAction SilentlyContinue) {
  & pm2 logs --nostream --lines ${safeLines}
}
else {
  "No logs found"
}`, 30000)
        : await runner.exec(logPath
          ? `tail -n ${safeLines} -- ${quotePosix(logPath)} 2>&1`
          : `(journalctl -u $(basename -- ${quotePosix(ps.remotePath)}) -n ${safeLines} --no-pager ${journalWindow} 2>/dev/null) || (pm2 logs --nostream --lines ${safeLines} 2>/dev/null) || (find ${quotePosix(`${ps.remotePath.replace(/[\\/]+$/, "")}/logs`)} -type f -name '*.log' -newermt ${effectiveSince ? quotePosix(effectiveSince) : quotePosix("1970-01-01")} -print0 2>/dev/null | xargs -0 tail -n ${safeLines} 2>/dev/null) || echo 'No logs found'`,
          30000);
      const compact = compactTextWithMetadata(result.stdout || result.stderr);
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            deploymentId,
            since: effectiveSince,
            until: effectiveUntil,
            lines: safeLines,
            filtersApplied: ps.server.os === "windows" ? "file modification time" : "journald time window when journald is available",
            output: compact.text,
            outputLength: compact.originalLength,
            truncated: compact.truncated,
          }),
        }],
      };
    }
  );

  // ── Tool: restart_service ──────────────────────────────────────────────────
  server.tool(
    "restart_service",
    "Restart Windows services, systemd units, PM2 processes, or Docker containers using a structured service selector.",
    {
      project: z.string().optional(),
      environment: z.string().optional(),
      service: z.string().describe("Service name or 'all' for all project services"),
    },
    async ({ project: projectName, environment, service }) => {
      const { ps, runner } = getRunner(projectName, environment);
      const safeService = service === "all" ? service : validateServiceName(service);
      const result = ps.server.os === "windows"
        ? await runner.execPowerShell(
          safeService === "all"
            ? `if (Get-Command pm2 -ErrorAction SilentlyContinue) { & pm2 restart all } elseif (Get-Command docker -ErrorAction SilentlyContinue) { & docker compose restart } else { throw "service=all requires PM2 or Docker on Windows" }`
            : safeService.startsWith("docker:")
              ? `& docker restart ${quotePowerShell(safeService.slice(7))}`
              : safeService.startsWith("pm2:")
                ? `& pm2 restart ${quotePowerShell(safeService.slice(4))}`
                : `Restart-Service -Name ${quotePowerShell(safeService.replace(/^windows:/, ""))} -Force -ErrorAction Stop`,
          30000
        )
        : await runner.exec(
          safeService === "all"
            ? "if command -v pm2 >/dev/null 2>&1; then pm2 restart all; elif command -v docker >/dev/null 2>&1; then docker compose restart; else echo 'service=all requires PM2 or Docker' >&2; exit 2; fi"
            : safeService.startsWith("docker:")
              ? `docker restart ${quotePosix(safeService.slice(7))}`
              : safeService.startsWith("pm2:")
                ? `pm2 restart ${quotePosix(safeService.slice(4))}`
                : `sudo systemctl restart -- ${quotePosix(safeService.replace(/^systemd:/, ""))}`,
          30000
        );
      return { content: [{ type: "text", text: compactText(`${result.stdout}\n${result.stderr}`) }] };
    }
  );

  // ── Tool: read_remote_file ─────────────────────────────────────────────────
  server.tool(
    "read_remote_file",
    "Read a text file from the remote server. Use async=true for large or slow files so the job can be checked without retrying the remote read.",
    {
      project: z.string().optional(),
      remotePath: z.string().describe("Absolute path on remote server"),
      environment: z.string().optional(),
      timeoutMs: z.number().optional().describe("Read timeout in milliseconds (default 30000)"),
      async: z.boolean().optional().describe("Run as an async job and return a jobId"),
    },
    async ({ project: projectName, remotePath, environment, timeoutMs = 30000, async = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getRunner(projectName, environment);
      const work = async (context?: JobContext) => {
        context?.phase("reading_remote_file");
        const content = await runner.readFile(remotePath, timeoutMs, executionForJob(context));
        writeAudit({
          userId: user.id,
          username: user.username,
          project: resolvedProjectName,
          tool: "read_remote_file",
          environment: environment ?? "production",
          host: ps.server.host,
          remotePath,
          bytes: Buffer.byteLength(content, "utf8"),
        });
        return summarizeJson({
          host: ps.server.host,
          remotePath,
          content: compactTextWithMetadata(content),
        });
      };
      if (async) {
        const job = startJob(user, resolvedProjectName, "read_remote_file", { remotePath, environment, timeoutMs }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "download_remote_file",
    "Download a remote file into the Relay project workspace and create a short-lived URL for streaming it into the agent's local workspace.",
    {
      project: z.string().optional(),
      remotePath: z.string().describe("Absolute source path on the remote server"),
      workspacePath: z.string().describe("Relative staging path in the Relay project workspace"),
      environment: z.string().optional(),
      overwrite: z.boolean().optional().describe("Replace an existing Relay workspace file. Default false."),
      ttlSeconds: z.number().int().min(60).max(3600).optional().describe("Local download URL lifetime. Default 900 seconds."),
      timeoutMs: z.number().int().positive().optional().describe("Remote-to-Relay transfer timeout. Default 1800000 milliseconds."),
    },
    async ({ project: projectName, remotePath, workspacePath: relPath, environment, overwrite = false, ttlSeconds, timeoutMs = 1_800_000 }) => {
      const { project, ps, runner } = getRunner(projectName, environment);
      const destination = resolveWorkspacePath(project.workspacePath, relPath);
      if (existsSync(destination) && !overwrite) {
        throw new Error(`Relay workspace destination already exists: ${relPath}`);
      }
      mkdirSync(dirname(destination), { recursive: true });
      let bytes: number;
      if (ps.connectionMode === "agent") {
        if (!ps.server.agentId) {
          throw new Error(`Agent server '${ps.server.name}' has no Agent ID`);
        }
        const upload = createUploadSession({
          userId: user.id,
          projectId: project.id,
          project: project.name,
          path: relPath,
          maxBytes: Number(process.env.RELAY_ARTIFACT_MAX_BYTES ?? 4 * 1024 * 1024 * 1024),
          ttlMs: timeoutMs + 60_000,
        });
        const agentStore = getAgentStore();
        agentStore.assertOnline(user.id, ps.server.agentId);
        const agentJob = agentStore.enqueueJob(
          user.id,
          ps.server.agentId,
          "artifact-upload",
          {
            remotePath,
            uploadPath: `/api/uploads/${upload.session.id}`,
            uploadToken: upload.token,
          },
          timeoutMs
        );
        const completed = await agentStore.waitForJob(agentJob.id, timeoutMs);
        const finalUpload = getUploadSession(upload.session.id);
        if (completed.status !== "completed" || finalUpload?.status !== "completed") {
          throw new Error(
            `Agent artifact transfer failed; jobId=${agentJob.id}; ` +
            `jobStatus=${completed.status}; uploadStatus=${finalUpload?.status ?? "missing"}; ` +
            `error=${completed.result?.stderr ?? finalUpload?.error ?? "unknown"}`
          );
        }
        bytes = finalUpload.bytesWritten ?? 0;
      } else {
        const tempPath = `${destination}.relay-download-${Date.now()}.tmp`;
        try {
          ({ bytes } = await runner.downloadFile(remotePath, tempPath));
          if (existsSync(destination)) rmSync(destination, { force: true });
          renameSync(tempPath, destination);
        } catch (error) {
          if (existsSync(tempPath)) rmSync(tempPath, { force: true });
          throw error;
        }
      }
      const staged = statSync(destination);
      if (!staged.isFile() || staged.size !== bytes) {
        throw new Error(`Staged artifact size mismatch: reported=${bytes}, actual=${staged.size}`);
      }
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(destination)) digest.update(chunk);
      const sha256 = digest.digest("hex");
      const { session, token } = createDownloadSession({
        userId: user.id,
        projectId: project.id,
        project: project.name,
        path: relPath,
        bytes,
        sha256,
        fileName: basename(destination),
        mtimeMs: staged.mtimeMs,
        ttlMs: ttlSeconds ? ttlSeconds * 1000 : undefined,
      });
      const downloadUrl = `${RELAY_PUBLIC_URL}/api/downloads/${session.id}`;
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            remote: {
              serverId: ps.server.id,
              serverName: ps.server.name,
              connectionMode: ps.connectionMode,
              path: remotePath.replace(/\\/g, "/"),
            },
            relayWorkspacePath: relPath,
            bytes,
            sha256,
            contentType: session.contentType,
            sessionId: session.id,
            downloadUrl,
            token,
            expiresAt: session.expiresAt,
            command: `npm run relay-download -- --url ${downloadUrl} --token <token> --file <local-file> --expected-bytes ${bytes} --expected-sha256 ${sha256}`,
          }),
        }],
      };
    }
  );

  // ── Tool: write_remote_file ────────────────────────────────────────────────
  server.tool(
    "write_remote_file",
    "Write content to a file on the remote server",
    {
      project: z.string().optional(),
      remotePath: z.string().describe("Absolute path on remote server"),
      content: z.string().describe("File content"),
      environment: z.string().optional(),
    },
    async ({ project: projectName, remotePath, content, environment }) => {
      const { runner } = getRunner(projectName, environment);
      await runner.writeFile(remotePath, content);
      return { content: [{ type: "text", text: `Written to ${remotePath}` }] };
    }
  );

  // ── Tool: list_remote_files ────────────────────────────────────────────────
  server.tool(
    "list_remote_files",
    "List files in a directory on the remote server",
    {
      project: z.string().optional(),
      remotePath: z.string().describe("Absolute directory path on remote server"),
      environment: z.string().optional(),
    },
    async ({ project: projectName, remotePath, environment }) => {
      const { runner } = getRunner(projectName, environment);
      const entries = await runner.listDir(remotePath);
      return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
    }
  );

  // ── Tool: read_local_file ──────────────────────────────────────────────────
  server.tool(
    "read_local_file",
    "Read a file from the project workspace on the MCP server",
    {
      project: z.string().optional(),
      path: z.string().describe("Relative path within project workspace"),
    },
    async ({ project: projectName, path: relPath }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const project = registry.getProject(user.id, resolvedProjectName);
      if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);

      const fullPath = resolveWorkspacePath(project.workspacePath, relPath, { mustExist: true });
      const content = readFileSync(fullPath, "utf8");
      return { content: [{ type: "text", text: content }] };
    }
  );

  server.tool(
    "workspace_info",
    "Show the Relay workspace root and bounded file listing so callers can distinguish Relay workspace paths from Codex local paths.",
    {
      project: z.string().optional(),
      path: z.string().optional().describe("Relative path inside the Relay workspace; default project root"),
      maxDepth: z.number().int().min(0).max(5).optional().describe("Maximum directory depth; default 2"),
      maxEntries: z.number().int().min(1).max(1000).optional().describe("Maximum entries returned; default 200"),
    },
    async ({ project: projectName, path: relPath = "", maxDepth = 2, maxEntries = 200 }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const project = registry.getProject(user.id, resolvedProjectName);
      if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);
      const root = resolveWorkspacePath(project.workspacePath, relPath);
      const entries: Array<{ path: string; type: "file" | "directory"; bytes?: number; modifiedAt: string }> = [];
      const visit = (current: string, depth: number) => {
        if (entries.length >= maxEntries || depth > maxDepth) return;
        for (const name of readdirSync(current).sort()) {
          if (entries.length >= maxEntries) break;
          const fullPath = resolveWorkspacePath(project.workspacePath, relative(project.workspacePath, join(current, name)), { mustExist: true });
          const stat = statSync(fullPath);
          const item = {
            path: relative(project.workspacePath, fullPath).replace(/\\/g, "/"),
            type: stat.isDirectory() ? "directory" as const : "file" as const,
            bytes: stat.isFile() ? stat.size : undefined,
            modifiedAt: stat.mtime.toISOString(),
          };
          entries.push(item);
          if (stat.isDirectory()) visit(fullPath, depth + 1);
        }
      };
      if (existsSync(root) && statSync(root).isDirectory()) visit(root, 0);
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            project: resolvedProjectName,
            relayWorkspaceRoot: project.workspacePath,
            requestedPath: relPath || ".",
            resolvedPath: root,
            entries,
            truncated: entries.length >= maxEntries,
            note: "Codex local absolute paths are not readable by the Relay server; upload them through create_workspace_upload.",
          }),
        }],
      };
    }
  );

  // ── Tool: sync_workspace ──────────────────────────────────────────────────
  server.tool(
    "sync_workspace",
    "Sync the entire project workspace to the linked remote server via SFTP (no size limit). Excludes node_modules, .git, dist, .env by default.",
    {
      project: z.string().optional(),
      environment: z.string().optional(),
      remoteDir: z.string().optional().describe("Override remote destination path (default: project's remotePath)"),
      exclude: z.array(z.string()).optional().describe("Additional patterns to exclude"),
    },
    async ({ project: projectName, environment, remoteDir, exclude }) => {
      const { project, ps, runner } = getRunner(projectName, environment);
      const dest = remoteDir ?? ps.remotePath;
      const { transferred, failed } = await runner.syncDir(project.workspacePath, dest, { exclude });
      const msg = `Synced ${transferred} file(s) to ${ps.server.host}:${dest}` +
        (failed.length ? `\nFailed (${failed.length}): ${failed.join(", ")}` : "");
      return { content: [{ type: "text", text: msg }] };
    }
  );

  // ── Tool: upload_workspace_file ────────────────────────────────────────────
  server.tool(
    "upload_workspace_file",
    "Upload one Relay workspace file to the linked server and verify local/remote SHA-256.",
    {
      project: z.string().optional(),
      localPath: z.string().describe("Relative path within project workspace"),
      remotePath: z.string().describe("Absolute destination path on remote server"),
      environment: z.string().optional(),
    },
    async ({ project: projectName, localPath: relPath, remotePath, environment }) => {
      const { project, ps, runner } = getRunner(projectName, environment);
      const fullLocal = resolveWorkspacePath(project.workspacePath, relPath, { mustExist: true });
      const stat = statSync(fullLocal);
      if (!stat.isFile()) throw new Error(`Workspace path is not a file: ${relPath}`);
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(fullLocal)) digest.update(chunk);
      const localSha256 = digest.digest("hex");
      await runner.uploadFile(fullLocal, remotePath);
      const hashResult = ps.server.os === "windows"
        ? await runner.execPowerShell(
            `[Console]::Write((Get-FileHash -LiteralPath ${quotePowerShell(remotePath)} -Algorithm SHA256).Hash.ToLowerInvariant())`,
            60000
          )
        : await runner.exec(`sha256sum -- ${quotePosix(remotePath)} | awk '{print $1}'`, 60000);
      ensureRemoteSuccess(hashResult);
      const remoteSha256 = hashResult.stdout.trim().toLowerCase();
      if (remoteSha256 !== localSha256) {
        throw new Error(`Upload SHA-256 mismatch: local=${localSha256}, remote=${remoteSha256}`);
      }
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            localPath: relPath,
            remotePath,
            bytes: stat.size,
            localSha256,
            remoteSha256,
            verified: true,
          }),
        }],
      };
    }
  );

  // ── Tool: write_local_file ─────────────────────────────────────────────────
  server.tool(
    "write_local_file",
    "Write (or append) a file to the project workspace. Use append=true for chunked writes of large files — call repeatedly with sequential chunks, then upload_workspace_file or sync_workspace once done.",
    {
      project: z.string().optional(),
      path: z.string().describe("Relative path within project workspace"),
      content: z.string().describe("File content (or next chunk if append=true)"),
      append: z.boolean().optional().describe("If true, append to existing file instead of overwriting. Default false."),
    },
    async ({ project: projectName, path: relPath, content, append = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const project = registry.getProject(user.id, resolvedProjectName);
      if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);

      const fullPath = resolveWorkspacePath(project.workspacePath, relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      if (append) {
        appendFileSync(fullPath, content, "utf8");
      } else {
        writeFileSync(fullPath, content, "utf8");
      }
      const bytes = Buffer.byteLength(content, "utf8");
      return { content: [{ type: "text", text: `${append ? "Appended" : "Written"} ${bytes} bytes → ${relPath}` }] };
    }
  );

  server.tool(
    "write_local_binary",
    "Write a small binary file to the Relay project workspace from Base64. Use create_workspace_upload for large files.",
    {
      project: z.string().optional(),
      path: z.string().describe("Relative destination path within the project workspace"),
      base64: z.string().describe("Base64-encoded file content"),
    },
    async ({ project: projectName, path: relPath, base64 }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const project = registry.getProject(user.id, resolvedProjectName);
      if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);
      const content = Buffer.from(base64, "base64");
      const limit = Number(process.env.MCP_BINARY_WRITE_LIMIT ?? 8 * 1024 * 1024);
      if (content.length > limit) {
        throw new Error(`Binary content exceeds ${limit} bytes; use create_workspace_upload`);
      }
      const fullPath = resolveWorkspacePath(project.workspacePath, relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content);
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            path: relPath,
            bytes: content.length,
            sha256: createHash("sha256").update(content).digest("hex"),
          }),
        }],
      };
    }
  );

  server.tool(
    "list_workspace_files",
    "List files and directories in a Relay project workspace with optional bounded recursion.",
    {
      project: z.string().optional(),
      path: z.string().optional().describe("Relative directory path; defaults to workspace root"),
      recursive: z.boolean().optional().describe("Recursively list descendants; default false"),
      maxEntries: z.number().int().positive().optional().describe("Maximum entries returned; default 500, maximum 5000"),
    },
    async ({ project: projectName, path: relPath = "", recursive = false, maxEntries = 500 }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const project = registry.getProject(user.id, resolvedProjectName);
      if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);
      const root = resolveWorkspacePath(project.workspacePath, relPath, { allowRoot: true, mustExist: true });
      const rootStat = statSync(root);
      if (!rootStat.isDirectory()) throw new Error(`Workspace path is not a directory: ${relPath}`);
      const limit = Math.min(maxEntries, 5000);
      const entries: Array<Record<string, unknown>> = [];
      const visit = (directory: string) => {
        for (const name of readdirSync(directory)) {
          if (entries.length >= limit) return;
          const fullPath = resolveWorkspacePath(project.workspacePath, relative(project.workspacePath, join(directory, name)), {
            mustExist: true,
          });
          const stat = lstatSync(fullPath);
          entries.push({
            path: relative(project.workspacePath, fullPath).replace(/\\/g, "/"),
            type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
            size: stat.isFile() ? stat.size : undefined,
            modifiedAt: stat.mtime.toISOString(),
          });
          if (recursive && stat.isDirectory() && !stat.isSymbolicLink()) visit(fullPath);
        }
      };
      visit(root);
      return { content: [{ type: "text", text: summarizeJson({ entries, truncated: entries.length >= limit }) }] };
    }
  );

  server.tool(
    "workspace_file_stat",
    "Return size, timestamps, type, and optional SHA-256 for a Relay workspace file.",
    {
      project: z.string().optional(),
      path: z.string(),
      sha256: z.boolean().optional().describe("Calculate SHA-256 for files; default false"),
    },
    async ({ project: projectName, path: relPath, sha256 = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const project = registry.getProject(user.id, resolvedProjectName);
      if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);
      const fullPath = resolveWorkspacePath(project.workspacePath, relPath, { mustExist: true });
      const stat = statSync(fullPath);
      let hash: string | undefined;
      if (sha256 && stat.isFile()) {
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(fullPath)) digest.update(chunk);
        hash = digest.digest("hex");
      }
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            path: relPath,
            type: stat.isDirectory() ? "directory" : "file",
            size: stat.isFile() ? stat.size : undefined,
            createdAt: stat.birthtime.toISOString(),
            modifiedAt: stat.mtime.toISOString(),
            sha256: hash,
          }),
        }],
      };
    }
  );

  server.tool(
    "move_workspace_file",
    "Move or rename a file or directory inside the same Relay project workspace.",
    {
      project: z.string().optional(),
      from: z.string().describe("Existing relative source path"),
      to: z.string().describe("Relative destination path"),
      overwrite: z.boolean().optional().describe("Replace an existing destination; default false"),
    },
    async ({ project: projectName, from, to, overwrite = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const project = registry.getProject(user.id, resolvedProjectName);
      if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);
      const source = resolveWorkspacePath(project.workspacePath, from, { mustExist: true });
      const destination = resolveWorkspacePath(project.workspacePath, to);
      if (existsSync(destination)) {
        if (!overwrite) throw new Error(`Destination already exists: ${to}`);
        rmSync(destination, { recursive: true, force: true });
      }
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(source, destination);
      return { content: [{ type: "text", text: `Moved ${from} → ${to}` }] };
    }
  );

  server.tool(
    "delete_workspace_file",
    "Delete a file or directory from a Relay project workspace. Recursive directory deletion must be explicitly enabled.",
    {
      project: z.string().optional(),
      path: z.string(),
      recursive: z.boolean().optional().describe("Allow recursive directory deletion; default false"),
    },
    async ({ project: projectName, path: relPath, recursive = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const project = registry.getProject(user.id, resolvedProjectName);
      if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);
      const fullPath = resolveWorkspacePath(project.workspacePath, relPath, { mustExist: true });
      const stat = statSync(fullPath);
      if (stat.isDirectory() && !recursive) {
        throw new Error("Directory deletion requires recursive=true");
      }
      rmSync(fullPath, { recursive, force: false });
      return { content: [{ type: "text", text: `Deleted ${relPath}` }] };
    }
  );

  server.tool(
    "create_workspace_upload",
    "Create a short-lived authenticated upload URL for streaming a large local binary file into the Relay workspace.",
    {
      project: z.string().optional(),
      path: z.string().describe("Relative destination path in the Relay workspace"),
      maxBytes: z.number().int().positive().optional(),
      expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
      ttlSeconds: z.number().int().min(60).max(3600).optional(),
    },
    async ({ project: projectName, path: relPath, maxBytes, expectedSha256, ttlSeconds }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const project = registry.getProject(user.id, resolvedProjectName);
      if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);
      resolveWorkspacePath(project.workspacePath, relPath);
      const { session, token } = createUploadSession({
        userId: user.id,
        projectId: project.id,
        project: project.name,
        path: relPath,
        maxBytes,
        expectedSha256,
        ttlMs: ttlSeconds ? ttlSeconds * 1000 : undefined,
      });
      const uploadUrl = `${RELAY_PUBLIC_URL}/api/uploads/${session.id}`;
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            upload: publicUploadSession(session),
            uploadUrl,
            uploadToken: token,
            headers: { "X-Relay-Upload-Token": token },
            command: `npm run relay-upload -- --url ${uploadUrl} --token <uploadToken> --file <local-file>`,
            curl: `curl --fail-with-body -X PUT -H "Content-Type: application/octet-stream" -H "X-Relay-Upload-Token: <uploadToken>" --data-binary "@<local-file>" "${uploadUrl}"`,
            relayWorkspaceRoot: project.workspacePath,
          }),
        }],
      };
    }
  );

  server.tool(
    "cleanup_workspace_staging",
    "Preview or remove old entries from the reserved .relay-staging directory in a project workspace.",
    {
      project: z.string().optional(),
      olderThanMinutes: z.number().positive().optional().describe("Only include entries older than this age; default 1440"),
      dryRun: z.boolean().optional().describe("Preview without deleting; default true"),
    },
    async ({ project: projectName, olderThanMinutes = 1440, dryRun = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const project = registry.getProject(user.id, resolvedProjectName);
      if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);
      const staging = resolveWorkspacePath(project.workspacePath, ".relay-staging");
      if (!existsSync(staging)) {
        return { content: [{ type: "text", text: summarizeJson({ dryRun, entries: [] }) }] };
      }
      const cutoff = Date.now() - olderThanMinutes * 60_000;
      const entries = readdirSync(staging)
        .map((name) => {
          const fullPath = resolveWorkspacePath(project.workspacePath, `.relay-staging/${name}`, { mustExist: true });
          return { name, fullPath, modifiedAt: statSync(fullPath).mtime };
        })
        .filter((entry) => entry.modifiedAt.getTime() <= cutoff);
      if (!dryRun) {
        for (const entry of entries) rmSync(entry.fullPath, { recursive: true, force: true });
      }
      return {
        content: [{
          type: "text",
          text: summarizeJson({
            dryRun,
            entries: entries.map((entry) => ({ name: entry.name, modifiedAt: entry.modifiedAt.toISOString() })),
          }),
        }],
      };
    }
  );

  // ── Tool: patch_remote_file ────────────────────────────────────────────────
  server.tool(
    "patch_remote_file",
    "Apply a unified diff (patch) to a file on the remote server. Far more token-efficient than rewriting the whole file — only send what changed. The diff must be in standard unified diff format (diff -u / git diff).",
    {
      project: z.string().optional(),
      remotePath: z.string().describe("Absolute path to the file on the remote server"),
      diff: z.string().describe("Unified diff string (output of `diff -u old new` or `git diff`)"),
      environment: z.string().optional(),
    },
    async ({ project: projectName, remotePath, diff, environment }) => {
      const { ps, runner } = getRunner(projectName, environment);
      const { linesChanged } = await runner.patchFile(remotePath, diff);
      return {
        content: [{ type: "text", text: `Patched ${ps.server.host}:${remotePath} (${linesChanged} lines changed)` }],
      };
    }
  );

  // ── Tool: job status and history ──────────────────────────────────────────
  server.tool(
    "job_status",
    "Get status/result for an asynchronous Relay-MCP job",
    {
      jobId: z.string().describe("Job id returned by an async tool"),
    },
    async ({ jobId }) => {
      const job = getJob(jobId);
      if (!job || job.userId !== user.id) throw new Error(`Job '${jobId}' not found`);
      const snapshot = {
        ...job,
        executionState:
          job.status === "succeeded" ? "Completed"
          : job.status === "failed" ? "Failed"
          : job.status === "unknown" || job.status === "interrupted" ? "Unknown"
          : job.status === "cancelled" ? "Cancelled"
          : job.phase === "not_started" ? "NotStarted"
          : "Running",
        dispatchState:
          job.status === "unknown" || job.phase === "unknown" ? "remote_completion_unknown"
          : job.phase === "agent_claimed" ? "agent_claimed"
          : job.phase === "waiting_agent" ? "waiting_agent"
          : job.phase === "queued" ? "queued"
          : job.phase === "connecting" ? "connecting"
          : job.status === "succeeded" ? "completed"
          : job.status === "failed" ? "remote_or_relay_failed"
          : job.status,
        agentClaimedAt: job.logs?.find((entry) => entry.message === "phase=agent_claimed")?.at,
        logs: job.logs?.slice(-40),
        summary: job.summary ? compactTextWithMetadata(job.summary, 6000) : undefined,
      };
      return { content: [{ type: "text", text: summarizeJson(snapshot) }] };
    }
  );

  server.tool(
    "job_list",
    "List recent asynchronous Relay-MCP jobs for the current user",
    {
      limit: z.number().optional().describe("Maximum jobs to return (default 20)"),
    },
    async ({ limit = 20 }) => {
      const jobs = listJobs(user.id, limit).map((job) => ({
        ...job,
        logs: job.logs?.slice(-8),
        summary: job.summary ? compactTextWithMetadata(job.summary, 1200) : undefined,
      }));
      return { content: [{ type: "text", text: summarizeJson(jobs) }] };
    }
  );

  server.tool(
    "job_cancel",
    "Request cancellation of a running asynchronous Relay-MCP job and close its active SSH command when supported.",
    {
      jobId: z.string().describe("Running job id returned by an async tool"),
    },
    async ({ jobId }) => {
      return { content: [{ type: "text", text: summarizeJson(cancelJob(jobId, user.id)) }] };
    }
  );

  // ── Tool: project context memory ──────────────────────────────────────────
  server.tool(
    "context_record_fact",
    "Record a durable project fact so future LLM calls do not need chat history",
    {
      project: z.string().optional(),
      text: z.string().describe("Short fact, pitfall, path, or project convention"),
      tags: z.array(z.string()).optional(),
    },
    async ({ project, text, tags = [] }) => {
      const resolvedProjectName = resolveProjectName(project);
      const fact = recordFact(user, resolvedProjectName, text, tags);
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "context_record_fact", tags });
      return { content: [{ type: "text", text: summarizeJson(fact) }] };
    }
  );

  server.tool(
    "context_search",
    "Search durable project facts recorded on the MCP server",
    {
      project: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ project, query = "", limit = 10 }) => {
      const resolvedProjectName = resolveProjectName(project);
      return { content: [{ type: "text", text: summarizeJson(searchFacts(user.id, resolvedProjectName, query, limit)) }] };
    }
  );

  // ── SampleManager high-level tools ────────────────────────────────────────
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
        environment: environment ?? "production",
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
          resultSets: selectedResult,
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
        includeResultSets: true,
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
          updateDeployment(run.id, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
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
        const result = JSON.parse(resultText) as Record<string, unknown>;
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
      configuration: z.string().optional().describe("Default Release"),
      msbuildPath: z.string().optional().describe("Optional explicit MSBuild.exe path"),
      environment: z.string().optional(),
      deploymentId: z.string().optional(),
      timeoutMs: z.number().positive().optional().describe("Default 600000"),
      async: z.boolean().optional().describe("Run as an async job; recommended"),
    },
    async ({
      project: projectName,
      projectOrSolutionPath,
      configuration = "Release",
      msbuildPath,
      environment,
      deploymentId,
      timeoutMs = 600000,
      async = true,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner, ps } = getRunner(projectName, environment);
      const buildProfile = ps.limsInstance?.buildProfile ?? {};
      const work = (context?: JobContext) => withDeploymentStep(
        deploymentId,
        resolvedProjectName,
        `build:${basename(projectOrSolutionPath)}`,
        () => buildSampleManagerProject(
          runner,
          projectOrSolutionPath,
          configuration,
          msbuildPath,
          buildProfile,
          timeoutMs,
          executionForJob(context)
        )
      );
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_build_dotnet", projectOrSolutionPath, configuration, async });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_build_dotnet", { projectOrSolutionPath, configuration, msbuildPath, environment, deploymentId, timeoutMs }, work);
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
      restart: z.boolean().optional().describe("Restart SampleManager after deploy. Default true."),
      rollbackOnFailure: z.boolean().optional().describe("Restore the timestamped backup if a later phase fails. Default true."),
      environment: z.string().optional(),
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
      restart = true,
      rollbackOnFailure = true,
      environment,
      timeoutMs = 600000,
      async = true,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner, instance: instanceTarget, instanceName, configuredInstance } =
        getSampleManagerTarget(projectName, environment, instance);
      const buildProfile = configuredInstance?.buildProfile ?? {};
      const target = targetRelativePath ?? basename(assemblyPath);
      const steps: Array<{
        name: string;
        status: "pending" | "running" | "succeeded" | "failed" | "rolled-back";
        startedAt?: string;
        finishedAt?: string;
        summary?: string;
        error?: string;
      }> = [
        { name: "build", status: "pending" },
        { name: "deploy", status: "pending" },
        { name: "restart", status: restart ? "pending" : "succeeded", summary: restart ? undefined : "Skipped by request" },
      ];
      const run = startDeployment({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        environment: environment ?? "production",
        host: ps.server.host || ps.server.agentId || ps.server.name,
        kind: "samplemanager-assembly",
        instance: instanceName,
        steps,
        artifacts: { projectOrSolutionPath, assemblyPath, targetRelativePath: target },
        rollbackRequested: rollbackOnFailure,
      });

      const setStep = (
        name: string,
        status: "pending" | "running" | "succeeded" | "failed" | "rolled-back",
        summary?: string,
        error?: string
      ) => {
        const step = steps.find((item) => item.name === name)!;
        step.status = status as any;
        if (status === "running") step.startedAt = new Date().toISOString();
        if (["succeeded", "failed", "rolled-back"].includes(status)) step.finishedAt = new Date().toISOString();
        step.summary = summary;
        step.error = error;
        updateDeployment(run.id, { steps: steps as any });
      };

      const work = async (context?: JobContext) => {
        const output: string[] = [];
        let backupPath: string | undefined;
        try {
          setStep("build", "running");
          const buildOutput = await buildSampleManagerProject(
            runner,
            projectOrSolutionPath,
            configuration,
            msbuildPath,
            buildProfile,
            timeoutMs,
            executionForJob(context)
          );
          output.push(`build\n${buildOutput}`);
          setStep("build", "succeeded", compactText(buildOutput, 1500));

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
            const parsed = JSON.parse(deployOutput);
            backupPath = parsed.backup ?? undefined;
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
            setStep("restart", "succeeded", compactText(restartOutput, 1500));
          }

          const compact = compactTextWithMetadata(output.join("\n\n"));
          finishDeployment(run.id, {
            status: "succeeded",
            rollback: { ...run.rollback, status: "not-needed" },
            steps: steps as any,
            output: compact.text,
            outputLength: compact.originalLength,
            outputTruncated: compact.truncated,
          });
          return summarizeJson(getDeployment(run.id));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const runningStep = steps.find((step) => step.status === "running");
          if (runningStep) setStep(runningStep.name, "failed", undefined, message);
          let rollback = run.rollback;
          if (rollbackOnFailure && backupPath) {
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
          finishDeployment(run.id, {
            status: "failed",
            rollback,
            steps: steps as any,
            output: compactText(output.join("\n\n")),
            error: message,
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
        instance: instanceName,
        assemblyPath,
        target,
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

  return server;
}

// ─── Express app with per-request MCP instances ───────────────────────────────
const app = express();
app.use(express.json());

app.all("/mcp", async (req, res) => {
  let user: McpUser;
  try {
    user = verifyToken(req);
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body as { method?: string; params?: { name?: string; arguments?: unknown } };
  if (body?.method === "tools/call" && body.params?.name) {
    const metadata = TOOL_CATALOG_BY_NAME.get(body.params.name);
    writeAudit({
      event: "tool_called",
      userId: user.id,
      username: user.username,
      tool: body.params.name,
      category: metadata?.category ?? "unclassified",
      description: metadata?.description,
      arguments: auditArguments(body.params.arguments),
    });
  }

  const server = createMcpServer(user);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp/health", (_req, res) => {
  res.json({
    ok: true,
    route: "relay_mcp",
    namespace: "relay_",
    version: "0.6.3",
    transport: "streamable-http",
    mcpPort: MCP_PORT,
  });
});

app.listen(MCP_PORT, "0.0.0.0", () => {
  console.log(`MCP server running on port ${MCP_PORT}`);
});
