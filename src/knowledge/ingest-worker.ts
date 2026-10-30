import { claimIngestJob, ingestJobSnapshot, scheduleIngestJobs } from "./ingest-dispatch.js";
export { runPendingIngestJobs, runIngestJob, recoverInterruptedIngestJobs } from "./ingest-dispatch.js";
import { createHash, randomUUID } from "node:crypto";
import { MigrationController, type CreateFromLocalInput } from "./migration-control.js";
import type { KnowledgeStore } from "./store.js";
import { readEngineControl, readEngineRuntime } from "./engine-config.js";
import type { EngineModelBinding } from "./engine-model-gateway.js";
import { importKnowledgeProductsAsync, type ProductDocumentImportOptions, type ProductDocumentImportReport } from "./knowledge-products.js";
import { listWikiTopicGroups, WikiGenerationService } from "./wiki-generation.js";
import { ingestArtifactSet, type ArtifactIngestReport } from "./artifact-ingest.js";

interface MigrationRuntimeBinding {
  knowledgeBaseId: string;
  embeddingBinding: EngineModelBinding;
  ingestionProfile: "standard" | "bulk";
}
class MigrationRuntimeBindingChangedError extends Error {
  constructor() { super("Migration runtime binding changed; start a new operation"); }
}
function migrationRuntimeBinding(): MigrationRuntimeBinding | undefined {
  if (!readEngineRuntime()) return undefined;
  const control = readEngineControl(), binding = control.bindings.find(value => value.kind === "embedding");
  if (!control.knowledgeBaseId || !binding) throw new Error("Migration runtime binding is unavailable");
  // Project known metadata fields explicitly: never serialize control.json or
  // arbitrary provider fields, which can carry credentials in future versions.
  const { providerId, kind, modelId, dimensions, indexVersion, alias, engineModelId } = binding;
  return { knowledgeBaseId: control.knowledgeBaseId, embeddingBinding: { providerId, kind, modelId, dimensions, indexVersion, alias, engineModelId }, ingestionProfile: control.ingestionProfile ?? "standard" };
}
function assertMigrationBinding(expected: MigrationRuntimeBinding | undefined): void {
  if (expected && JSON.stringify(expected) !== JSON.stringify(migrationRuntimeBinding())) throw new MigrationRuntimeBindingChangedError();
}

export interface IngestJob { id: string; kind: string; status: string; result?: unknown; error?: string; }
export class MigrationQueueBusyError extends Error {
  readonly code = "migration_queue_busy";
  readonly statusCode = 503;
  readonly retryAfterSeconds = 1;
  constructor() { super("Migration queue is busy; retry the same operation key"); this.name = "MigrationQueueBusyError"; }
}
export function enqueueProductMigration(store: KnowledgeStore, input: CreateFromLocalInput) {
  const request = { actorId: input.actorId, idempotencyKey: input.idempotencyKey.trim(), parserVersion: input.parserVersion.trim(), kind: input.kind ?? "product_knowledge", productVersion: input.productVersion, solution: input.solution, module: input.module, projectId: input.projectId, environment: input.environment, limit: input.limit ?? 1000, localDocumentIds: input.localDocumentIds };
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
      const runtimeBinding = migrationRuntimeBinding();
      const migration = controller.create({ ...request, sourceManifest: { source: "relay_local", parserVersion: request.parserVersion, asyncRequest: request } });
      const progress = { migrationId: migration.id, total: 0, mapped: 0, failed: 0, processed: 0 };
      store.db.prepare("INSERT INTO knowledge_ingest_jobs(id,kind,payload_json,status,result_json,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, "product_migration", JSON.stringify({ migrationId: migration.id, request: serialized, input: request, ...(runtimeBinding ? { runtimeBinding } : {}) }), "queued", JSON.stringify(progress), now, now, now);
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

export function enqueueWikiGeneration(store: KnowledgeStore, input: { topicGroupIds?: string[]; projectId?: string; environment?: string; triggerId?: string }): IngestJob | undefined {
  const topicGroupIds = [...new Set(input.topicGroupIds ?? listWikiTopicGroups(store, input).map(group => group.topicGroupId).filter(Boolean))].sort();
  if (!topicGroupIds.length) return undefined;
  const triggerId = input.triggerId ?? randomUUID();
  const id = `wiki-generation-${createHash("sha256").update(JSON.stringify({ topicGroupIds, projectId: input.projectId ?? "", environment: input.environment ?? "", triggerId })).digest("hex")}`;
  const now = new Date().toISOString();
  const existing = store.db.prepare("SELECT * FROM knowledge_ingest_jobs WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (existing) return { id, kind: "wiki_generation", status: String(existing.status), ...(existing.result_json ? { result: JSON.parse(String(existing.result_json)) } : {}), ...(existing.error ? { error: String(existing.error) } : {}) };
  const payload = { topicGroupIds, projectId: input.projectId, environment: input.environment, triggerId, cursor: 0 };
  store.db.prepare("INSERT INTO knowledge_ingest_jobs(id,kind,payload_json,status,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, "wiki_generation", JSON.stringify(payload), "queued", now, now, now);
  scheduleIngestJobs(store);
  return { id, kind: "wiki_generation", status: "queued" };
}

export function ensureWikiGeneration(store: KnowledgeStore, input: { projectId?: string; environment?: string } = {}): IngestJob | undefined {
  const groups = listWikiTopicGroups(store, input).map(group => group.topicGroupId);
  const pending = groups.filter(topicGroupId => {
    const row = store.db.prepare("SELECT status FROM knowledge_wiki_generation_state WHERE project_id=? AND environment=? AND topic_group_id=?").get(input.projectId ?? "", input.environment ?? "", topicGroupId) as { status?: string } | undefined;
    return !row;
  });
  return enqueueWikiGeneration(store, { ...input, topicGroupIds: pending, triggerId: "bootstrap" });
}
export function enqueueArtifactImport(store: KnowledgeStore, options: { source: string; kind?: string; name: string; version?: string; solution?: string; storageUri?: string }): IngestJob {
  const id = randomUUID(); const now = new Date().toISOString(); store.db.prepare("INSERT INTO knowledge_ingest_jobs(id,kind,payload_json,status,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, "artifact_set", JSON.stringify(options), "queued", now, now, now); scheduleIngestJobs(store); return { id, kind: "artifact_set", status: "queued" };
}

export async function executeIngestJob(store: KnowledgeStore, id: string, execution: { ownerToken?: string } = {}): Promise<IngestJob> {
  const row = store.db.prepare("SELECT * FROM knowledge_ingest_jobs WHERE id=?").get(id) as { kind?: string; payload_json?: string; status?: string; owner_token?: string; owner_pid?: number } | undefined;
  if (!row) throw new Error("Ingest job not found");
  const ownerToken = execution.ownerToken ?? randomUUID();
  if (execution.ownerToken) {
    if (row.status !== "running" || row.owner_token !== ownerToken || row.owner_pid !== process.ppid) return ingestJobSnapshot(store, id);
  } else if (!claimIngestJob(store, id, ownerToken)) return ingestJobSnapshot(store, id);
  const isOwner = () => store.db.open && Boolean(store.db.prepare("SELECT 1 FROM knowledge_ingest_jobs WHERE id=? AND status='running' AND owner_token=?").get(id, ownerToken));
  const assertOwner = () => { if (!isOwner()) throw new Error("Ingest execution owner changed"); };
  try {
    if (row.kind === "product_migration") {
      const payload = JSON.parse(String(row.payload_json)) as { migrationId: string; input: CreateFromLocalInput; runtimeBinding?: MigrationRuntimeBinding };
      const summarize = (value: Record<string, unknown>) => ({ migrationId: payload.migrationId, total: value.total ?? 0, mapped: value.mapped ?? 0, failed: value.failed ?? 0, withdrawn: value.withdrawn ?? 0, processed: Number(value.mapped ?? 0) + Number(value.failed ?? 0) + Number(value.withdrawn ?? 0), pending: value.pending ?? 0, yielded: value.yielded === true, ...(value.deferredUntil ? { deferredUntil: value.deferredUntil } : {}), ...(value.reason ? { reason: value.reason } : {}) });
      const progress = (value: Record<string, unknown>) => {
        assertOwner();
        const summary = summarize(value);
        store.db.prepare("UPDATE knowledge_ingest_jobs SET result_json=?,updated_at=? WHERE id=? AND status='running' AND owner_token=?").run(JSON.stringify(summary), new Date().toISOString(), id, ownerToken);
        return summary;
      };
      assertMigrationBinding(payload.runtimeBinding);
      const { managedControlPlane } = await import("./engine-service.js");
      const ingestor = managedControlPlane(store).ingestor, stageBatch = ingestor.stageBatch.bind(ingestor);
      ingestor.stageBatch = async (...args) => {
        assertOwner();
        const result = await stageBatch(...args);
        // Accepted external IDs remain recoverable in the ingestor, but a stale
        // attempt cannot write migration mappings after another owner takes over.
        assertOwner();
        return result;
      };
      let providerAuditWatermark=0;
      const migration = await new MigrationController(store).createFromLocal(payload.input, ingestor, progress, {
        maxDocumentsPerPass: 25,
        maxDurationMs: 300_000,
        beforeDocument: async document => {
          assertOwner();
          assertMigrationBinding(payload.runtimeBinding);
          providerAuditWatermark=(store.db.prepare("SELECT COALESCE(MAX(rowid),0) n FROM knowledge_audit").get() as {n:number}).n;
          if (!readEngineRuntime()) return undefined;
          const { assessMigrationDocumentCapacity } = await import("./migration-capacity.js");
          return assessMigrationDocumentCapacity(store, document);
        },
        afterDocumentFailure:async()=>{
          const providerId=payload.runtimeBinding?.embeddingBinding.providerId;
          if(!providerId)return;
          const {assertMigrationProviderHealthySince}=await import("./migration-capacity.js");
          assertMigrationProviderHealthySince(store,providerId,providerAuditWatermark);
        },
      });
      const result = summarize(migration.report), finished = new Date().toISOString();
      if (result.yielded) {
        const availableAt = String(result.deferredUntil);
        if (!Number.isFinite(Date.parse(availableAt))) throw new Error("Migration yield is missing a valid wake time");
        store.db.transaction(() => {
          store.db.prepare("UPDATE knowledge_ingest_jobs SET status='queued',available_at=?,result_json=?,error=NULL,finished_at=NULL,updated_at=? WHERE id=? AND status='running' AND owner_token=?").run(availableAt, JSON.stringify(result), finished, id, ownerToken);
        }).immediate();
        return ingestJobSnapshot(store, id);
      }
      const status = result.failed || result.withdrawn ? "failed" : "succeeded";
      const error = result.withdrawn ? "Migration has withdrawn documents; stage replacement sources in a new migration" : status === "failed" ? "Migration has failed documents; retry explicitly" : null;
      store.db.prepare("UPDATE knowledge_ingest_jobs SET status=?,error=?,result_json=?,finished_at=?,updated_at=? WHERE id=? AND status='running' AND owner_token=?").run(status, error, JSON.stringify(result), finished, finished, id, ownerToken);
      return ingestJobSnapshot(store, id);
    }
    if (row.kind === "wiki_generation") {
      const payload = JSON.parse(String(row.payload_json)) as { topicGroupIds: string[]; projectId?: string; environment?: string; cursor?: number };
      const cursor = Math.max(0, Number(payload.cursor ?? 0)), batch = payload.topicGroupIds.slice(cursor, cursor + 5);
      const generated: unknown[] = [], failures: Array<{ topicGroupId: string; error: string }> = [];
      for (const topicGroupId of batch) {
        assertOwner();
        try {
          generated.push(await new WikiGenerationService(store).generate({ topicGroupId, projectId: payload.projectId, environment: payload.environment }));
        } catch (error) {
          failures.push({ topicGroupId, error: error instanceof Error ? error.message : String(error) });
        }
      }
      assertOwner();
      const nextCursor = cursor + batch.length, summary = { processed: nextCursor, total: payload.topicGroupIds.length, generated, failures };
      if (nextCursor < payload.topicGroupIds.length) {
        const nextPayload = { ...payload, cursor: nextCursor };
        store.db.prepare("UPDATE knowledge_ingest_jobs SET status='queued',payload_json=?,result_json=?,error=NULL,finished_at=NULL,available_at=?,updated_at=? WHERE id=? AND status='running' AND owner_token=?").run(JSON.stringify(nextPayload), JSON.stringify(summary), new Date().toISOString(), new Date().toISOString(), id, ownerToken);
        return ingestJobSnapshot(store, id);
      }
      const status = failures.length ? "failed" : "succeeded", error = failures.length ? `${failures.length} Wiki topic generation(s) failed` : null, finished = new Date().toISOString();
      store.db.prepare("UPDATE knowledge_ingest_jobs SET status=?,error=?,result_json=?,finished_at=?,updated_at=? WHERE id=? AND status='running' AND owner_token=?").run(status, error, JSON.stringify(summary), finished, finished, id, ownerToken);
      return ingestJobSnapshot(store, id);
    }
    const options = JSON.parse(String(row.payload_json)) as ProductDocumentImportOptions; const kind = store.db.prepare("SELECT kind FROM knowledge_ingest_jobs WHERE id=?").get(id) as { kind: string };
    const result: ProductDocumentImportReport | ArtifactIngestReport = kind.kind === "artifact_set" ? ingestArtifactSet(store, options as never) : await importKnowledgeProductsAsync(store, { ...options, onProgress: (progress) => { assertOwner(); store.db.prepare("UPDATE knowledge_ingest_jobs SET result_json=?,updated_at=? WHERE id=? AND status='running' AND owner_token=?").run(JSON.stringify(progress), new Date().toISOString(), id, ownerToken); } });
    if (kind.kind === "product_documents") {
      const documentIds = (result as ProductDocumentImportReport).documents;
      const groups = documentIds.length
        ? (store.db.prepare(`SELECT DISTINCT COALESCE(NULLIF(p.topic_group_id,''),b.topic_id,'family:' || p.document_family_id) AS topic_group_id
          FROM knowledge_product_documents p LEFT JOIN knowledge_product_document_bindings b ON b.document_id=p.id
          WHERE p.id IN (${documentIds.map(() => "?").join(",")})`).all(...documentIds) as Array<{ topic_group_id?: string }>).map(row => row.topic_group_id).filter((value): value is string => Boolean(value))
        : [];
      enqueueWikiGeneration(store, { topicGroupIds: groups, triggerId: (result as ProductDocumentImportReport).runId });
    }
    const resultStatus = kind.kind === "artifact_set" ? "succeeded" : (result as ProductDocumentImportReport).status;
    // Item detail already lives in the import tables. Do not return tens of
    // thousands of source paths twice on each HTTP status poll.
    const summary = kind.kind === "product_documents" ? { ...result, documents: undefined, items: undefined } : result;
    store.db.prepare("UPDATE knowledge_ingest_jobs SET status=?,finished_at=?,result_json=?,updated_at=? WHERE id=? AND status='running' AND owner_token=?").run(resultStatus === "succeeded" ? "succeeded" : "failed", new Date().toISOString(), JSON.stringify(summary), new Date().toISOString(), id, ownerToken);
    return { id, kind: kind.kind, status: resultStatus, result };
  } catch (error) {
    if (!isOwner()) return ingestJobSnapshot(store, id);
    const providerFault=(error as {code?:string})?.code==="migration_provider_failure";
    const message = providerFault ? "Embedding provider failed; migration progress is preserved. Verify the provider before retrying." : error instanceof MigrationRuntimeBindingChangedError ? error.message : row.kind === "product_migration" ? "Migration execution failed; inspect migration progress and retry explicitly" : error instanceof Error ? error.message : String(error); store.db.prepare("UPDATE knowledge_ingest_jobs SET status='failed',finished_at=?,error=?,updated_at=? WHERE id=? AND status='running' AND owner_token=?").run(new Date().toISOString(), message, new Date().toISOString(), id, ownerToken); return ingestJobSnapshot(store, id);
  }
}
