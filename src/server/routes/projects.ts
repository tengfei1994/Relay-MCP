import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { z } from "zod";
import { mkdirSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "fs";
import { join } from "path";
import "dotenv/config";
import { resolveWorkspacePath } from "../../shared/workspace-path.js";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const MAX_FILE_PREVIEW_BYTES = 1_000_000;

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  description: z.string().max(500).optional(),
});

function projectForUser(id: number, userId: number) {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)))
    .get();
}

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

      const project = projectForUser(Number(id), userId);

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

      const project = projectForUser(Number(id), userId);

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

      const project = projectForUser(Number(id), userId);

      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      let targetDir: string;
      try {
        targetDir = resolveWorkspacePath(project.workspacePath, relPath, { allowRoot: true });
      } catch (error) {
        return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) });
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

  app.get(
    "/api/projects/:id/files/content",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const projectId = Number((req.params as { id: string }).id);
      const query = z.object({ path: z.string().min(1) }).safeParse(req.query);
      if (!query.success) return reply.status(400).send({ error: "A file path is required" });
      const project = projectForUser(projectId, req.user.id);
      if (!project) return reply.status(404).send({ error: "Project not found" });
      let filePath: string;
      try { filePath = resolveWorkspacePath(project.workspacePath, query.data.path, { mustExist: true }); }
      catch (error) { return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) }); }
      const info = statSync(filePath);
      if (info.isDirectory()) return reply.status(400).send({ error: "Directories cannot be previewed" });
      if (info.size > MAX_FILE_PREVIEW_BYTES) return reply.status(413).send({ error: `File preview is limited to ${MAX_FILE_PREVIEW_BYTES} bytes`, size: info.size });
      const bytes = readFileSync(filePath);
      if (bytes.includes(0)) return reply.status(415).send({ error: "Binary files cannot be previewed as text", size: info.size });
      return reply.send({ path: query.data.path, name: query.data.path.split(/[\\/]/).pop(), content: bytes.toString("utf8"), size: info.size, modifiedAt: info.mtime.toISOString(), truncated: false });
    }
  );

  app.patch(
    "/api/projects/:id/files",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const projectId = Number((req.params as { id: string }).id);
      const body = z.object({ path: z.string().min(1), name: z.string().trim().min(1).max(255).regex(/^[^\\/]+$/).refine((value) => value !== "." && value !== "..", "Invalid file name") }).safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: "A valid file name is required", details: body.error.issues });
      const project = projectForUser(projectId, req.user.id);
      if (!project) return reply.status(404).send({ error: "Project not found" });
      let sourcePath: string, destinationPath: string;
      try {
        sourcePath = resolveWorkspacePath(project.workspacePath, body.data.path, { mustExist: true });
        const parentPath = body.data.path.replaceAll("\\", "/").split("/").slice(0, -1).filter(Boolean).join("/");
        destinationPath = resolveWorkspacePath(project.workspacePath, parentPath ? `${parentPath}/${body.data.name}` : body.data.name);
      } catch (error) { return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) }); }
      if (existsSync(destinationPath)) return reply.status(409).send({ error: "A file or directory with that name already exists" });
      renameSync(sourcePath, destinationPath);
      const parentPath = body.data.path.replaceAll("\\", "/").split("/").slice(0, -1).filter(Boolean).join("/");
      const nextPath = parentPath ? `${parentPath}/${body.data.name}` : body.data.name;
      return reply.send({ ok: true, path: nextPath, name: body.data.name });
    }
  );

  app.delete(
    "/api/projects/:id/files",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const projectId = Number((req.params as { id: string }).id);
      const query = z.object({ path: z.string().min(1) }).safeParse(req.query);
      if (!query.success) return reply.status(400).send({ error: "A file path is required" });
      const project = projectForUser(projectId, req.user.id);
      if (!project) return reply.status(404).send({ error: "Project not found" });
      let targetPath: string;
      try { targetPath = resolveWorkspacePath(project.workspacePath, query.data.path, { mustExist: true }); }
      catch (error) { return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) }); }
      rmSync(targetPath, { recursive: true, force: false });
      return reply.send({ ok: true, path: query.data.path });
    }
  );
}
