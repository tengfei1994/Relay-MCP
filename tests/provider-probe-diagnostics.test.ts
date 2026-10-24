import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { callOpenAiEmbedding, callOpenAiRerank, callOpenAiChat, listOpenAiModels, ManagedProviderError } from "../src/knowledge/provider-probe.js";

test("provider diagnostics preserve HTTP evidence while excluding upstream bodies and unsafe identifiers", async (t) => {
  const token = "fixture-private-provider-token";
  let requestId = "upstream-request-42";
  let mode = "http-error";
  const server = createServer((request, response) => {
    request.resume();
    if (mode === "timeout") return;
    response.setHeader("x-request-id", requestId);
    response.setHeader("content-type", "application/json");
    response.writeHead(mode === "http-error" ? 502 : 200);
    response.end(mode === "invalid-json" ? "not JSON " + token : JSON.stringify({ error: { message: token }, data: [{ embedding: ["invalid"] }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const options = { baseUrl: `http://127.0.0.1:${port}/v1`, modelId: "fixture-model", token };
  const capture = async (operation: () => Promise<unknown>) => {
    try { await operation(); assert.fail("Expected provider failure"); }
    catch (error) { assert.ok(error instanceof ManagedProviderError); return error; }
  };
  try {
    await t.test("every operation identifies its failed endpoint and upstream response", async () => {
      for (const [stage, method, endpoint, call] of [
        ["models", "GET", "/models", () => listOpenAiModels(options)],
        ["embedding", "POST", "/embeddings", () => callOpenAiEmbedding({ ...options, texts: ["probe"] })],
        ["rerank", "POST", "/rerank", () => callOpenAiRerank({ ...options, query: "probe", documents: ["probe"] })],
        ["inference", "POST", "/chat/completions", () => callOpenAiChat({ ...options, prompt: "probe" })],
      ] as const) {
        const error = await capture(call);
        assert.deepEqual((error as any).diagnostics, { stage, method, endpoint, upstreamStatus: 502, upstreamRequestId: requestId, responseFormat: "json" });
        assert.match(error.message, new RegExp(method + " " + endpoint));
        assert.doesNotMatch(error.message + JSON.stringify(error), new RegExp(token));
      }
    });
    await t.test("echoed tokens and malformed request IDs never become diagnostic output", async () => {
      for (requestId of [token, "prefix-" + token, Buffer.from(token).toString("base64url"), "<html>bad</html>", "x".repeat(129)]) {
        const error = await capture(() => listOpenAiModels(options));
        assert.equal((error as any).diagnostics?.upstreamRequestId, undefined);
        assert.ok(!error.message.includes(requestId));
      }
      requestId = "upstream-request-42";
    });
    await t.test("invalid JSON and invalid vectors retain the successful HTTP response evidence", async () => {
      for (mode of ["invalid-json", "invalid-vector"]) {
        const error = await capture(() => callOpenAiEmbedding({ ...options, texts: ["probe"] }));
        assert.equal(error.code, mode === "invalid-json" ? "invalid_response" : "invalid_vector");
        assert.equal((error as any).diagnostics?.stage, "embedding");
        assert.equal((error as any).diagnostics?.upstreamStatus, 200);
        assert.doesNotMatch(error.message + JSON.stringify(error), new RegExp(token));
      }
    });
    await t.test("timeouts identify the attempted endpoint without inventing an upstream status", async () => {
      mode = "timeout";
      const error = await capture(() => listOpenAiModels({ ...options, signal: AbortSignal.timeout(50) }));
      assert.equal(error.code, "timeout");
      assert.deepEqual((error as any).diagnostics, { stage: "models", method: "GET", endpoint: "/models" });
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await t.test("connection failures retain the attempted endpoint and hide raw transport errors", async () => {
    const error = await capture(() => listOpenAiModels({ ...options, signal: AbortSignal.timeout(2000) }));
    assert.equal(error.code, "unavailable");
    assert.deepEqual((error as any).diagnostics, { stage: "models", method: "GET", endpoint: "/models" });
    assert.ok(!error.message.includes(options.baseUrl));
  });
});
