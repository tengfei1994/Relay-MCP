import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpUser } from "../register-tools.js";
import { compactText } from "../../shared/output.js";
import { compactTextWithMetadata, summarizeJson } from "../../shared/output.js";
import { startJob, writeAudit, type JobContext } from "../../shared/job-store.js";
import { basename, dirname, join, relative } from "path";
import { appendFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { ensureRemoteSuccess } from "../../shared/remote-runner.js";
import { getDeployment, updateDeployment } from "../../shared/deployment-store.js";
import { createDownloadSession } from "../../shared/download-store.js";
import { createUploadSession, getUploadSession, publicUploadSession } from "../../shared/upload-store.js";
import { getAgentStore } from "../../shared/agent-store.js";
import { resolveWorkspacePath } from "../../shared/workspace-path.js";
import { quotePosix, quotePowerShell, validateServiceName } from "../../shared/shell-utils.js";
import type { GetRunner, ResolveProjectName } from "../tool-context.js";
import type { ProjectRegistry } from "../project-registry.js";
export interface WorkspaceToolsContext {
  server: McpServer;
  user: McpUser;
  resolveProjectName: ResolveProjectName;
  getRunner: GetRunner;
  registry: ProjectRegistry;
  relayPublicUrl: string;
}
export function registerWorkspaceTools(context: WorkspaceToolsContext, legacy?: (context: WorkspaceToolsContext) => void): void {
  if (legacy) { legacy(context); return; }
  const { server, user, resolveProjectName, getRunner, registry, relayPublicUrl } = context;
  server.tool("restart_service", "Restart Windows services, systemd units, PM2 processes, or Docker containers using a structured service selector.", {
    project: z.string().optional(), environment: z.string().optional(), service: z.string().describe("Service name or 'all' for all project services"),
  }, async ({ project: projectName, environment, service }) => {
    const { ps, runner } = getRunner(projectName, environment); const safeService = service === "all" ? service : validateServiceName(service);
    const result = ps.server.os === "windows" ? await runner.execPowerShell(safeService === "all" ? `if (Get-Command pm2 -ErrorAction SilentlyContinue) { & pm2 restart all } elseif (Get-Command docker -ErrorAction SilentlyContinue) { & docker compose restart } else { throw "service=all requires PM2 or Docker on Windows" }` : safeService.startsWith("docker:") ? `& docker restart ${quotePowerShell(safeService.slice(7))}` : safeService.startsWith("pm2:") ? `& pm2 restart ${quotePowerShell(safeService.slice(4))}` : `Restart-Service -Name ${quotePowerShell(safeService.replace(/^windows:/, ""))} -Force -ErrorAction Stop`, 30000) : await runner.exec(safeService === "all" ? "if command -v pm2 >/dev/null 2>&1; then pm2 restart all; elif command -v docker >/dev/null 2>&1; then docker compose restart; else echo 'service=all requires PM2 or Docker' >&2; exit 2; fi" : safeService.startsWith("docker:") ? `docker restart ${quotePosix(safeService.slice(7))}` : safeService.startsWith("pm2:") ? `pm2 restart ${quotePosix(safeService.slice(4))}` : `sudo systemctl restart -- ${quotePosix(safeService.replace(/^systemd:/, ""))}`, 30000);
    return { content: [{ type: "text", text: compactText(`${result.stdout}\n${result.stderr}`) }] };
  });
  server.tool("read_remote_file", "Read a text file from the remote server. Use async=true for large or slow files so the job can be checked without retrying the remote read.", {
    project: z.string().optional(), remotePath: z.string().describe("Absolute path on remote server"), environment: z.string().optional(), timeoutMs: z.number().optional(), async: z.boolean().optional(),
  }, async ({ project: projectName, remotePath, environment, timeoutMs = 30000, async = true }) => {
    const resolvedProjectName = resolveProjectName(projectName); const { ps, runner } = getRunner(projectName, environment);
    const work = async (context?: JobContext) => { context?.phase("reading_remote_file"); const content = await runner.readFile(remotePath, timeoutMs, context); writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "read_remote_file", environment: environment ?? "production", host: ps.server.host, remotePath, bytes: Buffer.byteLength(content, "utf8") }); return summarizeJson({ host: ps.server.host, remotePath, content: compactTextWithMetadata(content) }); };
    if (async) { const job = startJob(user, resolvedProjectName, "read_remote_file", { remotePath, environment, timeoutMs }, work); return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, status: job.status }) }] }; }
    return { content: [{ type: "text", text: await work() }] };
  });
  server.tool("download_remote_file", "Download a remote file into the Relay project workspace and create a short-lived URL for streaming it into the agent's local workspace.", {
    project: z.string().optional(), remotePath: z.string(), workspacePath: z.string(), environment: z.string().optional(), overwrite: z.boolean().optional(), ttlSeconds: z.number().int().min(60).max(3600).optional(), timeoutMs: z.number().int().positive().optional(),
  }, async ({ project: projectName, remotePath, workspacePath: relPath, environment, overwrite = false, ttlSeconds, timeoutMs = 1_800_000 }) => {
    const { project, ps, runner } = getRunner(projectName, environment); const destination = resolveWorkspacePath(project.workspacePath, relPath);
    if (existsSync(destination) && !overwrite) throw new Error(`Relay workspace destination already exists: ${relPath}`); mkdirSync(dirname(destination), { recursive: true }); let bytes: number;
    if (ps.connectionMode === "agent") {
      if (!ps.server.agentId) throw new Error(`Agent server '${ps.server.name}' has no Agent ID`);
      const upload = createUploadSession({ userId: user.id, projectId: project.id, project: project.name, path: relPath, maxBytes: Number(process.env.RELAY_ARTIFACT_MAX_BYTES ?? 4 * 1024 * 1024 * 1024), ttlMs: timeoutMs + 60_000 }); const agentStore = getAgentStore(); agentStore.assertOnline(user.id, ps.server.agentId);
      const agentJob = agentStore.enqueueJob(user.id, ps.server.agentId, "artifact-upload", { remotePath, uploadPath: `/api/uploads/${upload.session.id}`, uploadToken: upload.token }, timeoutMs); const completed = await agentStore.waitForJob(agentJob.id, timeoutMs); const finalUpload = getUploadSession(upload.session.id);
      if (completed.status !== "completed" || finalUpload?.status !== "completed") throw new Error(`Agent artifact transfer failed; jobId=${agentJob.id}; jobStatus=${completed.status}; uploadStatus=${finalUpload?.status ?? "missing"}`); bytes = finalUpload.bytesWritten ?? 0;
    } else { const tempPath = `${destination}.relay-download-${Date.now()}.tmp`; try { ({ bytes } = await runner.downloadFile(remotePath, tempPath)); if (existsSync(destination)) rmSync(destination, { force: true }); renameSync(tempPath, destination); } catch (error) { if (existsSync(tempPath)) rmSync(tempPath, { force: true }); throw error; } }
    const staged = statSync(destination); if (!staged.isFile() || staged.size !== bytes) throw new Error(`Staged artifact size mismatch: reported=${bytes}, actual=${staged.size}`); const digest = createHash("sha256"); for await (const chunk of createReadStream(destination)) digest.update(chunk); const sha256 = digest.digest("hex");
    const { session, token } = createDownloadSession({ userId: user.id, projectId: project.id, project: project.name, path: relPath, bytes, sha256, fileName: basename(destination), mtimeMs: staged.mtimeMs, ttlMs: ttlSeconds ? ttlSeconds * 1000 : undefined });
    return { content: [{ type: "text", text: summarizeJson({ remote: { serverId: ps.server.id, serverName: ps.server.name, connectionMode: ps.connectionMode, path: remotePath.replace(/\\/g, "/") }, relayWorkspacePath: relPath, bytes, sha256, contentType: session.contentType, sessionId: session.id, downloadUrl: `${process.env.RELAY_PUBLIC_URL ?? "http://localhost:3000"}/api/downloads/${session.id}`, token, expiresAt: session.expiresAt }) }] };
  });
  server.tool("write_remote_file", "Write content to a file on the remote server", { project: z.string().optional(), remotePath: z.string(), content: z.string(), environment: z.string().optional() }, async ({ project: projectName, remotePath, content, environment }) => {
    const { runner } = getRunner(projectName, environment); await runner.writeFile(remotePath, content); return { content: [{ type: "text", text: `Written to ${remotePath}` }] };
  });
  server.tool("list_remote_files", "List files in a directory on the remote server", { project: z.string().optional(), remotePath: z.string(), environment: z.string().optional() }, async ({ project: projectName, remotePath, environment }) => {
    const { runner } = getRunner(projectName, environment); const entries = await runner.listDir(remotePath); return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
  });

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

  server.tool(
    "upload_workspace_file",
    "Upload one Relay workspace file through a verified temporary path, skip identical targets, and atomically replace the destination.",
    {
      project: z.string().optional(),
      localPath: z.string().describe("Relative path within project workspace"),
      remotePath: z.string().describe("Absolute destination path on remote server"),
      environment: z.string().optional(),
      serverId: z.number().int().optional().describe("Exact linked server ID."),
      serverName: z.string().optional().describe("Exact linked server display name."),
      deploymentId: z.string().optional().describe("Optional running deployment to receive upload evidence."),
      async: z.boolean().optional().describe("Run as a tracked job; default true."),
    },
    async ({ project: projectName, localPath: relPath, remotePath, environment, serverId, serverName, deploymentId, async = true }) => {
      const resolvedProjectName = resolveProjectName(projectName);
      const { project, ps, runner } = getRunner(projectName, environment, { serverId, serverName });
      const fullLocal = resolveWorkspacePath(project.workspacePath, relPath, { mustExist: true });
      const stat = statSync(fullLocal);
      if (!stat.isFile()) throw new Error(`Workspace path is not a file: ${relPath}`);
      if (deploymentId) {
        const deployment = getDeployment(deploymentId);
        if (!deployment || deployment.userId !== user.id || deployment.project !== resolvedProjectName) throw new Error(`Deployment '${deploymentId}' not found for project '${resolvedProjectName}'`);
        if (deployment.status !== "running") throw new Error(`Deployment '${deploymentId}' is '${deployment.status}' and cannot accept uploads`);
        if (deployment.environment.localeCompare(ps.environment, undefined, { sensitivity: "accent" }) !== 0) throw new Error(`Deployment '${deploymentId}' environment '${deployment.environment}' does not match '${ps.environment}'`);
        if (deployment.target?.serverId !== undefined && deployment.target.serverId !== ps.server.id) throw new Error(`Deployment '${deploymentId}' serverId '${deployment.target.serverId}' does not match '${ps.server.id}'`);
        if (deployment.target?.projectServerId !== undefined && deployment.target.projectServerId !== ps.id) throw new Error(`Deployment '${deploymentId}' project server link '${deployment.target.projectServerId}' does not match '${ps.id}'`);
      }
      const work = async (context?: JobContext) => {
        context?.phase("hashing_local");
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(fullLocal)) digest.update(chunk);
        const localSha256 = digest.digest("hex");
        const hashCommand = (path: string) => ps.server.os === "windows"
          ? runner.execPowerShell(`if (Test-Path -LiteralPath ${quotePowerShell(path)} -PathType Leaf) { [Console]::Write((Get-FileHash -LiteralPath ${quotePowerShell(path)} -Algorithm SHA256).Hash.ToLowerInvariant()) }`, 60000)
          : runner.exec(`if [ -f ${quotePosix(path)} ]; then sha256sum -- ${quotePosix(path)} | awk '{print $1}'; fi`, 60000);
        context?.phase("checking_remote_hash");
        const previousHashResult = await hashCommand(remotePath);
        ensureRemoteSuccess(previousHashResult);
        const previousSha256 = previousHashResult.stdout.trim().toLowerCase() || undefined;
        const skipped = previousSha256 === localSha256;
        const temporaryPath = `${remotePath}.relay-upload-${randomUUID()}.tmp`;
        if (!skipped) {
          context?.phase("uploading");
          await runner.uploadFile(fullLocal, temporaryPath);
          context?.phase("verifying_staged_file");
          const stagedHashResult = await hashCommand(temporaryPath);
          ensureRemoteSuccess(stagedHashResult);
          const stagedSha256 = stagedHashResult.stdout.trim().toLowerCase();
          if (stagedSha256 !== localSha256) {
            if (ps.server.os === "windows") await runner.execPowerShell(`Remove-Item -LiteralPath ${quotePowerShell(temporaryPath)} -Force -ErrorAction SilentlyContinue`, 30000);
            else await runner.exec(`rm -f -- ${quotePosix(temporaryPath)}`, 30000);
            throw new Error(`Upload SHA-256 mismatch: local=${localSha256}, staged=${stagedSha256}`);
          }
          context?.phase("replacing_target");
          const replaceResult = ps.server.os === "windows"
            ? await runner.execPowerShell(`Move-Item -LiteralPath ${quotePowerShell(temporaryPath)} -Destination ${quotePowerShell(remotePath)} -Force -ErrorAction Stop`, 60000)
            : await runner.exec(`mv -f -- ${quotePosix(temporaryPath)} ${quotePosix(remotePath)}`, 60000);
          ensureRemoteSuccess(replaceResult);
        }
        context?.phase("verifying_target");
        const finalHashResult = await hashCommand(remotePath);
        ensureRemoteSuccess(finalHashResult);
        const remoteSha256 = finalHashResult.stdout.trim().toLowerCase();
        if (remoteSha256 !== localSha256) throw new Error(`Final upload SHA-256 mismatch: local=${localSha256}, remote=${remoteSha256}`);
        const result = {
          project: resolvedProjectName,
          environment: ps.environment,
          projectServerId: ps.id,
          serverId: ps.server.id,
          serverName: ps.server.name,
          localPath: relPath,
          remotePath,
          bytes: stat.size,
          previousSha256,
          localSha256,
          remoteSha256,
          changed: !skipped,
          skipped,
          verified: true,
          deploymentId,
        };
        if (deploymentId) {
          const deployment = getDeployment(deploymentId)!;
          const uploads = Array.isArray(deployment.artifacts?.uploads) ? deployment.artifacts.uploads : [];
          updateDeployment(deploymentId, { artifacts: { uploads: [...uploads, result] } });
        }
        writeAudit({ userId: user.id, username: user.username, tool: "upload_workspace_file", ...result });
        context?.phase("completed");
        return summarizeJson(result);
      };
      if (async) {
        const job = startJob(user, resolvedProjectName, "upload_workspace_file", { localPath: relPath, remotePath, bytes: stat.size, environment: ps.environment, serverId: ps.server.id, projectServerId: ps.id, deploymentId }, work);
        return { content: [{ type: "text", text: summarizeJson({ jobId: job.id, deploymentId, status: job.status, target: { project: resolvedProjectName, environment: ps.environment, projectServerId: ps.id, serverId: ps.server.id, serverName: ps.server.name } }) }] };
      }
      const result = JSON.parse(await work()) as Record<string, unknown>;
      return { structuredContent: result, content: [{ type: "text", text: summarizeJson(result) }] };
    }
  );

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
      const uploadUrl = `${relayPublicUrl}/api/uploads/${session.id}`;
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
}
