import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDiagnosticTools } from "./tools/diagnostics.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerProjectTools } from "./tools/project.js";
import { registerRemoteTools } from "./tools/remote.js";
import { registerWorkspaceTools } from "./tools/workspace.js";
import { registerPlaywrightTools } from "./tools/playwright.js";
import { registerSampleManagerTools } from "./tools/samplemanager.js";
import { registerDeploymentTools } from "./tools/deployment.js";
import { registerDeploymentLogTools } from "./tools/deployment-logs.js";
import { getSharedProjectRegistry, ProjectRegistry } from "./project-registry.js";
import { RemoteRunner } from "../shared/remote-runner.js";
import { AgentRemoteRunner } from "../shared/agent-remote-runner.js";
import { selectProjectTarget } from "../shared/project-target-selection.js";
import { compactText } from "../shared/output.js";
import { getJob, type JobContext } from "../shared/job-store.js";
import type { JobRecord } from "../shared/job-store.js";
import type { ProjectLinkSummary, ProjectSelector, RunnerConnection, SampleManagerDatabaseTarget } from "./tool-context.js";
import type { ProjectInfo } from "./project-registry.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import "dotenv/config";

const RELAY_PUBLIC_URL = (process.env.RELAY_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
export const RELAY_MCP_VERSION = process.env.RELAY_MCP_VERSION ?? "0.6.3";
const MCP_PORT = Number(process.env.MCP_PORT ?? 3001);

export interface McpUser {
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

export interface ToolRegistrationDependencies {
  registry?: ProjectRegistry;
  server?: McpServer;
  knowledge?: KnowledgeStore;
}

// ─── Domain tool registrars (legacy-compatible implementation) ───────────────
export function registerToolsForUser(user: McpUser, dependencies: ToolRegistrationDependencies = {}) {
  const registry = dependencies.registry ?? getSharedProjectRegistry();
  const server = dependencies.server ?? new McpServer({
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
  function listAllowedProjects(): ProjectInfo[] {
    const projects = registry.listScopedProjects(user.id, user.tokenDbId, user.allowAllProjects);
    // A token's default project is only a selector, not an additional scope.
    // Never fall back to it when a scoped token has no matching project-scope
    // rows; doing so would turn a stale/malformed token into an access grant.
    if (projects.length === 0 && user.defaultProject && (!user.tokenDbId || user.allowAllProjects)) {
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
    selector: ProjectSelector = {}
  ): RunnerConnection {
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

  function getSampleManagerDatabaseTarget(
    projectName?: string,
    environment?: string,
    requestedDatabase?: string,
    selector: ProjectSelector = {}
  ): SampleManagerDatabaseTarget {
    const connection = getRunner(projectName, environment, selector);
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

  async function waitForTrackedJob(jobId: string, waitMs: number): Promise<JobRecord | undefined> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const current = getJob(jobId);
      if (!current || current.status !== "running") return current;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return getJob(jobId);
  }

  function projectLinkSummaries(projectId: number): ProjectLinkSummary[] {
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

  registerProjectTools({ server, user, registry, listAllowedProjects, projectLinkSummaries, resolveProjectName, getRunner, assertServerAllowed, relayRoute, relayMcpVersion: RELAY_MCP_VERSION, mcpPort: MCP_PORT });
  const domainContext = { server, user, resolveProjectName, getRunner, relayRoute };
  registerRemoteTools({ ...domainContext, executionForJob, waitForTrackedJob, getSampleManagerDatabaseTarget });
  registerWorkspaceTools({ ...domainContext, registry, relayPublicUrl: RELAY_PUBLIC_URL });
  registerPlaywrightTools({ ...domainContext, executionForJob, waitForTrackedJob, relayPublicUrl: RELAY_PUBLIC_URL });
  registerSampleManagerTools({ ...domainContext, registry, executionForJob, getSampleManagerDatabaseTarget });
  registerDeploymentTools(domainContext);
  registerDeploymentLogTools({ server, user, resolveProjectName, getRunner });

  registerJobTools({ server, user, resolveProjectName });

  registerDiagnosticTools({ server, user, knowledge: dependencies.knowledge, resolveProjectName, getRunner, registry });
  registerKnowledgeTools({ server, user, knowledge: dependencies.knowledge, resolveProjectName });
  return server;
}
