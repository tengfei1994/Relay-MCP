import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore, type KnowledgeStore } from "../src/knowledge/store.ts";
import { runReleaseGates } from "../src/knowledge/release-gates.ts";
import { WorkSessionService, type IntentEnvelope } from "../src/knowledge/work-session.ts";
import { EvidenceStore } from "../src/knowledge/evidence-store.ts";
import {
  CandidateInsightCompiler,
  FALLBACK_GENERATED_BY,
  type CandidateInsightProviderRequest,
  type ManagedCandidateInsightProvider,
} from "../src/knowledge/candidate-insight.ts";
import { CandidateInsightReviewService } from "../src/knowledge/candidate-review.ts";
import { WikiService } from "../src/knowledge/wiki.ts";
import { MigrationController } from "../src/knowledge/migration-control.ts";
import { WeKnoraIngestor, type WeKnoraDocumentWriter } from "../src/knowledge/weknora-ingest.ts";

const NOW = "2026-10-23T00:00:00.000Z";
const clock = () => new Date(NOW);

class FailingManagedProvider implements ManagedCandidateInsightProvider {
  readonly providerId = "fake-candidate-llm";
  readonly modelId = "fake-model-v1";
  complete(_request: CandidateInsightProviderRequest): Promise<string> {
    return Promise.reject(new Error("upstream unreachable"));
  }
}

const fakeWriter: WeKnoraDocumentWriter = {
  async upsertDocument(input) {
    return { externalDocumentId: `ext-${input.idempotencyKey}`, knowledgeBaseId: "kb-1" };
  },
};

function seedProductDocument(store: KnowledgeStore, id: string): void {
  store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,samplemanager_version,solution,module,source_locator,source_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "product_document", `Title ${id}`, `Body of ${id}`, "approved", "p1", "21.3", "Core", "Forms", `docs/${id}.html`, `sha-${id}`, NOW, NOW);
  store.db.prepare("INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,source_path,source_sha256,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, `family-${id}`, "html", "en", `docs/${id}.html`, `sha-${id}`, "21.3", NOW, NOW);
}

function auditIds(store: KnowledgeStore, action: string): string[] {
  return (store.db.prepare("SELECT id FROM knowledge_audit WHERE action=? ORDER BY occurred_at,id").all(action) as Array<{ id: string }>).map((row) => row.id);
}

test("integrated store/service flow ends release-ready with correlated metrics and audit ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-integrated-e2e-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), evidenceRoot: join(root, "evidence") });
  try {
    store.grantAcl("p1", 7, true);
    const intent: IntentEnvelope = { actions: ["diagnose", "capture"], phase: "diagnosis", objective: "Find the pump job root cause", constraints: [], acceptanceCriteria: ["Evidence linked"], projectId: "p1", risk: "read_only", knowledgeMode: "retrieve_and_capture", actorId: 7 };

    // 1. Open a Work Session and correlate a job domain event to it.
    const sessions = new WorkSessionService(store, clock);
    const session = sessions.open({ actorId: 7, idempotencyKey: "e2e-session-1", intent });
    assert.equal(session.status, "open");
    store.append({ id: "evt-job-1", type: "job.failed", occurredAt: NOW, projectId: "p1", jobId: "job-1", payload: { reasonCode: "pump_stopped" } });
    sessions.correlateEvent({ actorId: 7, sessionId: session.id, eventId: "evt-job-1", eventType: "job.failed", intentStep: "diagnose" });

    // 2. Persist an Evidence fixture visible to the session project.
    const evidence = new EvidenceStore(store, store.evidenceRoot!).put({ content: Buffer.from("pump stopped at 12:00", "utf8"), mimeType: "text/plain", sourceKind: "log", projectId: "p1", locator: "runlog:job-1/pump.log" });

    // 3. Compile a Candidate Insight; the managed provider fails and the
    //    deterministic fallback produces a persisted draft citing the Evidence.
    const compiler = new CandidateInsightCompiler(store, new FailingManagedProvider(), clock);
    const insight = await compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidence.id], context: { statement: "Pump power supply fault" } });
    assert.equal(insight.persisted, true);
    assert.equal(insight.generatedBy, FALLBACK_GENERATED_BY);
    assert.equal(insight.fallbackReason, "unavailable");
    assert.deepEqual(insight.evidenceRefs, [evidence.id]);

    // 4. Reviewer confirms and promotes the fact insight to Confirmed Memory.
    const review = new CandidateInsightReviewService(store, clock);
    const confirmed = review.confirm({ actorId: 7, id: insight.id, reason: "Verified against the run log" });
    assert.equal(confirmed.status, "accepted");
    const promotion = review.promote({ actorId: 7, id: insight.id, target: "fact", reason: "Reusable fact", title: "Pump power supply fact" });
    assert.equal(promotion.mode, "persisted");
    assert.ok(promotion.targetId?.startsWith("memory-fact-"));
    assert.ok(store.db.prepare("SELECT id FROM knowledge_confirmed_memories WHERE id=?").get(promotion.targetId));

    // 5. Create and publish a Wiki page with source references.
    const wiki = new WikiService(store, clock);
    const page = wiki.create({ actorId: 7, pageKey: "pump-triage", title: "Pump triage", body: "Check the pump power supply first.", projectId: "p1", sourceRefs: ["doc:manual/pump.pdf"], reason: "Initial capture" });
    const publishedPage = wiki.publish({ actorId: 7, id: page.id, reason: "Reviewed" });
    assert.equal(publishedPage.status, "published");

    // 6. Run a Product Knowledge migration end to end, then roll it back.
    seedProductDocument(store, "doc-1");
    const controller = new MigrationController(store, clock);
    const ingestor = new WeKnoraIngestor(store, fakeWriter, clock);
    const migration = await controller.createFromLocal({ actorId: 7, idempotencyKey: "e2e-migration-1", parserVersion: "parser-1" }, ingestor);
    assert.equal(migration.status, "staged");
    const publishedMigration = controller.validateAndPublish(migration.id, 7);
    assert.equal(publishedMigration.status, "published");
    assert.equal(controller.activeProductProvider(), "weknora");
    const rolledBack = controller.rollback(migration.id, 7, "e2e rollback drill");
    assert.equal(rolledBack.status, "rolled_back");
    assert.equal(controller.activeProductProvider(), "relay_local");

    // 7. The release gate report over the exercised state is ready, with
    //    metrics reflecting every step and no content leakage.
    const report = runReleaseGates(store, new Date("2026-10-23T12:00:00.000Z"));
    assert.deepEqual(report.failures, []);
    assert.equal(report.ready, true);
    assert.deepEqual(report.metrics.events, { total: 1, correlated: 1, uncorrelated: 0 });
    assert.equal(report.metrics.sessions.open, 1);
    assert.equal(report.metrics.candidates.total, 1);
    assert.equal(report.metrics.candidates.accepted, 1);
    assert.equal(report.metrics.candidates.fallback, 1);
    assert.equal(report.metrics.candidates.withEvidence, 1);
    assert.deepEqual(report.metrics.candidates.fallbackReasons, { unavailable: 1 });
    assert.equal(report.checks.migrations.rolledBack, 1);
    assert.equal(report.metrics.imports.weknora.staged, 1);
    assert.equal(report.metrics.imports.weknora.published, 0);
    assert.equal(report.metrics.wiki.published, 1);
    assert.equal(report.metrics.wiki.publishedWithSourceRefs, 1);
    assert.equal(report.checks.securityScan.ok, true);
    const serialized = JSON.stringify(report);
    for (const forbidden of ["pump stopped at 12:00", "Pump power supply fault", "Bearer", "password"]) {
      assert.ok(!serialized.includes(forbidden), `release report leaks '${forbidden}'`);
    }

    // 8. Every lifecycle step produced an audit row with a stable unique id.
    const expectedAudits: Array<[string, string]> = [
      ["knowledge.work_session.open", session.id],
      ["candidate_insight.compiled", insight.id],
      ["candidate_insight.confirm", insight.id],
      ["candidate_insight.promote", insight.id],
      ["wiki.create", page.id],
      ["wiki.publish", page.id],
      ["knowledge.migration.create", migration.id],
      ["knowledge.migration.publish", migration.id],
      ["knowledge.migration.rollback", migration.id],
    ];
    const allAuditIds = new Set<string>();
    for (const [action, entityId] of expectedAudits) {
      const rows = store.db.prepare("SELECT id FROM knowledge_audit WHERE action=? AND entity_id=?").all(action, entityId) as Array<{ id: string }>;
      assert.equal(rows.length, 1, `expected exactly one audit row for ${action} on ${entityId}`);
      assert.ok(rows[0].id.length > 0);
      allAuditIds.add(rows[0].id);
    }
    assert.equal(allAuditIds.size, expectedAudits.length);
    assert.equal(auditIds(store, "knowledge.integration.set_product_provider").length, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
