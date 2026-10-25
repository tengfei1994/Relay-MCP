import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WeKnoraClient, WeKnoraError } from "../src/knowledge/weknora.ts";
import { WeKnoraClientDocumentWriter, WeKnoraIngestor } from "../src/knowledge/weknora-ingest.ts";
import { createKnowledgeStore } from "../src/knowledge/store.ts";

const baseUrl = "https://engine.example.test";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const chunk = (id: string, seq = 0, knowledgeId = "doc-1") => ({ id, knowledge_id: knowledgeId, content: `Body ${id}`, seq, chunk_type: "text", is_enabled: true, index_status: "ready", source_locators: [{ type: "text", start: 0, end: 10 }] });
const uploadedDocument = (init?: RequestInit) => {
  const form = init?.body as FormData;
  return { id: "doc-1", parse_status: "pending", knowledge_base_id: "kb", channel: form.get("channel"), metadata: JSON.parse(String(form.get("metadata") ?? "{}")) };
};

// These are HTTP contract fixtures, not evidence of a running upstream engine.
test("document scope cannot be broadened by the upstream KB/document union semantics", async () => {
  let body: Record<string, unknown> = {};
  const client = new WeKnoraClient({ baseUrl, fetchImpl: async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return json({ success: true, data: [
      { id: "c1", knowledge_id: "allowed", content: "visible" },
      { id: "c2", knowledge_id: "foreign", content: "secret" },
    ] });
  } });
  const result = await client.search({ query: "x", knowledgeBaseIds: ["kb"], knowledgeIds: ["allowed"] });
  assert.equal(body.knowledge_base_id, undefined);
  assert.equal(body.knowledge_base_ids, undefined);
  assert.deepEqual(body.knowledge_ids, ["allowed"]);
  assert.deepEqual(result.references.map((r) => r.documentId), ["allowed"]);
});

test("an explicitly empty document scope performs no request", async () => {
  let calls = 0;
  const client = new WeKnoraClient({ baseUrl, fetchImpl: async () => { calls += 1; return json({ success: true, data: [] }); } });
  const result = await client.search({ query: "x", knowledgeBaseIds: ["kb"], knowledgeIds: [] });
  assert.deepEqual(result.references, []);
  assert.equal(calls, 0);
});

test("trusted Relay mapping hydrates missing metadata and overrides spoofed upstream scope", async () => {
  const client = new WeKnoraClient({ baseUrl, fetchImpl: async () => json({ success: true, data: [
    { id: "c1", knowledge_id: "d1", content: "body", metadata: { environment: "foreign", sourcePath: "spoof.md" }, source_locators: [{ type: "pdf", page: 2, quote: "body" }] },
    { id: "c2", knowledge_id: "d2", content: "foreign", metadata: { environment: "test" } },
  ] }) });
  const result = await client.search({ query: "x", knowledgeIds: ["d1", "d2"], filters: { environment: "test", projectId: "p1", productVersion: "21.3" }, documentMetadata: {
    d1: { environment: "test", projectId: "p1", version: "21.3", sourcePath: "C:/docs/guide.pdf", sourceSha256: "source-sha", title: "Guide" },
  } });
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].documentId, "d1");
  assert.equal(result.references[0].chunkId, "c1");
  assert.equal(result.references[0].environment, "test");
  assert.equal(result.references[0].projectId, "p1");
  assert.equal(result.references[0].sourceSha256, "source-sha");
  assert.equal(result.references[0].sourceLocator, "C:/docs/guide.pdf#page=2");
  assert.deepEqual(result.references[0].sourceLocators, [{ type: "pdf", page: 2, quote: "body" }]);
});

test("JWT mode is explicit and API keys resolve again on every request", async () => {
  let token = "first";
  const seen: Headers[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => { seen.push(new Headers(init?.headers)); return json({ success: true, data: { id: "d", parse_status: "completed" } }); };
  const keyClient = new WeKnoraClient({ baseUrl, secretResolver: async () => token, fetchImpl });
  await keyClient.getDocument("d"); token = "rotated"; await keyClient.getDocument("d");
  const jwtClient = new WeKnoraClient({ baseUrl, authMode: "jwt", secretResolver: async () => "session-token", fetchImpl });
  await jwtClient.getDocument("d");
  assert.equal(seen[0].get("X-API-Key"), "first");
  assert.equal(seen[1].get("X-API-Key"), "rotated");
  assert.equal(seen[2].get("Authorization"), "Bearer session-token");
  assert.equal(seen[2].get("X-API-Key"), null);
});

test("search rejects malformed success envelopes and non-upload conflicts", async () => {
  for (const response of [json({ success: true, data: {} }), json({ success: false, data: [] }), json({ data: [] }, 409)]) {
    const client = new WeKnoraClient({ baseUrl, fetchImpl: async () => response });
    await assert.rejects(client.search({ query: "x", knowledgeBaseIds: ["kb"] }), (e: unknown) => e instanceof WeKnoraError && ["invalid_response", "conflict"].includes(e.code));
  }
});

test("normalized Markdown uploads use a Markdown extension and string metadata", async () => {
  const client = new WeKnoraClient({ baseUrl, fetchImpl: async (_url, init) => {
    const form = init?.body as FormData;
    assert.equal(form.get("fileName"), "docs/guide.html.md");
    assert.equal((form.get("file") as File).name, "guide.html.md");
    assert.deepEqual(JSON.parse(String(form.get("metadata"))), { revision: "3", enabled: "true" });
    return json({ success: true, data: { id: "doc-1", parse_status: "pending" } });
  } });
  await client.upsertDocument({ knowledgeBaseId: "kb", title: "Guide", sourcePath: "docs/guide.html", content: "# Guide", metadata: { revision: 3, enabled: true } });
});

test("document reads paginate actual chunks and never mix another document", async () => {
  const client = new WeKnoraClient({ baseUrl, fetchImpl: async (url) => {
    const path = new URL(String(url));
    if (path.pathname.endsWith("/knowledge/doc-1")) return json({ success: true, data: { id: "doc-1", title: "Guide", parse_status: "completed" } });
    if (path.pathname.endsWith("/knowledge/doc-1/download")) return new Response("Complete original source", { headers: { "content-type": "application/octet-stream" } });
    if (path.pathname.endsWith("/chunks/by-id/c1")) return json({ success: true, data: chunk("c1") });
    const page = Number(path.searchParams.get("page"));
    assert.ok(path.pathname.endsWith("/chunks/doc-1"));
    return json({ success: true, data: [chunk(page === 1 ? "c1" : "c2", page - 1)], total: 2, page, page_size: 1 });
  } });
  const read = await client.readDocument("doc-1", { pageSize: 1 });
  assert.equal(read.documentId, "doc-1");
  assert.equal(read.content, "Complete original source");
  assert.deepEqual(read.chunks.map((c) => c.chunkId), ["c1", "c2"]);
  assert.equal((await client.getChunk("c1")).documentId, "doc-1");
  const foreign = new WeKnoraClient({ baseUrl, fetchImpl: async () => json({ success: true, data: [chunk("bad", 0, "foreign")], total: 1 }) });
  await assert.rejects(foreign.listDocumentChunks("doc-1"), /document/i);
});

test("readiness waits through pending and finalizing, and fails closed on terminal errors", async () => {
  const states = ["pending", "processing", "finalizing", "completed"];
  const client = new WeKnoraClient({ baseUrl, fetchImpl: async () => json({ success: true, data: { id: "doc-1", parse_status: states.shift() } }) });
  assert.equal((await client.waitForDocumentReady("doc-1", { timeoutMs: 1000, pollIntervalMs: 1 })).parseStatus, "completed");
  for (const state of ["failed", "cancelled", "deleting"]) {
    const failed = new WeKnoraClient({ baseUrl, fetchImpl: async () => json({ success: true, data: { id: "doc-1", parse_status: state, error_message: "private provider token" } }) });
    await assert.rejects(failed.waitForDocumentReady("doc-1", { timeoutMs: 100, pollIntervalMs: 1 }), (e: unknown) => e instanceof WeKnoraError && e.code === "parse_failed" && !e.message.includes("private provider token"));
  }
  const pending = new WeKnoraClient({ baseUrl, fetchImpl: async () => json({ success: true, data: { id: "doc-1", parse_status: "pending" } }) });
  await assert.rejects(pending.waitForDocumentReady("doc-1", { timeoutMs: 5, pollIntervalMs: 1 }), (e: unknown) => e instanceof WeKnoraError && e.code === "timeout");
});

test("real client writer verifies completed parse and chunk IDs before returning staging readiness", async () => {
  const paths: string[] = [];
  const client = new WeKnoraClient({ baseUrl, fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path.endsWith("/knowledge/file")) return json({ success: true, data: uploadedDocument(init) });
    if (path.endsWith("/knowledge/doc-1")) return json({ success: true, data: { id: "doc-1", parse_status: "completed" } });
    return json({ success: true, data: [chunk("c1")], total: 1 });
  } });
  const writer = new WeKnoraClientDocumentWriter(client, "kb", { readiness: { timeoutMs: 100, pollIntervalMs: 1 } });
  const result = await writer.upsertDocument({ idempotencyKey: "k", title: "Guide", content: "Body", normalizedContent: "Body", normalizedContentSha256: "sha", parserVersion: "v1" });
  assert.equal(result.parseStatus, "completed");
  assert.deepEqual(result.externalChunkIds, ["c1"]);
  assert.ok(paths.some((p) => p.includes("/chunks/")));
});

test("ingestion rejects unverified writers and legacy staged rows cannot publish", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weknora-readiness-"));
  const store = createKnowledgeStore({ dbPath: join(dir, "knowledge.db") });
  try {
    const input = { idempotencyKey: "unsafe", title: "Unsafe", content: "Body", parserVersion: "v1" };
    const ingestor = new WeKnoraIngestor(store, { upsertDocument: async () => ({ externalDocumentId: "d", externalChunkIds: ["c"] }) });
    await assert.rejects(ingestor.stage(input), /readiness|completed|verified/i);
    const row = store.db.prepare("SELECT id FROM knowledge_weknora_documents WHERE idempotency_key='unsafe'").get() as { id: string };
    store.db.prepare("UPDATE knowledge_weknora_documents SET status='staged' WHERE id=?").run(row.id);
    assert.throws(() => ingestor.publish(row.id, 7), /readiness|completed|verified/i);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("writer rejects completed parses without indexed text chunks", async () => {
  for (const chunks of [[], [{ ...chunk("c1"), index_status: "failed" }], [{ ...chunk("c1"), is_enabled: false }]]) {
    const client = new WeKnoraClient({ baseUrl, fetchImpl: async (url, init) => {
      if (String(url).endsWith("/knowledge/file")) return json({ success: true, data: uploadedDocument(init) });
      return String(url).includes("/chunks/") ? json({ success: true, data: chunks, total: chunks.length })
        : json({ success: true, data: { id: "doc-1", parse_status: "completed" } });
    } });
    const writer = new WeKnoraClientDocumentWriter(client, "kb");
    await assert.rejects(writer.upsertDocument({ idempotencyKey: "k", title: "Guide", content: "Body", normalizedContent: "Body", normalizedContentSha256: "sha", parserVersion: "v1" }), /chunks|indexed|ready/i);
  }
});

test("legacy filter aliases cannot expand an explicit authorization document list", async () => {
  let ids: unknown;
  const client = new WeKnoraClient({ baseUrl, fetchImpl: async (_url, init) => {
    ids = JSON.parse(String(init?.body)).knowledge_ids;
    return json({ success: true, data: [{ id: "c", knowledge_id: "foreign", content: "denied" }] });
  } });
  const result = await client.search({ query: "x", knowledgeIds: ["allowed"], filters: { knowledge_ids: "allowed,foreign" } });
  assert.deepEqual(ids, ["allowed"]);
  assert.deepEqual(result.references, []);
});

test("writer retains verified parent chunks used by upstream search expansion", async () => {
  const client = new WeKnoraClient({ baseUrl, fetchImpl: async (url, init) => {
    if (String(url).endsWith("/knowledge/file")) return json({ success: true, data: uploadedDocument(init) });
    return String(url).includes("/chunks/") ? json({ success: true, data: [chunk("text"), { ...chunk("parent", 1), chunk_type: "parent_text" }], total: 2 })
      : json({ success: true, data: { id: "doc-1", parse_status: "completed" } });
  } });
  const result = await new WeKnoraClientDocumentWriter(client, "kb").upsertDocument({ idempotencyKey: "k", title: "Guide", content: "Body", normalizedContent: "Body", normalizedContentSha256: "sha", parserVersion: "v1" });
  assert.deepEqual(result.externalChunkIds, ["text", "parent"]);
});


test("summary search hits resolve to verified original source chunks instead of generated excerpts",async()=>{
  const client=new WeKnoraClient({baseUrl,fetchImpl:async(url,init)=>{
    if(init?.method==="POST")return json({success:true,data:[{id:"generated-summary",knowledge_id:"doc-1",chunk_type:"summary",parent_chunk_id:"c1",content:"Generated summary must not be the source quotation",score:.8}]});
    assert.ok(String(url).endsWith("/chunks/by-id/c1"));
    return json({success:true,data:{...chunk("c1"),chunk_type:"text",is_enabled:true}});
  }});
  const result=await client.search({query:"guide",knowledgeIds:["doc-1"]});
  assert.equal(result.references[0].chunkId,"c1");assert.equal(result.references[0].snippet,"Body c1");assert.equal(result.references[0].matchReason,"summary_match_source_chunk");
});

test("summary search cannot redirect citations to a foreign or disabled source chunk",async()=>{
  for(const override of [{knowledge_id:"foreign"},{is_enabled:false}]){
    const client=new WeKnoraClient({baseUrl,fetchImpl:async(_url,init)=>init?.method==="POST"?json({success:true,data:[{id:"summary",knowledge_id:"doc-1",chunk_type:"summary",parent_chunk_id:"c1",content:"generated"}]}):json({success:true,data:{...chunk("c1"),chunk_type:"text",...override}})});
    await assert.rejects(client.search({query:"guide",knowledgeIds:["doc-1"]}),/source|summary|chunk/i);
  }
});
