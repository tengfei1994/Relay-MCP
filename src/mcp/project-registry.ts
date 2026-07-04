import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { join } from "path";
import "dotenv/config";

const DB_PATH = process.env.DB_PATH ?? "./data/app.db";
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";

export interface ProjectInfo {
  id: number;
  userId: number;
  name: string;
  description?: string;
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
    this.db = new Database(DB_PATH, { readonly: false });
  }

  getUserByToken(userId: number): { id: number; username: string } | undefined {
    return this.db
      .prepare("SELECT id, username FROM users WHERE id = ?")
      .get(userId) as any;
  }

  getProject(userId: number, projectName: string): ProjectInfo | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE user_id = ? AND name = ?")
      .get(userId, projectName) as any;
    return row ? mapProject(row) : undefined;
  }

  listProjects(userId: number): ProjectInfo[] {
    const rows = this.db
      .prepare("SELECT * FROM projects WHERE user_id = ?")
      .all(userId) as any[];
    return rows.map(mapProject);
  }

  listScopedProjects(userId: number, tokenDbId?: number, allowAllProjects = false): ProjectInfo[] {
    if (!tokenDbId || allowAllProjects) return this.listProjects(userId);
    const rows = this.db
      .prepare(`
        SELECT p.*
        FROM projects p
        JOIN mcp_token_project_scopes scope ON scope.project_id = p.id
        WHERE p.user_id = ? AND scope.token_id = ?
      `)
      .all(userId, tokenDbId) as any[];
    return rows.map(mapProject);
  }

  createProject(userId: number, username: string, name: string, description = ""): ProjectInfo {
    const existing = this.getProject(userId, name);
    if (existing) throw new Error(`Project '${name}' already exists`);

    const workspacePath = join(WORKSPACE_ROOT, username, name);
    mkdirSync(workspacePath, { recursive: true });
    const row = this.db
      .prepare("INSERT INTO projects (user_id, name, description, workspace_path) VALUES (?, ?, ?, ?) RETURNING *")
      .get(userId, name, description, workspacePath) as any;
    return mapProject(row);
  }

  addTokenProjectScope(tokenDbId: number, projectId: number) {
    const existing = this.db
      .prepare("SELECT id FROM mcp_token_project_scopes WHERE token_id = ? AND project_id = ?")
      .get(tokenDbId, projectId);
    if (existing) return;
    this.db
      .prepare("INSERT INTO mcp_token_project_scopes (token_id, project_id) VALUES (?, ?)")
      .run(tokenDbId, projectId);
  }

  getServerForUser(userId: number, serverId: number): ServerInfo | undefined {
    const row = this.db
      .prepare("SELECT * FROM servers WHERE id = ? AND user_id = ?")
      .get(serverId, userId) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      host: row.host,
      port: row.port,
      sshUser: row.ssh_user,
      privateKeyPath: row.private_key_path,
      name: row.name,
      status: row.status,
      os: row.os === "windows" ? "windows" : "linux",
    };
  }

  linkProjectServer(projectId: number, serverId: number, remotePath: string, environment = "production") {
    const existing = this.db
      .prepare("SELECT id FROM project_servers WHERE project_id = ? AND environment = ?")
      .get(projectId, environment);
    if (existing) throw new Error(`Environment '${environment}' already has a server linked`);
    return this.db
      .prepare("INSERT INTO project_servers (project_id, server_id, remote_path, environment) VALUES (?, ?, ?, ?) RETURNING *")
      .get(projectId, serverId, remotePath, environment) as any;
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

function mapProject(row: any): ProjectInfo {
  return {
    id: row.id,
    userId: row.user_id ?? row.userId,
    name: row.name,
    description: row.description,
    workspacePath: row.workspace_path ?? row.workspacePath,
  };
}
