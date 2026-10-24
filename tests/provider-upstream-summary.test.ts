import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { callOpenAiEmbedding, ManagedProviderError } from "../src/knowledge/provider-probe.js";

test("upstream JSON diagnostics expose fixed classifications without forwarding private errors", async (t) => {
  const token = "fixture-upstream-secret-token";
  let body: unknown;
  let mode = "json";
  const server = createServer((req, res) => {
    req.resume(); res.setHeader("content-type", "application/json"); res.writeHead(502);
    if (mode === "hung") { res.write('{"error":'); return; }
    res.end(mode === "malformed" ? "not json " + token : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const options = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, modelId: "private-model-name", token, texts: ["private-document-text"] };
  const fail = async () => {
    try { await callOpenAiEmbedding(options); assert.fail("Expected upstream error"); }
    catch (error) { assert.ok(error instanceof ManagedProviderError); return error; }
  };
  try {
    await t.test("wrapped upstream status and a request ID inside JSON remain distinguishable from the outer 502", async () => {
      body = { error: { code: "bad_response_status_code", type: "upstream_error", param: "404", message: `private-document-text ${token} (request id: gateway-20261025-abc)` } };
      const error = await fail();
      assert.equal(error.status, 502);
      assert.equal(error.diagnostics?.upstreamStatus, 502);
      assert.equal((error.diagnostics as any)?.upstreamErrorCode, "bad_response_status_code");
      assert.equal((error.diagnostics as any)?.upstreamReportedStatus, 404);
      assert.equal((error.diagnostics as any)?.reason, "upstream_http_error");
      assert.equal(error.diagnostics?.upstreamRequestId, "gateway-20261025-abc");
      assert.match(error.message, /bad_response_status_code/);
      assert.match(error.message, /404/);
      assert.match(error.message, /gateway-20261025-abc/);
      assert.doesNotMatch(error.message + JSON.stringify(error), /fixture-upstream-secret-token|private-document-text|private-model-name/);
    });
    await t.test("channel, quota, authentication and network messages become fixed reason categories", async () => {
      for (const [message, reason] of [
        ["No available channel for model private-model-name under group private-group", "channel_unavailable"],
        ["当前分组下对于模型 private-model-name 无可用渠道", "channel_unavailable"],
        ["insufficient quota: private balance details", "quota_exceeded"],
        ["invalid api key: private details", "authentication_failed"],
        ["Post private-internal-url: dial tcp private-address: connection refused", "upstream_connection_failed"],
      ]) {
        body = { error: { type: "new_api_error", message } };
        const error = await fail();
        assert.equal((error.diagnostics as any)?.reason, reason);
        assert.ok(!error.message.includes(message));
        assert.doesNotMatch(error.message + JSON.stringify(error), /private-/);
      }
    });
    await t.test("unknown error codes, arbitrary messages and credential-shaped request IDs are excluded", async () => {
      for (const requestId of [token, "prefix-" + token, Buffer.from(token).toString("base64url"), "private-document-text", "private-model-name", "x".repeat(129)]) {
        body = { request_id: requestId, error: { code: "private-error-code", message: "private-document-text " + token, request_id: requestId } };
        const error = await fail();
        assert.equal(error.diagnostics?.upstreamRequestId, undefined);
        assert.equal((error.diagnostics as any)?.upstreamErrorCode, undefined);
        assert.equal((error.diagnostics as any)?.reason, undefined);
        assert.doesNotMatch(error.message + JSON.stringify(error), /private-|fixture-upstream-secret-token/);
      }
    });
    await t.test("oversized, malformed and unfinished JSON cannot replace or stall the original HTTP error", async () => {
      for (mode of ["json", "malformed", "hung"]) {
        body = { padding: "x".repeat(20_000), error: { code: "insufficient_quota" } };
        const started = Date.now();
        const error = await fail();
        assert.equal(error.status, 502);
        assert.equal(error.code, "unavailable");
        assert.equal((error.diagnostics as any)?.reason, undefined);
        assert.ok(Date.now() - started < 4000, "error summarization must have its own deadline");
      }
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
