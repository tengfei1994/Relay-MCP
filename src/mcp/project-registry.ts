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
  connectionMode: "ssh" | "agent";
  agentId?: string;
}

export interface ProjectServer {
  id: number;
  server: ServerInfo;
  remotePath: string;
  environment: string;
  connectionMode: "ssh" | "agent";
  limsInstance?: LimsInstanceInfo;
}

export interface LimsInstanceInfo {
  id: number;
  name: string;
  version: string;
  runtimeKind: "framework" | "dotnet" | "unknown";
  rootPath: string;
  exePath: string;
  formsPath: string;
  formsBinPath: string;
  solutionAssembliesPath: string;
  logfilePath: string;
  dataPath: string;
  databaseHost: string;
  databaseName: string;
  databaseAuthType: string;
  services: Array<{ name: string; displayName?: string; state?: string; startMode?: string; pathName?: string }>;
  buildProfile: {
    kind: "msbuild" | "dotnet" | "unknown";
    selectedPath?: string;
    selectedVersion?: string;
    targetFramework?: string;
  };
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

  listScopedServerIds(userId: number, tokenDbId?: number, allowAllServers = false): number[] {
    if (!tokenDbId || allowAllServers) {
      const rows = this.db
        .prepare("SELECT id FROM servers WHERE user_id = ?")
        .all(userId) as any[];
      return rows.map((row) => row.id);
    }
    const rows = this.db
      .prepare(`
        SELECT s.id
        FROM servers s
        JOIN mcp_token_server_scopes scope ON scope.server_id = s.id
        WHERE s.user_id = ? AND scope.token_id = ?
      `)
      .all(userId, tokenDbId) as any[];
    return rows.map((row) => row.id);
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
      connectionMode: row.connection_mode === "agent" ? "agent" : "ssh",
      agentId: row.agent_id ?? undefined,
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
        SELECT s.*, ps.id AS project_server_id, ps.remote_path, ps.environment,
          ps.connection_mode AS project_connection_mode, ps.lims_instance_id,
          li.name AS lims_name, li.version AS lims_version, li.runtime_kind AS lims_runtime_kind,
          li.root_path AS lims_root_path, li.exe_path AS lims_exe_path,
          li.forms_path AS lims_forms_path, li.forms_bin_path AS lims_forms_bin_path,
          li.solution_assemblies_path AS lims_solution_assemblies_path,
          li.logfile_path AS lims_logfile_path, li.data_path AS lims_data_path,
          li.database_host AS lims_database_host, li.database_name AS lims_database_name,
          li.database_auth_type AS lims_database_auth_type, li.services_json AS lims_services_json,
          li.build_profile_json AS lims_build_profile_json
        FROM project_servers ps
        JOIN servers s ON s.id = ps.server_id
        LEFT JOIN lims_instances li ON li.id = ps.lims_instance_id
        WHERE ps.project_id = ?
      `)
      .all(projectId) as any[];

    return rows.map((r) => ({
      id: r.project_server_id,
      server: {
        id: r.id,
        host: r.host,
        port: r.port,
        sshUser: r.ssh_user,
        privateKeyPath: r.private_key_path,
        name: r.name,
        status: r.status,
        os: r.os === "windows" ? "windows" : "linux",
        connectionMode: r.connection_mode === "agent" ? "agent" : "ssh",
        agentId: r.agent_id ?? undefined,
      },
      remotePath: r.remote_path,
      environment: r.environment,
      connectionMode: r.project_connection_mode === "agent" || r.connection_mode === "agent" ? "agent" : "ssh",
      limsInstance: r.lims_instance_id ? {
        id: r.lims_instance_id,
        name: r.lims_name,
        version: r.lims_version ?? "",
        runtimeKind: r.lims_runtime_kind === "framework" || r.lims_runtime_kind === "dotnet" ? r.lims_runtime_kind : "unknown",
        rootPath: r.lims_root_path,
        exePath: r.lims_exe_path,
        formsPath: r.lims_forms_path,
        formsBinPath: r.lims_forms_bin_path,
        solutionAssembliesPath: r.lims_solution_assemblies_path,
        logfilePath: r.lims_logfile_path,
        dataPath: r.lims_data_path,
        databaseHost: r.lims_database_host ?? "",
        databaseName: r.lims_database_name ?? "",
        databaseAuthType: r.lims_database_auth_type ?? "unknown",
        services: JSON.parse(r.lims_services_json ?? "[]"),
        buildProfile: JSON.parse(r.lims_build_profile_json ?? "{}"),
      } : undefined,
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
