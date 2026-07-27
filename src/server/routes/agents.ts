import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAgentStore } from "../../shared/agent-store.js";
import { agentTokens } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";

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
  message: z.string().max(4000).nullish().transform((value) => value ?? undefined),
  exitCode: z.number().int().optional(),
  stdout: z.string().max(1000000).nullish().transform((value) => value ?? undefined),
  stderr: z.string().max(1000000).nullish().transform((value) => value ?? undefined),
});

export async function agentRoutes(app: FastifyInstance) {
  const store = getAgentStore();
  const authenticateAgent = async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
      if (req.user.tokenKind === "mcp") return;
      if (req.user.tokenKind !== "agent") throw new Error("Agent endpoints require an Agent token");
      const requestedAgentId = (req.params as { agentId?: string })?.agentId;
      if (requestedAgentId && requestedAgentId.toLowerCase() !== String(req.user.agentId ?? "").toLowerCase()) {
        throw new Error("Agent token is not valid for this Agent ID");
      }
      const row = db.select({ id: agentTokens.id })
        .from(agentTokens)
        .where(and(
          eq(agentTokens.tokenId, req.user.tokenId),
          eq(agentTokens.userId, req.user.id),
          eq(agentTokens.active, true),
        ))
        .get();
      if (!row) throw new Error("Agent token is revoked or not found");
      db.update(agentTokens)
        .set({ lastUsedAt: new Date().toISOString() })
        .where(eq(agentTokens.id, row.id))
        .run();
    } catch (error) {
      return reply.status(401).send({ error: error instanceof Error ? error.message : "Invalid Agent token" });
    }
  };

  const agentAuth = { onRequest: [authenticateAgent] };
  app.post("/api/agents/heartbeat", agentAuth, async (req, reply) => {
    const body = HeartbeatSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Invalid heartbeat", details: body.error.issues });
    }
    if (
      req.user.tokenKind === "agent" &&
      body.data.agentId.toLowerCase() !== String(req.user.agentId ?? "").toLowerCase()
    ) {
      return reply.status(401).send({ error: "Agent token is not valid for this Agent ID" });
    }

    const state = store.heartbeat({
      agentId: body.data.agentId,
      userId: req.user.id,
      username: req.user.username,
      machine: body.data.machine,
      lastClientTimestamp: body.data.ts,
    });
    return reply.send({ ok: true, agent: state });
  });

  app.get("/api/agents/:agentId", agentAuth, async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const state = store.getAgentState(req.user.id, agentId);
    if (!state) {
      return reply.status(404).send({ error: "Agent has not checked in" });
    }
    return reply.send({ agent: state });
  });

  app.get("/api/agents/:agentId/jobs/next", agentAuth, async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const job = store.claimNextJob(req.user.id, agentId);
    if (!job) return reply.status(204).send();
    return reply.send({
      jobId: job.id,
      kind: job.kind,
      payload: job.payload,
      timeoutMs: job.timeoutMs,
    });
  });

  app.post("/api/agents/:agentId/jobs/:jobId/events", agentAuth, async (req, reply) => {
    const body = AgentEventSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Invalid event", details: body.error.issues });
    }
    const { agentId, jobId } = req.params as { agentId: string; jobId: string };
    store.appendEvent(req.user.id, agentId, jobId, body.data);
    req.log.info({ agentId, jobId, event: body.data }, "Relay agent job event");
    return reply.send({ ok: true });
  });

  app.post("/api/agents/:agentId/jobs/:jobId/result", agentAuth, async (req, reply) => {
    const body = AgentResultSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Invalid result", details: body.error.issues });
    }
    const { agentId, jobId } = req.params as { agentId: string; jobId: string };
    store.completeJob(req.user.id, agentId, jobId, body.data);
    req.log.info({ agentId, jobId, result: body.data }, "Relay agent job result");
    return reply.send({ ok: true });
  });
}
