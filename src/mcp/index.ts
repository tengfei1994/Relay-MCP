import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import { ProjectRegistry } from "./project-registry.js";
import { RemoteRunner } from "../shared/remote-runner.js";
import { compactText, summarizeExec, summarizeJson } from "../shared/output.js";
import { cancelJob, getJob, listJobs, startJob, writeAudit, type JobContext } from "../shared/job-store.js";
import { recordFact, searchFacts } from "../shared/context-store.js";
import {
  clearFormCache,
  buildDotNetProject,
  convertSampleManagerTables,
  createEntityDefinition,
  deploySampleManagerFile,
  loadTableLoaderFile,
  recentErrors,
  restoreSampleManagerBackup,
  restartSampleManagerInstance,
  runSampleManagerCommand,
  runSampleManagerUtility,
  runSql,
} from "../shared/samplemanager-tools.js";
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
import { createUploadSession, publicUploadSession } from "../shared/upload-store.js";
import { TOOL_CATALOG_BY_NAME } from "../shared/tool-catalog.js";
import "dotenv/config";

const MCP_PORT = Number(process.env.MCP_PORT ?? 3001);
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-in-production";
const DB_PATH = process.env.DB_PATH ?? "./data/app.db";
const RELAY_PUBLIC_URL = (process.env.RELAY_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");

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
  const sensitive = /^(script|content|base64|token|password|sql)$/i;
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
      payload.defaultProject = row.project_name ?? payload.defaultProject;
      payload.defaultEnvironment = row.environment ?? payload.defaultEnvironment;
      payload.projectServerId = row.project_server_id ?? payload.projectServerId;
      payload.defaultServerId = row.default_server_id ?? payload.defaultServerId;
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
    version: "1.0.0",
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
    return registry.listScopedServerIds(user.id, user.tokenDbId);
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
          projects: allowedProjects.map((project) => ({ name: project.name, id: project.id })),
        })
      );
    }
    if (!user.allowAllProjects && user.tokenDbId) {
      const allowed = allowedProjects.some((project) => project.name === resolved);
      if (!allowed) throw new Error(`Project '${resolved}' is not allowed for this MCP token`);
    }
    return resolved;
  }

  function getRunner(projectName?: string, environment?: string) {
    const resolvedProjectName = resolveProjectName(projectName);
    const resolvedEnvironment = environment || user.defaultEnvironment || "production";
    const project = registry.getProject(user.id, resolvedProjectName);
    if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);

    const projectServers = registry.getProjectServers(project.id)
      .filter((s) => listAllowedServerIds().includes(s.server.id));
    const ps = user.defaultServerId
      ? projectServers.find((s) => s.server.id === user.defaultServerId && s.environment === resolvedEnvironment)
      : projectServers.find((s) => s.environment === resolvedEnvironment);
    if (!ps) throw new Error(`No connected server for project '${resolvedProjectName}' env '${resolvedEnvironment}'`);

    const runner = new RemoteRunner({
      host: ps.server.host,
      port: ps.server.port,
      username: ps.server.sshUser,
      privateKeyPath: ps.server.privateKeyPath,
      os: ps.server.os,
    });
    return { project, ps, runner };
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
    };
  }

  // ── Tool: list_projects ────────────────────────────────────────────────────
  server.tool("list_projects", "List all projects for the current user", {}, async () => {
    const projects = listAllowedProjects();
    return {
      content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
    };
  });

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
    "Execute a shell command on the remote server for a project",
    {
      project: z.string().optional().describe("Project name. Optional when the MCP token has a default project."),
      command: z.string().describe("Shell command to run"),
      environment: z.string().optional().describe("Target environment (default: production)"),
      timeoutMs: z.number().optional().describe("Command timeout in milliseconds (default 60000)"),
      async: z.boolean().optional().describe("Run as an async job and return a jobId."),
    },
    async ({ project: projectName, command, environment, timeoutMs = 60000, async = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getRunner(projectName, environment);
      const work = async (context?: JobContext) => {
        const result = await runner.exec(command, timeoutMs, executionForJob(context));
        writeAudit({
          userId: user.id,
          username: user.username,
          project: resolvedProjectName,
          tool: "exec_remote",
          environment: environment ?? "production",
          host: ps.server.host,
          command,
          async,
          exitCode: result.code,
        });
        return `[${ps.server.host}]\n${summarizeExec(command, result)}`;
      };
      if (async) {
        const job = startJob(user, resolvedProjectName, "exec_remote", { command, environment, timeoutMs }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "exec_remote_powershell",
    "Execute PowerShell on a linked Windows remote server using EncodedCommand, avoiding shell quoting issues with $ variables.",
    {
      project: z.string().optional().describe("Project name. Optional when the MCP token has a default project."),
      script: z.string().describe("PowerShell script content to execute"),
      environment: z.string().optional().describe("Target environment (default: production)"),
      timeoutMs: z.number().optional().describe("Command timeout in milliseconds (default 120000)"),
      async: z.boolean().optional().describe("Run as an async job and return a jobId."),
    },
    async ({ project: projectName, script, environment, timeoutMs = 120000, async = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getRunner(projectName, environment);
      const work = async (context?: JobContext) => {
        const result = await runner.execPowerShell(script, timeoutMs, executionForJob(context));
        writeAudit({
          userId: user.id,
          username: user.username,
          project: resolvedProjectName,
          tool: "exec_remote_powershell",
          environment: environment ?? "production",
          host: ps.server.host,
          async,
          exitCode: result.code,
        });
        return `[${ps.server.host}]\n${summarizeExec("powershell -EncodedCommand <script>", result)}`;
      };
      if (async) {
        const job = startJob(user, resolvedProjectName, "exec_remote_powershell", { environment, timeoutMs, scriptLength: script.length }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "exec_remote_script",
    "Write a PowerShell script to a linked Windows remote server, execute it, and clean it up automatically on success.",
    {
      project: z.string().optional().describe("Project name. Optional when the MCP token has a default project."),
      script: z.string().describe("PowerShell script content to write and execute"),
      environment: z.string().optional().describe("Target environment (default: production)"),
      remotePath: z.string().optional().describe("Optional absolute remote .ps1 path; defaults to C:\\Windows\\Temp\\relay-mcp-*.ps1"),
      timeoutMs: z.number().optional().describe("Script timeout in milliseconds (default 120000)"),
      cleanup: z.boolean().optional().describe("Remove the remote script after execution. Default true."),
      preserveOnFailure: z.boolean().optional().describe("Keep the remote script when execution fails. Default false."),
      async: z.boolean().optional().describe("Run as an async job and return a jobId."),
    },
    async ({
      project: projectName,
      script,
      environment,
      remotePath,
      timeoutMs = 120000,
      cleanup = true,
      preserveOnFailure = false,
      async = false,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { ps, runner } = getRunner(projectName, environment);
      const work = async (context?: JobContext) => {
        const result = await runner.execPowerShellScript(script, {
          remotePath,
          timeout: timeoutMs,
          cleanup,
          preserveOnFailure,
          execution: executionForJob(context),
        });
        writeAudit({
          userId: user.id,
          username: user.username,
          project: resolvedProjectName,
          tool: "exec_remote_script",
          environment: environment ?? "production",
          host: ps.server.host,
          remotePath: result.remotePath,
          cleanedUp: result.cleanedUp,
          async,
          exitCode: result.code,
        });
        return [
          `[${ps.server.host}]`,
          `remotePath=${result.remotePath}`,
          `cleanedUp=${result.cleanedUp}`,
          summarizeExec("powershell -File <remote script>", result),
        ].join("\n");
      };
      if (async) {
        const job = startJob(user, resolvedProjectName, "exec_remote_script", {
          environment,
          remotePath,
          timeoutMs,
          cleanup,
          preserveOnFailure,
          scriptLength: script.length,
        }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  // ── Tool: deploy ───────────────────────────────────────────────────────────
  server.tool(
    "deploy",
    "Update a remote Git checkout and optionally restart PM2 or Docker workloads. Supports Windows and Linux targets.",
    {
      project: z.string().optional().describe("Project name. Optional when the MCP token has a default project."),
      environment: z.string().optional(),
      branch: z.string().optional().describe("Git branch (default: main)"),
    },
    async ({ project: projectName, environment, branch = "main" }) => {
      const { ps, runner } = getRunner(projectName, environment);
      const remotePath = ps.remotePath;
      const safeBranch = validateGitRef(branch);
      const result = ps.server.os === "windows"
        ? await runner.execPowerShell(`
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath ${quotePowerShell(remotePath)}
& git fetch origin
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& git checkout -- ${quotePowerShell(safeBranch)}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& git pull --ff-only origin ${quotePowerShell(safeBranch)}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (Get-Command pm2 -ErrorAction SilentlyContinue) {
  & pm2 restart all
}
elseif ((Test-Path -LiteralPath "docker-compose.yml") -or (Test-Path -LiteralPath "compose.yml")) {
  & docker compose up -d --build
}
`, 120000)
        : await runner.exec([
          `cd -- ${quotePosix(remotePath)}`,
          "git fetch origin",
          `git checkout -- ${quotePosix(safeBranch)}`,
          `git pull --ff-only origin ${quotePosix(safeBranch)}`,
          "if command -v pm2 >/dev/null 2>&1; then pm2 restart all; elif [ -f docker-compose.yml ] || [ -f compose.yml ]; then docker compose up -d --build; fi",
        ].join(" && "), 120000);

      return {
        content: [{ type: "text", text: compactText(`Deploy result:\n${result.stdout}\n${result.stderr}`) }],
      };
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
    },
    async ({ project: projectName, environment, lines = 100, logPath }) => {
      const { ps, runner } = getRunner(projectName, environment);

      const safeLines = Math.max(1, Math.min(Math.trunc(lines), 5000));
      const result = ps.server.os === "windows"
        ? await runner.execPowerShell(logPath
          ? `Get-Content -LiteralPath ${quotePowerShell(logPath)} -Tail ${safeLines} -ErrorAction Stop`
          : `
$root = ${quotePowerShell(ps.remotePath)}
$files = Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in ".log",".txt" } |
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
          : `(journalctl -u $(basename -- ${quotePosix(ps.remotePath)}) -n ${safeLines} --no-pager 2>/dev/null) || (pm2 logs --nostream --lines ${safeLines} 2>/dev/null) || (find ${quotePosix(`${ps.remotePath.replace(/[\\/]+$/, "")}/logs`)} -type f -name '*.log' -print0 2>/dev/null | xargs -0 tail -n ${safeLines} 2>/dev/null) || echo 'No logs found'`,
          30000);
      return { content: [{ type: "text", text: compactText(result.stdout || result.stderr) }] };
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
    "Read a file from the remote server",
    {
      project: z.string().optional(),
      remotePath: z.string().describe("Absolute path on remote server"),
      environment: z.string().optional(),
    },
    async ({ project: projectName, remotePath, environment }) => {
      const { runner } = getRunner(projectName, environment);
      const content = await runner.readFile(remotePath);
      return { content: [{ type: "text", text: content }] };
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
    "Upload a single file from the project workspace to the remote server via SFTP. Handles files of any size.",
    {
      project: z.string().optional(),
      localPath: z.string().describe("Relative path within project workspace"),
      remotePath: z.string().describe("Absolute destination path on remote server"),
      environment: z.string().optional(),
    },
    async ({ project: projectName, localPath: relPath, remotePath, environment }) => {
      const { project, ps, runner } = getRunner(projectName, environment);
      const fullLocal = resolveWorkspacePath(project.workspacePath, relPath, { mustExist: true });
      await runner.uploadFile(fullLocal, remotePath);
      return { content: [{ type: "text", text: `Uploaded ${relPath} → ${ps.server.host}:${remotePath}` }] };
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
            token,
            command: `npm run relay-upload -- --url ${uploadUrl} --token <token> --file <local-file>`,
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
      return { content: [{ type: "text", text: summarizeJson(job) }] };
    }
  );

  server.tool(
    "job_list",
    "List recent asynchronous Relay-MCP jobs for the current user",
    {
      limit: z.number().optional().describe("Maximum jobs to return (default 20)"),
    },
    async ({ limit = 20 }) => {
      return { content: [{ type: "text", text: summarizeJson(listJobs(user.id, limit)) }] };
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
    "samplemanager_restart_instance",
    "Restart a SampleManager instance on a linked Windows server and stop stuck client task hosts",
    {
      project: z.string().optional(),
      instance: z.string().describe("SampleManager instance name, e.g. VGSM"),
      environment: z.string().optional(),
      async: z.boolean().optional().describe("Run as an async job and return a jobId"),
    },
    async ({ project: projectName, instance, environment, async = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner } = getRunner(projectName, environment);
      const work = (context?: JobContext) => restartSampleManagerInstance(runner, instance, executionForJob(context));
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_restart_instance", { instance, environment }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_clear_form_cache",
    "Clear FormsBin cache for one SampleManager form without creating local throwaway scripts",
    {
      project: z.string().optional(),
      instance: z.string(),
      formName: z.string(),
      environment: z.string().optional(),
    },
    async ({ project: projectName, instance, formName, environment }) => {
      const { runner } = getRunner(projectName, environment);
      return { content: [{ type: "text", text: await clearFormCache(runner, instance, formName) }] };
    }
  );

  server.tool(
    "samplemanager_recent_errors",
    "Search recent SampleManager logs and return a compact error-focused result",
    {
      project: z.string().optional(),
      instance: z.string(),
      environment: z.string().optional(),
      minutes: z.number().optional(),
      keywords: z.array(z.string()).optional(),
    },
    async ({ project: projectName, instance, environment, minutes = 30, keywords }) => {
      const { runner } = getRunner(projectName, environment);
      return { content: [{ type: "text", text: await recentErrors(runner, instance, minutes, keywords) }] };
    }
  );

  server.tool(
    "samplemanager_sql_query",
    "Run a compact SQL query against a SampleManager SQL Server database. Read-only by default.",
    {
      project: z.string().optional(),
      database: z.string().describe("Database name, e.g. vgsm"),
      sql: z.string(),
      environment: z.string().optional(),
      allowMutation: z.boolean().optional(),
      maxRows: z.number().optional().describe("Maximum rows returned per result set, capped at 1000. Default 100."),
      includeResultSets: z.boolean().optional().describe("Include full resultSets payload. Default false."),
    },
    async ({ project: projectName, database, sql, environment, allowMutation = false, maxRows, includeResultSets }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner } = getRunner(projectName, environment);
      const text = await runSql(runner, database, sql, { allowMutation, maxRows, includeResultSets });
      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "samplemanager_sql_query",
        database,
        allowMutation,
        maxRows,
        includeResultSets,
      });
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "samplemanager_sql_execute_file",
    "Run a SQL file from the relay project workspace against a SampleManager SQL Server database. Mutations require allowMutation=true.",
    {
      project: z.string().optional(),
      database: z.string().describe("Database name, e.g. vgsm"),
      path: z.string().describe("Relative SQL file path within the relay project workspace"),
      environment: z.string().optional(),
      allowMutation: z.boolean().optional(),
      maxRows: z.number().optional().describe("Maximum rows returned per result set, capped at 1000. Default 100."),
      includeResultSets: z.boolean().optional().describe("Include full resultSets payload. Default false."),
    },
    async ({ project: projectName, database, path: relPath, environment, allowMutation = false, maxRows, includeResultSets }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const project = registry.getProject(user.id, resolvedProjectName);
      if (!project) throw new Error(`Project '${resolvedProjectName}' not found`);

      const fullPath = resolveWorkspacePath(project.workspacePath, relPath, { mustExist: true });
      if (!existsSync(fullPath)) {
        throw new Error(`SQL file '${relPath}' does not exist in project '${resolvedProjectName}'`);
      }

      const { runner } = getRunner(projectName, environment);
      const sql = readFileSync(fullPath, "utf8");
      const text = await runSql(runner, database, sql, { allowMutation, maxRows, includeResultSets });
      writeAudit({
        userId: user.id,
        username: user.username,
        project: resolvedProjectName,
        tool: "samplemanager_sql_execute_file",
        database,
        path: relPath,
        allowMutation,
        maxRows,
        includeResultSets,
      });
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "samplemanager_run_command",
    "Run SampleManagerCommand.exe from the instance Exe folder with structured arguments.",
    {
      project: z.string().optional(),
      instance: z.string().describe("SampleManager instance name, e.g. VGSM"),
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
      const { runner } = getRunner(projectName, environment);
      const work = (context?: JobContext) => runSampleManagerCommand(runner, instance, {
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
        instance,
        commandUsername: username,
        task,
        async,
      });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_run_command", { instance, username, task, args, environment }, work);
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
      instance: z.string(),
      environment: z.string().optional(),
      timeoutMs: z.number().positive().optional().describe("Default 600000"),
      async: z.boolean().optional().describe("Run as an async job; recommended"),
    },
    async ({ project: projectName, instance, environment, timeoutMs = 600000, async = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner } = getRunner(projectName, environment);
      const work = (context?: JobContext) => createEntityDefinition(
        runner,
        instance,
        timeoutMs,
        executionForJob(context)
      );
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_create_entity_definition", instance, async });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_create_entity_definition", { instance, environment, timeoutMs }, work);
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
      instance: z.string(),
      tables: z.array(z.string()).min(1),
      environment: z.string().optional(),
      timeoutMs: z.number().positive().optional().describe("Timeout per table; default 600000"),
      async: z.boolean().optional().describe("Run as an async job; recommended"),
    },
    async ({ project: projectName, instance, tables, environment, timeoutMs = 600000, async = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner } = getRunner(projectName, environment);
      const work = (context?: JobContext) => convertSampleManagerTables(
        runner,
        instance,
        tables,
        timeoutMs,
        executionForJob(context)
      );
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_convert_tables", instance, tables, async });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_convert_tables", { instance, tables, environment, timeoutMs }, work);
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
      instance: z.string(),
      username: z.string(),
      remoteCsvPath: z.string(),
      mode: z.string().optional().describe("Table-loader mode; default overwrite_table"),
      environment: z.string().optional(),
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
      timeoutMs = 300000,
      async = true,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner } = getRunner(projectName, environment);
      const work = (context?: JobContext) => loadTableLoaderFile(
        runner,
        instance,
        username,
        remoteCsvPath,
        mode,
        timeoutMs,
        executionForJob(context)
      );
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_table_loader", instance, remoteCsvPath, mode, async });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_table_loader", { instance, username, remoteCsvPath, mode, environment, timeoutMs }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_run_utility",
    "Run an allowlisted SampleManager utility with structured arguments. Use dedicated tools for CreateEntityDefinition and convert_table.",
    {
      project: z.string().optional(),
      instance: z.string(),
      utility: z.enum(["FormImport.exe", "BuildFormDefinition.exe", "DeployPackageTask.exe"]),
      args: z.array(z.string()).optional(),
      environment: z.string().optional(),
      timeoutMs: z.number().positive().optional().describe("Default 300000"),
      async: z.boolean().optional().describe("Run as an async job"),
    },
    async ({ project: projectName, instance, utility, args = [], environment, timeoutMs = 300000, async = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner } = getRunner(projectName, environment);
      const work = (context?: JobContext) => runSampleManagerUtility(runner, instance, utility, {
        args,
        timeoutMs,
        execution: executionForJob(context),
      });
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_run_utility", instance, utility, args, async });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_run_utility", { instance, utility, args, environment, timeoutMs }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
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
      timeoutMs: z.number().positive().optional().describe("Default 600000"),
      async: z.boolean().optional().describe("Run as an async job; recommended"),
    },
    async ({
      project: projectName,
      projectOrSolutionPath,
      configuration = "Release",
      msbuildPath,
      environment,
      timeoutMs = 600000,
      async = true,
    }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner } = getRunner(projectName, environment);
      const work = (context?: JobContext) => buildDotNetProject(
        runner,
        projectOrSolutionPath,
        configuration,
        msbuildPath,
        timeoutMs,
        executionForJob(context)
      );
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_build_dotnet", projectOrSolutionPath, configuration, async });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_build_dotnet", { projectOrSolutionPath, configuration, msbuildPath, environment, timeoutMs }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_deploy_file",
    "Copy a staged remote file into a SampleManager instance area and create a timestamped backup of the replaced file.",
    {
      project: z.string().optional(),
      instance: z.string(),
      sourcePath: z.string().describe("Absolute source file path already present on the remote server"),
      area: z.enum(["exe", "solutionAssemblies", "forms", "resourceIcon", "data"]),
      targetRelativePath: z.string(),
      backup: z.boolean().optional().describe("Create backup before replacement; default true"),
      environment: z.string().optional(),
      async: z.boolean().optional().describe("Run as an async job"),
    },
    async ({ project: projectName, instance, sourcePath, area, targetRelativePath, backup = true, environment, async = false }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { runner } = getRunner(projectName, environment);
      const work = (context?: JobContext) => deploySampleManagerFile(
        runner,
        instance,
        sourcePath,
        area,
        targetRelativePath,
        backup,
        executionForJob(context)
      );
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "samplemanager_deploy_file", instance, sourcePath, area, targetRelativePath, backup, async });
      if (async) {
        const job = startJob(user, resolvedProjectName, "samplemanager_deploy_file", { instance, sourcePath, area, targetRelativePath, backup, environment }, work);
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
  res.json({ ok: true });
});

app.listen(MCP_PORT, "0.0.0.0", () => {
  console.log(`MCP server running on port ${MCP_PORT}`);
});
