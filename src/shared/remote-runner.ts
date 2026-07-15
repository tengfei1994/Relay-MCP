import { NodeSSH } from "node-ssh";
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { applyPatch } from "diff";

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
  os?: "linux" | "windows";
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RemoteExecutionOptions {
  signal?: AbortSignal;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface PowerShellScriptOptions {
  remotePath?: string;
  cleanup?: boolean;
  preserveOnFailure?: boolean;
  timeout?: number;
  execution?: RemoteExecutionOptions;
}

export interface PowerShellScriptResult extends ExecResult {
  remotePath: string;
  cleanedUp: boolean;
}

export class RemoteCommandTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Remote command timed out after ${timeoutMs}ms`);
    this.name = "RemoteCommandTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class RemoteCommandCancelledError extends Error {
  constructor() {
    super("Remote command was cancelled");
    this.name = "RemoteCommandCancelledError";
  }
}

export class RemoteRunner {
  private config: SshConfig;

  constructor(config: SshConfig) {
    this.config = config;
  }

  async exec(
    command: string,
    timeout = 60000,
    options: RemoteExecutionOptions = {}
  ): Promise<ExecResult> {
    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        privateKeyPath: this.config.privateKeyPath,
        readyTimeout: 10000,
      });

      let channel: { close: () => void } | undefined;
      const result = await runWithTimeout(
        ssh.execCommand(command, {
          execOptions: { pty: false },
          onChannel: (clientChannel) => {
            channel = clientChannel;
          },
          onStdout: (chunk) => options.onStdout?.(chunk.toString("utf8")),
          onStderr: (chunk) => options.onStderr?.(chunk.toString("utf8")),
        }),
        timeout,
        () => {
          try {
            channel?.close();
          } finally {
            ssh.dispose();
          }
        },
        options.signal
      );

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code ?? 0,
      };
    } finally {
      ssh.dispose();
    }
  }

  async execPowerShell(
    script: string,
    timeout = 60000,
    options: RemoteExecutionOptions = {}
  ): Promise<ExecResult> {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = await this.exec(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      timeout,
      options
    );
    return cleanPowerShellResult(result);
  }

  async execPowerShellScript(script: string, options: PowerShellScriptOptions = {}): Promise<PowerShellScriptResult> {
    await this.ensureWindowsTarget();

    const cleanup = options.cleanup ?? true;
    const preserveOnFailure = options.preserveOnFailure ?? false;
    const remotePath = options.remotePath ?? `C:\\Windows\\Temp\\relay-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`;
    let cleanedUp = false;

    await this.writeFile(remotePath, script);
    let result: ExecResult;
    try {
      result = await this.execPowerShell(`
$ErrorActionPreference = "Stop"
& ${psQuote(remotePath)}
if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
`, options.timeout ?? 120000, options.execution);
    } catch (error) {
      if (cleanup && !preserveOnFailure) {
        try {
          const cleanupResult = await this.execPowerShell(
            `Remove-Item -LiteralPath ${psQuote(remotePath)} -Force -ErrorAction SilentlyContinue`,
            30000
          );
          cleanedUp = cleanupResult.code === 0;
        } catch {}
      }
      throw error;
    }

    if (cleanup && (result.code === 0 || !preserveOnFailure)) {
      const cleanupResult = await this.execPowerShell(`Remove-Item -LiteralPath ${psQuote(remotePath)} -Force -ErrorAction SilentlyContinue`, 30000);
      cleanedUp = cleanupResult.code === 0;
    }

    return { ...result, remotePath, cleanedUp };
  }

  isWindows(): boolean {
    return this.config.os === "windows";
  }

  private async ensureWindowsTarget(): Promise<void> {
    if (this.isWindows()) return;

    try {
      const probe = await this.execPowerShell(
        "[Console]::Write([Environment]::OSVersion.Platform)",
        15000
      );
      if (probe.code === 0 && probe.stdout.trim().toLowerCase() === "win32nt") {
        this.config.os = "windows";
        return;
      }
    } catch {}

    throw new Error("execPowerShellScript requires a Windows target; capability probe failed");
  }

  async writeFile(remotePath: string, content: string): Promise<void> {
    // Write to a local temp file then SFTP-upload — avoids shell command size limits
    const tmpPath = join(tmpdir(), `remote-ops-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmpPath, content, "utf8");
    try {
      await this.uploadFile(tmpPath, remotePath);
    } finally {
      try { unlinkSync(tmpPath); } catch {}
    }
  }

  async readFile(remotePath: string): Promise<string> {
    const result = this.isWindows()
      ? await this.execPowerShell(`Get-Content -LiteralPath ${psQuote(remotePath)} -Raw`, 30000)
      : await this.exec(`cat '${shQuote(remotePath)}'`);
    if (result.code !== 0) {
      throw new Error(`Failed to read file: ${result.stderr}`);
    }
    return result.stdout;
  }

  async listDir(remotePath: string): Promise<Array<{ name: string; type: "file" | "directory"; size?: number }>> {
    if (this.isWindows()) {
      const script = `
$items = Get-ChildItem -LiteralPath ${psQuote(remotePath)} -Force | ForEach-Object {
  [pscustomobject]@{
    name = $_.Name
    type = if ($_.PSIsContainer) { "directory" } else { "file" }
    size = if ($_.PSIsContainer) { $null } else { $_.Length }
  }
}
$items | ConvertTo-Json -Compress
`;
      const result = await this.execPowerShell(script, 30000);
      if (result.code !== 0) throw new Error(result.stderr);
      if (!result.stdout.trim()) return [];
      const parsed = JSON.parse(result.stdout);
      return Array.isArray(parsed) ? parsed : [parsed];
    }

    const result = await this.exec(
      `ls -la '${shQuote(remotePath)}' 2>&1 | awk 'NR>1 {print $1,$5,$9}'`
    );
    if (result.code !== 0) throw new Error(result.stderr);

    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(" ");
        const perms = parts[0];
        const size = Number(parts[1]);
        const name = parts.slice(2).join(" ");
        return {
          name,
          type: perms.startsWith("d") ? ("directory" as const) : ("file" as const),
          size: perms.startsWith("d") ? undefined : size,
        };
      })
      .filter((e) => e.name && e.name !== "." && e.name !== "..");
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        privateKeyPath: this.config.privateKeyPath,
        readyTimeout: 10000,
      });
      if (this.isWindows()) {
        const parent = remotePath.replace(/[\\/][^\\/]+$/, "");
        await ssh.execCommand(
          `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(
            `New-Item -ItemType Directory -Force -Path ${psQuote(parent)} | Out-Null`,
            "utf16le"
          ).toString("base64")}`
        );
      } else {
        await ssh.execCommand(`mkdir -p "$(dirname '${shQuote(remotePath)}')"`);
      }
      await ssh.putFile(localPath, remotePath);
    } finally {
      ssh.dispose();
    }
  }

  async downloadFile(remotePath: string, localPath: string): Promise<{ bytes: number }> {
    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        privateKeyPath: this.config.privateKeyPath,
        readyTimeout: 15000,
      });
      mkdirSync(dirname(localPath), { recursive: true });
      await ssh.getFile(localPath, remotePath);
      return { bytes: statSync(localPath).size };
    } finally {
      ssh.dispose();
    }
  }

  async patchFile(remotePath: string, unifiedDiff: string): Promise<{ linesChanged: number }> {
    // Read current content from remote
    const original = await this.readFile(remotePath);

    // Apply patch in Node.js (relay side) — works for both Linux and Windows targets
    const patched = applyPatch(original, unifiedDiff);
    if (patched === false) {
      throw new Error("Patch failed to apply — diff may not match the current file content");
    }

    // Write back via SFTP
    await this.writeFile(remotePath, patched as string);

    // Count changed lines from diff header
    const linesChanged = (unifiedDiff.match(/^[+-]/gm) ?? [])
      .filter((l) => l !== "---" && l !== "+++").length;
    return { linesChanged };
  }

  async syncDir(
    localDir: string,
    remoteDir: string,
    options: { exclude?: string[] } = {}
  ): Promise<{ transferred: number; failed: string[] }> {
    const ssh = new NodeSSH();
    const failed: string[] = [];
    let transferred = 0;

    try {
      await ssh.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        privateKeyPath: this.config.privateKeyPath,
        readyTimeout: 15000,
      });

      if (this.isWindows()) {
        await ssh.execCommand(
          `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(
            `New-Item -ItemType Directory -Force -Path ${psQuote(remoteDir)} | Out-Null`,
            "utf16le"
          ).toString("base64")}`
        );
      } else {
        await ssh.execCommand(`mkdir -p '${shQuote(remoteDir)}'`);
      }

      const defaultExclude = ["node_modules", ".git", "dist", ".env", "*.log"];
      const excludes = new Set([...defaultExclude, ...(options.exclude ?? [])]);

      const status = await ssh.putDirectory(localDir, remoteDir, {
        recursive: true,
        concurrency: 5,
        validate: (itemPath) => {
          const name = itemPath.split(/[/\\]/).pop() ?? "";
          return !excludes.has(name);
        },
        tick: (_local, _remote, error) => {
          if (error) {
            failed.push(_remote);
          } else {
            transferred++;
          }
        },
      });

      return { transferred, failed };
    } finally {
      ssh.dispose();
    }
  }
}

function shQuote(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function runWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
  signal?: AbortSignal
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new RangeError("timeoutMs must be a positive finite number"));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      try {
        onTimeout?.();
      } catch {
        // Cleanup errors must not hide timeout or cancellation.
      }
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      cleanup();
      reject(error);
    };
    const abortHandler = () => finishReject(new RemoteCommandCancelledError());
    const timer = setTimeout(() => {
      finishReject(new RemoteCommandTimeoutError(timeoutMs));
    }, timeoutMs);
    if (signal?.aborted) {
      finishReject(new RemoteCommandCancelledError());
      return;
    }
    signal?.addEventListener("abort", abortHandler, { once: true });

    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortHandler);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortHandler);
        reject(error);
      }
    );
  });
}

function cleanPowerShellResult(result: ExecResult): ExecResult {
  return {
    ...result,
    stdout: cleanPowerShellText(result.stdout),
    stderr: cleanPowerShellText(result.stderr),
  };
}

export function cleanPowerShellText(value: string): string {
  if (!value) return value;

  const withoutProgressLines = value
    .split(/\r?\n/)
    .filter((line) => !/^\s*(Preparing modules for first use\.|WARNING:\s*Preparing modules for first use\.)\s*$/.test(line))
    .join("\n");

  const markerIndex = withoutProgressLines.indexOf("#< CLIXML");
  const rawXmlIndex = withoutProgressLines.search(/<Objs(?:\s|>)/);
  const xmlStart = markerIndex >= 0 && rawXmlIndex >= 0
    ? Math.min(markerIndex, rawXmlIndex)
    : Math.max(markerIndex, rawXmlIndex);

  if (xmlStart < 0) {
    return withoutProgressLines.trim();
  }

  const messages: string[] = [];
  const messagePattern = /<S S="([^"]+)"[^>]*>([\s\S]*?)<\/S>/g;
  let match: RegExpExecArray | null;
  while ((match = messagePattern.exec(withoutProgressLines)) !== null) {
    const stream = match[1].toLowerCase();
    const text = decodeCliXmlText(match[2]).trim();
    if (!text) continue;
    if (stream === "progress") continue;
    if (/^Preparing modules for first use\.$/i.test(text)) continue;
    messages.push(text);
  }

  const plainText = withoutProgressLines.slice(0, xmlStart).trim();
  if (plainText) {
    messages.unshift(plainText);
  }

  return messages.join("\n").trim();
}

function decodeCliXmlText(value: string): string {
  return value
    .replace(/_x000D__x000A_/g, "\n")
    .replace(/_x000D_/g, "\r")
    .replace(/_x000A_/g, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
