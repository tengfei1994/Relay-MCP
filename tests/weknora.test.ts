import assert from "node:assert/strict";
import test from "node:test";
import { WeKnoraClient, WeKnoraError, mapWeKnoraReferences } from "../src/knowledge/weknora.ts";

const BASE = "https://weknora.example.test";

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
}

test("WeKnora client calls /api/v1/knowledge-search with X-API-Key and maps references safely", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = new WeKnoraClient({
    baseUrl: `${BASE}/`,
    secretResolver: async () => "sk-secret-value",
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return jsonResponse({
        success: true,
        data: [{
          id: "chunk-1",
          content: "Hello SampleManager",
          knowledge_id: "doc-1",
          chunk_index: 0,
          knowledge_title: "Guide",
          score: 0.9,
          chunk_type: "text",
          metadata: { topicId: "topic-1", productVersion: "21.3", sourcePath: "docs/guide.html", anchor: "intro", solution: "Core", module: "Forms" },
          knowledge_filename: "guide.md",
          knowledge_source: "file",
        }],
      }, { headers: { "x-request-id": "req-1" } });
    },
  });
  const result = await client.search({ query: "hello", knowledgeBaseIds: ["kb-1", "kb-2"], limit: 5 });
  assert.equal(seenUrl, `${BASE}/api/v1/knowledge-search`);
  const headers = seenInit?.headers as Record<string, string>;
  assert.equal(headers["X-API-Key"], "sk-secret-value");
  assert.equal(headers.Authorization, undefined);
  const body = JSON.parse(String(seenInit?.body));
  assert.deepEqual(body.knowledge_base_ids, ["kb-1", "kb-2"]);
  assert.equal(body.match_count, 5);
  const ref = result.references[0];
  assert.equal(ref.provider, "weknora");
  assert.equal(ref.documentId, "doc-1");
  assert.equal(ref.chunkId, "chunk-1");
  assert.equal(ref.topicId, "topic-1");
  assert.equal(ref.version, "21.3");
  assert.equal(ref.module, "Forms");
  assert.equal(ref.sourceLocator, "docs/guide.html#intro");
  assert.equal(ref.citation, "docs/guide.html#intro");
  assert.equal(result.retrievalRunId, "req-1");
  assert.doesNotMatch(JSON.stringify(result), /sk-secret-value/);
});

test("WeKnora normalizes base URLs that already include /api/v1", async () => {
  let seenUrl = "";
  const client = new WeKnoraClient({ baseUrl: `${BASE}/api/v1/`, fetchImpl: async (url) => { seenUrl = String(url); return jsonResponse({ success: true, data: [] }); } });
  await client.search({ query: "x", knowledgeBaseIds: ["kb-1"] });
  assert.equal(seenUrl, `${BASE}/api/v1/knowledge-search`);
});

test("WeKnora rejects base URLs containing URL credentials", () => {
  assert.throws(() => new WeKnoraClient({ baseUrl: "https://user:password@weknora.example.test" }), /credentials/i);
});

test("WeKnora classifies timeout, 429, 401, 5xx and invalid JSON deterministically without leaking secrets", async () => {
  const secret = "sk-classify-token";
  const query = "sensitive query text";
  const mk = (fetchImpl: typeof fetch) => new WeKnoraClient({ baseUrl: BASE, fetchImpl, secretResolver: async () => secret, timeoutMs: 60 });

  const timeout = mk(((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  })) as typeof fetch);
  await assert.rejects(() => timeout.search({ query, knowledgeBaseIds: ["kb-1"] }), (error: unknown) => error instanceof WeKnoraError && error.code === "timeout");

  const rateLimited = mk((async () => jsonResponse({}, { status: 429, headers: { "retry-after": "7" } })) as typeof fetch);
  await assert.rejects(() => rateLimited.search({ query, knowledgeBaseIds: ["kb-1"] }), (error: unknown) => error instanceof WeKnoraError && error.code === "rate_limited" && error.retryAfterSeconds === 7);

  const unauthorized = mk((async () => jsonResponse({}, { status: 401 })) as typeof fetch);
  await assert.rejects(() => unauthorized.search({ query, knowledgeBaseIds: ["kb-1"] }), (error: unknown) => error instanceof WeKnoraError && error.code === "unauthorized");

  const unavailable = mk((async () => jsonResponse({}, { status: 503 })) as typeof fetch);
  await assert.rejects(() => unavailable.search({ query, knowledgeBaseIds: ["kb-1"] }), (error: unknown) => error instanceof WeKnoraError && error.code === "unavailable");

  const invalid = mk((async () => new Response("not-json", { status: 200 })) as typeof fetch);
  await assert.rejects(() => invalid.search({ query, knowledgeBaseIds: ["kb-1"] }), (error: unknown) => error instanceof WeKnoraError && error.code === "invalid_response");

  for (const client of [timeout, rateLimited, unauthorized, unavailable, invalid]) {
    const error = await client.search({ query, knowledgeBaseIds: ["kb-1"] }).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof WeKnoraError);
    assert.doesNotMatch(String(error.message), /sk-classify-token|sensitive query text/);
  }
});

test("WeKnora error messages and traces never contain the token or query", async () => {
  const traces: unknown[] = [];
  const client = new WeKnoraClient({
    baseUrl: BASE,
    secretResolver: async () => "sk-trace-token",
    onTrace: (trace) => traces.push(trace),
    fetchImpl: (async () => jsonResponse({ success: false, error: { code: 1006, message: "leaked sk-trace-token sensitive-query" } }, { status: 500 })) as typeof fetch,
  });
  await assert.rejects(() => client.search({ query: "sensitive-query", knowledgeBaseIds: ["kb-1"] }), (error: unknown) => {
    assert.ok(error instanceof WeKnoraError);
    assert.doesNotMatch(error.message, /sk-trace-token|sensitive-query/);
    return true;
  });
  const traceText = JSON.stringify(traces);
  assert.ok(traces.length >= 1);
  assert.doesNotMatch(traceText, /sk-trace-token|sensitive-query/);
});

test("reference mapper tolerates partial provider payloads while preserving source locator", () => {
  const rows = mapWeKnoraReferences([
    { id: "chunk-9", knowledge_id: "doc-9", score: 0.4, metadata: { sourcePath: "a.md", lineStart: 3 } },
    { content: "no document id" },
    "garbage",
  ], "run");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].documentId, "doc-9");
  assert.equal(rows[0].chunkId, "chunk-9");
  assert.equal(rows[0].sourceLocator, "a.md:3");
  assert.equal(rows[0].retrievalRunId, "run");
});

test("metadata filters are enforced client-side and scope keys map onto the request", async () => {
  let seenBody: Record<string, unknown> = {};
  const client = new WeKnoraClient({
    baseUrl: BASE,
    fetchImpl: (async (_url, init) => {
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse({ success: true, data: [
        { id: "c1", knowledge_id: "d1", content: "a", score: 0.9, metadata: { productVersion: "21.3", topicId: "t1", sourcePath: "a.md" } },
        { id: "c2", knowledge_id: "d2", content: "b", score: 0.8, metadata: { productVersion: "21.1", topicId: "t1", sourcePath: "b.md" } },
      ] });
    }) as typeof fetch,
  });
  const result = await client.search({ query: "x", filters: { knowledge_ids: "d1,d2", version: "21.3" }, limit: 10 });
  assert.deepEqual(seenBody.knowledge_ids, ["d1", "d2"]);
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].documentId, "d1");
});

test("document upsert/get/delete use stable endpoints and never expose the raw knowledge base id", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let mode: "ok" | "duplicate" = "ok";
  const client = new WeKnoraClient({
    baseUrl: BASE,
    secretResolver: async () => "sk-doc-token",
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), method: String(init?.method ?? "GET") });
      const target = String(url);
      if (target.endsWith("/knowledge/file")) {
        assert.ok(init?.body instanceof FormData);
        if (mode === "duplicate") return jsonResponse({ success: false, data: { id: "kn-existing", title: "Guide", parse_status: "completed" } }, { status: 409 });
        return jsonResponse({ success: true, data: { id: "kn-1", title: "Guide", parse_status: "pending" } });
      }
      if (init?.method === "DELETE") return jsonResponse({ success: true, data: { task_id: "task-1" } });
      return jsonResponse({ success: true, data: { id: "kn-1", title: "Guide", parse_status: "completed" } });
    }) as typeof fetch,
  });

  const created = await client.upsertDocument({ knowledgeBaseId: "kb-raw-1", title: "Guide", content: "# Guide", sourcePath: "docs/guide.md", metadata: { productVersion: "21.3" } });
  assert.equal(created.documentId, "kn-1");
  assert.equal(created.duplicate, undefined);
  assert.equal("knowledgeBaseId" in created, false);

  mode = "duplicate";
  const deduped = await client.upsertDocument({ knowledgeBaseId: "kb-raw-1", title: "Guide", content: "# Guide" });
  assert.equal(deduped.documentId, "kn-existing");
  assert.equal(deduped.duplicate, true);

  const fetched = await client.getDocument("kn-1");
  assert.deepEqual(fetched, { documentId: "kn-1", title: "Guide", parseStatus: "completed" });

  const deleted = await client.deleteDocument("kn-1");
  assert.deepEqual(deleted, { documentId: "kn-1", accepted: true });

  assert.equal(calls[0].url, `${BASE}/api/v1/knowledge-bases/kb-raw-1/knowledge/file`);
  assert.equal(calls[2].url, `${BASE}/api/v1/knowledge/kn-1`);
  assert.equal(calls[3].method, "DELETE");
  assert.doesNotMatch(JSON.stringify({ created, deduped, fetched, deleted }), /kb-raw-1/);
});

test("document get on a missing document is classified as not_found", async () => {
  const client = new WeKnoraClient({ baseUrl: BASE, fetchImpl: (async () => jsonResponse({ success: false, error: { code: 1003, message: "not found" } }, { status: 404 })) as typeof fetch });
  await assert.rejects(() => client.getDocument("missing"), (error: unknown) => error instanceof WeKnoraError && error.code === "not_found" && error.status === 404);
});

test("document-result budgets preserve distinct sources after many same-source chunks", async () => {
  const rows = [
    ...Array.from({ length: 180 }, (_, i) => ({ id: "a" + i, knowledge_id: "doc-a", content: "Source A " + i, score: 1 - i / 1000, chunk_type: "text" })),
    { id: "b", knowledge_id: "doc-b", content: "Source B", score: 0.7, chunk_type: "text" },
  ];
  const client = new WeKnoraClient({ baseUrl: BASE, fetchImpl: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return jsonResponse({ success: true, data: rows.slice(0, request.match_count) });
  } });
  const sources = await client.search({ query: "configuration", knowledgeIds: ["doc-a", "doc-b"], limit: 2, distinctDocuments: true });
  assert.deepEqual(sources.references.map(ref => [ref.documentId, ref.chunkId, ref.snippet, ref.score]),
    [["doc-a", "a0", "Source A 0", 1], ["doc-b", "b", "Source B", 0.7]]);
  const chunks = await client.search({ query: "configuration", knowledgeIds: ["doc-a", "doc-b"], limit: 2 });
  assert.deepEqual(chunks.references.map(ref => ref.chunkId), ["a0", "a1"]);
});
