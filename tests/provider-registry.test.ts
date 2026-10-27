import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { ProviderRegistry } from "../src/knowledge/provider-registry.ts";

function withStore(fn: (registry: ProviderRegistry, store: ReturnType<typeof createKnowledgeStore>) => void): void {
  const root = mkdtempSync(join(tmpdir(), "relay-provider-")); const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try { fn(new ProviderRegistry(store, () => new Date("2026-10-23T00:00:00.000Z")), store); } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

test("provider config stores only a secret reference and exposes safe metadata", () => withStore((registry) => {
  const saved = registry.upsert({ id: "embed", kind: "embedding", provider: "openai", baseUrl: "https://api.example.test", modelId: "text-embedding-3-small", dimensions: 1536, secretRef: "vault://relay/embed", actorId: 7 });
  assert.equal(saved.tokenConfigured, true); assert.equal((saved as any).secretRef, undefined);
  assert.doesNotMatch(JSON.stringify(saved), /vault:\/\/|secret-value/);
  assert.equal(registry.list()[0].modelId, "text-embedding-3-small");
}));

test("provider model or dimension changes create pending reindex state and rotation is idempotent", () => withStore((registry) => {
  registry.upsert({ id: "embed", kind: "embedding", provider: "openai", modelId: "m1", dimensions: 3, actorId: 7 });
  const changed = registry.upsert({ id: "embed", kind: "embedding", provider: "openai", modelId: "m2", dimensions: 4, secretRef: "vault://new", actorId: 7 });
  assert.equal(changed.reindexRequired, true); assert.equal(changed.status, "pending_reindex");
  assert.equal(registry.rotateSecret("embed", "vault://new", 7).tokenConfigured, true);
  assert.equal(registry.disable("embed", 7).status, "disabled");
}));

test("provider configuration rejects credentials embedded in the base URL", () => withStore((registry) => {
  assert.throws(() => registry.upsert({ id: "embed", kind: "embedding", provider: "openai", baseUrl: "https://user:password@example.test", modelId: "m1", actorId: 7 }), /credentials/i);
}));

test("provider metadata suppresses credentials from legacy base URL rows", () => withStore((registry, store) => {
  registry.upsert({ id: "embed", kind: "embedding", provider: "openai", modelId: "m1", actorId: 7 });
  store.db.prepare("UPDATE knowledge_provider_configs SET base_url=? WHERE id=?").run("https://legacy-user:legacy-password@example.test", "embed");
  const listed = registry.list()[0];
  assert.equal(listed.baseUrl, undefined);
  assert.doesNotMatch(JSON.stringify(listed), /legacy-user|legacy-password/);
}));

test("changing embedding endpoint invalidates vectors even when model label and width match",()=>withStore((registry)=>{
  registry.upsert({id:"embed",kind:"embedding",provider:"one",baseUrl:"https://one.test/v1",modelId:"model",dimensions:3,actorId:7});
  const changed=registry.upsert({id:"embed",kind:"embedding",provider:"two",baseUrl:"https://two.test/v1",modelId:"model",dimensions:3,actorId:7});
  assert.equal(changed.indexVersion,2);assert.equal(changed.reindexRequired,true);
}));
