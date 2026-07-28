import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { mkdirSync } from "fs";
import { dirname } from "path";
import "dotenv/config";

const dbPath = process.env.DB_PATH ?? "./data/app.db";
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

// Run migrations on startup
export function runMigrations() {
  // Create tables directly for simplicity (no separate migration files needed)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      workspace_path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER DEFAULT 22,
      ssh_user TEXT NOT NULL,
      private_key_path TEXT NOT NULL,
      public_key TEXT NOT NULL,
      connection_mode TEXT DEFAULT 'ssh',
      agent_id TEXT,
      os TEXT DEFAULT 'linux',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      remote_path TEXT NOT NULL,
      environment TEXT DEFAULT 'production',
      connection_mode TEXT DEFAULT 'ssh'
    );

    CREATE TABLE IF NOT EXISTS lims_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      version TEXT DEFAULT '',
      runtime_kind TEXT DEFAULT 'unknown',
      root_path TEXT NOT NULL,
      exe_path TEXT NOT NULL,
      forms_path TEXT NOT NULL,
      forms_bin_path TEXT NOT NULL,
      solution_assemblies_path TEXT NOT NULL,
      logfile_path TEXT NOT NULL,
      data_path TEXT NOT NULL,
      database_host TEXT DEFAULT '',
      database_name TEXT DEFAULT '',
      database_auth_type TEXT DEFAULT 'unknown',
      database_config_source TEXT DEFAULT '',
      services_json TEXT DEFAULT '[]',
      build_profile_json TEXT DEFAULT '{}',
      discovery_json TEXT DEFAULT '{}',
      status TEXT DEFAULT 'ready',
      last_discovered_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(server_id, name)
    );

    CREATE TABLE IF NOT EXISTS mcp_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      project_server_id INTEGER REFERENCES project_servers(id) ON DELETE SET NULL,
      default_server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL,
      environment TEXT DEFAULT 'production',
      allow_all_projects INTEGER DEFAULT 0,
      can_create_projects INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS mcp_token_project_scopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id INTEGER NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mcp_token_server_scopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id INTEGER NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_states (
      user_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL COLLATE NOCASE,
      username TEXT NOT NULL,
      machine TEXT,
      last_seen_at TEXT NOT NULL,
      last_client_timestamp TEXT,
      PRIMARY KEY (user_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS agent_jobs (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL COLLATE NOCASE,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      completed_at TEXT,
      result_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_jobs_next
    ON agent_jobs (user_id, agent_id, status, created_at);

    CREATE TABLE IF NOT EXISTS agent_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      event_json TEXT NOT NULL
    );
  `);

  // Incremental migrations for existing databases
  try { sqlite.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`); } catch {}
  try { sqlite.exec(`ALTER TABLE servers ADD COLUMN os TEXT DEFAULT 'linux'`); } catch {}
  try { sqlite.exec(`ALTER TABLE servers ADD COLUMN connection_mode TEXT DEFAULT 'ssh'`); } catch {}
  try { sqlite.exec(`ALTER TABLE servers ADD COLUMN agent_id TEXT`); } catch {}
  try { sqlite.exec(`ALTER TABLE project_servers ADD COLUMN connection_mode TEXT DEFAULT 'ssh'`); } catch {}
  try { sqlite.exec(`ALTER TABLE project_servers ADD COLUMN lims_instance_id INTEGER REFERENCES lims_instances(id) ON DELETE SET NULL`); } catch {}
  try { sqlite.exec(`ALTER TABLE mcp_tokens ADD COLUMN default_server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL`); } catch {}
  try { sqlite.exec(`ALTER TABLE mcp_tokens ADD COLUMN allow_all_projects INTEGER DEFAULT 0`); } catch {}
  try { sqlite.exec(`ALTER TABLE mcp_tokens ADD COLUMN can_create_projects INTEGER DEFAULT 0`); } catch {}
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_lims_instances_server ON lims_instances(server_id, name)`);

  // Set first user as admin if no admin exists
  const adminExists = sqlite.prepare(`SELECT id FROM users WHERE is_admin = 1 LIMIT 1`).get();
  if (!adminExists) {
    sqlite.prepare(`UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)`).run();
  }
}
