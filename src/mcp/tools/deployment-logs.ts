import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpUser } from "../register-tools.js";
import { getDeployment } from "../../shared/deployment-store.js";
import { compactTextWithMetadata, summarizeJson } from "../../shared/output.js";
import { quotePosix, quotePowerShell } from "../../shared/shell-utils.js";
import type { GetRunner, ResolveProjectName } from "../tool-context.js";

export interface DeploymentLogToolsContext {
  server: McpServer;
  user: McpUser;
  resolveProjectName: ResolveProjectName;
  getRunner: GetRunner;
}

export function registerDeploymentLogTools(context: DeploymentLogToolsContext): void {
  const { server, user, resolveProjectName, getRunner } = context;
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


}
