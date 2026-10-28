import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function readRpc(response: Response): Promise<any> {
  const raw = await response.text();
  const data = raw.split(/\r?\n/).find(line => line.startsWith("data:"));
  return JSON.parse(data ? data.slice(5).trim() : raw);
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("real MCP outer audit does not persist rejected Work Session input and the handler still receives originals", async () => {
  const root = mkdtempSync(join(tmpdir(), "work-session-audit-http-"));
  const port = await freePort();
  const stateRoot = join(root, "state");
  const appPath = join(root, "app.db");
  const knowledgePath = join(stateRoot, "knowledge.db");
  const appDb = new Database(appPath);
  appDb.exec("CREATE TABLE projects(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,description TEXT,workspace_path TEXT)");
  appDb.prepare("INSERT INTO projects VALUES(1,7,'audit-project','',?)").run(root);
  appDb.close();
  const secret = randomBytes(32).toString("hex");
  const token = jwt.sign({ id: 7, username: "audit-test" }, secret);
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, NODE_ENV: "test", JWT_SECRET: secret, MCP_PORT: String(port), DB_PATH: appPath, KNOWLEDGE_DB_PATH: knowledgePath, RELAY_STATE_ROOT: stateRoot, WORKSPACE_ROOT: root, KNOWLEDGE_CAPTURE_INTERVAL_MS: "60000", KNOWLEDGE_OUTBOX_PRUNE_INTERVAL_MS: "86400000", RELAY_MCP_SHUTDOWN_GRACE_MS: "250" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", chunk => { output += String(chunk); });
  child.stderr?.on("data", chunk => { output += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } }) });
    assert.equal(response.status, 200, output);
    return readRpc(response);
  };
  try {
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`MCP exited: ${output}`);
      try { ready = (await fetch(`${base}/mcp/health/ready`)).status === 200; } catch { /* startup */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, output);
    const objective = "approved-private-objective-marker";
    const intent = { actions: ["understand"], phase: "explore", objective, constraints: [], acceptanceCriteria: [], projectId: "1", environment: "nonprod", risk: "read_only", knowledgeMode: "capture" };
    const opened = await call("knowledge_work_session_open", { idempotencyKey: "audit-open", intent });
    assert.equal(opened.result?.isError, undefined, JSON.stringify(opened));
    const session = JSON.parse(opened.result.content[0].text).session;
    assert.equal(session.intent.objective, objective);
    const summary = "approved-private-summary-marker";
    const updated = await call("knowledge_work_session_update", { sessionId: session.id, idempotencyKey: "audit-accepted", patch: { summary } });
    assert.equal(updated.result?.isError, undefined, JSON.stringify(updated));
    assert.equal(JSON.parse(updated.result.content[0].text).session.summary, summary);

    const marker = "rejected-hidden-reasoning-privacy-marker";
    const patch = { hiddenReasoning: marker };
    const rejected = await call("knowledge_work_session_update", { sessionId: session.id, idempotencyKey: "audit-rejected", patch });
    assert.equal(rejected.result?.isError, true, JSON.stringify(rejected));
    assert.match(rejected.result.content[0].text, /sensitive fields and hidden reasoning are never persisted/);
    const result = { acceptanceResults: { hiddenReasoning: marker } };
    const rejectedClose = await call("knowledge_work_session_close", { sessionId: session.id, result });
    assert.equal(rejectedClose.result?.isError, true, JSON.stringify(rejectedClose));
    assert.match(rejectedClose.result.content[0].text, /sensitive fields and hidden reasoning are never persisted/);

    const knowledgeDb = new Database(knowledgePath, { readonly: true });
    try {
      const row = knowledgeDb.prepare("SELECT intent_json,summary,status FROM knowledge_work_sessions WHERE id=?").get(session.id) as { intent_json: string; summary: string; status: string };
      assert.equal(JSON.parse(row.intent_json).objective, objective);
      assert.equal(row.summary, summary);
      assert.equal(row.status, "active");
      assert.equal(JSON.stringify(knowledgeDb.prepare("SELECT * FROM knowledge_work_sessions").all()).includes(marker), false);
      assert.equal(JSON.stringify(knowledgeDb.prepare("SELECT * FROM knowledge_audit").all()).includes(marker), false);
    } finally { knowledgeDb.close(); }
    assert.equal(output.includes(marker), false);
    const auditText = readFileSync(join(stateRoot, "audit.jsonl"), "utf8");
    assert.equal(auditText.includes(marker), false, "rejected reasoning must not enter the pre-handler outer audit");
    assert.equal(auditText.includes(objective), false, "accepted objective text is not audit metadata");
    assert.equal(auditText.includes(summary), false, "accepted summary text is not audit metadata");
    const audit = auditText.trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(row => row.event === "tool_called");
    assert.equal(audit.length, 4);
    assert.equal(audit[0].arguments.intentHash, digest(intent));
    assert.equal(audit[2].arguments.patchHash, digest(patch));
    assert.equal(audit[3].arguments.resultHash, digest(result));
    assert.equal(audit[2].arguments.sessionId, session.id);
    assert.equal(audit[2].arguments.patch, undefined);
  } finally {
    await stop(child);
    const resolvedRoot = join(tmpdir(), root.slice(tmpdir().length));
    assert.equal(resolvedRoot, root);
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
