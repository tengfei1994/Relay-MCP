import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { z } from "zod";
import { mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import "dotenv/config";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  description: z.string().max(500).optional(),
});

export async function projectRoutes(app: FastifyInstance) {
  // List projects for current user
  app.get(
    "/api/projects",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const userId = req.user.id;
      const result = db
        .select()
        .from(projects)
        .where(eq(projects.userId, userId))
        .all();
      return reply.send({ projects: result });
    }
  );

  // Create project
  app.post(
    "/api/projects",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const body = CreateProjectSchema.safeParse(req.body);
      if (!body.success) {
        return reply.status(400).send({ error: "Invalid input", details: body.error.issues });
      }

      const userId = req.user.id;
      const { name, description } = body.data;

      // Check name uniqueness for user
      const existing = db
        .select()
        .from(projects)
        .where(and(eq(projects.userId, userId), eq(projects.name, name)))
        .get();
      if (existing) {
        return reply.status(409).send({ error: "Project name already exists" });
      }

      const username = req.user.username;
      const workspacePath = join(WORKSPACE_ROOT, username, name);
      mkdirSync(workspacePath, { recursive: true });

      const result = db
        .insert(projects)
        .values({ userId, name, description: description ?? "", workspacePath })
        .returning()
        .get();

      return reply.status(201).send({ project: result });
    }
  );

  // Get project details
  app.get(
    "/api/projects/:id",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user.id;

      const project = db
        .select()
        .from(projects)
        .where(and(eq(projects.id, Number(id)), eq(projects.userId, userId)))
        .get();

      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }
      return reply.send({ project });
    }
  );

  // Delete project
  app.delete(
    "/api/projects/:id",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user.id;

      const project = db
        .select()
        .from(projects)
        .where(and(eq(projects.id, Number(id)), eq(projects.userId, userId)))
        .get();

      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      db.delete(projects).where(eq(projects.id, Number(id))).run();
      // Note: workspace directory is NOT deleted — manual cleanup required
      return reply.send({ ok: true });
    }
  );

  // List files in project workspace
  app.get(
    "/api/projects/:id/files",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { path: relPath = "" } = req.query as { path?: string };
      const userId = req.user.id;

      const project = db
        .select()
        .from(projects)
        .where(and(eq(projects.id, Number(id)), eq(projects.userId, userId)))
        .get();

      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      const targetDir = join(project.workspacePath, relPath);
      if (!targetDir.startsWith(project.workspacePath)) {
        return reply.status(400).send({ error: "Path traversal not allowed" });
      }

      if (!existsSync(targetDir)) {
        return reply.status(404).send({ error: "Directory not found" });
      }

      const entries = readdirSync(targetDir).map((name) => {
        const fullPath = join(targetDir, name);
        const stat = statSync(fullPath);
        return {
          name,
          type: stat.isDirectory() ? "directory" : "file",
          size: stat.isDirectory() ? null : stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      });

      return reply.send({ path: relPath, entries });
    }
  );
}
