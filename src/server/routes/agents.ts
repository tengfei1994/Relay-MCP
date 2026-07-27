import type { FastifyInstance } from "fastify";
import { z } from "zod";

const HeartbeatSchema = z.object({
  agentId: z.string().min(1).max(120),
  machine: z.string().max(120).optional(),
  ts: z.string().max(80).optional(),
});

const AgentEventSchema = z.object({
  level: z.string().max(40).optional(),
  message: z.string().max(4000).optional(),
  data: z.unknown().optional(),
});

const AgentResultSchema = z.object({
  status: z.string().max(80),
  message: z.string().max(4000).optional(),
  exitCode: z.number().int().optional(),
  stdout: z.string().max(20000).optional(),
  stderr: z.string().max(20000).optional(),
});

interface AgentState {
  agentId: string;
  userId: number;
  username: string;
  machine?: string;
  lastSeenAt: string;
  lastClientTimestamp?: string;
}

const agents = new Map<string, AgentState>();

export async function agentRoutes(app: FastifyInstance) {
  app.post("/api/agents/heartbeat", { onRequest: [app.authenticate] }, async (req, reply) => {
    const body = HeartbeatSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Invalid heartbeat", details: body.error.issues });
    }

    const state: AgentState = {
      agentId: body.data.agentId,
      userId: req.user.id,
      username: req.user.username,
      machine: body.data.machine,
      lastSeenAt: new Date().toISOString(),
      lastClientTimestamp: body.data.ts,
    };
    agents.set(agentKey(req.user.id, body.data.agentId), state);
    return reply.send({ ok: true, agent: state });
  });

  app.get("/api/agents/:agentId", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const state = agents.get(agentKey(req.user.id, agentId));
    if (!state) {
      return reply.status(404).send({ error: "Agent has not checked in" });
    }
    return reply.send({ agent: state });
  });

  app.get("/api/agents/:agentId/jobs/next", { onRequest: [app.authenticate] }, async (_req, reply) => {
    return reply.status(204).send();
  });

  app.post("/api/agents/:agentId/jobs/:jobId/events", { onRequest: [app.authenticate] }, async (req, reply) => {
    const body = AgentEventSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Invalid event", details: body.error.issues });
    }
    const { agentId, jobId } = req.params as { agentId: string; jobId: string };
    req.log.info({ agentId, jobId, event: body.data }, "Relay agent job event");
    return reply.send({ ok: true });
  });

  app.post("/api/agents/:agentId/jobs/:jobId/result", { onRequest: [app.authenticate] }, async (req, reply) => {
    const body = AgentResultSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Invalid result", details: body.error.issues });
    }
    const { agentId, jobId } = req.params as { agentId: string; jobId: string };
    req.log.info({ agentId, jobId, result: body.data }, "Relay agent job result");
    return reply.send({ ok: true });
  });
}

function agentKey(userId: number, agentId: string): string {
  return `${userId}:${agentId.toLowerCase()}`;
}

