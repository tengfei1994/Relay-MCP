import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { ProviderRegistry } from "../src/knowledge/provider-registry.ts";
import { InMemorySecretResolver } from "../src/knowledge/provider-secret.ts";
import { ProviderUnavailableError } from "../src/knowledge/providers.ts";

interface RecordedCall { url: string; authorization?: string; body: unknown }
interface FakeOutcome { status?: number; body?: unknown; delayMs?: number }

interface FakeHttp {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
  active: number;
  maxActive: number;
}

function fakeHttp(handler: (call: RecordedCall) => FakeOutcome): FakeHttp {
  const state: FakeHttp = { fetchImpl: undefined as never, calls: [], active: 0, maxActive: 0 };
  state.fetchImpl = (async (url: unknown, init: { headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => {
    const call: RecordedCall = { url: String(url), authorization: init?.headers?.authorization, body: JSON.parse(init?.body ?? "null") };
    state.calls.push(call);
    const outcome = handler(call);
    if (outcome.delayMs) {
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, outcome.delayMs);
          init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason ?? new Error("aborted")); }, { once: true });
        });
      } finally {
        state.active -= 1;
      }
    }
    return new Response(JSON.stringify(outcome.body ?? {}), { status: outcome.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return state;
}

const EMBED_OK = { data: [{ embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 3, total_tokens: 3 } };
const RERANK_OK = { results: [{ index: 0, relevance_score: 0.9 }] };
const CHAT_OK = { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } };

function openAiOk(call: RecordedCall): FakeOutcome {
  const url = String(call.url);
  if (url.includes("/rerank")) return { body: RERANK_OK };
  if (url.includes("/chat/completions")) return { body: CHAT_OK };
  return { body: EMBED_OK };
}

interface RuntimeContext {
  registry: ProviderRegistry;
  secrets: InMemorySecretResolver;
  store: ReturnType<typeof createKnowledgeStore>;
}

async function withRuntime(http: FakeHttp, fn: (context: RuntimeContext) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "relay-provider-runtime-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  const secrets = new InMemorySecretResolver();
  const registry = new ProviderRegistry(store, () => new Date("2026-10-23T00:00:00.000Z"), {
    secrets,
    fetchImpl: http.fetchImpl,
    policy: { retryBaseMs: 10, sleep: async () => undefined },
  });
  try {
    await fn({ registry, secrets, store });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function upsertEmbedding(registry: ProviderRegistry, extra: Record<string, unknown> = {}): void {
  registry.upsert({ id: "embed", kind: "embedding", provider: "openai-compatible", baseUrl: "https://fake.test/v1", modelId: "embed-v1", dimensions: 3, secretRef: "vault://embed", actorId: 7, ...extra });
}

function auditDetails(store: ReturnType<typeof createKnowledgeStore>): string {
  const rows = store.db.prepare("SELECT action,details_json FROM knowledge_audit").all() as Array<{ action: string; details_json: string }>;
  return rows.map((row) => `${row.action}:${row.details_json}`).join("\n");
}

test("managed embedding probe succeeds with a resolved token and leaks no secrets", async () => {
  const http = fakeHttp(openAiOk);
  await withRuntime(http, async ({ registry, secrets, store }) => {
    secrets.set("vault://embed", "unit-test-token-embed");
    upsertEmbedding(registry, { quota: { maxCalls: 100, windowMs: 60_000 } });
    const report = await registry.probe("embed", 7);
    assert.equal(report.ok, true);
    assert.equal(report.observedDimensions, 3);
    assert.equal(report.httpStatus, 200);
    assert.equal(report.tokenUsage?.totalTokens, 3);
    const provider = registry.get("embed")!;
    assert.equal(provider.status, "ready");
    assert.equal(provider.lastErrorCode, undefined);
    assert.equal(provider.quota?.maxCalls, 100);
    assert.equal(provider.indexVersion, 1);
    // The token was resolved at call time and only used for the Authorization header.
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0].url, "https://fake.test/v1/embeddings");
    assert.equal(http.calls[0].authorization, "Bearer unit-test-token-embed");
    const audit = auditDetails(store);
    const serialized = JSON.stringify({ metadata: registry.list(), report }) + audit;
    assert.doesNotMatch(serialized, /unit-test-token-embed|vault:\/\/embed/);
    assert.match(audit, /knowledge\.provider\.probe/);
    assert.match(audit, /"total":3/);
  });
});

test("probe classifies timeouts and degrades the provider", async () => {
  const http = fakeHttp(() => ({ delayMs: 100, body: EMBED_OK }));
  await withRuntime(http, async ({ registry }) => {
    upsertEmbedding(registry, { timeoutMs: 5, maxRetries: 0 });
    const report = await registry.probe("embed");
    assert.equal(report.ok, false);
    assert.match(report.errorCode ?? "", /timeout/);
    assert.equal(registry.get("embed")!.status, "degraded");
    assert.match(registry.get("embed")!.lastErrorCode ?? "", /timeout/);
  });
});

test("probe retries 429 and then succeeds", async () => {
  let count = 0;
  const http = fakeHttp(() => (++count === 1 ? { status: 429, body: { error: "slow down" } } : { body: EMBED_OK }));
  await withRuntime(http, async ({ registry }) => {
    upsertEmbedding(registry, { maxRetries: 1 });
    const report = await registry.probe("embed");
    assert.equal(report.ok, true);
    assert.equal(http.calls.length, 2);
    assert.equal(registry.get("embed")!.status, "ready");
  });
});

test("probe treats 401 as unauthorized without retrying", async () => {
  const http = fakeHttp(() => ({ status: 401, body: { error: "bad key" } }));
  await withRuntime(http, async ({ registry }) => {
    upsertEmbedding(registry, { maxRetries: 3 });
    const report = await registry.probe("embed");
    assert.equal(report.ok, false);
    assert.equal(report.errorCode, "unauthorized");
    assert.equal(http.calls.length, 1);
    assert.equal(registry.get("embed")!.status, "degraded");
  });
});

test("probe rejects invalid vectors and dimension mismatches", async () => {
  const http = fakeHttp((call) => {
    if (String(call.url).includes("bad-vector")) return { body: { data: [{ embedding: ["not-a-number", 0.2] }] } };
    return { body: { data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] } };
  });
  await withRuntime(http, async ({ registry }) => {
    registry.upsert({ id: "bad-vector", kind: "embedding", provider: "openai-compatible", baseUrl: "https://fake.test/bad-vector", modelId: "embed-v1", dimensions: 2, actorId: 7 });
    assert.equal((await registry.probe("bad-vector")).errorCode, "invalid_vector");
    registry.upsert({ id: "embed", kind: "embedding", provider: "openai-compatible-2", baseUrl: "https://fake.test/good-shape", modelId: "embed-v1", dimensions: 3, actorId: 7 });
    assert.equal((await registry.probe("embed")).errorCode, "dimension_mismatch");
    assert.equal(registry.get("embed")!.status, "degraded");
  });
});

test("embedding model/dimension changes create pending reindex jobs and completing one restores ready", async () => {
  const http = fakeHttp(() => ({ body: { data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] } }));
  await withRuntime(http, async ({ registry }) => {
    upsertEmbedding(registry);
    const changed = registry.upsert({ id: "embed", kind: "embedding", provider: "openai-compatible", baseUrl: "https://fake.test/v1", modelId: "embed-v2", dimensions: 4, actorId: 7 });
    assert.equal(changed.status, "pending_reindex");
    assert.equal(changed.reindexRequired, true);
    assert.equal(changed.indexVersion, 2);
    const pending = registry.pendingReindex();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].job.fromDimensions, 3);
    assert.equal(pending[0].job.toDimensions, 4);
    assert.equal(pending[0].job.toModelId, "embed-v2");
    assert.equal(pending[0].job.status, "pending");
    assert.equal(pending[0].provider.indexVersion, 2);
    // Probing with the new dimension succeeds but keeps pending_reindex until the job completes.
    const report = await registry.probe("embed");
    assert.equal(report.ok, true);
    assert.equal(registry.get("embed")!.status, "pending_reindex");
    registry.beginReindex(pending[0].job.id);
    registry.completeReindex(pending[0].job.id, 7);
    const after = registry.get("embed")!;
    assert.equal(after.status, "ready");
    assert.equal(after.reindexRequired, false);
    assert.equal(registry.pendingReindex().length, 0);
  });
});

test("rotation takes effect immediately and the old token is never used again", async () => {
  const http = fakeHttp(openAiOk);
  await withRuntime(http, async ({ registry, secrets, store }) => {
    secrets.set("vault://old", "token-old-12345");
    registry.upsert({ id: "embed", kind: "embedding", provider: "openai-compatible", baseUrl: "https://fake.test/v1", modelId: "embed-v1", dimensions: 3, secretRef: "vault://old", actorId: 7 });
    await registry.probe("embed");
    const handle = registry.resolveCandidateProvider("embed");
    await handle.embed(["hello"]);
    registry.rotateSecret("embed", "vault://new", 7);
    secrets.set("vault://new", "token-new-67890");
    // The handle resolved before the rotation must pick up the new reference.
    await handle.embed(["world"]);
    await registry.probe("embed");
    assert.deepEqual(http.calls.map((call) => call.authorization), [
      "Bearer token-old-12345",
      "Bearer token-old-12345",
      "Bearer token-new-67890",
      "Bearer token-new-67890",
    ]);
    assert.equal(registry.get("embed")!.tokenConfigured, true);
    const audit = auditDetails(store);
    assert.doesNotMatch(audit + JSON.stringify(registry.list()), /token-old-12345|token-new-67890|vault:\/\/old|vault:\/\/new/);
  });
});

test("managed handle enforces the configured concurrency limit", async () => {
  const http = fakeHttp(() => ({ delayMs: 15, body: EMBED_OK }));
  await withRuntime(http, async ({ registry }) => {
    upsertEmbedding(registry, { concurrency: 1 });
    const handle = registry.resolveCandidateProvider("embed");
    const results = await Promise.all([handle.embed(["a"]), handle.embed(["b"]), handle.embed(["c"])]);
    assert.equal(results.length, 3);
    assert.equal(results[0].vectors[0].length, 3);
    assert.equal(http.maxActive, 1);
  });
});

test("disabled providers reject probes and handle resolution", async () => {
  const http = fakeHttp(openAiOk);
  await withRuntime(http, async ({ registry }) => {
    upsertEmbedding(registry);
    registry.disable("embed", 7);
    const report = await registry.probe("embed");
    assert.equal(report.ok, false);
    assert.equal(report.errorCode, "provider_disabled");
    assert.equal(registry.get("embed")!.status, "disabled");
    assert.throws(() => registry.resolveCandidateProvider("embed"), ProviderUnavailableError);
  });
});

test("concurrent upserts and probes stay consistent", async () => {
  const http = fakeHttp(openAiOk);
  await withRuntime(http, async ({ registry }) => {
    await Promise.all([
      (async () => registry.upsert({ id: "p1", kind: "embedding", provider: "a", baseUrl: "https://fake.test/v1", modelId: "m1", dimensions: 3, actorId: 1 }))(),
      (async () => registry.upsert({ id: "p2", kind: "rerank", provider: "b", baseUrl: "https://fake.test/v1", modelId: "r1", actorId: 1 }))(),
      (async () => registry.upsert({ id: "p3", kind: "wiki_llm", provider: "c", baseUrl: "https://fake.test/v1", modelId: "c1", actorId: 1 }))(),
    ]);
    const reports = await Promise.all([registry.probe("p1"), registry.probe("p1"), registry.probe("p2"), registry.probe("p3")]);
    assert.ok(reports.every((report) => report.ok));
    const providers = registry.list();
    assert.equal(providers.length, 3);
    assert.equal(providers.find((provider) => provider.id === "p1")?.status, "ready");
    assert.equal(providers.find((provider) => provider.id === "p2")?.status, "ready");
    assert.equal(providers.find((provider) => provider.id === "p3")?.status, "ready");
  });
});
