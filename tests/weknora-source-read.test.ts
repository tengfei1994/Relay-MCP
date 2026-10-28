import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WeKnoraClient, WeKnoraError, type WeKnoraRequestTrace } from "../src/knowledge/weknora.ts";

const source = "# Canonical source\n\n<a id=\"table-anchor\"></a>\n\n<table><tr><th>Name</th><th>Value</th></tr>\n<tr><td>alpha</td><td>beta</td></tr></table>\n\n## Code\n\n```text\nfirst line\nsecond line\nthird line\n```\n\n### End\n";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
// Two overlap windows deliberately split both the table and the fenced code.
const chunks = [
  { id: "c1", knowledge_id: "doc-1", content: source.slice(0, 152), seq: 0, chunk_type: "text", is_enabled: true },
  { id: "c2", knowledge_id: "doc-1", content: source.slice(20, 206), seq: 1, chunk_type: "text", is_enabled: true },
  { id: "c3", knowledge_id: "doc-1", content: source.slice(170), seq: 2, chunk_type: "text", is_enabled: true },
];

async function fixture(run: (f: { client: WeKnoraClient; requests: string[]; traces: WeKnoraRequestTrace[]; setDownload: (status: number, body: string | Uint8Array, headers?: Record<string, string>) => void; redirected: () => number }) => Promise<void>) {
  let redirects = 0;
  const external = createServer((_req, res) => { redirects += 1; res.end("unexpected outbound content"); });
  await new Promise<void>(resolve => external.listen(0, "127.0.0.1", resolve));
  const externalUrl = `http://127.0.0.1:${(external.address() as AddressInfo).port}/private`;
  let download = { status: 200, body: source as string | Uint8Array, headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="../../untrusted.md"' } as Record<string, string> };
  const requests: string[] = [], traces: WeKnoraRequestTrace[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.headers["x-api-key"] !== "internal-test-key") { res.writeHead(401); res.end(); return; }
    if (req.url === "/api/v1/knowledge/doc-1/download") {
      res.writeHead(download.status, download.headers); res.end(download.body); return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v1/knowledge/doc-1") res.end(JSON.stringify({ success: true, data: { id: "doc-1", title: "Guide", parse_status: "completed", file_url: externalUrl, file_path: externalUrl, download_url: externalUrl } }));
    else if (req.url?.startsWith("/api/v1/chunks/doc-1?")) res.end(JSON.stringify({ success: true, data: chunks, total: chunks.length }));
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new WeKnoraClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secretResolver: async () => "internal-test-key", onTrace: trace => traces.push(trace) });
  try { await run({ client, requests, traces, setDownload: (status, body, headers = {}) => { download = { status, body, headers: { ...headers, ...(status >= 300 && status < 400 ? { location: externalUrl } : {}) } }; }, redirected: () => redirects }); }
  finally { server.closeAllConnections(); external.closeAllConnections(); await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => external.close(() => resolve()))]); }
}

test("real HTTP source read returns exact uploaded Markdown across overlapping table/code chunks", () => fixture(async ({ client, requests, traces, redirected }) => {
  const result = await client.readDocument("doc-1", { expectedNormalizedSha256: sha(source) });
  assert.equal(result.content, source);
  assert.equal(result.title, "Guide");
  assert.deepEqual(result.chunks.map(chunk => chunk.content), chunks.map(chunk => chunk.content));
  assert.equal((result.content.match(/<table>/g) ?? []).length, 1);
  assert.equal((result.content.match(/id="table-anchor"/g) ?? []).length, 1);
  assert.equal((result.content.match(/```/g) ?? []).length, 2);
  assert.ok(requests.includes("/api/v1/knowledge/doc-1/download"));
  assert.equal(redirected(), 0);
  assert.ok(!JSON.stringify(traces).includes(source));
  assert.ok(!JSON.stringify(traces).includes("internal-test-key"));
}));

test("source read keeps the optional options contract while never reconstructing chunks", () => fixture(async ({ client }) => {
  assert.equal((await client.readDocument("doc-1")).content, source);
}));

test("source download failures and partial responses fail closed without chunk fallback", async t => {
  for (const status of [401, 404, 500, 204, 206]) await t.test(String(status), () => fixture(async ({ client, setDownload }) => {
    setDownload(status, status === 204 ? "" : "private upstream error body");
    await assert.rejects(client.readDocument("doc-1", { expectedNormalizedSha256: sha(source) }), error => error instanceof WeKnoraError && !error.message.includes("private upstream"));
  }));
});

test("source download redirects never send the credential or issue an external request", async t => {
  for (const status of [301, 302, 307, 308]) await t.test(String(status), () => fixture(async ({ client, setDownload, redirected }) => {
    setDownload(status, "");
    await assert.rejects(client.readDocument("doc-1", { expectedNormalizedSha256: sha(source) }), error => error instanceof WeKnoraError && error.code === "invalid_response");
    assert.equal(redirected(), 0);
  }));
});

test("source download verifies original bytes before exposing any body", () => fixture(async ({ client, setDownload }) => {
  setDownload(200, source + "\nmodified");
  await assert.rejects(client.readDocument("doc-1", { expectedNormalizedSha256: sha(source) }), /hash|identity|integrity/i);
  await assert.rejects(client.readDocument("doc-1", { expectedNormalizedSha256: "invalid-hash" }), /hash|identity|integrity/i);
}));

test("source read rejects invalid UTF-8 even when its bytes match and preserves valid BOM/CRLF", () => fixture(async ({ client, setDownload }) => {
  const invalid = new Uint8Array([0xc3, 0x28]);
  setDownload(200, invalid);
  await assert.rejects(client.readDocument("doc-1", { expectedNormalizedSha256: sha(invalid) }), /UTF-8|encoding/i);
  const preserved = "\ufeff# Source\r\n\r\ncontent\r\n";
  setDownload(200, preserved);
  assert.equal((await client.readDocument("doc-1", { expectedNormalizedSha256: sha(preserved) })).content, preserved);
}));


test("source download retains the bounded response budget", () => fixture(async ({ client, setDownload }) => {
  setDownload(200, new Uint8Array(16 * 1024 * 1024 + 1));
  await assert.rejects(client.readDocument("doc-1"), /size limit/i);
}));

test("manual redirect policy and binary Accept apply only to source download", async () => {
  const observed: Array<{ path: string; init?: RequestInit }> = [];
  const client = new WeKnoraClient({ baseUrl: "https://internal.example.test", fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname; observed.push({ path, init });
    if (path.endsWith("/download")) return new Response(source);
    return new Response(JSON.stringify({ data: path.includes("/chunks/") ? chunks : { id: "doc-1", parse_status: "completed" }, total: chunks.length }));
  } });
  await client.readDocument("doc-1", { expectedNormalizedSha256: sha(source) });
  assert.equal(observed.length, 3);
  for (const request of observed) {
    const download = request.path.endsWith("/download");
    assert.equal(request.init?.redirect, download ? "manual" : undefined);
    assert.equal(new Headers(request.init?.headers).get("accept"), download ? "application/octet-stream" : "application/json");
  }
});
