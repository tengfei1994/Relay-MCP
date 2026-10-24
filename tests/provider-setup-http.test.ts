import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("provider setup discovers models, tests before saving and persists only encrypted credentials", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "provider-setup-"));
  const keys = ["DB_PATH", "KNOWLEDGE_DB_PATH", "PROVIDER_SECRET_KEY_FILE"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.DB_PATH = join(root, "app.db");
  process.env.KNOWLEDGE_DB_PATH = join(root, "knowledge.db");
  process.env.PROVIDER_SECRET_KEY_FILE = join(root, "provider.key");
  const token = "fixture-private-token-one";
  const replacement = "fixture-private-token-two";
  const previousFetch = globalThis.fetch;
  let mode = "ok";
  let calls: Array<{ url: string; auth: string | null; method: string; redirect?: string }> = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), method: init?.method ?? "GET", redirect: init?.redirect });
    if (mode === "unauthorized") return new Response(token, { status: 401 });
    if (mode === "malformed") return new Response("not json " + token);
    if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "https://other.test" } });
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "embed-model", secret: token }, { id: "chat-model" }, { id: "embed-model" }] });
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("/embeddings")) {
      assert.equal(body.model, "embed-model");
      return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    }
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  }) as typeof fetch;
  const { default: Fastify } = await import("fastify");
  const { db, runMigrations } = await import("../src/server/db/index.js");
  const { knowledgeRoutes } = await import("../src/server/routes/knowledge.js");
  const { getKnowledgeStore } = await import("../src/server/knowledge-context.js");
  runMigrations();
  const store = getKnowledgeStore();
  const app = Fastify();
  app.decorate("authenticate", async (req: any) => { req.user = { id: 7, isAdmin: req.headers["x-reader"] !== "true" }; });
  await app.register(knowledgeRoutes);
  const base = "/api/knowledge/providers/managed";
  const setup = { kind: "embedding", provider: "gateway", baseUrl: "https://gateway.test", modelId: "embed-model", token };
  try {
    await t.test("only administrators can discover, save or clear credentials", async () => {
      for (const [url, payload] of [
        [base + "/models", { baseUrl: setup.baseUrl, token }],
        [base + "/embed/configure", setup],
        [base + "/embed/token", { token: null }],
      ] as const) {
        const response = await app.inject({ method: "POST", url, payload, headers: { "x-reader": "true" } });
        assert.equal(response.statusCode, 403, response.body);
      }
      assert.equal(calls.length, 0);
    });
    await t.test("root and /v1 URLs discover sanitized unique model IDs using bearer auth", async () => {
      for (const baseUrl of ["https://gateway.test", "https://gateway.test/v1/"]) {
        const response = await app.inject({ method: "POST", url: base + "/models", payload: { baseUrl, token } });
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json().models, [{ id: "chat-model" }, { id: "embed-model" }]);
        assert.ok(!response.body.includes(token));
        assert.deepEqual(calls.at(-1), { url: "https://gateway.test/v1/models", auth: "Bearer " + token, method: "GET", redirect: "error" });
      }
    });
    await t.test("credential-bearing URLs and upstream failures never echo tokens", async () => {
      const count = calls.length;
      for (const baseUrl of ["https://user:pass@gateway.test", "https://gateway.test?token=" + token, "https://gateway.test#" + token]) {
        const response = await app.inject({ method: "POST", url: base + "/models", payload: { baseUrl, token } });
        assert.equal(response.statusCode, 400);
        assert.ok(!response.body.includes(token));
      }
      assert.equal(calls.length, count);
      for (mode of ["unauthorized", "malformed", "redirect"]) {
        const response = await app.inject({ method: "POST", url: base + "/models", payload: { baseUrl: setup.baseUrl, token } });
        assert.equal(response.statusCode, 502, response.body);
        assert.ok(!response.body.includes(token));
      }
      mode = "ok";
    });
    await t.test("save probes the selected model and derives dimensions without leaking or storing plaintext", async () => {
      const response = await app.inject({ method: "POST", url: base + "/embed/configure", payload: setup });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().provider.dimensions, 3);
      assert.equal(response.json().provider.tokenConfigured, true);
      assert.equal(response.json().report.ok, true);
      assert.ok(!response.body.includes(token));
      const rows = store.db.prepare("SELECT * FROM knowledge_provider_secrets").all();
      assert.equal(rows.length, 1);
      assert.ok(!JSON.stringify(rows).includes(token));
      assert.equal(readFileSync(process.env.PROVIDER_SECRET_KEY_FILE!).length, 32);
      assert.ok(!JSON.stringify(store.db.prepare("SELECT * FROM knowledge_audit").all()).includes(token));
      store.db.pragma("wal_checkpoint(TRUNCATE)");
      assert.ok(!readFileSync(process.env.KNOWLEDGE_DB_PATH!).includes(Buffer.from(token)));
      const freshRuntime = (await import("../src/knowledge/provider-setup.js")).createManagedProviderRegistry(store);
      assert.equal((await freshRuntime.probe("embed", 7)).ok, true);
      assert.equal(calls.at(-1)?.auth, "Bearer " + token);
    });
    await t.test("failed validation leaves the working provider and credential intact", async () => {
      mode = "unauthorized";
      const failed = await app.inject({ method: "POST", url: base + "/embed/configure", payload: { ...setup, token: replacement } });
      assert.equal(failed.statusCode, 502, failed.body);
      mode = "ok";
      const unknown = await app.inject({ method: "POST", url: base + "/embed/configure", payload: { ...setup, modelId: "not-listed" } });
      assert.equal(unknown.statusCode, 400, unknown.body);
      const tested = await app.inject({ method: "POST", url: base + "/embed/test", payload: {} });
      assert.equal(tested.json().report.ok, true);
      assert.equal(calls.at(-1)?.auth, "Bearer " + token);
    });
    await t.test("rotation replaces the encrypted credential and clearing disables the provider", async () => {
      const rotated = await app.inject({ method: "POST", url: base + "/embed/token", payload: { token: replacement } });
      assert.equal(rotated.statusCode, 200, rotated.body);
      await app.inject({ method: "POST", url: base + "/embed/test", payload: {} });
      assert.equal(calls.at(-1)?.auth, "Bearer " + replacement);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_provider_secrets").get().n, 1);
      const cleared = await app.inject({ method: "POST", url: base + "/embed/token", payload: { token: null } });
      assert.equal(cleared.statusCode, 200, cleared.body);
      assert.equal(cleared.json().provider.tokenConfigured, false);
      assert.equal(cleared.json().provider.status, "disabled");
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_provider_secrets").get().n, 0);
      const count = calls.length;
      await app.inject({ method: "POST", url: base + "/embed/test", payload: {} });
      assert.equal(calls.length, count);
    });
  } finally {
    await app.close();
    store.close();
    (db as any).session.client.close();
    globalThis.fetch = previousFetch;
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true });
  }
});
