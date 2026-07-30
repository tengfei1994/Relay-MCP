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
      if (stat.size !== session.bytes) {
        return reply.status(409).send({
          ok: false,
          errorCode: "ARTIFACT_SIZE_CHANGED",
          sessionId: session.id,
          expectedBytes: session.bytes,
          actualBytes: stat.size,
          expectedSha256: session.sha256,
        });
      }
      if (Math.abs(stat.mtimeMs - session.mtimeMs) > 1) {
        return reply.status(409).send({
          ok: false,
          errorCode: "ARTIFACT_CHANGED",
          sessionId: session.id,
          expectedBytes: session.bytes,
          actualBytes: stat.size,
          expectedSha256: session.sha256,
        });
      }

      const rangeHeader = req.headers.range;
      const range = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader;
      let start = 0;
      let end = stat.size > 0 ? stat.size - 1 : 0;
      let statusCode = 200;
      if (range && stat.size > 0) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!match) {
          return reply.status(416).header("Content-Range", `bytes */${stat.size}`).send({
            ok: false,
            errorCode: "INVALID_RANGE",
            totalBytes: stat.size,
          });
        }
        if (!match[1] && match[2]) {
          const suffixLength = Number(match[2]);
          if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
            return reply.status(416).header("Content-Range", `bytes */${stat.size}`).send({
              ok: false,
              errorCode: "RANGE_NOT_SATISFIABLE",
              totalBytes: stat.size,
            });
          }
          start = Math.max(0, stat.size - suffixLength);
          end = stat.size - 1;
        } else {
          start = match[1] ? Number(match[1]) : 0;
          end = match[2] ? Number(match[2]) : stat.size - 1;
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
          return reply.status(416).header("Content-Range", `bytes */${stat.size}`).send({
            ok: false,
            errorCode: "RANGE_NOT_SATISFIABLE",
            totalBytes: stat.size,
          });
        }
        end = Math.min(end, stat.size - 1);
        statusCode = 206;
      }

      const contentLength = stat.size === 0 ? 0 : end - start + 1;
      reply
        .code(statusCode)
        .header("Content-Type", session.contentType)
        .header("Content-Length", String(contentLength))
        .header("Accept-Ranges", "bytes")
        .header("ETag", `"sha256-${session.sha256}"`)
        .header("X-Relay-SHA256", session.sha256)
        .header("X-Relay-Artifact-Bytes", String(session.bytes))
        .header("X-Relay-Session-Id", session.id)
        .header("Content-Disposition", `attachment; filename="${(session.fileName || basename(filePath)).replace(/[\r\n"]/g, "")}"`);
      if (statusCode === 206) {
        reply.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      }
      return reply.send(stat.size === 0 ? Buffer.alloc(0) : createReadStream(filePath, { start, end }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ ok: false, errorCode: "DOWNLOAD_FAILED", error: message });
    }
  });
}
