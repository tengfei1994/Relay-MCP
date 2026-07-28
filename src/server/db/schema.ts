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
  connectionMode: text("connection_mode").default("ssh"), // ssh | agent
  agentId: text("agent_id"),
  os: text("os").default("linux"), // linux | windows
  status: text("status").default("pending"), // pending | connected | failed
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const limsInstances = sqliteTable("lims_instances", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  serverId: integer("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  version: text("version").default(""),
  runtimeKind: text("runtime_kind").default("unknown"), // framework | dotnet | unknown
  rootPath: text("root_path").notNull(),
  exePath: text("exe_path").notNull(),
  formsPath: text("forms_path").notNull(),
  formsBinPath: text("forms_bin_path").notNull(),
  solutionAssembliesPath: text("solution_assemblies_path").notNull(),
  logfilePath: text("logfile_path").notNull(),
  dataPath: text("data_path").notNull(),
  databaseHost: text("database_host").default(""),
  databaseName: text("database_name").default(""),
  databaseAuthType: text("database_auth_type").default("unknown"),
  databaseConfigSource: text("database_config_source").default(""),
  servicesJson: text("services_json").default("[]"),
  buildProfileJson: text("build_profile_json").default("{}"),
  discoveryJson: text("discovery_json").default("{}"),
  status: text("status").default("ready"), // ready | needs-review | unavailable
  lastDiscoveredAt: text("last_discovered_at"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
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
  connectionMode: text("connection_mode").default("ssh"), // ssh | agent
  limsInstanceId: integer("lims_instance_id").references(() => limsInstances.id, { onDelete: "set null" }),
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

export const agentTokens = sqliteTable("agent_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenId: text("token_id").notNull().unique(),
  name: text("name").notNull(),
  agentId: text("agent_id").notNull(),
  serverId: integer("server_id").references(() => servers.id, { onDelete: "set null" }),
  active: integer("active", { mode: "boolean" }).default(true),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  lastUsedAt: text("last_used_at"),
});
