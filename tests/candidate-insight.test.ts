import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createKnowledgeStore, type KnowledgeStore } from "../src/knowledge/store.ts";
import { EvidenceStore } from "../src/knowledge/evidence-store.ts";
import {
  CandidateInsightCompiler,
  classifyCandidateProviderError,
  FALLBACK_GENERATED_BY,
  type CandidateInsightProviderRequest,
  type ManagedCandidateInsightProvider,
} from "../src/knowledge/candidate-insight.ts";
import { WorkSessionService, type IntentEnvelope } from "../src/knowledge/work-session.ts";

const intent: IntentEnvelope = { actions: ["diagnose", "capture"], phase: "diagnosis", objective: "Find root cause", constraints: [], acceptanceCriteria: ["Evidence linked"], projectId: "p1", risk: "read_only", knowledgeMode: "retrieve_and_capture", actorId: 7 };

function withStore(fn: (store: KnowledgeStore) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "relay-insight-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), evidenceRoot: join(root, "evidence") });
  store.grantAcl("p1", 7, true);
  return Promise.resolve(fn(store)).finally(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
}

function openSession(store: KnowledgeStore, key = randomUUID()) {
  return new WorkSessionService(store).open({ actorId: 7, idempotencyKey: key, intent });
}

function putEvidence(store: KnowledgeStore, projectId: string | undefined, content = "pump stopped at 12:00"): string {
  const evidence = new EvidenceStore(store, store.evidenceRoot!).put({ content: Buffer.from(content, "utf8"), mimeType: "text/plain", sourceKind: "log", projectId, locator: `test:${randomUUID()}` });
  return evidence.id;
}

class FakeManagedProvider implements ManagedCandidateInsightProvider {
  readonly providerId = "fake-managed";
  readonly modelId = "fake-model-v1";
  readonly prompts: string[] = [];
  constructor(private readonly handler: (prompt: string, request: CandidateInsightProviderRequest) => Promise<string> | string) {}
  complete(request: CandidateInsightProviderRequest): Promise<string> {
    this.prompts.push(request.prompt);
    return Promise.resolve(this.handler(request.prompt, request));
  }
}

function validOutput(refs: string[]): string {
  return JSON.stringify({
    kind: "fact",
    statement: "Root cause found",
    whyProposed: "Evidence supports it",
    evidenceRefs: refs,
    intentRefs: ["objective"],
    unknowns: [],
    reuseBoundary: { scope: "project" },
    confidence: 0.8,
    confirmedFacts: ["Pump stopped"],
    observedBehavior: ["Retry storm in logs"],
    hypothesis: "Power supply fault",
    reusableStatement: { statement: "Check the PSU before replacing the pump" },
  });
}

test("Managed provider success persists structured sections and provider identity", () => withStore(async (store) => {
  const session = openSession(store);
  const evidenceId = putEvidence(store, "p1");
  const provider = new FakeManagedProvider(() => validOutput([evidenceId]));
  const compiler = new CandidateInsightCompiler(store, provider, () => new Date("2026-10-23T00:00:00.000Z"));
  const insight = await compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidenceId], context: { statement: "Root cause found" } });
  assert.equal(insight.status, "draft");
  assert.equal(insight.persisted, true);
  assert.equal(insight.generatedBy, "managed-candidate-llm:fake-managed/fake-model-v1");
  assert.equal(insight.fallbackReason, undefined);
  assert.deepEqual(insight.confirmedFacts, ["Pump stopped"]);
  assert.deepEqual(insight.observedBehavior, ["Retry storm in logs"]);
  assert.equal(insight.hypothesis, "Power supply fault");
  assert.equal(insight.reusableStatement?.statement, "Check the PSU before replacing the pump");
  assert.equal(insight.confidence, 0.8);
  assert.deepEqual(insight.evidenceRefs, [evidenceId]);
  assert.equal(compiler.get(7, insight.id)?.id, insight.id);
  const audit = store.db.prepare("SELECT action FROM knowledge_audit WHERE entity_id = ? AND action = 'candidate_insight.compiled'").all(insight.id);
  assert.equal(audit.length, 1);
}));

test("Provider timeout degrades to the deterministic fallback with evidence refs", () => withStore(async (store) => {
  const session = openSession(store);
  const evidenceId = putEvidence(store, "p1");
  const provider = new FakeManagedProvider((_prompt, request) => new Promise<string>((_resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  }));
  const compiler = new CandidateInsightCompiler(store, provider, () => new Date(), { timeoutMs: 25 });
  const insight = await compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidenceId], context: { statement: "Timeout case" } });
  assert.equal(insight.generatedBy, FALLBACK_GENERATED_BY);
  assert.equal(insight.fallbackReason, "timeout");
  assert.equal(insight.status, "draft");
  assert.deepEqual(insight.evidenceRefs, [evidenceId]);
  assert.equal(insight.persisted, true);
  assert.ok(insight.unknowns.some((item) => item.includes("timeout")));
}));

test("HTTP 429 rate limiting is classified and falls back", () => withStore(async (store) => {
  const session = openSession(store);
  const evidenceId = putEvidence(store, "p1");
  const provider = new FakeManagedProvider(() => { throw Object.assign(new Error("HTTP 429: rate limit exceeded"), { status: 429 }); });
  const compiler = new CandidateInsightCompiler(store, provider);
  const insight = await compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidenceId], context: {} });
  assert.equal(insight.generatedBy, FALLBACK_GENERATED_BY);
  assert.equal(insight.fallbackReason, "rate_limited");
  assert.equal(classifyCandidateProviderError(new Error("429 too many requests")), "rate_limited");
}));

test("Markdown-wrapped and invalid JSON outputs fall back safely", () => withStore(async (store) => {
  const session = openSession(store);
  const evidenceId = putEvidence(store, "p1");
  const markdown = new CandidateInsightCompiler(store, new FakeManagedProvider((p) => `\`\`\`json\n${validOutput([evidenceId])}\n\`\`\``));
  const fromMarkdown = await markdown.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidenceId], context: { variant: "markdown" } });
  assert.equal(fromMarkdown.generatedBy, FALLBACK_GENERATED_BY);
  assert.equal(fromMarkdown.fallbackReason, "invalid_output");

  const broken = new CandidateInsightCompiler(store, new FakeManagedProvider(() => "this is not json"));
  const fromBroken = await broken.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidenceId], context: { variant: "broken" } });
  assert.equal(fromBroken.generatedBy, FALLBACK_GENERATED_BY);
  assert.equal(fromBroken.fallbackReason, "invalid_output");
}));

test("Overlong output falls back instead of being truncated into the store", () => withStore(async (store) => {
  const session = openSession(store);
  const evidenceId = putEvidence(store, "p1");
  const padded = validOutput([evidenceId]).replace(/\}$/, `,"padding":"${"x".repeat(2_000)}"}`);
  const compiler = new CandidateInsightCompiler(store, new FakeManagedProvider(() => padded), () => new Date(), { maxOutputChars: 1_000 });
  const insight = await compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidenceId], context: {} });
  assert.equal(insight.generatedBy, FALLBACK_GENERATED_BY);
  assert.equal(insight.fallbackReason, "overlong_output");
}));

test("Hidden reasoning fields and nested sensitive output fall back", () => withStore(async (store) => {
  const session = openSession(store);
  const evidenceId = putEvidence(store, "p1");
  const withReasoning = new CandidateInsightCompiler(store, new FakeManagedProvider(() => JSON.stringify({ ...JSON.parse(validOutput([evidenceId])), reasoning: "secret thoughts" })));
  const insight = await withReasoning.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidenceId], context: { variant: "reasoning" } });
  assert.equal(insight.generatedBy, FALLBACK_GENERATED_BY);
  assert.equal(insight.fallbackReason, "invalid_output");

  const nestedSecret = new CandidateInsightCompiler(store, new FakeManagedProvider(() => {
    const output = JSON.parse(validOutput([evidenceId]));
    output.reuseBoundary = { scope: "project", credentials: { apiKey: "sk-live-123" } };
    return JSON.stringify(output);
  }));
  const nested = await nestedSecret.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidenceId], context: { variant: "nested" } });
  assert.equal(nested.generatedBy, FALLBACK_GENERATED_BY);

  const bearer = new CandidateInsightCompiler(store, new FakeManagedProvider(() => {
    const output = JSON.parse(validOutput([evidenceId]));
    output.statement = "Authenticate with Bearer abcdef123456 before retrying";
    return JSON.stringify(output);
  }));
  const bearerResult = await bearer.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidenceId], context: { variant: "bearer" } });
  assert.equal(bearerResult.generatedBy, FALLBACK_GENERATED_BY);
  assert.equal(bearerResult.fallbackReason, "invalid_output");
}));

test("Nested sensitive input is redacted before reaching the provider", () => withStore(async (store) => {
  const session = openSession(store);
  const evidenceId = putEvidence(store, "p1");
  const provider = new FakeManagedProvider(() => validOutput([evidenceId]));
  const compiler = new CandidateInsightCompiler(store, provider);
  await compiler.compile({
    actorId: 7, sessionId: session.id, evidenceRefs: [evidenceId],
    context: { credentials: { nested: { apiToken: "tok-secret-123" } }, note: "password = hunter2", keep: "visible" },
  });
  assert.equal(provider.prompts.length, 1);
  const prompt = provider.prompts[0];
  assert.ok(!prompt.includes("tok-secret-123"), "token must be redacted");
  assert.ok(!prompt.includes("hunter2"), "password assignment must be redacted");
  assert.ok(prompt.includes("[REDACTED]"));
  assert.ok(prompt.includes("visible"));
}));

test("Compile with no valid evidence returns an ephemeral draft and persists nothing", () => withStore(async (store) => {
  const session = openSession(store);
  const provider = new FakeManagedProvider(() => validOutput([]));
  const compiler = new CandidateInsightCompiler(store, provider, () => new Date("2026-10-23T00:00:00.000Z"));
  const first = await compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [], context: { statement: "No evidence yet" } });
  const second = await compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [], context: { statement: "No evidence yet" } });
  assert.equal(first.id, second.id);
  assert.equal(first.persisted, false);
  assert.equal(first.status, "draft");
  assert.equal(first.generatedBy, FALLBACK_GENERATED_BY);
  assert.equal(provider.prompts.length, 0);
  const count = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_candidate_insights").get() as { count: number };
  assert.equal(count.count, 0);
  assert.equal(compiler.get(7, first.id), undefined);
}));

test("Cross-project evidence is rejected; ACL-shared evidence is accepted", () => withStore(async (store) => {
  const session = openSession(store);
  const foreign = putEvidence(store, "p2");
  const compiler = new CandidateInsightCompiler(store, new FakeManagedProvider((p) => validOutput([])), () => new Date());
  await assert.rejects(() => compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [foreign], context: {} }), /outside the session project/);

  const shared = putEvidence(store, undefined);
  await assert.rejects(() => compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [shared], context: {} }), /outside the session project/);
  store.db.prepare("INSERT INTO knowledge_evidence_acl(evidence_id,project_id,created_at) VALUES (?,?,?)").run(shared, "p1", new Date().toISOString());
  const sharing = new CandidateInsightCompiler(store, new FakeManagedProvider((p) => {
    const output = JSON.parse(validOutput([]));
    output.evidenceRefs = [shared];
    return JSON.stringify(output);
  }));
  const insight = await sharing.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [shared], context: {} });
  assert.equal(insight.persisted, true);
  assert.deepEqual(insight.evidenceRefs, [shared]);
}));

test("Concurrent and sequential replays return the original record", () => withStore(async (store) => {
  const session = openSession(store);
  const evidenceId = putEvidence(store, "p1");
  const provider = new FakeManagedProvider(() => validOutput([evidenceId]));
  const compiler = new CandidateInsightCompiler(store, provider, () => new Date("2026-10-23T00:00:00.000Z"));
  const input = { actorId: 7, sessionId: session.id, evidenceRefs: [evidenceId], context: { statement: "Replay" } };
  const [a, b] = await Promise.all([compiler.compile(input), compiler.compile(input)]);
  const c = await compiler.compile(input);
  assert.equal(a.id, b.id);
  assert.equal(a.id, c.id);
  assert.equal(provider.prompts.length, 1);
  const count = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_candidate_insights").get() as { count: number };
  assert.equal(count.count, 1);
}));

test("Model output citing unknown evidence ids is filtered or rejected", () => withStore(async (store) => {
  const session = openSession(store);
  const evidenceId = putEvidence(store, "p1");
  const hallucinated = new CandidateInsightCompiler(store, new FakeManagedProvider(() => validOutput(["evidence-does-not-exist"])));
  const rejected = await hallucinated.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidenceId], context: { variant: "hallucinated" } });
  assert.equal(rejected.generatedBy, FALLBACK_GENERATED_BY);
  assert.deepEqual(rejected.evidenceRefs, [evidenceId]);

  const mixed = new CandidateInsightCompiler(store, new FakeManagedProvider(() => validOutput([evidenceId, "evidence-does-not-exist"])));
  const filtered = await mixed.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [evidenceId], context: { variant: "mixed" } });
  assert.equal(filtered.generatedBy, "managed-candidate-llm:fake-managed/fake-model-v1");
  assert.deepEqual(filtered.evidenceRefs, [evidenceId]);
}));
