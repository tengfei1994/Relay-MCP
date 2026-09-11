import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { classifyRelayEvent } from "../src/knowledge/event-classifier.ts";
import { captureKnowledgeCandidates } from "../src/knowledge/capture-worker.ts";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { acceptCandidate } from "../src/knowledge/review-service.ts";
import { describeCandidate } from "../src/knowledge/candidate-narrative.ts";

function withStore<T>(fn: (root: string, store: ReturnType<typeof createKnowledgeStore>) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-compiler-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  return fn(root, store).finally(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
}

test("deterministic classifier keeps routine success telemetry-only", async () => {
  const result = classifyRelayEvent({ id: "e1", type: "job.finished", occurredAt: new Date().toISOString(), projectId: "p1", jobId: "j1", payload: { status: "succeeded" }, eventKey: "job:j1:finished" });
  assert.deepEqual(result, { eventClass: "telemetry_only", captureCandidate: false, storeObservation: false, captureReason: "Routine successful execution without an anomaly or reusable Knowledge signal." });
  await withStore(async (_root, store) => {
    store.append({ id: "e1", type: "job.finished", occurredAt: "2026-09-03T00:00:00.000Z", projectId: "p1", jobId: "j1", payload: { status: "succeeded" } });
    assert.equal(await captureKnowledgeCandidates(store), 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM relay_domain_events").get().count, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_audit WHERE action = 'knowledge.event.classified'").get().count, 1);
  });
});

test("routine zero-warning message is not treated as a failure signal", () => {
  const result = classifyRelayEvent({
    id: "e-benign-message",
    type: "job.finished",
    occurredAt: new Date().toISOString(),
    projectId: "p1",
    jobId: "j-benign-message",
    payload: { status: "succeeded", message: "Build succeeded. 0 Warning(s) 0 Error(s)" },
    eventKey: "job:j-benign-message:finished",
  });
  assert.equal(result.eventClass, "telemetry_only");
  assert.equal(result.captureCandidate, false);
  assert.equal(result.storeObservation, false);
});

test("legacy execution summaries become observations when they contain captured stdout", async () => {
  const summary = [
    "$ powershell -File <remote script>",
    "exit=0",
    "--- stdout ---",
    '[{"Name":"DAVLandingPage.xml"}]',
    "--- stderr ---",
    "(empty)",
  ].join("\n");
  const result = classifyRelayEvent({ id: "e-output", type: "job.finished", occurredAt: new Date().toISOString(), projectId: "p1", jobId: "j-output", payload: { status: "succeeded", kind: "exec_remote_script", summary }, eventKey: "job:j-output:finished" });
  assert.equal(result.eventClass, "observation");
  assert.equal(result.storeObservation, true);
  assert.match(result.captureReason, /captured execution output/i);

  await withStore(async (_root, store) => {
    store.append({ id: "e-output", type: "job.finished", occurredAt: "2026-09-03T00:00:00.000Z", projectId: "p1", jobId: "j-output", payload: { status: "succeeded", kind: "exec_remote_script", summary }, eventKey: "job:j-output:finished" });
    assert.equal(await captureKnowledgeCandidates(store), 1);
    const row = store.db.prepare("SELECT event_class,facts_json FROM knowledge_observations WHERE event_id = ?").get("e-output") as { event_class: string; facts_json: string };
    assert.equal(row.event_class, "observation");
    const facts = JSON.parse(row.facts_json) as Array<{ field: string; value: string }>;
    assert.equal(facts.find((fact) => fact.field === "stdout")?.value, '[{"Name":"DAVLandingPage.xml"}]');
    assert.equal(facts.some((fact) => fact.field === "summary"), false, "parsed output should not be duplicated as one opaque summary fact");
  });
});

test("directory inventories do not promote a Candidate because a filename contains timeout", async () => {
  const stdout = "DIR C:\\Thermo\\SampleManager\\Server\\VGSM\\Exe exists=True\n\nName Length LastWriteTime\n---- ------ -------------\ntimeout.dll 14736 9/14/2022 10:34:24 PM";
  const event = { id: "e-directory", type: "job.finished" as const, occurredAt: "2026-09-08T00:18:38.916Z", projectId: "p1", jobId: "j-directory", payload: { status: "succeeded", exitCode: 0, stdout } };
  assert.equal(classifyRelayEvent(event).storeObservation, true);
  await withStore(async (_root, store) => {
    store.append(event);
    assert.equal(await captureKnowledgeCandidates(store), 1);
    assert.equal(await captureKnowledgeCandidates(store), 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_candidates").get().count, 0);
  });
});

test("narrative explains successful directory checks and missing paths without claiming a failure", () => {
  const body = JSON.stringify({ eventType: "job.finished", occurredAt: "2026-09-08T00:18:38.916Z", payload: {
    status: "succeeded", environment: "Demo", exitCode: 0,
    stdout: "DIR C:\\Thermo\\SampleManager\\Server\\VGSM\\Exe exists=True\nDIR C:\\Thermo\\SampleManager\\Server\\VGSM\\Forms exists=False\ntimeout.dll 14736 9/14/2022 10:34:24 PM",
  } });
  const narrative = describeCandidate(body);
  assert.equal(narrative.assessment, "insufficient");
  assert.match(narrative.title, /目录检查/);
  assert.match(narrative.summary, /Demo/);
  assert.ok(narrative.facts.some((fact) => /未找到/.test(fact)));
  assert.doesNotMatch(narrative.summary, /超时/);
});

test("warnings materialize idempotent observations with immutable evidence", async () => {
  await withStore(async (_root, store) => {
    const event = { id: "e-warning", type: "job.finished" as const, occurredAt: "2026-09-03T00:00:00.000Z", projectId: "p1", jobId: "j-warning", payload: { status: "succeeded", warning: "slow", log: "warning details" } };
    store.append(event);
    assert.equal(await captureKnowledgeCandidates(store), 1);
    assert.equal(await captureKnowledgeCandidates(store), 0);
    const row = store.db.prepare("SELECT event_id,event_class,capture_reason,evidence_refs_json FROM knowledge_observations WHERE event_id = ?").get(event.id) as Record<string, unknown>;
    assert.equal(row.event_class, "observation");
    assert.match(String(row.capture_reason), /facts|warnings/i);
    assert.equal(JSON.parse(String(row.evidence_refs_json)).length, 1);
    const candidate = store.db.prepare("SELECT id,source_observation_id FROM knowledge_candidates WHERE source_observation_id LIKE 'observation-%'").get() as { id: string; source_observation_id: string };
    assert.ok(candidate.id);
    assert.match(candidate.source_observation_id, /^observation-/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_entity_evidence WHERE entity_type = 'candidate' AND entity_id = ?").get(candidate.id).count, 1);
  });
});

test("contract failures create a structured card without an inference provider", async () => {
  await withStore(async (_root, store) => {
    store.append({ id: "e-parse", type: "job.finished", occurredAt: "2026-09-03T00:00:00.000Z", projectId: "p1", jobId: "j-parse", payload: { status: "succeeded", parseStatus: "failed", parseError: "invalid output", stdout: "raw output" } });
    assert.equal(await captureKnowledgeCandidates(store), 1);
    const candidate = store.db.prepare("SELECT id FROM knowledge_candidates WHERE event_id = ?").get("e-parse") as { id: string };
    const card = store.getCandidateCard(candidate.id);
    assert.equal(card?.eventClass, "integration_contract_failure");
    assert.match(card?.captureReason ?? "", /parsing|contract/i);
    assert.ok(card?.problemStatement.includes("invalid output"));
    assert.equal(store.db.prepare("SELECT payload_json FROM relay_domain_events WHERE id = ?").get("e-parse")?.payload_json.includes("invalid output"), true);
  });
});

test("accepting a candidate compiles one traceable Case and is idempotent", async () => {
  await withStore(async (_root, store) => {
    store.append({ id: "e-case", type: "job.failed", occurredAt: "2026-09-03T00:00:00.000Z", projectId: "p1", jobId: "j-case", payload: { status: "failed", error: "command failed", log: "stderr" } });
    assert.equal(await captureKnowledgeCandidates(store), 1);
    const candidate = store.db.prepare("SELECT id FROM knowledge_candidates WHERE event_id = ?").get("e-case") as { id: string };
    store.grantAcl("p1", 7, true);
    acceptCandidate(store, 7, candidate.id, "reproduced in test");
    acceptCandidate(store, 7, candidate.id, "same acceptance replay");
    const result = store.db.prepare("SELECT source_candidate_id,event_id,job_id,evidence_refs_json,status FROM knowledge_cases WHERE id = ?").get(`case-${candidate.id}`) as Record<string, unknown>;
    assert.equal(result.source_candidate_id, candidate.id);
    assert.equal(result.event_id, "e-case");
    assert.equal(result.job_id, "j-case");
    assert.equal(result.status, "reproduced");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_cases").get().count, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_relations WHERE relation_type = 'produces_case'").get().count, 1);
  });
});
