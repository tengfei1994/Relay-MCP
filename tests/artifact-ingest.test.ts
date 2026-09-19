import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { ingestArtifactSet } from "../src/knowledge/artifact-ingest.js";
import { enqueueProductImport, runPendingIngestJobs } from "../src/knowledge/ingest-worker.js";

test("artifact ingest records metadata and creates source baseline without execution", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-artifact-")); const input = join(root, "solution"); mkdirSync(join(input, "SQL"), { recursive: true });
  writeFileSync(join(input, "SQL", "sample.sql"), "select 1"); writeFileSync(join(input, "setup.exe"), "MZ fake");
  const store = new KnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  const report = ingestArtifactSet(store, { source: input, name: "Demo", kind: "solution", version: "21.3", solution: "Demo" });
  assert.equal(report.files.length, 2); assert.ok(report.baselineId);
  assert.equal(store.db.prepare("SELECT category FROM knowledge_artifacts WHERE relative_path='setup.exe'").get()?.category, "installer");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_source_files WHERE baseline_id=?").get(report.baselineId)?.n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_source_chunks WHERE baseline_id=?").get(report.baselineId)?.n, 1);
  assert.equal(store.db.prepare("SELECT status FROM knowledge_artifact_sets WHERE id=?").get(report.setId)?.status, "staged");
  store.close(); rmSync(root, { recursive: true, force: true });
});

test("product imports use a durable queued job that can resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-ingest-job-")); const input = join(root, "docs"); mkdirSync(input); writeFileSync(join(input, "guide.md"), "# Guide\n\n## Setup\nUse it.", "utf8");
  const store = new KnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  const job = enqueueProductImport(store, { root: input, sampleManagerVersion: "21.3", product: "SampleManager", idempotencyKey: "job-test" }); await new Promise((resolve) => setTimeout(resolve, 25)); await runPendingIngestJobs(store);
  const row = store.db.prepare("SELECT status FROM knowledge_ingest_jobs WHERE id=?").get(job.id) as { status: string }; assert.equal(row.status, "succeeded"); assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_documents WHERE kind='product_document'").get().n, 1);
  store.close(); rmSync(root, { recursive: true, force: true });
});
