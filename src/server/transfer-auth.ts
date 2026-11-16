import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { mcpTokenProjectScopes, mcpTokens, projects, users } from "./db/schema.js";

/** Recheck account, project ownership and any originating MCP token on each transfer. */
export function authorizeTransfer(userId: number, projectId: number, mcpTokenDbId?: number, origin?: "web" | "mcp") {
  // Old short-lived capabilities have no provenance and must be recreated.
  if (!origin || (origin === "mcp" && mcpTokenDbId === undefined) || (origin === "web" && mcpTokenDbId !== undefined)) {
    throw new Error("Transfer access is no longer available");
  }
  const project = db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).get();
  const user = db.select({ accountStatus: users.accountStatus }).from(users).where(eq(users.id, userId)).get();
  if (!project || user?.accountStatus !== "active") throw new Error("Transfer access is no longer available");
  if (mcpTokenDbId !== undefined) {
    const token = db.select({ active: mcpTokens.active, allowAllProjects: mcpTokens.allowAllProjects }).from(mcpTokens)
      .where(and(eq(mcpTokens.id, mcpTokenDbId), eq(mcpTokens.userId, userId))).get();
    if (!token?.active) throw new Error("Transfer access is no longer available");
    if (!token.allowAllProjects && !db.select({ id: mcpTokenProjectScopes.id }).from(mcpTokenProjectScopes)
      .where(and(eq(mcpTokenProjectScopes.tokenId, mcpTokenDbId), eq(mcpTokenProjectScopes.projectId, projectId))).get()) {
      throw new Error("Transfer access is no longer available");
    }
  }
  return project;
}
