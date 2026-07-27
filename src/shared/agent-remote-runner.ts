import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import {
  cleanPowerShellText,
  RemoteRunner,
  type ExecResult,
  type PowerShellScriptOptions,
  type PowerShellScriptResult,
  type RemoteExecutionOptions,
} from "./remote-runner.js";
import { getAgentStore } from "./agent-store.js";

export class AgentRemoteRunner extends RemoteRunner {
  constructor(
    private readonly userId: number,
    private readonly agentId: string,
    os: "linux" | "windows" = "windows"
  ) {
    super({ host: agentId, port: 0, username: "agent", privateKeyPath: "", os });
  }

  override async exec(command: string, timeout = 60000, options: RemoteExecutionOptions = {}): Promise<ExecResult> {
    return this.dispatch("exec", { command }, timeout, options);
  }

  override async execPowerShell(script: string, timeout = 120000, options: RemoteExecutionOptions = {}): Promise<ExecResult> {
    const result = await this.dispatch("powershell", { script }, timeout, options);
    return {
      ...result,
      stdout: cleanPowerShellText(result.stdout),
      stderr: cleanPowerShellText(result.stderr),
    };
  }

  override async execPowerShellScript(script: string, options: PowerShellScriptOptions = {}): Promise<PowerShellScriptResult> {
    const result = await this.execPowerShell(script, options.timeout ?? 120000, options.execution);
    return { ...result, remotePath: options.remotePath ?? "(agent:inline)", cleanedUp: true };
  }

  override isWindows(): boolean {
    return true;
  }

  override async writeFile(remotePath: string, content: string): Promise<void> {
    const base64 = Buffer.from(content, "utf8").toString("base64");
    const script = `
$path = ${psQuote(remotePath)}
$parent = Split-Path -Parent $path
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
[IO.File]::WriteAllBytes($path, [Convert]::FromBase64String('${base64}'))
`;
    const result = await this.execPowerShell(script, 120000);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  }

  override async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const base64 = readFileSync(localPath).toString("base64");
    const script = `
$path = ${psQuote(remotePath)}
$parent = Split-Path -Parent $path
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
[IO.File]::WriteAllBytes($path, [Convert]::FromBase64String('${base64}'))
`;
    const result = await this.execPowerShell(script, 300000);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  }

  override async downloadFile(remotePath: string, localPath: string): Promise<{ bytes: number }> {
    const result = await this.execPowerShell(
      `[Console]::Write([Convert]::ToBase64String([IO.File]::ReadAllBytes(${psQuote(remotePath)})))`,
      300000
    );
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    const content = Buffer.from(result.stdout.trim(), "base64");
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, content);
    return { bytes: content.length };
  }

  override async syncDir(
    localDir: string,
    remoteDir: string,
    options: { exclude?: string[] } = {}
  ): Promise<{ transferred: number; failed: string[] }> {
    const excludes = new Set(["node_modules", ".git", "dist", ".env", "*.log", ...(options.exclude ?? [])]);
    const files = walkFiles(localDir, excludes);
    const failed: string[] = [];
    let transferred = 0;
    for (const file of files) {
      const remotePath = remoteDir.replace(/[\\/]+$/, "") + "\\" + relative(localDir, file).replace(/\//g, "\\");
      try {
        await this.uploadFile(file, remotePath);
        transferred++;
      } catch {
        failed.push(remotePath);
      }
    }
    return { transferred, failed };
  }

  private async dispatch(
    kind: "exec" | "powershell",
    payload: Record<string, unknown>,
    timeoutMs: number,
    options: RemoteExecutionOptions
  ): Promise<ExecResult> {
    const store = getAgentStore();
    options.onPhase?.("checking_agent");
    store.assertOnline(this.userId, this.agentId);
    options.onPhase?.("queued");
    const job = store.enqueueJob(this.userId, this.agentId, kind, payload, timeoutMs);
    options.onPhase?.("waiting_agent");
    const completed = await store.waitForJob(job.id, timeoutMs, options.signal);
    const result = completed.result ?? { status: completed.status };
    if (result.stdout) options.onStdout?.(result.stdout);
    if (result.stderr) options.onStderr?.(result.stderr);
    options.onPhase?.("completed");
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.message ?? "",
      code: result.exitCode ?? (completed.status === "completed" ? 0 : 1),
    };
  }
}

function walkFiles(root: string, excludes: Set<string>): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    if (excludes.has(name) || (excludes.has("*.log") && name.toLowerCase().endsWith(".log"))) continue;
    const full = join(root, name);
    if (statSync(full).isDirectory()) files.push(...walkFiles(full, excludes));
    else files.push(full);
  }
  return files;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
