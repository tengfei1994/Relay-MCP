import { sqliteTable, text, integer, blob } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: integer("is_admin", { mode: "boolean" }).default(false),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").default(""),
  workspacePath: text("workspace_path").notNull(), // /workspace/{username}/{project}
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const servers = sqliteTable("servers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  host: text("host").notNull(),
  port: integer("port").default(22),
  sshUser: text("ssh_user").notNull(),
  privateKeyPath: text("private_key_path").notNull(), // path on MCP server
  publicKey: text("public_key").notNull(),
  os: text("os").default("linux"), // linux | windows
  status: text("status").default("pending"), // pending | connected | failed
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const projectServers = sqliteTable("project_servers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  serverId: integer("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
  remotePath: text("remote_path").notNull(), // deployment target path on server
  environment: text("environment").default("production"),
});

export const mcpTokens = sqliteTable("mcp_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenId: text("token_id").notNull().unique(),
  name: text("name").notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  projectServerId: integer("project_server_id").references(() => projectServers.id, { onDelete: "set null" }),
  defaultServerId: integer("default_server_id").references(() => servers.id, { onDelete: "set null" }),
  environment: text("environment").default("production"),
  allowAllProjects: integer("allow_all_projects", { mode: "boolean" }).default(false),
  canCreateProjects: integer("can_create_projects", { mode: "boolean" }).default(false),
  active: integer("active", { mode: "boolean" }).default(true),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  lastUsedAt: text("last_used_at"),
});

export const mcpTokenProjectScopes = sqliteTable("mcp_token_project_scopes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenId: integer("token_id")
    .notNull()
    .references(() => mcpTokens.id, { onDelete: "cascade" }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
});

export const mcpTokenServerScopes = sqliteTable("mcp_token_server_scopes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenId: integer("token_id")
    .notNull()
    .references(() => mcpTokens.id, { onDelete: "cascade" }),
  serverId: integer("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
});
