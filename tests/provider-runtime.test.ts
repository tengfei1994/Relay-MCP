import assert from "node:assert/strict";
import test from "node:test";
import { FakeEmbeddingProvider, ProviderCircuitOpenError, ProviderQuotaExceededError, ProviderTimeoutError, ProviderRegistry, assertProviderConfig, embeddingModelChanged, providerConfigMetadata } from "../src/knowledge/provider-runtime.ts";

test("an unmetered policy reports total calls without retaining a rolling quota history", async () => {
  const provider=new FakeEmbeddingProvider(),registry=new ProviderRegistry({maxRetries:0});
  registry.register("embedding",provider,{providerId:"unmetered",modelId:provider.capabilities.modelId});
  for(let i=0;i<20;i++)await registry.embed(["bounded fixture"]);
  const health=registry.health()[0];
  assert.equal(health.totalCalls,20);assert.equal(health.quotaUsed,0);assert.equal(health.quotaResetAt,undefined);
});

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


// These are real queued operations, not manually rewritten policy internals.
test("half-open quota refusal releases its own probe reservation without changing standalone quota",async()=>{
 const {ProviderPolicy}=await import('../src/knowledge/provider-runtime.ts');let now=1000,calls=0;
 const policy=new ProviderPolicy({kind:'embedding',providerId:'half-open-quota',modelId:'fixture',dataPolicy:'local',concurrency:1,maxRetries:0,circuitFailureThreshold:1,circuitCooldownMs:100,quota:{maxCalls:1,windowMs:1000}},{now:()=>now});
 await assert.rejects(policy.execute(async()=>{calls++;throw new Error('upstream failure');}));
 now=1100;await assert.rejects(policy.execute(async()=>{calls++;return 'unexpected';}),ProviderQuotaExceededError);assert.equal(calls,1);
 now=2000;assert.equal(await policy.execute(async()=>{calls++;return 'recovered';}),'recovered');assert.equal(calls,2);
});

test("aborting an unrelated old waiter cannot release a queued half-open probe reservation",async()=>{
 const {ProviderPolicy}=await import('../src/knowledge/provider-runtime.ts');let now=1000,releaseA:()=>void=()=>{},releaseB:()=>void=()=>{};let probeCalls=0,unexpectedCalls=0;
 const config={kind:'embedding' as const,providerId:'probe-owner',modelId:'fixture',dataPolicy:'local' as const,concurrency:2,maxRetries:0,circuitFailureThreshold:1,circuitCooldownMs:100};
 const policy=new ProviderPolicy(config,{now:()=>now});
 const a=policy.execute(async()=>{await new Promise<void>(resolve=>{releaseA=resolve;});return 'a';});
 const b=policy.execute(async()=>{await new Promise<void>(resolve=>{releaseB=resolve;});throw new Error('upstream failure');});
 const bRejected=assert.rejects(b);await new Promise(resolve=>setImmediate(resolve));
 const controller=new AbortController(),oldWaiter=policy.execute(async()=>{unexpectedCalls++;return 'old';},{signal:controller.signal});
 const oldRejected=assert.rejects(oldWaiter);await new Promise(resolve=>setImmediate(resolve));
 policy.updateConfig({...config,concurrency:1});releaseB();await bRejected;
 now=1100;const probe=policy.execute(async()=>{probeCalls++;return 'probe';});await new Promise(resolve=>setImmediate(resolve));
 controller.abort();await oldRejected;
 const challenger=policy.execute(async()=>{unexpectedCalls++;return 'challenger';});const captured=Promise.allSettled([challenger]);
 await new Promise(resolve=>setImmediate(resolve));releaseA();await a;await probe;
 const [result]=await captured;assert.equal(result.status,'rejected');if(result.status==='rejected')assert.ok(result.reason instanceof ProviderCircuitOpenError);
 assert.equal(probeCalls,1);assert.equal(unexpectedCalls,0);
});
