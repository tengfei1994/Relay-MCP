import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod";
import { agentTokens, servers } from "../db/schema.js";
import { db } from "../db/index.js";

const CreateAgentTokenSchema = z.object({
  name: z.string().min(1).max(100),
  serverId: z.number().int(),
});

export async function agentTokenRoutes(app: FastifyInstance) {
  app.get("/api/agent-tokens", { onRequest: [app.authenticate] }, async (req, reply) => {
    const rows = db
      .select({
        id: agentTokens.id,
        name: agentTokens.name,
        agentId: agentTokens.agentId,
        serverId: agentTokens.serverId,
        serverName: servers.name,
        active: agentTokens.active,
        createdAt: agentTokens.createdAt,
        lastUsedAt: agentTokens.lastUsedAt,
      })
      .from(agentTokens)
      .leftJoin(servers, eq(agentTokens.serverId, servers.id))
      .where(eq(agentTokens.userId, req.user.id))
      .all();
    return reply.send({ tokens: rows });
  });

  app.post("/api/agent-tokens", { onRequest: [app.authenticate] }, async (req, reply) => {
    const body = CreateAgentTokenSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid input" });

    const server = db
      .select({ id: servers.id, name: servers.name, agentId: servers.agentId, connectionMode: servers.connectionMode })
      .from(servers)
      .where(and(eq(servers.id, body.data.serverId), eq(servers.userId, req.user.id)))
      .get();
    if (!server) return reply.status(404).send({ error: "Server not found" });
    if (server.connectionMode !== "agent" || !server.agentId) {
      return reply.status(400).send({ error: "Selected server is not configured for Agent mode" });
    }

    const tokenId = randomUUID();
    const row = db.insert(agentTokens).values({
      userId: req.user.id,
      tokenId,
      name: body.data.name,
      agentId: server.agentId,
      serverId: server.id,
      active: true,
    }).returning().get();

    const token = app.jwt.sign({
      id: req.user.id,
      username: req.user.username,
      isAdmin: req.user.isAdmin ?? false,
      tokenKind: "agent",
      tokenId,
      agentId: server.agentId,
    });
    return reply.status(201).send({ token, profile: row });
  });

  app.delete("/api/agent-tokens/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    db.update(agentTokens)
      .set({ active: false })
      .where(and(eq(agentTokens.id, Number(id)), eq(agentTokens.userId, req.user.id)))
      .run();
    return reply.send({ ok: true });
  });
}
