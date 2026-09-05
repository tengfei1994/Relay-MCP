import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpUser } from "../register-tools.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import { ensureRemoteSuccess } from "../../shared/remote-runner.js";
import { startJob, writeAudit, type JobContext } from "../../shared/job-store.js";
import { compactTextWithMetadata, sanitizeStructuredOutput, summarizeExec, summarizeJson } from "../../shared/output.js";
import { runUnicodeCheck } from "../../shared/samplemanager-tools.js";
import type { GetRunner, ResolveProjectName, SampleManagerDatabaseTarget, WaitForTrackedJob } from "../tool-context.js";

export interface RemoteToolsContext {
  server: McpServer;
  user: McpUser;
  resolveProjectName: ResolveProjectName;
  getRunner: GetRunner;
  relayRoute: (tool: string, extra?: Record<string, unknown>) => Record<string, unknown>;
  executionForJob: (context?: JobContext) => Record<string, unknown>;
  waitForTrackedJob: WaitForTrackedJob;
  getSampleManagerDatabaseTarget: (project?: string, environment?: string, database?: string) => SampleManagerDatabaseTarget;
}

/** Remote execution registration boundary. Legacy implementations are injected by the composition root. */
export function registerRemoteTools(context: RemoteToolsContext, legacy?: (context: RemoteToolsContext) => void): void {
  if (legacy) { legacy(context); return; }
  const { server, user, resolveProjectName, getRunner, relayRoute, executionForJob, waitForTrackedJob, getSampleManagerDatabaseTarget } = context;

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
}
