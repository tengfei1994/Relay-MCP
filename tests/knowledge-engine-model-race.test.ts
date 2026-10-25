import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { ProviderRegistry } from "../src/knowledge/provider-registry.ts";
import { registerEngineModelGateway } from "../src/knowledge/engine-model-gateway.ts";

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(mode: "queue" | "secret" | "retry", run: (state: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "engine-model-race-"));
  const store = createKnowledgeStore({ dbPath: join(dir, "knowledge.db") });
  const entered = gate(), blocked = gate(); const models: string[] = [];
  let secrets = 0;
  const registry = new ProviderRegistry(store, undefined, {
    policy: { circuitFailureThreshold: 1, sleep: async () => { entered.release(); await blocked.promise; } },
    secrets: { resolve: async () => { if (mode === "secret" && secrets++ === 0) { entered.release(); await blocked.promise; } return "private-token"; } },
    fetchImpl: async (_url, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      if (models.length === 1 && mode === "queue") { entered.release(); await blocked.promise; }
      if (models.length === 1 && mode === "retry") return Response.json({ error: { code: "unavailable" } }, { status: 503 });
      return Response.json({ data: [{ index: 0, embedding: [0.1, 0.2] }] });
    },
  });
  const configure = (modelId: string) => registry.upsert({ id: "embedding", kind: "embedding", provider: "test", baseUrl: "https://provider.test/v1", modelId, dimensions: 2, secretRef: "test:token", actorId: 1, concurrency: 1, maxRetries: 1 });
  configure("model-a");
  const handle = registry.resolveCandidateProvider("embedding");
  const app = Fastify();
  await registerEngineModelGateway(app, { registry, token: () => "internal-token", bindings: () => [{ providerId: "embedding", kind: "embedding", modelId: "model-a", dimensions: 2, indexVersion: 1, alias: "alias-a" }] });
  const request = () => app.inject({ method: "POST", url: "/internal/knowledge-engine/v1/embeddings", headers: { authorization: "Bearer internal-token" }, payload: { model: "alias-a", input: ["private source"] } });
  const admissions = () => (store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_provider_admissions").get() as { n: number }).n;
  try { await run({ entered, blocked, configure, registry, store, models, handle, request, admissions }); }
  finally { blocked.release(); await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("queued old alias rejects a same-dimension model switch before transport or admission", () => fixture("queue", async ({ entered, blocked, configure, models, handle, request, admissions }) => {
  const first = request().then((response: any) => response); await entered.promise;
  const queued = request().then((response: any) => response);
  const deadline = Date.now() + 1000;
  while (handle.health().totalCalls < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(handle.health().totalCalls, 2);
  configure("model-b"); blocked.release();
  assert.equal((await first).statusCode, 200);
  const rejected = await queued;
  assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().error.code, "model_binding_stale");
  assert.deepEqual(models, ["model-a"]); assert.equal(admissions(), 1);
  assert.equal(handle.health().consecutiveFailures, 0);
}));

test("model change while resolving a secret rejects before transport and admission", () => fixture("secret", async ({ entered, blocked, configure, models, handle, request, admissions }) => {
  const response = request().then((value: any) => value); await entered.promise;
  configure("model-b"); blocked.release();
  const rejected = await response;
  assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().error.code, "model_binding_stale");
  assert.deepEqual(models, []); assert.equal(admissions(), 0);
  assert.equal(handle.health().consecutiveFailures, 0);
}));

test("model change during retry backoff never sends a retry under the old alias", () => fixture("retry", async ({ entered, blocked, configure, models, handle, request, admissions }) => {
  const response = request().then((value: any) => value); await entered.promise;
  configure("model-b"); blocked.release();
  const rejected = await response;
  assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().error.code, "model_binding_stale");
  assert.deepEqual(models, ["model-a"]); assert.equal(admissions(), 1);
  assert.equal(handle.health().consecutiveFailures, 0);
}));

test("credential rotation during secret resolution never transmits the retired secret", () => fixture("secret", async ({ entered, blocked, registry, models, handle, request, admissions }) => {
  const response = request().then((value: any) => value); await entered.promise;
  registry.rotateSecret("embedding", "test:replacement-token", 1); blocked.release();
  const rejected = await response;
  assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().error.code, "provider_credentials_changed");
  assert.deepEqual(models, []); assert.equal(admissions(), 0);
  assert.equal(handle.health().consecutiveFailures, 0);
}));

test("an alias pins its generation across another process changing config before handle resolution", () => fixture("queue", async ({ blocked, registry, store, models, request, admissions }) => {
  blocked.release();
  const second = createKnowledgeStore({ dbPath: store.db.name });
  const other = new ProviderRegistry(second);
  const resolve = registry.resolveCandidateProvider.bind(registry);
  registry.resolveCandidateProvider = (...args: any[]) => {
    other.upsert({ id: "embedding", kind: "embedding", provider: "test", baseUrl: "https://provider.test/v1", modelId: "model-b", dimensions: 2, secretRef: "test:token", actorId: 1, concurrency: 1, maxRetries: 1 });
    return resolve(...args);
  };
  try {
    const rejected = await request();
    assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().error.code, "model_binding_stale");
    assert.deepEqual(models, []); assert.equal(admissions(), 0);
  } finally { second.close(); }
}));
