import Database from "better-sqlite3";
import { join } from "path";
import "dotenv/config";

const DB_PATH = process.env.DB_PATH ?? "./data/app.db";

export interface ProjectInfo {
  id: number;
  userId: number;
  name: string;
  workspacePath: string;
}

export interface ServerInfo {
  id: number;
  host: string;
  port: number;
  sshUser: string;
  privateKeyPath: string;
  name: string;
  status: string;
  os: "linux" | "windows";
}

export interface ProjectServer {
  server: ServerInfo;
  remotePath: string;
  environment: string;
}

export class ProjectRegistry {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH, { readonly: true });
  }

  getUserByToken(userId: number): { id: number; username: string } | undefined {
    return this.db
      .prepare("SELECT id, username FROM users WHERE id = ?")
      .get(userId) as any;
  }

  getProject(userId: number, projectName: string): ProjectInfo | undefined {
    return this.db
      .prepare("SELECT * FROM projects WHERE user_id = ? AND name = ?")
      .get(userId, projectName) as any;
  }

  listProjects(userId: number): ProjectInfo[] {
    return this.db
      .prepare("SELECT * FROM projects WHERE user_id = ?")
      .all(userId) as any[];
  }

  getProjectServers(projectId: number): ProjectServer[] {
    const rows = this.db
      .prepare(`
        SELECT s.*, ps.remote_path, ps.environment
        FROM project_servers ps
        JOIN servers s ON s.id = ps.server_id
        WHERE ps.project_id = ? AND s.status = 'connected'
      `)
      .all(projectId) as any[];

    return rows.map((r) => ({
      server: {
        id: r.id,
        host: r.host,
        port: r.port,
        sshUser: r.ssh_user,
        privateKeyPath: r.private_key_path,
        name: r.name,
        status: r.status,
        os: r.os === "windows" ? "windows" : "linux",
      },
      remotePath: r.remote_path,
      environment: r.environment,
    }));
  }
}
