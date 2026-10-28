import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { ProviderCredentialStore } from "../src/knowledge/provider-credential-store.ts";
import { createManagedProviderRegistry, ProviderSetupService } from "../src/knowledge/provider-setup.ts";
import { listOpenAiModels } from "../src/knowledge/provider-probe.ts";

test("encrypted credentials survive restart, reject tampering and never replace a missing original key", async () => {
  const root = mkdtempSync(join(tmpdir(), "provider-keys-"));
  const options = { dbPath: join(root, "knowledge.db") };
  const keyFile = join(root, "key");
  let store = createKnowledgeStore(options);
  try {
    const credentials = new ProviderCredentialStore(store, keyFile);
    const ref = credentials.save("fixture-token");
    const other = credentials.save("fixture-token");
    const rows = store.db.prepare("SELECT ciphertext FROM knowledge_provider_secrets").all() as any[];
    assert.notDeepEqual(rows[0].ciphertext, rows[1].ciphertext);
    store.close(); store = createKnowledgeStore(options);
    const reopened = new ProviderCredentialStore(store, keyFile);
    assert.equal(await reopened.resolve(ref), "fixture-token");
    store.db.prepare("UPDATE knowledge_provider_secrets SET ciphertext=? WHERE ref=?").run(Buffer.from("tampered"), other);
    await assert.rejects(() => reopened.resolve(other), /could not be decrypted/);
    const key = readFileSync(keyFile);
    unlinkSync(keyFile);
    await assert.rejects(() => reopened.resolve(ref), /could not be decrypted/);
    assert.throws(() => reopened.save("another-token"), /original key/);
    writeFileSync(keyFile, key);
    assert.equal(await reopened.resolve(ref), "fixture-token");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("model discovery rejects oversized data, token echoes, malformed IDs and timed-out requests", async () => {
  const options = { baseUrl: "https://gateway.test/v1", modelId: "", token: "fixture-token" };
  for (const body of [{ data: [{ id: "fixture-token" }] }, { data: [{ name: "missing-id" }] }, { data: "wrong-shape" }, { data: [], padding: "x".repeat(2 * 1024 * 1024) }]) {
    await assert.rejects(() => listOpenAiModels({ ...options, fetchImpl: async () => Response.json(body) }), (error: any) => error.code === "invalid_response" && !error.message.includes(options.token));
  }
  await assert.rejects(() => listOpenAiModels({ ...options, signal: AbortSignal.abort(), fetchImpl: async () => { throw new Error(options.token); } }), (error: any) => error.code === "timeout");
  assert.deepEqual(await listOpenAiModels({ ...options, fetchImpl: async () => Response.json({ data: [] }) }), []);
});

test("a configuration changed during a probe is not overwritten by the stale save", async () => {
  const root = mkdtempSync(join(tmpdir(), "provider-race-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  const oldFetch = globalThis.fetch;
  try {
    const registry = createManagedProviderRegistry(store);
    registry.upsert({ id: "p", kind: "embedding", provider: "gateway", modelId: "m", baseUrl: "https://gateway.test/v1", dimensions: 3, actorId: 7 });
    globalThis.fetch = (async (url) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "m" }] });
      registry.disable("p", 8);
      return Response.json({ data: [{ embedding: [1, 2, 3] }] });
    }) as typeof fetch;
    await assert.rejects(() => new ProviderSetupService(store).configure({ id: "p", kind: "embedding", provider: "gateway", baseUrl: "https://gateway.test/v1", modelId: "m", token: "fixture-token", actorId: 7 }), /changed/);
    assert.equal(registry.get("p")?.status, "disabled");
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_provider_secrets").get() as any).n, 0);
  } finally { globalThis.fetch = oldFetch; store.close(); rmSync(root, { recursive: true, force: true }); }
});
