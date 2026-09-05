import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpUser } from "../register-tools.js";
import { z } from "zod";
import { createHash, randomUUID } from "crypto";
import { createReadStream, existsSync, mkdirSync, statSync } from "fs";
import { basename, dirname } from "path";
import { AgentRemoteRunner } from "../../shared/agent-remote-runner.js";
import { ensureRemoteSuccess } from "../../shared/remote-runner.js";
import { startJob, writeAudit, type JobContext } from "../../shared/job-store.js";
import { compactText, summarizeJson } from "../../shared/output.js";
import { createUploadSession, getUploadSession } from "../../shared/upload-store.js";
import { createDownloadSession } from "../../shared/download-store.js";
import { resolveWorkspacePath } from "../../shared/workspace-path.js";
import type { GetRunner, ResolveProjectName, WaitForTrackedJob } from "../tool-context.js";

export interface PlaywrightToolsContext {
  server: McpServer;
  user: McpUser;
  resolveProjectName: ResolveProjectName;
  getRunner: GetRunner;
  relayRoute: (tool: string, extra?: Record<string, unknown>) => Record<string, unknown>;
  executionForJob: (context?: JobContext) => Record<string, unknown>;
  waitForTrackedJob: WaitForTrackedJob;
  relayPublicUrl: string;
}

function playwrightSelectors() {
  return {
    project: z.string().optional().describe("Project name. Optional when the MCP token has a default project."),
    environment: z.string().optional().describe("Exact project environment key."),
    serverId: z.number().int().optional().describe("Exact linked server ID."),
    serverName: z.string().optional().describe("Exact linked server name."),
  };
}

/** Dedicated Playwright control plane registration boundary. */
export function registerPlaywrightTools(context: PlaywrightToolsContext, legacy?: (context: PlaywrightToolsContext) => void): void {
  if (legacy) { legacy(context); return; }
  const { server, user, resolveProjectName, getRunner, relayRoute, executionForJob, waitForTrackedJob, relayPublicUrl } = context;

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
    jobContext?: JobContext
  ) {
    const result = await runner.dispatchPlaywright(payload, timeoutMs, executionForJob(jobContext));
    ensureRemoteSuccess(result);
    const text = result.stdout.trim();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Agent Playwright returned invalid JSON: ${compactText(text, 4000)}`);
    }
  }

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
        const downloadUrl = `${relayPublicUrl}/api/downloads/${download.session.id}`;
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
}
