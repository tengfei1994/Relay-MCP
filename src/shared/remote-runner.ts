import { NodeSSH } from "node-ssh";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class RemoteRunner {
  private config: SshConfig;

  constructor(config: SshConfig) {
    this.config = config;
  }

  async exec(command: string, timeout = 60000): Promise<ExecResult> {
    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        privateKeyPath: this.config.privateKeyPath,
        readyTimeout: 10000,
      });

      const result = await ssh.execCommand(command, {
        execOptions: { pty: false },
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code ?? 0,
      };
    } finally {
      ssh.dispose();
    }
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
    const result = await this.exec(`cat '${remotePath}'`);
    if (result.code !== 0) {
      throw new Error(`Failed to read file: ${result.stderr}`);
    }
    return result.stdout;
  }

  async listDir(remotePath: string): Promise<Array<{ name: string; type: "file" | "directory"; size?: number }>> {
    const result = await this.exec(
      `ls -la '${remotePath}' 2>&1 | awk 'NR>1 {print $1,$5,$9}'`
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
      // Ensure remote parent directory exists
      await ssh.execCommand(`mkdir -p "$(dirname '${remotePath}')"`);
      await ssh.putFile(localPath, remotePath);
    } finally {
      ssh.dispose();
    }
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

      // Ensure remote directory exists
      await ssh.execCommand(`mkdir -p '${remoteDir}'`);

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
