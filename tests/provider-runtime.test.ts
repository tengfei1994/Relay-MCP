import assert from "node:assert/strict";
import test from "node:test";
import { FakeEmbeddingProvider, ProviderCircuitOpenError, ProviderQuotaExceededError, ProviderTimeoutError, ProviderRegistry, assertProviderConfig, embeddingModelChanged, providerConfigMetadata } from "../src/knowledge/provider-runtime.ts";

test("provider policy retries transient failures and exposes safe health", async () => {
  const provider = new FakeEmbeddingProvider({ failTimes: 2 });
  const registry = new ProviderRegistry({ maxRetries: 2, retryBaseMs: 1, sleep: async () => undefined });
  registry.register("embedding", provider, { providerId: "fake", modelId: provider.capabilities.modelId });
  const vectors = await registry.embed(["hello"]);
  assert.equal(vectors.length, 1); assert.equal(provider.calls, 3);
  assert.equal(registry.health()[0].state, "closed");
  assert.equal(registry.configs()[0].secretConfigured, false);
});

test("provider policy opens a circuit after timeout failures", async () => {
  const provider = new FakeEmbeddingProvider({ delayMs: 20 });
  const registry = new ProviderRegistry({ timeoutMs: 5, maxRetries: 0, circuitFailureThreshold: 2, circuitCooldownMs: 1000 });
  registry.register("embedding", provider, { providerId: "slow", modelId: provider.capabilities.modelId });
  await assert.rejects(() => registry.embed(["a"]), ProviderTimeoutError);
  await assert.rejects(() => registry.embed(["a"]), ProviderTimeoutError);
  await assert.rejects(() => registry.embed(["a"]), ProviderCircuitOpenError);
  assert.equal(registry.health()[0].state, "open");
});

test("provider quota is enforced without leaking secret values", async () => {
  const provider = new FakeEmbeddingProvider();
  const registry = new ProviderRegistry();
  registry.register("embedding", provider, { providerId: "enterprise", modelId: "enterprise-v1", dataPolicy: "enterprise", secretRef: "vault://relay/provider", quota: { maxCalls: 1, windowMs: 60_000 } });
  await registry.embed(["a"]);
  await assert.rejects(() => registry.embed(["b"]), ProviderQuotaExceededError);
  const metadata = registry.configs()[0] as Record<string, unknown>;
  assert.equal(metadata.secretRef, undefined); assert.equal(metadata.secretConfigured, true); assert.doesNotMatch(JSON.stringify(metadata), /vault:\/\/relay\/provider/);
});

test("provider configuration rejects raw credentials and detects embedding model changes", () => {
  assert.throws(() => assertProviderConfig({ kind: "embedding", providerId: "x", modelId: "m", dataPolicy: "cloud", endpoint: "https://example.test?apiKey=raw" }), /credentials/);
  assert.throws(() => assertProviderConfig({ kind: "embedding", providerId: "x", modelId: "m", dataPolicy: "cloud", apiKey: "raw" } as never), /raw secret/);
  assert.equal(embeddingModelChanged({ kind: "embedding", providerId: "x", modelId: "m", dataPolicy: "local", dimensions: 4 }, { kind: "embedding", providerId: "x", modelId: "m2", dataPolicy: "local", dimensions: 4 }), true);
  const metadata = providerConfigMetadata({ kind: "embedding", providerId: "x", modelId: "m", dataPolicy: "local", secretRef: "vault://x" });
  assert.equal(metadata.secretConfigured, true); assert.equal((metadata as Record<string, unknown>).secretRef, undefined);
});

