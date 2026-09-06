import { closeSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import { tmpdir } from "os";
import {
  cleanPowerShellText,
  RemoteRunner,
  type ExecResult,
  type PowerShellScriptOptions,
  type PowerShellScriptResult,
  type RemoteExecutionOptions,
} from "./remote-runner.js";
import { getAgentStore } from "./agent-store.js";
import type { AgentJob } from "./agent-store.js";

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

  async dispatchPlaywright(
    payload: Record<string, unknown>,
    timeout = 120000,
    options: RemoteExecutionOptions = {}
  ): Promise<ExecResult> {
    const result = await this.dispatch("playwright", payload, timeout, options);
    return {
      ...result,
      stdout: cleanPowerShellText(result.stdout),
      stderr: cleanPowerShellText(result.stderr),
    };
  }

  override isWindows(): boolean {
    return true;
  }

  override async writeFile(remotePath: string, content: string): Promise<void> {
    const tempPath = join(tmpdir(), `relay-agent-write-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tempPath, content, "utf8");
    try {
      await this.uploadFile(tempPath, remotePath);
    } finally {
      try { unlinkSync(tempPath); } catch {}
    }
  }

  override async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const chunkBytes = Math.max(64 * 1024, Math.min(Number(process.env.RELAY_AGENT_UPLOAD_CHUNK_BYTES ?? 256 * 1024), 1024 * 1024));
    const initialize = await this.execPowerShell(`
$path = ${psQuote(remotePath)}
$parent = Split-Path -Parent $path
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
[IO.File]::WriteAllBytes($path, [byte[]]@())
`, 120000);
    if (initialize.code !== 0) throw new Error(initialize.stderr || initialize.stdout);

    const handle = openSync(localPath, "r");
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let offset = 0;
    try {
      while (true) {
        const bytesRead = readSync(handle, buffer, 0, buffer.length, offset);
        if (bytesRead === 0) break;
        const base64 = buffer.subarray(0, bytesRead).toString("base64");
        const append = await this.execPowerShell(`
$path = ${psQuote(remotePath)}
$bytes = [Convert]::FromBase64String('${base64}')
$stream = [IO.File]::Open($path, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read)
try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
`, 120000);
        if (append.code !== 0) throw new Error(append.stderr || append.stdout);
        offset += bytesRead;
      }
    } catch (error) {
      try { await this.execPowerShell(`Remove-Item -LiteralPath ${psQuote(remotePath)} -Force -ErrorAction SilentlyContinue`, 30000); } catch {}
      throw error;
    } finally {
      closeSync(handle);
    }
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
    kind: AgentJob["kind"],
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
    let reportedClaim = false;
    const completed = await store.waitForJob(job.id, timeoutMs, options.signal, (current) => {
      if (current.claimedAt && !reportedClaim) {
        reportedClaim = true;
        options.onPhase?.("agent_claimed");
      }
    });
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
