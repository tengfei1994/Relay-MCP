import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { ProjectRegistry } from "./project-registry.js";
import { RemoteRunner } from "../shared/remote-runner.js";
import { compactText, summarizeExec, summarizeJson } from "../shared/output.js";
import { getJob, listJobs, startJob, writeAudit } from "../shared/job-store.js";
import { recordFact, searchFacts } from "../shared/context-store.js";
import {
  clearFormCache,
  recentErrors,
  restartSampleManagerInstance,
  runSql,
} from "../shared/samplemanager-tools.js";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import "dotenv/config";

const MCP_PORT = Number(process.env.MCP_PORT ?? 3001);
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-in-production";

// ─── Auth middleware ───────────────────────────────────────────────────────────
function verifyToken(req: express.Request): { id: number; username: string } {
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
  return jwt.verify(token, JWT_SECRET) as { id: number; username: string };
}

// ─── Build MCP server for a given user ────────────────────────────────────────
function createMcpServer(user: { id: number; username: string }) {
  const registry = new ProjectRegistry();
  const server = new McpServer({
    name: "remote-ops",
    version: "1.0.0",
  });

  // ── Helper: resolve project + runner ──────────────────────────────────────
  function getRunner(projectName: string, environment = "production") {
    const project = registry.getProject(user.id, projectName);
    if (!project) throw new Error(`Project '${projectName}' not found`);

    const projectServers = registry.getProjectServers(project.id);
    const ps = projectServers.find((s) => s.environment === environment);
    if (!ps) throw new Error(`No connected server for project '${projectName}' env '${environment}'`);

    const runner = new RemoteRunner({
      host: ps.server.host,
      port: ps.server.port,
      username: ps.server.sshUser,
      privateKeyPath: ps.server.privateKeyPath,
      os: ps.server.os,
    });
    return { project, ps, runner };
  }

  // ── Tool: list_projects ────────────────────────────────────────────────────
  server.tool("list_projects", "List all projects for the current user", {}, async () => {
    const projects = registry.listProjects(user.id);
    return {
      content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
    };
  });

  // ── Tool: exec_remote ──────────────────────────────────────────────────────
  server.tool(
    "exec_remote",
    "Execute a shell command on the remote server for a project",
    {
      project: z.string().describe("Project name"),
      command: z.string().describe("Shell command to run"),
      environment: z.string().optional().describe("Target environment (default: production)"),
    },
    async ({ project: projectName, command, environment }) => {
      const { ps, runner } = getRunner(projectName, environment);
      const result = await runner.exec(command);
      writeAudit({
        userId: user.id,
        username: user.username,
        project: projectName,
        tool: "exec_remote",
        environment: environment ?? "production",
        host: ps.server.host,
        command,
        exitCode: result.code,
      });
      const text = `[${ps.server.host}]\n${summarizeExec(command, result)}`;
      return { content: [{ type: "text", text }] };
    }
  );

  // ── Tool: deploy ───────────────────────────────────────────────────────────
  server.tool(
    "deploy",
    "Deploy the project to the remote server (git pull + restart)",
    {
      project: z.string().describe("Project name"),
      environment: z.string().optional(),
      branch: z.string().optional().describe("Git branch (default: main)"),
    },
    async ({ project: projectName, environment, branch = "main" }) => {
      const { ps, runner } = getRunner(projectName, environment);
      const remotePath = ps.remotePath;

      const steps = [
        `cd '${remotePath}'`,
        `git fetch origin`,
        `git checkout ${branch}`,
        `git pull origin ${branch}`,
      ];

      // Try common restart patterns
      const restartCmds = [
        `if command -v pm2 &>/dev/null; then pm2 restart all 2>/dev/null || true; fi`,
        `if [ -f docker-compose.yml ]; then docker compose up -d --build 2>/dev/null || true; fi`,
      ];

      const fullCommand = [...steps, ...restartCmds].join(" && ");
      const result = await runner.exec(fullCommand, 120000);

      return {
        content: [{ type: "text", text: compactText(`Deploy result:\n${result.stdout}\n${result.stderr}`) }],
      };
    }
  );

  // ── Tool: fetch_logs ───────────────────────────────────────────────────────
  server.tool(
    "fetch_logs",
    "Fetch recent logs from the remote server",
    {
      project: z.string(),
      environment: z.string().optional(),
      lines: z.number().optional().describe("Number of lines (default: 100)"),
      logPath: z.string().optional().describe("Custom log file path"),
    },
    async ({ project: projectName, environment, lines = 100, logPath }) => {
      const { ps, runner } = getRunner(projectName, environment);

      let cmd: string;
      if (logPath) {
        cmd = `tail -n ${lines} '${logPath}' 2>&1`;
      } else {
        // Try common log locations
        cmd = `(journalctl -u $(basename '${ps.remotePath}') -n ${lines} --no-pager 2>/dev/null) || (pm2 logs --nostream --lines ${lines} 2>/dev/null) || (tail -n ${lines} '${ps.remotePath}/logs/*.log' 2>/dev/null) || echo 'No logs found'`;
      }

      const result = await runner.exec(cmd, 30000);
      return { content: [{ type: "text", text: compactText(result.stdout || result.stderr) }] };
    }
  );

  // ── Tool: restart_service ──────────────────────────────────────────────────
  server.tool(
    "restart_service",
    "Restart a service on the remote server",
    {
      project: z.string(),
      environment: z.string().optional(),
      service: z.string().describe("Service name or 'all' for all project services"),
    },
    async ({ project: projectName, environment, service }) => {
      const { runner } = getRunner(projectName, environment);

      let cmd: string;
      if (service === "all") {
        cmd = `pm2 restart all 2>/dev/null || systemctl restart ${service} 2>/dev/null || docker compose restart 2>/dev/null`;
      } else if (service.startsWith("docker:")) {
        cmd = `docker restart ${service.slice(7)}`;
      } else if (service.startsWith("pm2:")) {
        cmd = `pm2 restart ${service.slice(4)}`;
      } else {
        cmd = `sudo systemctl restart ${service}`;
      }

      const result = await runner.exec(cmd, 30000);
      return { content: [{ type: "text", text: compactText(`${result.stdout}\n${result.stderr}`) }] };
    }
  );

  // ── Tool: read_remote_file ─────────────────────────────────────────────────
  server.tool(
    "read_remote_file",
    "Read a file from the remote server",
    {
      project: z.string(),
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
      project: z.string(),
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
      project: z.string(),
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
      project: z.string(),
      path: z.string().describe("Relative path within project workspace"),
    },
    async ({ project: projectName, path: relPath }) => {
      const project = registry.getProject(user.id, projectName);
      if (!project) throw new Error(`Project '${projectName}' not found`);

      const fullPath = join(project.workspacePath, relPath);
      if (!fullPath.startsWith(project.workspacePath)) {
        throw new Error("Path traversal not allowed");
      }
      const content = readFileSync(fullPath, "utf8");
      return { content: [{ type: "text", text: content }] };
    }
  );

  // ── Tool: sync_workspace ──────────────────────────────────────────────────
  server.tool(
    "sync_workspace",
    "Sync the entire project workspace to the linked remote server via SFTP (no size limit). Excludes node_modules, .git, dist, .env by default.",
    {
      project: z.string(),
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
      project: z.string(),
      localPath: z.string().describe("Relative path within project workspace"),
      remotePath: z.string().describe("Absolute destination path on remote server"),
      environment: z.string().optional(),
    },
    async ({ project: projectName, localPath: relPath, remotePath, environment }) => {
      const { project, ps, runner } = getRunner(projectName, environment);
      const fullLocal = join(project.workspacePath, relPath);
      if (!fullLocal.startsWith(project.workspacePath)) throw new Error("Path traversal not allowed");
      await runner.uploadFile(fullLocal, remotePath);
      return { content: [{ type: "text", text: `Uploaded ${relPath} → ${ps.server.host}:${remotePath}` }] };
    }
  );

  // ── Tool: write_local_file ─────────────────────────────────────────────────
  server.tool(
    "write_local_file",
    "Write (or append) a file to the project workspace. Use append=true for chunked writes of large files — call repeatedly with sequential chunks, then upload_workspace_file or sync_workspace once done.",
    {
      project: z.string(),
      path: z.string().describe("Relative path within project workspace"),
      content: z.string().describe("File content (or next chunk if append=true)"),
      append: z.boolean().optional().describe("If true, append to existing file instead of overwriting. Default false."),
    },
    async ({ project: projectName, path: relPath, content, append = false }) => {
      const project = registry.getProject(user.id, projectName);
      if (!project) throw new Error(`Project '${projectName}' not found`);

      const fullPath = join(project.workspacePath, relPath);
      if (!fullPath.startsWith(project.workspacePath)) {
        throw new Error("Path traversal not allowed");
      }
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

  // ── Tool: patch_remote_file ────────────────────────────────────────────────
  server.tool(
    "patch_remote_file",
    "Apply a unified diff (patch) to a file on the remote server. Far more token-efficient than rewriting the whole file — only send what changed. The diff must be in standard unified diff format (diff -u / git diff).",
    {
      project: z.string(),
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

  // ── Tool: project context memory ──────────────────────────────────────────
  server.tool(
    "context_record_fact",
    "Record a durable project fact so future LLM calls do not need chat history",
    {
      project: z.string(),
      text: z.string().describe("Short fact, pitfall, path, or project convention"),
      tags: z.array(z.string()).optional(),
    },
    async ({ project, text, tags = [] }) => {
      const fact = recordFact(user, project, text, tags);
      writeAudit({ userId: user.id, username: user.username, project, tool: "context_record_fact", tags });
      return { content: [{ type: "text", text: summarizeJson(fact) }] };
    }
  );

  server.tool(
    "context_search",
    "Search durable project facts recorded on the MCP server",
    {
      project: z.string(),
      query: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ project, query = "", limit = 10 }) => {
      return { content: [{ type: "text", text: summarizeJson(searchFacts(user.id, project, query, limit)) }] };
    }
  );

  // ── SampleManager high-level tools ────────────────────────────────────────
  server.tool(
    "samplemanager_restart_instance",
    "Restart a SampleManager instance on a linked Windows server and stop stuck client task hosts",
    {
      project: z.string(),
      instance: z.string().describe("SampleManager instance name, e.g. VGSM"),
      environment: z.string().optional(),
      async: z.boolean().optional().describe("Run as an async job and return a jobId"),
    },
    async ({ project: projectName, instance, environment, async = false }) => {
      const { runner } = getRunner(projectName, environment);
      const work = () => restartSampleManagerInstance(runner, instance);
      if (async) {
        const job = startJob(user, projectName, "samplemanager_restart_instance", { instance, environment }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] };
      }
      return { content: [{ type: "text", text: await work() }] };
    }
  );

  server.tool(
    "samplemanager_clear_form_cache",
    "Clear FormsBin cache for one SampleManager form without creating local throwaway scripts",
    {
      project: z.string(),
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
      project: z.string(),
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
      project: z.string(),
      database: z.string().describe("Database name, e.g. vgsm"),
      sql: z.string(),
      environment: z.string().optional(),
      allowMutation: z.boolean().optional(),
    },
    async ({ project: projectName, database, sql, environment, allowMutation = false }) => {
      const { runner } = getRunner(projectName, environment);
      const text = await runSql(runner, database, sql, allowMutation);
      writeAudit({
        userId: user.id,
        username: user.username,
        project: projectName,
        tool: "samplemanager_sql_query",
        database,
        allowMutation,
      });
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

// ─── Express app with per-request MCP instances ───────────────────────────────
const app = express();
app.use(express.json());

app.all("/mcp", async (req, res) => {
  let user: { id: number; username: string };
  try {
    user = verifyToken(req);
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
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
