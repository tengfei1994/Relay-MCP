import type { FastifyInstance } from "fastify";
import { createHash } from "crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { once } from "events";
import { finished } from "stream/promises";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import {
  authenticateUploadSession,
  completeUploadSession,
  createUploadSession,
  failUploadSession,
  getUploadSession,
  publicUploadSession,
} from "../../shared/upload-store.js";
import { resolveWorkspacePath } from "../../shared/workspace-path.js";

const CreateUploadSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().optional(),
  expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  ttlSeconds: z.number().int().min(60).max(3600).optional(),
});

export async function uploadRoutes(app: FastifyInstance) {
  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
      done(null, payload);
    });
  }

  app.post(
    "/api/projects/:id/uploads",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const projectId = Number((req.params as { id: string }).id);
      const parsed = CreateUploadSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid upload request", details: parsed.error.issues });
      }

      const project = db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, req.user.id)))
        .get();
      if (!project) return reply.status(404).send({ error: "Project not found" });

      resolveWorkspacePath(project.workspacePath, parsed.data.path);
      const { session, token } = createUploadSession({
        userId: req.user.id,
        projectId: project.id,
        project: project.name,
        path: parsed.data.path,
        maxBytes: parsed.data.maxBytes,
        expectedSha256: parsed.data.expectedSha256,
        ttlMs: parsed.data.ttlSeconds ? parsed.data.ttlSeconds * 1000 : undefined,
      });

      return reply.status(201).send({
        upload: publicUploadSession(session),
        token,
        uploadUrl: `/api/uploads/${session.id}`,
      });
    }
  );

  app.get(
    "/api/uploads/:id",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const session = getUploadSession((req.params as { id: string }).id);
      if (!session || session.userId !== req.user.id) {
        return reply.status(404).send({ error: "Upload session not found" });
      }
      return reply.send({ upload: publicUploadSession(session) });
    }
  );

  app.put("/api/uploads/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const tokenHeader = req.headers["x-relay-upload-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    if (!token) return reply.status(401).send({ error: "Missing X-Relay-Upload-Token header" });

    let tempPath: string | undefined;
    try {
      const session = authenticateUploadSession(id, token);
      const project = db.select().from(projects).where(eq(projects.id, session.projectId)).get();
      if (!project || project.userId !== session.userId) {
        throw new Error("Upload project is no longer available");
      }

      const targetPath = resolveWorkspacePath(project.workspacePath, session.path);
      mkdirSync(dirname(targetPath), { recursive: true });
      resolveWorkspacePath(project.workspacePath, session.path);

      tempPath = join(dirname(targetPath), `.relay-upload-${session.id}.tmp`);
      if (existsSync(tempPath)) unlinkSync(tempPath);
      const output = createWriteStream(tempPath, { flags: "wx" });
      const hash = createHash("sha256");
      let bytes = 0;
      const payload = req.body as AsyncIterable<Buffer | string>;
      if (!payload || typeof payload[Symbol.asyncIterator] !== "function") {
        throw new Error("Request body must be application/octet-stream");
      }

      try {
        for await (const chunkValue of payload) {
          const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
          bytes += chunk.length;
          if (bytes > session.maxBytes) {
            throw new Error(`Upload exceeds maximum size of ${session.maxBytes} bytes`);
          }
          hash.update(chunk);
          if (!output.write(chunk)) await once(output, "drain");
        }
        output.end();
        await finished(output);
      } catch (error) {
        output.destroy();
        throw error;
      }

      const sha256 = hash.digest("hex");
      if (session.expectedSha256 && sha256 !== session.expectedSha256) {
        throw new Error(`SHA-256 mismatch: expected ${session.expectedSha256}, received ${sha256}`);
      }

      if (existsSync(targetPath)) unlinkSync(targetPath);
      renameSync(tempPath, targetPath);
      tempPath = undefined;
      const completed = completeUploadSession(session.id, bytes, sha256);
      return reply.send({ upload: publicUploadSession(completed) });
    } catch (error) {
      if (tempPath && existsSync(tempPath)) {
        try { unlinkSync(tempPath); } catch {}
      }
      const message = error instanceof Error ? error.message : String(error);
      failUploadSession(id, message);
      return reply.status(400).send({ error: message });
    }
  });
}
