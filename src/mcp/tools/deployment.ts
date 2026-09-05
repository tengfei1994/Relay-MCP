import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpUser } from "../register-tools.js";
import { z } from "zod";
import { compactTextWithMetadata, summarizeExec, summarizeJson } from "../../shared/output.js";
import { finishDeployment, startDeployment } from "../../shared/deployment-store.js";
import { writeAudit } from "../../shared/job-store.js";
import { quotePosix, quotePowerShell, validateGitRef } from "../../shared/shell-utils.js";
import type { GetRunner, ResolveProjectName } from "../tool-context.js";
export interface DeploymentToolsContext { server: McpServer; user: McpUser; resolveProjectName: ResolveProjectName; getRunner: GetRunner; }
/** Deployment and lifecycle registration boundary. */
export function registerDeploymentTools(context: DeploymentToolsContext, legacy?: (context: DeploymentToolsContext) => void): void {
  if (legacy) { legacy(context); return; }
  const { server, user, resolveProjectName, getRunner } = context;
  server.tool("deploy", "Update a remote Git checkout and optionally restart PM2 or Docker workloads. Returns a deployment run record with commits and rollback status.", {
    project: z.string().optional(), environment: z.string().optional(), branch: z.string().optional(), rollbackOnFailure: z.boolean().optional(),
  }, async ({ project: projectName, environment, branch = "main", rollbackOnFailure = false }) => {
    const resolvedProjectName = resolveProjectName(projectName); const { ps, runner } = getRunner(projectName, environment);
    const safeBranch = validateGitRef(branch); const run = startDeployment({ userId: user.id, username: user.username, project: resolvedProjectName, environment: environment ?? "production", host: ps.server.host, branch: safeBranch, rollbackRequested: rollbackOnFailure });
    const output: string[] = []; const execute = async (label: string, linux: string, windows: string) => { const result = ps.server.os === "windows" ? await runner.execPowerShell(windows, 120000) : await runner.exec(linux, 120000); output.push(`${label}\n${summarizeExec(label, result, 4000)}`); if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`); return result.stdout.trim(); };
    const linuxInRepo = (command: string) => `cd -- ${quotePosix(ps.remotePath)} && ${command}`; const windowsInRepo = (command: string) => `$ErrorActionPreference = "Stop"\nSet-Location -LiteralPath ${quotePowerShell(ps.remotePath)}\n${command}`;
    let commitBefore: string | undefined; let commitAfter: string | undefined; let rollback = run.rollback;
    try {
      commitBefore = await execute("git rev-parse HEAD (before)", linuxInRepo("git rev-parse HEAD"), windowsInRepo("& git rev-parse HEAD\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"));
      await execute("git fetch origin", linuxInRepo("git fetch origin"), windowsInRepo("& git fetch origin\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"));
      await execute(`git checkout ${safeBranch}`, linuxInRepo(`git checkout ${quotePosix(safeBranch)}`), windowsInRepo(`& git checkout ${quotePowerShell(safeBranch)}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`));
      await execute(`git pull --ff-only origin ${safeBranch}`, linuxInRepo(`git pull --ff-only origin ${quotePosix(safeBranch)}`), windowsInRepo(`& git pull --ff-only origin ${quotePowerShell(safeBranch)}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`));
      commitAfter = await execute("git rev-parse HEAD (after)", linuxInRepo("git rev-parse HEAD"), windowsInRepo("& git rev-parse HEAD\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"));
      await execute("restart workload", linuxInRepo("if command -v pm2 >/dev/null 2>&1; then pm2 restart all; elif [ -f docker-compose.yml ] || [ -f compose.yml ]; then docker compose up -d --build; else echo 'No PM2 or Docker workload found'; fi"), windowsInRepo("if (Get-Command pm2 -ErrorAction SilentlyContinue) { & pm2 restart all; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } } else { Write-Output \"No PM2 or Docker workload found\" }"));
      const compact = compactTextWithMetadata(output.join("\n\n")); const record = finishDeployment(run.id, { status: "succeeded", commitBefore, commitAfter, rollback: rollbackOnFailure ? { ...rollback, status: "not-needed" } : rollback, output: compact.text, outputLength: compact.originalLength, outputTruncated: compact.truncated }); writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "deploy", deploymentId: record.id, status: record.status, commitBefore, commitAfter }); return { content: [{ type: "text", text: summarizeJson(record) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (rollbackOnFailure && commitBefore) {
        rollback = { ...rollback, attempted: true };
        const rollbackResult = ps.server.os === "windows"
          ? await runner.execPowerShell(windowsInRepo(`& git reset --hard ${quotePowerShell(commitBefore)}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`), 120000)
          : await runner.exec(linuxInRepo(`git reset --hard ${quotePosix(commitBefore)}`), 120000);
        output.push(`rollback\n${summarizeExec("git reset --hard <previous-commit>", rollbackResult, 4000)}`);
        rollback = rollbackResult.code === 0 ? { ...rollback, status: "succeeded", commit: commitBefore } : { ...rollback, status: "failed", commit: commitBefore, error: rollbackResult.stderr || rollbackResult.stdout };
      }
      const compact = compactTextWithMetadata(output.join("\n\n")); const record = finishDeployment(run.id, { status: "failed", commitBefore, commitAfter, rollback, error: message, output: compact.text, outputLength: compact.originalLength, outputTruncated: compact.truncated }); writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "deploy", deploymentId: record.id, status: record.status, error: message }); return { content: [{ type: "text", text: summarizeJson(record) }] };
    }
  });
}
