import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "../db/index.js";
import { mcpTokens, projects, projectServers, servers } from "../db/schema.js";
import { z } from "zod";

const CreateTokenSchema = z.object({
  name: z.string().min(1).max(100),
  projectId: z.number().int().optional(),
  projectServerId: z.number().int().optional(),
  environment: z.string().min(1).max(50).default("production"),
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
        environment: mcpTokens.environment,
        active: mcpTokens.active,
        createdAt: mcpTokens.createdAt,
        lastUsedAt: mcpTokens.lastUsedAt,
      })
      .from(mcpTokens)
      .leftJoin(projects, eq(mcpTokens.projectId, projects.id))
      .where(eq(mcpTokens.userId, req.user.id))
      .all();
    return reply.send({ tokens: rows });
  });

  app.post("/api/tokens", { onRequest: [app.authenticate] }, async (req, reply) => {
    const body = CreateTokenSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid input" });

    let projectName: string | undefined;
    let environment = body.data.environment;

    if (body.data.projectId) {
      const project = db
        .select()
        .from(projects)
        .where(and(eq(projects.id, body.data.projectId), eq(projects.userId, req.user.id)))
        .get();
      if (!project) return reply.status(404).send({ error: "Project not found" });
      projectName = project.name;
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
        environment,
        active: true,
      })
      .returning()
      .get();

    const token = app.jwt.sign({
      id: req.user.id,
      username: req.user.username,
      isAdmin: req.user.isAdmin ?? false,
      tokenKind: "mcp",
      tokenId,
      defaultProject: projectName,
      defaultEnvironment: environment,
      projectServerId: body.data.projectServerId,
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
