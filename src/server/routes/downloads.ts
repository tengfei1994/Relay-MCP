import type { FastifyInstance } from "fastify";
import { createReadStream, statSync } from "fs";
import { basename } from "path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { authenticateDownloadSession } from "../../shared/download-store.js";
import { resolveWorkspacePath } from "../../shared/workspace-path.js";

export async function downloadRoutes(app: FastifyInstance) {
  app.get("/api/downloads/:id", async (req, reply) => {
    const tokenHeader = req.headers["x-relay-download-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    if (!token) return reply.status(401).send({ error: "Missing X-Relay-Download-Token header" });

    try {
      const session = authenticateDownloadSession((req.params as { id: string }).id, token);
      const project = db.select().from(projects).where(eq(projects.id, session.projectId)).get();
      if (!project || project.userId !== session.userId) {
        throw new Error("Download project is no longer available");
      }
      const filePath = resolveWorkspacePath(project.workspacePath, session.path, { mustExist: true });
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error("Download path is not a file");

      reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", String(stat.size))
        .header("Content-Disposition", `attachment; filename="${basename(filePath).replace(/[\r\n"]/g, "")}"`)
        .send(createReadStream(filePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: message });
    }
  });
}
