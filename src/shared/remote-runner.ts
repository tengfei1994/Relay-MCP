import { NodeSSH } from "node-ssh";

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
    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        privateKeyPath: this.config.privateKeyPath,
        readyTimeout: 10000,
      });

      // Use heredoc to write file content
      const escaped = content.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
      await ssh.execCommand(
        `mkdir -p "$(dirname '${remotePath}')" && cat > '${remotePath}' << 'REMOTE_OPS_EOF'\n${content}\nREMOTE_OPS_EOF`
      );
    } finally {
      ssh.dispose();
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
      await ssh.putFile(localPath, remotePath);
    } finally {
      ssh.dispose();
    }
  }
}
