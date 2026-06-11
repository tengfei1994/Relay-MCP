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
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      remote_path TEXT NOT NULL,
      environment TEXT DEFAULT 'production'
    );
  `);

  // Incremental migrations for existing databases
  try { sqlite.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`); } catch {}

  // Set first user as admin if no admin exists
  const adminExists = sqlite.prepare(`SELECT id FROM users WHERE is_admin = 1 LIMIT 1`).get();
  if (!adminExists) {
    sqlite.prepare(`UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)`).run();
  }
}
