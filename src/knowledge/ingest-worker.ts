import { scheduleIngestJobs } from "./ingest-dispatch.js";
export { runPendingIngestJobs, runIngestJob, recoverInterruptedIngestJobs } from "./ingest-dispatch.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { KnowledgeStore } from "./store.js";
import { importKnowledgeProducts, type ProductDocumentImportOptions, type ProductDocumentImportReport } from "./knowledge-products.js";
import { ingestArtifactSet, type ArtifactIngestReport } from "./artifact-ingest.js";
import { parsePdfBytes } from "./parsers.js";

export interface IngestJob { id: string; kind: string; status: string; result?: unknown; error?: string; }
function pdfFiles(root: string): string[] { if (!existsSync(root) || statSync(root).isFile()) return extname(root).toLowerCase() === ".pdf" ? [root] : []; return readdirSync(root, { withFileTypes: true }).flatMap((entry) => { const path = join(root, entry.name); return entry.isDirectory() ? pdfFiles(path) : extname(path).toLowerCase() === ".pdf" ? [path] : []; }); }

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
    const options = JSON.parse(String(row.payload_json)) as ProductDocumentImportOptions; const kind = store.db.prepare("SELECT kind FROM knowledge_ingest_jobs WHERE id=?").get(id) as { kind: string };
    if (kind.kind === "product_documents") { const pdfText: Record<string, string> = { ...(options.pdfText ?? {}) }; for (const path of pdfFiles(resolve(options.root))) pdfText[path] = await parsePdfBytes(readFileSync(path)); options.pdfText = pdfText; }
    const result: ProductDocumentImportReport | ArtifactIngestReport = kind.kind === "artifact_set" ? ingestArtifactSet(store, options as never) : importKnowledgeProducts(store, { ...options, onProgress: (progress) => { store.db.prepare("UPDATE knowledge_ingest_jobs SET result_json=?,updated_at=? WHERE id=?").run(JSON.stringify(progress), new Date().toISOString(), id); } });
    const resultStatus = kind.kind === "artifact_set" ? "succeeded" : (result as ProductDocumentImportReport).status;
    // Item detail already lives in the import tables. Do not return tens of
    // thousands of source paths twice on each HTTP status poll.
    const summary = kind.kind === "product_documents" ? { ...result, documents: undefined, items: undefined } : result;
    store.db.prepare("UPDATE knowledge_ingest_jobs SET status=?,finished_at=?,result_json=?,updated_at=? WHERE id=?").run(resultStatus === "succeeded" ? "succeeded" : "failed", new Date().toISOString(), JSON.stringify(summary), new Date().toISOString(), id);
    return { id, kind: kind.kind, status: resultStatus, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); store.db.prepare("UPDATE knowledge_ingest_jobs SET status='failed',finished_at=?,error=?,updated_at=? WHERE id=?").run(new Date().toISOString(), message, new Date().toISOString(), id); return { id, kind: "product_documents", status: "failed", error: message };
  }
}
