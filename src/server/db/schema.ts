import { sqliteTable, text, integer, blob } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
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
