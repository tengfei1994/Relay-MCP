import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "../db/index.js";
import { mcpTokenProjectScopes, mcpTokenServerScopes, mcpTokens, projects, projectServers, servers } from "../db/schema.js";
import { z } from "zod";

const CreateTokenSchema = z.object({
  name: z.string().min(1).max(100),
  projectId: z.number().int().optional(),
  projectIds: z.array(z.number().int()).optional(),
  projectServerId: z.number().int().optional(),
  defaultServerId: z.number().int().optional(),
  serverIds: z.array(z.number().int()).min(1),
  environment: z.string().min(1).max(50).default("production"),
  allowAllProjects: z.boolean().default(false),
  canCreateProjects: z.boolean().default(false),
});

export async function tokenRoutes(app: FastifyInstance) {
  app.get("/api/tokens", { onRequest: [app.authenticate] }, async (req, reply) => {
    const rows = db
      .select({
        id: mcpTokens.id,
        tokenId: mcpTokens.tokenId,
        name: mcpTokens.name,
        projectId: mcpTokens.projectId,
        projectName: projects.name,
        projectServerId: mcpTokens.projectServerId,
        defaultServerId: mcpTokens.defaultServerId,
        environment: mcpTokens.environment,
        allowAllProjects: mcpTokens.allowAllProjects,
        canCreateProjects: mcpTokens.canCreateProjects,
        active: mcpTokens.active,
        createdAt: mcpTokens.createdAt,
        lastUsedAt: mcpTokens.lastUsedAt,
      })
      .from(mcpTokens)
      .leftJoin(projects, eq(mcpTokens.projectId, projects.id))
      .where(eq(mcpTokens.userId, req.user.id))
      .all();

    const scopes = db
      .select({
        tokenDbId: mcpTokenProjectScopes.tokenId,
        projectId: mcpTokenProjectScopes.projectId,
        projectName: projects.name,
      })
      .from(mcpTokenProjectScopes)
      .innerJoin(projects, eq(mcpTokenProjectScopes.projectId, projects.id))
      .where(eq(projects.userId, req.user.id))
      .all();

    const serverScopes = db
      .select({
        tokenDbId: mcpTokenServerScopes.tokenId,
        serverId: mcpTokenServerScopes.serverId,
        serverName: servers.name,
        serverHost: servers.host,
      })
      .from(mcpTokenServerScopes)
      .innerJoin(servers, eq(mcpTokenServerScopes.serverId, servers.id))
      .where(eq(servers.userId, req.user.id))
      .all();

    return reply.send({
      tokens: rows.map((row) => ({
        ...row,
        projectScopes: scopes.filter((scope) => scope.tokenDbId === row.id),
        serverScopes: serverScopes.filter((scope) => scope.tokenDbId === row.id),
      })),
    });
  });

  app.post("/api/tokens", { onRequest: [app.authenticate] }, async (req, reply) => {
    const body = CreateTokenSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid input" });

    let projectName: string | undefined;
    let environment = body.data.environment;
    const scopedProjectIds = Array.from(new Set([...(body.data.projectIds ?? []), ...(body.data.projectId ? [body.data.projectId] : [])]));
    const scopedServerIds = Array.from(new Set(body.data.serverIds));

    if (!body.data.allowAllProjects && scopedProjectIds.length === 0) {
      return reply.status(400).send({ error: "Select at least one project or allow all projects" });
    }
    if (body.data.defaultServerId && !scopedServerIds.includes(body.data.defaultServerId)) {
      return reply.status(400).send({ error: "Default server must be included in allowed servers" });
    }

    if (body.data.projectId) {
      const project = db
        .select()
        .from(projects)
        .where(and(eq(projects.id, body.data.projectId), eq(projects.userId, req.user.id)))
        .get();
      if (!project) return reply.status(404).send({ error: "Project not found" });
      projectName = project.name;
    }

    if (scopedProjectIds.length > 0) {
      const ownedProjects = db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.userId, req.user.id))
        .all();
      const ownedIds = new Set(ownedProjects.map((project) => project.id));
      const invalid = scopedProjectIds.filter((projectId) => !ownedIds.has(projectId));
      if (invalid.length > 0) {
        return reply.status(404).send({ error: `Project scope not found: ${invalid.join(", ")}` });
      }
    }

    const ownedServers = db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.userId, req.user.id))
      .all();
    const ownedServerIds = new Set(ownedServers.map((server) => server.id));
    const invalidServers = scopedServerIds.filter((serverId) => !ownedServerIds.has(serverId));
    if (invalidServers.length > 0) {
      return reply.status(404).send({ error: `Server scope not found: ${invalidServers.join(", ")}` });
    }

    if (body.data.projectServerId) {
      const link = db
        .select({
          id: projectServers.id,
          projectId: projectServers.projectId,
          environment: projectServers.environment,
          projectName: projects.name,
          serverUserId: servers.userId,
        })
        .from(projectServers)
        .innerJoin(projects, eq(projectServers.projectId, projects.id))
        .innerJoin(servers, eq(projectServers.serverId, servers.id))
        .where(eq(projectServers.id, body.data.projectServerId))
        .get();
      if (!link || link.serverUserId !== req.user.id) {
        return reply.status(404).send({ error: "Project server link not found" });
      }
      if (body.data.projectId && link.projectId !== body.data.projectId) {
        return reply.status(400).send({ error: "Project server link does not belong to the selected project" });
      }
      projectName = link.projectName;
      environment = link.environment ?? environment;
    }

    const tokenId = randomUUID();
    const row = db
      .insert(mcpTokens)
      .values({
        userId: req.user.id,
        tokenId,
        name: body.data.name,
        projectId: body.data.projectId,
        projectServerId: body.data.projectServerId,
        defaultServerId: body.data.defaultServerId,
        environment,
        allowAllProjects: body.data.allowAllProjects,
        canCreateProjects: body.data.canCreateProjects,
        active: true,
      })
      .returning()
      .get();

    if (!body.data.allowAllProjects && scopedProjectIds.length > 0) {
      db.insert(mcpTokenProjectScopes)
        .values(scopedProjectIds.map((projectId) => ({ tokenId: row.id, projectId })))
        .run();
    }
    db.insert(mcpTokenServerScopes)
      .values(scopedServerIds.map((serverId) => ({ tokenId: row.id, serverId })))
      .run();

    const token = app.jwt.sign({
      id: req.user.id,
      username: req.user.username,
      isAdmin: req.user.isAdmin ?? false,
      tokenKind: "mcp",
      tokenId,
      defaultProject: projectName,
      defaultEnvironment: environment,
      projectServerId: body.data.projectServerId,
      defaultServerId: body.data.defaultServerId,
    });

    return reply.status(201).send({ token, profile: row });
  });

  app.delete("/api/tokens/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    db.update(mcpTokens)
      .set({ active: false })
      .where(and(eq(mcpTokens.id, Number(id)), eq(mcpTokens.userId, req.user.id)))
      .run();
    return reply.send({ ok: true });
  });
}
