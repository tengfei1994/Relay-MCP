import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { limsInstances, projects, servers, projectServers } from "../db/schema.js";
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
          serverConnectionMode: servers.connectionMode,
          serverAgentId: servers.agentId,
          serverStatus: servers.status,
          connectionMode: projectServers.connectionMode,
          limsInstanceId: projectServers.limsInstanceId,
          limsInstanceName: limsInstances.name,
          limsInstanceVersion: limsInstances.version,
          limsRuntimeKind: limsInstances.runtimeKind,
          limsDatabaseName: limsInstances.databaseName,
        })
        .from(projectServers)
        .innerJoin(servers, eq(projectServers.serverId, servers.id))
        .leftJoin(limsInstances, eq(projectServers.limsInstanceId, limsInstances.id))
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
        remotePath: z.string().optional(),
        environment: z.string().default("production"),
        connectionMode: z.enum(["ssh", "agent"]).optional(),
        limsInstanceId: z.number().int().optional().nullable(),
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
      const connectionMode = body.data.connectionMode ?? server.connectionMode ?? "ssh";
      const remotePath = body.data.remotePath?.trim() ?? "";
      if (connectionMode === "ssh" && !remotePath) {
        return reply.status(400).send({ error: "Remote path is required for SSH links" });
      }
      if (connectionMode === "agent" && !server.agentId) {
        return reply.status(400).send({ error: "Selected server does not have an Agent ID" });
      }
      if (body.data.limsInstanceId) {
        const instance = db.select().from(limsInstances).where(and(
          eq(limsInstances.id, body.data.limsInstanceId),
          eq(limsInstances.serverId, server.id),
          eq(limsInstances.userId, userId),
        )).get();
        if (!instance) return reply.status(400).send({ error: "Selected LIMS instance does not belong to this server" });
      }

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

      if (connectionMode === "ssh") {
        const runner = new RemoteRunner({
          host: server.host,
          port: server.port ?? 22,
          username: server.sshUser,
          privateKeyPath: server.privateKeyPath,
          os: server.os === "windows" ? "windows" : "linux",
        });
        const mkdirResult = runner.isWindows()
          ? await runner.execPowerShell(`New-Item -ItemType Directory -Force -LiteralPath ${quotePowerShell(remotePath)} | Out-Null`)
          : await runner.exec(`mkdir -p -- ${quotePosix(remotePath)}`);
        if (mkdirResult.code !== 0) {
          return reply.status(502).send({ error: mkdirResult.stderr || "Failed to create remote project directory" });
        }
      }

      const result = db
        .insert(projectServers)
        .values({
          projectId: Number(id),
          serverId: body.data.serverId,
          remotePath,
          environment: body.data.environment,
          connectionMode,
          limsInstanceId: body.data.limsInstanceId ?? null,
        })
        .returning()
        .get();

      return reply.status(201).send({ link: result });
    }
  );

  // Update an existing project-server link, including its LIMS instance binding.
  app.put(
    "/api/projects/:projectId/servers/:linkId",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { projectId, linkId } = req.params as { projectId: string; linkId: string };
      const userId = req.user.id;
      const LinkSchema = z.object({
        remotePath: z.string().optional(),
        environment: z.string().min(1).default("production"),
        connectionMode: z.enum(["ssh", "agent"]).optional(),
        limsInstanceId: z.number().int().optional().nullable(),
      });
      const body = LinkSchema.safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: "Invalid input" });

      const project = db.select().from(projects).where(and(
        eq(projects.id, Number(projectId)),
        eq(projects.userId, userId),
      )).get();
      if (!project) return reply.status(404).send({ error: "Project not found" });

      const existing = db.select().from(projectServers).where(and(
        eq(projectServers.id, Number(linkId)),
        eq(projectServers.projectId, project.id),
      )).get();
      if (!existing) return reply.status(404).send({ error: "Server link not found" });

      const server = db.select().from(servers).where(and(
        eq(servers.id, existing.serverId),
        eq(servers.userId, userId),
      )).get();
      if (!server) return reply.status(404).send({ error: "Server not found" });

      const connectionMode = body.data.connectionMode ?? existing.connectionMode ?? server.connectionMode ?? "ssh";
      const remotePath = body.data.remotePath?.trim() ?? existing.remotePath ?? "";
      if (connectionMode === "ssh" && !remotePath) {
        return reply.status(400).send({ error: "Remote path is required for SSH links" });
      }
      if (connectionMode === "agent" && !server.agentId) {
        return reply.status(400).send({ error: "Selected server does not have an Agent ID" });
      }
      if (body.data.limsInstanceId) {
        const instance = db.select().from(limsInstances).where(and(
          eq(limsInstances.id, body.data.limsInstanceId),
          eq(limsInstances.serverId, server.id),
          eq(limsInstances.userId, userId),
        )).get();
        if (!instance) return reply.status(400).send({ error: "Selected LIMS instance does not belong to this server" });
      }

      const environment = body.data.environment.trim();
      const duplicate = db.select().from(projectServers).where(and(
        eq(projectServers.projectId, project.id),
        eq(projectServers.environment, environment),
      )).all().find((link) => link.id !== existing.id);
      if (duplicate) {
        return reply.status(409).send({ error: `Environment '${environment}' already has a server linked` });
      }

      const result = db.update(projectServers).set({
        remotePath,
        environment,
        connectionMode,
        limsInstanceId: body.data.limsInstanceId ?? null,
      }).where(eq(projectServers.id, existing.id)).returning().get();

      return reply.send({ link: result });
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
