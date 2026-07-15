import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects, servers, projectServers } from "../db/schema.js";
import { RemoteRunner } from "../../shared/remote-runner.js";
import { z } from "zod";
import { quotePosix, quotePowerShell } from "../../shared/shell-utils.js";

export async function projectServerRoutes(app: FastifyInstance) {
  // List servers linked to a project
  app.get(
    "/api/projects/:id/servers",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user.id;

      const project = db
        .select()
        .from(projects)
        .where(and(eq(projects.id, Number(id)), eq(projects.userId, userId)))
        .get();
      if (!project) return reply.status(404).send({ error: "Project not found" });

      const rows = db
        .select({
          id: projectServers.id,
          projectId: projectServers.projectId,
          serverId: projectServers.serverId,
          remotePath: projectServers.remotePath,
          environment: projectServers.environment,
          serverName: servers.name,
          serverHost: servers.host,
          serverPort: servers.port,
          serverSshUser: servers.sshUser,
          serverStatus: servers.status,
        })
        .from(projectServers)
        .innerJoin(servers, eq(projectServers.serverId, servers.id))
        .where(eq(projectServers.projectId, Number(id)))
        .all();

      return reply.send({ servers: rows });
    }
  );

  // Link a server to a project
  app.post(
    "/api/projects/:id/servers",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user.id;

      const LinkSchema = z.object({
        serverId: z.number().int(),
        remotePath: z.string().min(1),
        environment: z.string().default("production"),
      });
      const body = LinkSchema.safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: "Invalid input" });

      const project = db
        .select()
        .from(projects)
        .where(and(eq(projects.id, Number(id)), eq(projects.userId, userId)))
        .get();
      if (!project) return reply.status(404).send({ error: "Project not found" });

      const server = db
        .select()
        .from(servers)
        .where(and(eq(servers.id, body.data.serverId), eq(servers.userId, userId)))
        .get();
      if (!server) return reply.status(404).send({ error: "Server not found" });

      // Check for duplicate environment
      const existing = db
        .select()
        .from(projectServers)
        .where(
          and(
            eq(projectServers.projectId, Number(id)),
            eq(projectServers.environment, body.data.environment)
          )
        )
        .get();
      if (existing) {
        return reply.status(409).send({ error: `Environment '${body.data.environment}' already has a server linked` });
      }

      const runner = new RemoteRunner({
        host: server.host,
        port: server.port ?? 22,
        username: server.sshUser,
        privateKeyPath: server.privateKeyPath,
        os: server.os === "windows" ? "windows" : "linux",
      });
      const mkdirResult = runner.isWindows()
        ? await runner.execPowerShell(`New-Item -ItemType Directory -Force -LiteralPath ${quotePowerShell(body.data.remotePath)} | Out-Null`)
        : await runner.exec(`mkdir -p -- ${quotePosix(body.data.remotePath)}`);
      if (mkdirResult.code !== 0) {
        return reply.status(502).send({ error: mkdirResult.stderr || "Failed to create remote project directory" });
      }

      const result = db
        .insert(projectServers)
        .values({
          projectId: Number(id),
          serverId: body.data.serverId,
          remotePath: body.data.remotePath,
          environment: body.data.environment,
        })
        .returning()
        .get();

      return reply.status(201).send({ link: result });
    }
  );

  // Unlink a server from a project
  app.delete(
    "/api/projects/:projectId/servers/:linkId",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { projectId, linkId } = req.params as { projectId: string; linkId: string };
      const userId = req.user.id;

      const project = db
        .select()
        .from(projects)
        .where(and(eq(projects.id, Number(projectId)), eq(projects.userId, userId)))
        .get();
      if (!project) return reply.status(404).send({ error: "Project not found" });

      db.delete(projectServers).where(eq(projectServers.id, Number(linkId))).run();
      return reply.send({ ok: true });
    }
  );
}
