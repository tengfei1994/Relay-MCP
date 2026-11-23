import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { limsInstances, projects, projectServers, servers } from "../db/schema.js";
import { TOOL_CATALOG } from "../../shared/tool-catalog.js";
import { getJob, listJobs, type JobRecord } from "../../shared/job-store.js";
import { sanitizeAuditArguments } from "../../shared/audit-sanitizer.js";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), project: z.string().trim().min(1).max(120).optional() });
const jobParams = z.object({ id: z.string().max(256).regex(/^[A-Za-z0-9_-]+$/) });

const descriptions = new Map(TOOL_CATALOG.map((tool) => [tool.name, tool.description]));

function jobTarget(job: JobRecord) {
  if (!job.input || typeof job.input !== "object") return undefined;
  const input = job.input as Record<string, unknown>;
  if (typeof input.projectServerId === "number") {
    const target = db.select({ server: servers.name, instance: limsInstances.name }).from(projectServers)
      .innerJoin(projects, and(eq(projects.id, projectServers.projectId), eq(projects.userId, job.userId)))
      .innerJoin(servers, and(eq(servers.id, projectServers.serverId), eq(servers.userId, job.userId)))
      .leftJoin(limsInstances, and(eq(limsInstances.id, projectServers.limsInstanceId), eq(limsInstances.serverId, servers.id)))
      .where(eq(projectServers.id, input.projectServerId)).get();
    if (target) return target;
  }
  if (typeof input.serverId !== "number") return undefined;
  return db.select({ server: servers.name }).from(servers)
    .where(and(eq(servers.id, input.serverId), eq(servers.userId, job.userId))).get();
}

function jobMetadata(job: JobRecord) {
  return {
    id: job.id,
    project: job.project,
    projectId: job.projectIdSnapshot,
    environment: job.environment,
    kind: job.kind,
    description: descriptions.get(job.kind),
    status: job.status,
    phase: job.phase,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastHeartbeatAt: job.lastHeartbeatAt,
    errorCategory: job.errorCategory,
    retrySafe: job.retrySafe === true,
    retryOf: job.retryOf,
  };
}

export async function jobRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] };

  app.get("/api/jobs", auth, async (request, reply) => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid jobs limit" });
    const jobs = listJobs(request.user.id, query.data.limit, query.data.project).map(jobMetadata);
    return reply.header("Cache-Control", "no-store").send({ jobs });
  });

  app.get("/api/jobs/:id", auth, async (request, reply) => {
    const params = jobParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "Job not found" });
    const job = getJob(params.data.id);
    if (!job || job.userId !== request.user.id) return reply.code(404).send({ error: "Job not found" });
    const logs = (job.logs ?? []).slice(-100).map(({ at, level, message }) => {
      const sanitized = sanitizeAuditArguments(message);
      return { at, level, message: typeof sanitized === "string" ? sanitized.slice(0, 2000) : "[redacted]" };
    });
    return reply.header("Cache-Control", "no-store").send({ job: { ...jobMetadata(job), target: jobTarget(job), logs } });
  });
}
