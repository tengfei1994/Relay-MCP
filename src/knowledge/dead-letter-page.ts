import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Scan JSONL without retaining the entire file; return a stable file/line page. */
export async function readDeadLetterPage(paths: string[], limit: number, offset: number, projectIds?: string[]) {
  const records: Array<Record<string, unknown>> = [];
  let total = 0;
  for (const path of paths) {
    const input = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber++;
        if (!line.trim()) continue;
        let record: Record<string, unknown>;
        try {
          const parsed = JSON.parse(line);
          const event = parsed.event ?? parsed;
          record = {
            sourcePath: path, lineNumber, eventId: event.id ?? parsed.eventId,
            type: event.type ?? parsed.type, projectId: event.projectId ?? parsed.projectId,
            jobId: event.jobId ?? parsed.jobId, deploymentId: event.deploymentId ?? parsed.deploymentId,
            error: String(parsed.error ?? parsed.reason ?? "unknown error").slice(0, 2000),
            attempts: parsed.attempts, sha256: parsed.sha256, length: parsed.length ?? line.length,
          };
        } catch { record = { sourcePath: path, lineNumber, error: "invalid dead-letter record", length: line.length }; }
        if (projectIds && !projectIds.includes(String(record.projectId))) continue;
        if (total >= offset && records.length < limit) records.push(record);
        total++;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally { lines.close(); input.destroy(); }
  }
  return { deadLetters: records, page: { limit, offset, total } };
}
