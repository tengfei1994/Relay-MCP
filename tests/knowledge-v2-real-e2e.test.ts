import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

process.env.NODE_ENV ??= "test";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePort, reject) => server.listen(0, "127.0.0.1", () => resolvePort()).once("error", reject));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolvePort, reject) => server.close(error => error ? reject(error) : resolvePort()));
  return port;
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Synthetic acceptance server exited before becoming ready");
    try { if ((await fetch(url)).ok) return; } catch { /* Still starting. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error("Synthetic acceptance server did not become ready");
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([exited.then(() => true), new Promise<false>(resolveWait => { timeout = setTimeout(() => resolveWait(false), 3000); })]);
  if (timeout) clearTimeout(timeout);
  if (stopped) return;
  child.kill("SIGKILL");
  await exited;
}

test("real isolated Web and MCP servers enforce the Memory review and withdrawal flow", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-memory-e2e-"));
  const webPort = await freePort();
  let mcpPort = await freePort();
  while (mcpPort === webPort) mcpPort = await freePort();
  const web = `http://127.0.0.1:${webPort}`, mcp = `http://127.0.0.1:${mcpPort}`;
  const env = { ...process.env, NODE_ENV: "test", PORT: String(webPort), MCP_PORT: String(mcpPort), JWT_SECRET: "synthetic-local-e2e-secret-not-used-elsewhere", DB_PATH: join(root, "app.db"), KNOWLEDGE_DB_PATH: join(root, "knowledge.db"), RELAY_STATE_ROOT: join(root, "state"), WORKSPACE_ROOT: join(root, "workspace"), RELAY_PUBLIC_URL: web };
  let webProcess: ChildProcess | undefined, mcpProcess: ChildProcess | undefined;
  try {
    webProcess = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], { env, stdio: "ignore" });
    await waitForServer(`${web}/api/health`, webProcess);
    const request = async (url: string, options: RequestInit = {}) => {
      const response = await fetch(url, options);
      const body = await response.json() as any;
      assert.ok(response.ok, `${response.status} from ${new URL(url).pathname}`);
      return body;
    };
    const admin = await request(`${web}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "fixture-admin", password: "fixture-password" }) });
    assert.equal(admin.status, "active");
    const headers = { authorization: `Bearer ${admin.token}`, "content-type": "application/json" };
    await request(`${web}/api/users/${admin.user.id}/knowledge`, { method: "PATCH", headers, body: JSON.stringify({ knowledgeEnabled: true }) });
    const token = await request(`${web}/api/tokens`, { method: "POST", headers, body: JSON.stringify({ name: "Synthetic acceptance", projectIds: [], serverIds: [] }) });
    mcpProcess = spawn(process.execPath, ["--import", "tsx", "src/mcp/index.ts"], { env, stdio: "ignore" });
    await waitForServer(`${mcp}/mcp/health/live`, mcpProcess);
    let id = 0;
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${mcp}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token.token}`, "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
      const raw = await response.text();
      const data = (response.headers.get("content-type") ?? "").includes("text/event-stream") ? raw.split(/\r?\n/).find(line => line.startsWith("data:"))?.slice(5).trim() : raw;
      if (!data) throw new Error("MCP returned no response");
      const parsed = JSON.parse(data);
      if (!response.ok || parsed.error || parsed.result?.isError) throw new Error(`MCP ${name} was rejected`);
      return JSON.parse(parsed.result.content.map((item: { text?: string }) => item.text ?? "").join("\n"));
    };
    const query = "synthetic-acceptance-experience";
    for (let i = 0; i < 3; i++) assert.equal((await rpc("memory_search", { scope: "general", query })).results.length, 0);
    assert.equal((await request(`${web}/api/knowledge/memory-submissions`, { headers })).submissions.length, 0, "ordinary calls do not create review candidates");
    const input = { action: "submit", idempotencyKey: "synthetic-e2e", requestedScope: "general", title: query, memoryType: "Fact", statement: "Reconnect after a synthetic reset.", objective: "Exercise the review flow.", outcome: "The synthetic connection recovered.", unknowns: ["No external evidence is attached."] };
    const first = await rpc("memory_capture", input), duplicate = await rpc("memory_capture", input);
    assert.equal(first.submission.id, duplicate.submission.id);
    assert.equal(first.submission.status, "pending");
    assert.equal((await rpc("memory_search", { scope: "general", query })).results.length, 0, "pending submissions remain unsearchable");
    const reviewed = await request(`${web}/api/knowledge/memory-submissions/${encodeURIComponent(first.submission.id)}/review`, { method: "POST", headers, body: JSON.stringify({ action: "approve", scope: "general", reason: "Synthetic local acceptance review" }) });
    assert.equal(reviewed.submission.status, "approved");
    const found = await rpc("memory_search", { scope: "general", query });
    assert.equal(found.results.length, 1);
    assert.equal((await rpc("knowledge_confirmed_memory_get", { memoryId: found.results[0].id })).memory.id, found.results[0].id);
    await request(`${web}/api/users/${admin.user.id}/knowledge`, { method: "PATCH", headers, body: JSON.stringify({ knowledgeEnabled: false }) });
    await assert.rejects(() => rpc("memory_search", { scope: "general", query }));
    await request(`${web}/api/users/${admin.user.id}/knowledge`, { method: "PATCH", headers, body: JSON.stringify({ knowledgeEnabled: true }) });
    assert.equal((await rpc("memory_search", { scope: "general", query })).results.length, 1);
    await request(`${web}/api/tokens/${token.profile.id}`, { method: "DELETE", headers });
    await assert.rejects(() => rpc("memory_search", { scope: "general", query }));
  } finally {
    await stop(mcpProcess);
    await stop(webProcess);
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  }
});
