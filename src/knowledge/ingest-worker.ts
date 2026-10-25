import { scheduleIngestJobs } from "./ingest-dispatch.js";
export { runPendingIngestJobs, runIngestJob, recoverInterruptedIngestJobs } from "./ingest-dispatch.js";
import { createHash, randomUUID } from "node:crypto";
import { MigrationController, type CreateFromLocalInput } from "./migration-control.js";
import type { KnowledgeStore } from "./store.js";
import { importKnowledgeProductsAsync, type ProductDocumentImportOptions, type ProductDocumentImportReport } from "./knowledge-products.js";
import { ingestArtifactSet, type ArtifactIngestReport } from "./artifact-ingest.js";

export interface IngestJob { id: string; kind: string; status: string; result?: unknown; error?: string; }
export class MigrationQueueBusyError extends Error {
  readonly code = "migration_queue_busy";
  readonly statusCode = 503;
  readonly retryAfterSeconds = 1;
  constructor() { super("Migration queue is busy; retry the same operation key"); this.name = "MigrationQueueBusyError"; }
}
export function enqueueProductMigration(store: KnowledgeStore, input: CreateFromLocalInput) {
  const request = { actorId: input.actorId, idempotencyKey: input.idempotencyKey.trim(), parserVersion: input.parserVersion.trim(), kind: input.kind ?? "product_knowledge", productVersion: input.productVersion, solution: input.solution, module: input.module, projectId: input.projectId, environment: input.environment, limit: input.limit ?? 1000 };
  if (!request.idempotencyKey || !request.parserVersion) throw new Error("Migration operation key and parser version are required");
  const serialized = JSON.stringify(request);
  const id = `migration-job-${createHash("sha256").update(request.idempotencyKey).digest("hex")}`;
  try {
  const controller = new MigrationController(store);
  const result = store.db.transaction(() => {
    const now = new Date().toISOString();
    let row = store.db.prepare("SELECT * FROM knowledge_ingest_jobs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (row) {
      const payload = JSON.parse(String(row.payload_json));
      if (payload.request !== serialized) throw new Error("Migration idempotency key belongs to a different request");
      if (row.status === "failed" && input.retry) {
        store.db.prepare("UPDATE knowledge_ingest_jobs SET status='queued',payload_json=?,error=NULL,started_at=NULL,finished_at=NULL,available_at=?,updated_at=? WHERE id=? AND status='failed'").run(JSON.stringify({ ...payload, input: { ...request, retry: true } }), now, now, id);
      }
    } else {
      if (store.db.prepare("SELECT 1 FROM knowledge_migrations WHERE idempotency_key=?").get(request.idempotencyKey)) throw new Error("Migration operation key already belongs to another migration request");
      const migration = controller.create({ ...request, sourceManifest: { source: "relay_local", parserVersion: request.parserVersion, asyncRequest: request } });
      const progress = { migrationId: migration.id, total: 0, mapped: 0, failed: 0, processed: 0 };
      store.db.prepare("INSERT INTO knowledge_ingest_jobs(id,kind,payload_json,status,result_json,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, "product_migration", JSON.stringify({ migrationId: migration.id, request: serialized, input: request }), "queued", JSON.stringify(progress), now, now, now);
    }
    row = store.db.prepare("SELECT * FROM knowledge_ingest_jobs WHERE id=?").get(id) as Record<string, unknown>;
    const payload = JSON.parse(String(row.payload_json));
    return { migrationId: payload.migrationId as string, migration: controller.get(payload.migrationId)!, job: { id, kind: "product_migration", status: String(row.status), result: JSON.parse(String(row.result_json)), ...(row.error ? { error: String(row.error) } : {}) } };
  // Reserve the writer before the idempotency read. In WAL mode a deferred
  // read snapshot cannot upgrade after another process commits, even with a
  // busy timeout. BEGIN IMMEDIATE can wait before taking that snapshot.
  }).immediate();
  if (result.job.status === "queued") scheduleIngestJobs(store);
  return result;
  } catch (error) {
    const code = error && typeof error === "object" ? String((error as { code?: unknown }).code ?? "") : "";
    if (/^SQLITE_(BUSY|LOCKED)(?:_|$)/.test(code)) throw new MigrationQueueBusyError();
    throw error;
  }
}

export function enqueueProductImport(store: KnowledgeStore, options: ProductDocumentImportOptions): IngestJob {
  const id = randomUUID(); const now = new Date().toISOString();
  store.db.prepare("INSERT INTO knowledge_ingest_jobs(id,kind,payload_json,status,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, "product_documents", JSON.stringify(options), "queued", now, now, now);
  // The durable row is written before dispatch. A process restart can claim it
  // again through runPendingIngestJobs; no upload bytes are held in memory here.
  scheduleIngestJobs(store);
  return { id, kind: "product_documents", status: "queued" };
}
export function enqueueArtifactImport(store: KnowledgeStore, options: { source: string; kind?: string; name: string; version?: string; solution?: string; storageUri?: string }): IngestJob {
  const id = randomUUID(); const now = new Date().toISOString(); store.db.prepare("INSERT INTO knowledge_ingest_jobs(id,kind,payload_json,status,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, "artifact_set", JSON.stringify(options), "queued", now, now, now); scheduleIngestJobs(store); return { id, kind: "artifact_set", status: "queued" };
}

export async function executeIngestJob(store: KnowledgeStore, id: string): Promise<IngestJob> {
  const row = store.db.prepare("SELECT * FROM knowledge_ingest_jobs WHERE id=?").get(id) as { kind?: string; payload_json?: string; status?: string; attempts?: number } | undefined;
  if (!row) throw new Error("Ingest job not found"); if (["succeeded", "failed", "running"].includes(String(row.status))) return { id, kind: String(row.kind ?? "product_documents"), status: String(row.status) };
  const now = new Date().toISOString(); const claim = store.db.prepare("UPDATE knowledge_ingest_jobs SET status='running',attempts=attempts+1,started_at=?,updated_at=? WHERE id=? AND status='queued'").run(now, now, id);
  if (!claim.changes) return { id, kind: String(row.kind), status: "running" };
  try {
    if (row.kind === "product_migration") {
      const payload = JSON.parse(String(row.payload_json)) as { migrationId: string; input: CreateFromLocalInput };
      const progress = (value: Record<string, unknown>) => {
        const summary = { migrationId: payload.migrationId, total: value.total ?? 0, mapped: value.mapped ?? 0, failed: value.failed ?? 0, withdrawn: value.withdrawn ?? 0, processed: Number(value.mapped ?? 0) + Number(value.failed ?? 0) + Number(value.withdrawn ?? 0) };
        store.db.prepare("UPDATE knowledge_ingest_jobs SET result_json=?,updated_at=? WHERE id=?").run(JSON.stringify(summary), new Date().toISOString(), id);
        return summary;
      };
      const { managedControlPlane } = await import("./engine-service.js");
      const migration = await new MigrationController(store).createFromLocal(payload.input, managedControlPlane(store).ingestor, progress);
      const result = progress(migration.report);
      const status = result.failed || result.withdrawn ? "failed" : "succeeded";
      const error = result.withdrawn ? "Migration has withdrawn documents; stage replacement sources in a new migration" : status === "failed" ? "Migration has failed documents; retry explicitly" : null;
      store.db.prepare("UPDATE knowledge_ingest_jobs SET status=?,error=?,finished_at=?,updated_at=? WHERE id=?").run(status, error, new Date().toISOString(), new Date().toISOString(), id);
      return { id, kind: "product_migration", status, result, ...(error ? { error } : {}) };
    }
    const options = JSON.parse(String(row.payload_json)) as ProductDocumentImportOptions; const kind = store.db.prepare("SELECT kind FROM knowledge_ingest_jobs WHERE id=?").get(id) as { kind: string };
    const result: ProductDocumentImportReport | ArtifactIngestReport = kind.kind === "artifact_set" ? ingestArtifactSet(store, options as never) : await importKnowledgeProductsAsync(store, { ...options, onProgress: (progress) => { store.db.prepare("UPDATE knowledge_ingest_jobs SET result_json=?,updated_at=? WHERE id=?").run(JSON.stringify(progress), new Date().toISOString(), id); } });
    const resultStatus = kind.kind === "artifact_set" ? "succeeded" : (result as ProductDocumentImportReport).status;
    // Item detail already lives in the import tables. Do not return tens of
    // thousands of source paths twice on each HTTP status poll.
    const summary = kind.kind === "product_documents" ? { ...result, documents: undefined, items: undefined } : result;
    store.db.prepare("UPDATE knowledge_ingest_jobs SET status=?,finished_at=?,result_json=?,updated_at=? WHERE id=?").run(resultStatus === "succeeded" ? "succeeded" : "failed", new Date().toISOString(), JSON.stringify(summary), new Date().toISOString(), id);
    return { id, kind: kind.kind, status: resultStatus, result };
  } catch (error) {
    const message = row.kind === "product_migration" ? "Migration execution failed; inspect migration progress and retry explicitly" : error instanceof Error ? error.message : String(error); store.db.prepare("UPDATE knowledge_ingest_jobs SET status='failed',finished_at=?,error=?,updated_at=? WHERE id=?").run(new Date().toISOString(), message, new Date().toISOString(), id); return { id, kind: String(row.kind), status: "failed", error: message };
  }
}
