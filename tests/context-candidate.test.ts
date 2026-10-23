import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { buildContextPack } from "../src/knowledge/context-pack.ts";
import { CandidateInsightCompiler } from "../src/knowledge/candidate-insight.ts";
import { WorkSessionService, type IntentEnvelope } from "../src/knowledge/work-session.ts";

const intent: IntentEnvelope = { actions: ["diagnose", "capture"], phase: "diagnosis", objective: "Find root cause", constraints: [], acceptanceCriteria: ["Evidence linked"], projectId: "p1", risk: "read_only", knowledgeMode: "retrieve_and_capture", actorId: 7 };
function withStore(fn: (store: ReturnType<typeof createKnowledgeStore>) => Promise<void> | void): Promise<void> { const root = mkdtempSync(join(tmpdir(), "relay-insight-")); const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") }); store.grantAcl("p1", 7, true); return Promise.resolve(fn(store)).finally(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); }

test("Context Pack separates authoritative docs, confirmed memory, candidates and degraded provider state", () => { const pack = buildContextPack({ authoritativeDocs: [{ provider: "weknora", documentId: "d1", chunkId: "c1", retrievalRunId: "r1" }], confirmedKnowledge: [{ id: "case-1", statement: "known" }], candidates: [{ id: "candidate-1", status: "draft" }], currentFacts: [{ id: "fact-1", text: "current" }], provider: "weknora", degraded: { productKnowledge: "timeout" } }); assert.equal(pack.authoritativeDocs[0].provider, "weknora"); assert.equal(pack.confirmedKnowledge.length, 1); assert.equal(pack.candidates[0].status, "draft"); assert.equal(pack.degraded.productKnowledge, "timeout"); });

test("Candidate compiler validates evidence references and falls back deterministically", async () => withStore(async (store) => { const session = new WorkSessionService(store).open({ actorId: 7, idempotencyKey: "s1", intent }); const compiler = new CandidateInsightCompiler(store, async () => "{\"kind\":\"fact\",\"statement\":\"Root cause found\",\"whyProposed\":\"Evidence supports it\",\"evidenceRefs\":[],\"intentRefs\":[\"objective\"],\"unknowns\":[],\"reuseBoundary\":{}}", () => new Date("2026-10-23T00:00:00.000Z")); const first = await compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [], context: { statement: "Root cause found" } }); const second = await compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: [], context: { statement: "Root cause found" } }); assert.equal(first.id, second.id); assert.equal(first.status, "draft"); assert.equal(first.evidenceRefs.length, 0); }));

test("Candidate compiler rejects evidence outside the session project", async () => withStore(async (store) => { const session = new WorkSessionService(store).open({ actorId: 7, idempotencyKey: "s2", intent }); const compiler = new CandidateInsightCompiler(store, async () => "{}", () => new Date()); await assert.rejects(() => compiler.compile({ actorId: 7, sessionId: session.id, evidenceRefs: ["missing-evidence"], context: {} }), /Evidence/); }));
