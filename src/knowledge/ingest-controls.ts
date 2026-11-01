import type { KnowledgeStore } from "./store.js";
import { ingestJobSnapshot, scheduleIngestJobs } from "./ingest-dispatch.js";
import type { WikiGenerationJobSummary } from "./ingest-dispatch.js";

export class WikiGenerationControlError extends Error {
  constructor(readonly code: "not_found" | "unsupported_kind" | "terminal" | "conflict", message: string) {
    super(message);
    this.name = "WikiGenerationControlError";
  }
}

function rowSummary(store: KnowledgeStore, id: string): WikiGenerationJobSummary {
  return ingestJobSnapshot(store, id) as WikiGenerationJobSummary;
}

export function controlWikiGenerationJob(store: KnowledgeStore, id: string, action: "pause" | "resume", actorId: number): WikiGenerationJobSummary {
  const now = new Date().toISOString();
  const changed = store.db.transaction(() => {
    const row = store.db.prepare("SELECT * FROM knowledge_ingest_jobs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new WikiGenerationControlError("not_found", "Ingest job not found");
    if (row.kind !== "wiki_generation") throw new WikiGenerationControlError("unsupported_kind", "Only Wiki generation jobs can be controlled");
    const status = String(row.status ?? "");
    const controlState = row.control_state === "pause_requested" || row.control_state === "paused" ? row.control_state : "active";
    if (!["queued", "running"].includes(status)) throw new WikiGenerationControlError("terminal", "Completed or failed jobs cannot be controlled");
    if (action === "pause") {
      if (controlState !== "active") throw new WikiGenerationControlError("conflict", "Wiki generation job is already pausing or paused");
      if (status === "running") {
        return store.db.prepare("UPDATE knowledge_ingest_jobs SET control_state='pause_requested',pause_requested_at=?,paused_by=?,updated_at=? WHERE id=? AND status='running' AND COALESCE(control_state,'active')='active'").run(now, actorId, now, id).changes;
      }
      return store.db.prepare("UPDATE knowledge_ingest_jobs SET control_state='paused',paused_at=?,paused_by=?,updated_at=? WHERE id=? AND status='queued' AND COALESCE(control_state,'active')='active'").run(now, actorId, now, id).changes;
    }
    if (!(["paused", "pause_requested"] as string[]).includes(controlState)) throw new WikiGenerationControlError("conflict", "Wiki generation job is already active");
    return store.db.prepare("UPDATE knowledge_ingest_jobs SET control_state='active',pause_requested_at=NULL,resumed_at=?,available_at=CASE WHEN status='queued' THEN ? ELSE available_at END,updated_at=? WHERE id=? AND status IN ('queued','running') AND control_state IN ('paused','pause_requested')").run(now, now, now, id).changes;
  }).immediate();
  if (!changed) throw new WikiGenerationControlError("conflict", "Wiki generation job changed before the control was applied");
  const result = rowSummary(store, id);
  if (action === "resume" && result.status === "queued") scheduleIngestJobs(store);
  return result;
}
