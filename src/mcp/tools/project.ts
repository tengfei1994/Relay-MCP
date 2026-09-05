import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RemoteRunner } from "../../shared/remote-runner.js";
import { quotePosix, quotePowerShell } from "../../shared/shell-utils.js";
import { summarizeJson } from "../../shared/output.js";
import type { ProjectRegistry } from "../project-registry.js";
import type { GetRunner, ProjectLinkSummary, ResolveProjectName } from "../tool-context.js";
import type { ProjectInfo } from "../project-registry.js";
import type { McpUser } from "../register-tools.js";

export interface ProjectToolsContext {
  server: McpServer;
  user: McpUser;
  registry: ProjectRegistry;
  listAllowedProjects: () => ProjectInfo[];
  projectLinkSummaries: (projectId: number) => ProjectLinkSummary[];
  resolveProjectName: ResolveProjectName;
  getRunner: GetRunner;
  assertServerAllowed: (serverId: number) => void;
  relayRoute: (tool: string, extra?: Record<string, unknown>) => Record<string, unknown>;
  relayMcpVersion: string;
  mcpPort: number;
}

export function registerProjectTools(ctx: ProjectToolsContext): void {
  const { server, user, registry, listAllowedProjects, projectLinkSummaries, resolveProjectName, getRunner, assertServerAllowed, relayRoute, relayMcpVersion, mcpPort } = ctx;

  server.tool("list_projects", "List all projects for the current user", {}, async () => {
    const projects = listAllowedProjects().map((project) => ({ ...project, serverLinks: projectLinkSummaries(project.id) }));
    return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
  });

  server.tool("project_server_links_list", "List selectable server links for one project or every allowed project, including exact environment keys and bound LIMS instances.", { project: z.string().optional().describe("Optional project name. Omit to list links for every allowed project.") }, async ({ project: projectName }) => {
    const projects = projectName ? [registry.getProject(user.id, resolveProjectName(projectName))].filter(Boolean) : listAllowedProjects();
    return { content: [{ type: "text", text: summarizeJson(projects.map((project) => ({ projectId: project!.id, projectName: project!.name, serverLinks: projectLinkSummaries(project!.id) }))) }] };
  });

  const relayMetadata = (tool: string, readOnly = false) => ({ ...relayRoute(tool), ...(readOnly ? { readOnly: true } : {}), namespace: "relay_", version: relayMcpVersion, transport: "streamable-http", mcpPort, preferredTools: { routeCheck: "relay_route_check", projectLinks: "relay_project_server_links_list", powershell: "relay_exec_remote_powershell", script: "relay_exec_remote_script", playwrightRuntime: "playwright_runtime_status", playwrightRun: "playwright_run_suite", playwrightRunStatus: "playwright_run_status", jobStatus: "job_status", jobList: "job_list" }, legacyAliases: { exec_remote: "relay_exec_remote", exec_remote_powershell: "relay_exec_remote_powershell", exec_remote_script: "relay_exec_remote_script", project_server_links_list: "relay_project_server_links_list" } });
  server.tool("relay_mcp_info", "Return Relay MCP route metadata so clients can verify they are calling the Relay server rather than a local shell.", {}, async () => ({ content: [{ type: "text", text: summarizeJson(relayMetadata("relay_mcp_info")) }] }));
  server.tool("relay_core_tools", "Return the stable preferred Relay MCP tools and legacy aliases. This tool is read-only and does not contact a remote server.", {}, async () => ({ content: [{ type: "text", text: summarizeJson({ ...relayMetadata("relay_core_tools", true), instruction: "Use the preferred relay_* names below for new calls. Do not route remote work through a local shell." }) }] }));

  server.tool("relay_route_check", "Check that the request is being handled by Relay MCP and optionally resolve a project/server target without executing a remote command.", { project: z.string().optional().describe("Optional project name."), environment: z.string().optional().describe("Optional exact environment key."), serverId: z.number().int().optional().describe("Optional exact linked server ID."), serverName: z.string().optional().describe("Optional exact linked server name.") }, async ({ project: projectName, environment, serverId, serverName }) => {
    const projects = listAllowedProjects();
    const result: Record<string, unknown> = { ...relayRoute("relay_route_check"), readOnly: true, remoteExecutionAttempted: false, mcpServerVersion: relayMcpVersion, mcpPort, user: user.username, projects: projects.map((project) => ({ id: project.id, name: project.name, serverLinks: projectLinkSummaries(project.id) })), selected: null };
    if (projectName || environment || serverId !== undefined || serverName) {
      try {
        const resolvedProjectName = resolveProjectName(projectName);
        const { ps } = getRunner(resolvedProjectName, environment, { serverId, serverName });
        result.selected = { project: resolvedProjectName, environment: ps.environment, serverId: ps.server.id, serverName: ps.server.name, connectionMode: ps.connectionMode, status: ps.server.status, agentId: ps.server.agentId, limsInstance: ps.limsInstance ? { id: ps.limsInstance.id, name: ps.limsInstance.name, version: ps.limsInstance.version, runtimeKind: ps.limsInstance.runtimeKind, databaseHost: ps.limsInstance.databaseHost, databaseName: ps.limsInstance.databaseName } : undefined };
      } catch (error) { result.selectionError = error instanceof Error ? error.message : String(error); }
    }
    return { content: [{ type: "text", text: summarizeJson(result) }] };
  });

  server.tool("project_create", "Create a Relay-MCP project workspace, optionally link it to a server and create the remote directory", { name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/), description: z.string().optional(), serverId: z.number().optional().describe("Optional existing server id to link"), remotePath: z.string().optional().describe("Remote project directory to create when serverId is supplied"), environment: z.string().optional().describe("Environment name for the server link, default production") }, async ({ name, description = "", serverId, remotePath, environment = "production" }) => {
    if (!user.canCreateProjects) throw new Error("This MCP token is not allowed to create projects");
    if (serverId && !remotePath) throw new Error("remotePath is required when serverId is supplied");
    if (serverId) assertServerAllowed(serverId);
    const project = registry.createProject(user.id, user.username, name, description);
    if (user.tokenDbId && !user.allowAllProjects) registry.addTokenProjectScope(user.tokenDbId, project.id);
    let remote: { serverId: number; remotePath: string; environment: string; mkdirExitCode: number } | undefined;
    if (serverId && remotePath) {
      const linkedServer = registry.getServerForUser(user.id, serverId);
      if (!linkedServer) throw new Error(`Server '${serverId}' not found`);
      registry.linkProjectServer(project.id, serverId, remotePath, environment);
      const runner = new RemoteRunner({ host: linkedServer.host, port: linkedServer.port, username: linkedServer.sshUser, privateKeyPath: linkedServer.privateKeyPath, os: linkedServer.os });
      const mkdirResult = linkedServer.os === "windows" ? await runner.execPowerShell(`New-Item -ItemType Directory -Force -LiteralPath ${quotePowerShell(remotePath)} | Out-Null`) : await runner.exec(`mkdir -p -- ${quotePosix(remotePath)}`);
      remote = { serverId, remotePath, environment, mkdirExitCode: mkdirResult.code };
    }
    return { content: [{ type: "text", text: summarizeJson({ project, remote }) }] };
  });
}
