import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore, type KnowledgeStore } from "../src/knowledge/store.ts";
import { runReleaseGates } from "../src/knowledge/release-gates.ts";
import { WorkSessionService, type IntentEnvelope } from "../src/knowledge/work-session.ts";

const NOW = "2026-10-23T00:00:00.000Z";
const GATE_NOW = new Date("2026-10-23T12:00:00.000Z");

function withStore(fn: (store: KnowledgeStore) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "relay-gates-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  return Promise.resolve(fn(store)).finally(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
}

function insertProvider(store: KnowledgeStore, overrides: { id?: string; kind?: string; status?: string; secretRef?: string; reindexRequired?: number } = {}): string {
  const id = overrides.id ?? "prov-1";
  store.db.prepare(`INSERT INTO knowledge_provider_configs(id,kind,provider,model_id,status,secret_ref,token_configured,reindex_required,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, overrides.kind ?? "embedding", "test-provider", "model-1", overrides.status ?? "ready", overrides.secretRef ?? null, overrides.secretRef ? 1 : 0, overrides.reindexRequired ?? 0, NOW, NOW);
  return id;
}

function insertSession(store: KnowledgeStore, id: string, intentJson: string): void {
  store.db.prepare("INSERT INTO knowledge_work_sessions(id,actor_id,project_id,status,intent_json,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, 7, "p1", "open", intentJson, `key-${id}`, NOW, NOW);
}

function insertCandidate(store: KnowledgeStore, id: string, sessionId: string, evidenceRefs: string[]): void {
  store.db.prepare(`INSERT INTO knowledge_candidate_insights(id,work_session_id,project_id,kind,statement,why_proposed,evidence_refs_json,generated_by,input_hash,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, sessionId, "p1", "fact", "Statement", "Why", JSON.stringify(evidenceRefs), "deterministic-fallback-v1", `hash-${id}`, NOW, NOW);
}

function insertWeknoraDocument(store: KnowledgeStore, id: string, status: string, externalId: string): void {
  store.db.prepare(`INSERT INTO knowledge_weknora_documents(id,external_document_id,title,normalized_content_sha256,parser_version,status,idempotency_key,created_at,updated_at,published_at,deprecated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, externalId, `Doc ${id}`, `sha-${id}`, "parser-1", status, `wk-${id}`, NOW, NOW,
      status === "published" ? NOW : null, status === "deprecated" ? NOW : null);
}

function insertMigration(store: KnowledgeStore, id: string, status: string, rollbackManifest = "{}"): void {
  store.db.prepare(`INSERT INTO knowledge_migrations(id,kind,status,idempotency_key,source_manifest_json,rollback_manifest_json,created_at,updated_at,published_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, "product_knowledge", status, `mig-${id}`, '{"documents":[1]}', rollbackManifest, NOW, NOW, status === "published" ? NOW : null);
}

function linkMigrationDocument(store: KnowledgeStore, migrationId: string, documentId: string, status: string): void {
  store.db.prepare(`INSERT INTO knowledge_migration_documents(migration_id,local_document_id,document_id,idempotency_key,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(migrationId, `local-${documentId}`, documentId, `key-${migrationId}-${documentId}`, status, NOW, NOW);
}

function insertWikiPage(store: KnowledgeStore, id: string, status: string, sourceRefs: string[]): void {
  store.db.prepare(`INSERT INTO knowledge_wiki_pages(id,page_key,title,body,status,source_refs_json,current_revision,created_by,created_at,updated_at,published_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, `page-${id}`, `Page ${id}`, "Body", status, JSON.stringify(sourceRefs), 1, 7, NOW, NOW, status === "published" ? NOW : null);
}

test("clean minimal state is release ready with stable report shape", () => withStore((store) => {
  const report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.ready, true);
  assert.deepEqual(report.failures, []);
  assert.equal(report.checkedAt, GATE_NOW.toISOString());
  for (const [name, check] of Object.entries(report.checks)) {
    assert.equal(check.ok, true, `check ${name} must pass on a clean store`);
  }
  assert.equal(report.checks.database.status, "available");
  assert.deepEqual(report.metrics.sessions, { total: 0, open: 0, active: 0, awaitingReview: 0, needsClarification: 0, completed: 0, abandoned: 0 });
  assert.deepEqual(report.metrics.events, { total: 0, correlated: 0, uncorrelated: 0 });
  assert.equal(report.metrics.imports.ingest.avgDurationMs, null);
  assert.deepEqual(report.metrics.outbox, { backlog: 0, pendingClaims: 0, deadLetter: 0 });
  // Deterministic: two runs over the same state are identical.
  assert.deepEqual(runReleaseGates(store, GATE_NOW), report);
}));

test("raw provider secret persisted in secret_ref fails the security scan without leaking the value", () => withStore((store) => {
  insertProvider(store, { secretRef: "sk-live-secret-1234567890" });
  const report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.ready, false);
  assert.equal(report.checks.securityScan.ok, false);
  assert.ok(report.failures.includes("raw secret-like values persisted in knowledge tables"));
  assert.deepEqual(report.checks.securityScan.findings, ["knowledge_provider_configs:provider-config:secret-like value"]);
  // Findings name the table and record category only, never the content.
  assert.ok(!JSON.stringify(report).includes("sk-live-secret-1234567890"));
}));

test("bearer token and hidden reasoning in session intent fail the security scan", () => withStore((store) => {
  insertSession(store, "s-secret", JSON.stringify({ objective: "use Bearer abcdef123456 to call the API" }));
  insertSession(store, "s-reasoning", JSON.stringify({ objective: "ok", reasoning: "private chain of thought" }));
  const report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.ready, false);
  assert.ok(report.checks.securityScan.findings.includes("knowledge_work_sessions:work-session:secret-like value"));
  assert.ok(report.checks.securityScan.findings.includes("knowledge_work_sessions:work-session:hidden reasoning field"));
  assert.ok(!JSON.stringify(report).includes("abcdef123456"));
}));

test("secret-like values in evidence metadata, candidates, wiki and audit details are all detected", () => withStore((store) => {
  insertSession(store, "s-1", JSON.stringify({ objective: "clean" }));
  store.db.prepare("INSERT INTO knowledge_evidence(id,sha256,storage_path,mime_type,size_bytes,source_kind,source_locator,retention,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("ev-1", "sha-ev-1", "/tmp/ev-1", "text/plain", 10, "log", "postgres://user:hunter2@db.internal/knowledge", "standard", NOW);
  insertCandidate(store, "c-1", "s-1", []);
  store.db.prepare("UPDATE knowledge_candidate_insights SET statement=? WHERE id=?").run("set password=hunter2 in the config", "c-1");
  insertWikiPage(store, "w-1", "draft", []);
  store.db.prepare("UPDATE knowledge_wiki_pages SET body=? WHERE id=?").run("apiKey: sk-wiki-secret-value", "w-1");
  store.db.prepare("INSERT INTO knowledge_audit(id,actor_id,action,entity_type,entity_id,details_json,occurred_at) VALUES (?,?,?,?,?,?,?)")
    .run("audit-1", 7, "test.action", "test", "e-1", JSON.stringify({ connection_string: "Server=db;Password=x" }), NOW);
  const report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.checks.securityScan.ok, false);
  for (const expected of [
    "knowledge_evidence:evidence-metadata:secret-like value",
    "knowledge_candidate_insights:candidate:secret-like value",
    "knowledge_wiki_pages:wiki:secret-like value",
    "knowledge_audit:audit:secret-like field",
  ]) assert.ok(report.checks.securityScan.findings.includes(expected), `missing finding ${expected}`);
  const serialized = JSON.stringify(report);
  for (const leaked of ["hunter2", "sk-wiki-secret-value", "Server=db"]) assert.ok(!serialized.includes(leaked), `report leaks ${leaked}`);
}));

test("degraded or disabled active providers block the release", () => withStore((store) => {
  insertProvider(store, { id: "prov-degraded", status: "degraded" });
  let report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.ready, false);
  assert.equal(report.checks.providers.ok, false);
  assert.ok(report.failures.includes("active provider is degraded or disabled"));

  store.db.prepare("UPDATE knowledge_provider_configs SET status='disabled' WHERE id=?").run("prov-degraded");
  report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.checks.providers.ok, false);
  assert.equal(report.checks.providers.disabled, 1);

  store.db.prepare("UPDATE knowledge_provider_configs SET status='ready' WHERE id=?").run("prov-degraded");
  report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.checks.providers.ok, true);
  assert.equal(report.checks.providers.ready, 1);
}));

test("pending reindex blocks the release", () => withStore((store) => {
  const providerId = insertProvider(store, { reindexRequired: 1 });
  let report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.ready, false);
  assert.equal(report.checks.reindex.ok, false);
  assert.ok(report.failures.includes("provider reindex is pending"));

  store.db.prepare("UPDATE knowledge_provider_configs SET reindex_required=0 WHERE id=?").run(providerId);
  store.db.prepare("INSERT INTO knowledge_provider_reindex_jobs(id,provider_id,index_version,to_model_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("reindex-1", providerId, 2, "model-2", "pending", NOW, NOW);
  report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.checks.reindex.ok, false);
  assert.equal(report.checks.reindex.pendingJobs, 1);

  store.db.prepare("UPDATE knowledge_provider_reindex_jobs SET status='completed', completed_at=? WHERE id=?").run(NOW, "reindex-1");
  report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.checks.reindex.ok, true);
  assert.equal(report.checks.reindex.completedJobs, 1);
}));

test("staged and failed migrations block the release", () => withStore((store) => {
  insertMigration(store, "m-staged", "staged");
  let report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.ready, false);
  assert.equal(report.checks.migrations.ok, false);
  assert.equal(report.checks.migrations.staged, 1);
  assert.ok(report.failures.includes("staged knowledge migrations are not published"));

  store.db.prepare("UPDATE knowledge_migrations SET status='failed' WHERE id=?").run("m-staged");
  report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.checks.migrations.failed, 1);
  assert.ok(report.failures.includes("failed knowledge migrations exist"));
}));

test("published migration without a rollback manifest blocks the release", () => withStore((store) => {
  insertMigration(store, "m-pub", "published");
  let report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.ready, false);
  assert.equal(report.checks.rollback.ok, false);
  assert.equal(report.checks.rollback.publishedWithoutManifest, 1);
  assert.ok(report.failures.includes("published migration lacks a rollback manifest"));

  store.db.prepare("UPDATE knowledge_migrations SET rollback_manifest_json=? WHERE id=?")
    .run(JSON.stringify({ restoreProvider: "relay_local", documentIds: ["doc-1"] }), "m-pub");
  report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.checks.rollback.ok, true);
  assert.equal(report.checks.migrations.published, 1);
}));

test("published documents with missing or pending external ids block the release", () => withStore((store) => {
  insertWeknoraDocument(store, "w-pending", "published", "pending:abc");
  insertWeknoraDocument(store, "w-ok", "published", "ext-1");
  const report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.ready, false);
  assert.equal(report.checks.publishedVisibility.ok, false);
  assert.equal(report.checks.publishedVisibility.publishedMissingExternalId, 1);
  assert.equal(report.checks.publishedVisibility.publishedDocuments, 2);
  assert.ok(report.failures.includes("published WeKnora documents lack external ids"));
}));

test("staged or deprecated documents visible through published routing block the release", () => withStore((store) => {
  // Deliberately simulate corrupted legacy data. Normal writes are now
  // withdrawn by 043; the release gate must still catch this broken invariant.
  store.db.exec("DROP TRIGGER knowledge_migration_insert_withdrawal");
  insertMigration(store, "m-1", "published", JSON.stringify({ restoreProvider: "relay_local", documentIds: ["w-staged", "w-dep"] }));
  insertWeknoraDocument(store, "w-staged", "staged", "ext-staged");
  insertWeknoraDocument(store, "w-dep", "deprecated", "ext-dep");
  linkMigrationDocument(store, "m-1", "w-staged", "published");
  linkMigrationDocument(store, "m-1", "w-dep", "published");
  const report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.ready, false);
  assert.equal(report.checks.publishedVisibility.ok, false);
  assert.equal(report.checks.publishedVisibility.stagedVisible, 1);
  assert.equal(report.checks.publishedVisibility.deprecatedVisible, 1);
  assert.ok(report.failures.includes("non-published WeKnora documents remain visible to routing"));
}));

test("candidate insights without valid evidence block the release", () => withStore((store) => {
  insertSession(store, "s-1", JSON.stringify({ objective: "clean" }));
  insertCandidate(store, "c-empty", "s-1", []);
  insertCandidate(store, "c-missing", "s-1", ["evidence-does-not-exist"]);
  const report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.ready, false);
  assert.equal(report.checks.candidateEvidence.ok, false);
  assert.equal(report.checks.candidateEvidence.withoutEvidence, 1);
  assert.equal(report.checks.candidateEvidence.unresolvedEvidence, 1);
  assert.ok(report.failures.includes("candidate insights lack valid evidence"));
  assert.equal(report.metrics.candidates.total, 2);
}));

test("published wiki pages without source refs block the release", () => withStore((store) => {
  insertWikiPage(store, "w-1", "published", []);
  insertWikiPage(store, "w-2", "published", ["doc:manual/a.pdf"]);
  const report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.ready, false);
  assert.equal(report.checks.wiki.ok, false);
  assert.equal(report.checks.wiki.publishedWithoutSourceRefs, 1);
  assert.ok(report.failures.includes("published wiki pages lack source refs"));
  assert.equal(report.metrics.wiki.published, 2);
  assert.equal(report.metrics.wiki.publishedWithSourceRefs, 1);
}));

test("uncorrelated relay events block the release and correlation clears it", () => withStore((store) => {
  store.grantAcl("p1", 7, true);
  store.append({ id: "evt-1", type: "job.started", occurredAt: NOW, projectId: "p1", jobId: "job-1", payload: {} });
  let report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.ready, false);
  assert.equal(report.checks.contextMetrics.ok, false);
  assert.equal(report.checks.contextMetrics.uncorrelatedEvents, 1);
  assert.ok(report.failures.includes("uncorrelated relay events exist"));
  assert.equal(report.metrics.outbox.backlog, 1);

  const intent: IntentEnvelope = { actions: ["diagnose"], phase: "diagnosis", objective: "Investigate job", constraints: [], acceptanceCriteria: [], projectId: "p1", risk: "read_only", knowledgeMode: "retrieve", actorId: 7 };
  const sessions = new WorkSessionService(store, () => new Date(NOW));
  const session = sessions.open({ actorId: 7, idempotencyKey: "session-1", intent });
  sessions.correlateEvent({ actorId: 7, sessionId: session.id, eventId: "evt-1", eventType: "job.started" });
  report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.checks.contextMetrics.ok, true);
  assert.deepEqual(report.metrics.events, { total: 1, correlated: 1, uncorrelated: 0 });
  assert.equal(report.metrics.sessions.open, 1);
  assert.equal(report.ready, true);
}));

test("import and provider error-class metrics stay numeric and content-free", () => withStore((store) => {
  store.db.prepare("INSERT INTO knowledge_ingest_jobs(id,kind,payload_json,status,attempts,available_at,started_at,finished_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("job-a", "product_documents", "{}", "succeeded", 2, NOW, "2026-10-22T00:00:00.000Z", "2026-10-22T00:01:40.000Z", NOW, NOW);
  store.db.prepare("INSERT INTO knowledge_ingest_jobs(id,kind,payload_json,status,attempts,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("job-b", "artifact_set", "{}", "failed", 1, NOW, NOW, NOW);
  insertProvider(store, { id: "prov-e1" });
  store.db.prepare("UPDATE knowledge_provider_configs SET last_error_code='timeout' WHERE id=?").run("prov-e1");
  const report = runReleaseGates(store, GATE_NOW);
  assert.equal(report.metrics.imports.ingest.total, 2);
  assert.equal(report.metrics.imports.ingest.succeeded, 1);
  assert.equal(report.metrics.imports.ingest.failed, 1);
  assert.equal(report.metrics.imports.ingest.retried, 1);
  assert.equal(report.metrics.imports.ingest.avgDurationMs, 100_000);
  assert.equal(report.checks.importMetrics.failedJobs, 1);
  assert.deepEqual(report.metrics.providers.errorClasses, { timeout: 1 });
}));
