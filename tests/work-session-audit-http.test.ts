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

test("real MCP capture audit protects accepted and rejected candidate content", async () => {
  const root = mkdtempSync(join(tmpdir(), "work-session-audit-http-"));
  const port = await freePort();
  const stateRoot = join(root, "state");
  const appPath = join(root, "app.db");
  const knowledgePath = join(stateRoot, "knowledge.db");
  const appDb = new Database(appPath);
  appDb.exec("CREATE TABLE projects(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,description TEXT,workspace_path TEXT); CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,is_admin INTEGER,knowledge_enabled INTEGER,account_status TEXT DEFAULT 'active'); INSERT INTO users VALUES(7,'audit-test',0,1,'active')");
  appDb.prepare("INSERT INTO projects VALUES(1,7,'audit-project','',?)").run(root);
  appDb.exec("CREATE TABLE mcp_tokens(id INTEGER PRIMARY KEY,user_id INTEGER,token_id TEXT,project_id INTEGER,project_server_id INTEGER,environment TEXT,allow_all_projects INTEGER,can_create_projects INTEGER,default_server_id INTEGER,active INTEGER,last_used_at TEXT); INSERT INTO mcp_tokens VALUES(1,7,'audit-token',NULL,NULL,'test',0,0,NULL,1,NULL); CREATE TABLE mcp_token_project_scopes(id INTEGER PRIMARY KEY,token_id INTEGER,project_id INTEGER); CREATE TABLE mcp_token_server_scopes(id INTEGER PRIMARY KEY,token_id INTEGER,server_id INTEGER)");
  appDb.close();
  const secret = randomBytes(32).toString("hex");
  const token = jwt.sign({ id: 7, username: "audit-test", tokenKind: "mcp", tokenId: "audit-token" }, secret);
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
    const summary = "approved-private-summary-marker";
    const input = { action:"submit", idempotencyKey:"audit-capture", requestedScope:"general", title:"Reviewed experience", memoryType:"Fact", statement:summary, objective };
    const accepted=await call("memory_capture",input);
    assert.equal(accepted.result?.isError,undefined,JSON.stringify(accepted));
    const id=JSON.parse(accepted.result.content[0].text).submission.id;
    const status=await call("memory_capture",{action:"status",id});
    assert.equal(JSON.parse(status.result.content[0].text).submission.status,"pending");
    const marker="rejected-secret-privacy-marker";
    const rejected=await call("memory_capture",{...input,idempotencyKey:"audit-rejected",statement:"password: "+marker});
    assert.equal(rejected.result?.isError,true,JSON.stringify(rejected));
    const removed=await call("knowledge_work_session_open",{intent:{hiddenReasoning:marker}});
    assert.equal(removed.result?.isError,true);
    const knowledgeDb=new Database(knowledgePath,{readonly:true});
    try {
      const rows=knowledgeDb.prepare("SELECT * FROM knowledge_memory_submissions").all();
      assert.equal(rows.length,1);assert.equal(JSON.stringify(rows).includes(marker),false);
      assert.equal(JSON.stringify(knowledgeDb.prepare("SELECT * FROM knowledge_audit").all()).includes(marker),false);
    } finally {knowledgeDb.close();}
    assert.equal(output.includes(marker),false);
    const auditText=readFileSync(join(stateRoot,"audit.jsonl"),"utf8");
    assert.equal(auditText.includes(marker),false);assert.equal(auditText.includes(objective),false);assert.equal(auditText.includes(summary),false);
    const audit=auditText.trim().split(/\r?\n/).map(line=>JSON.parse(line)).filter(row=>row.event==="tool_called"&&row.tool==="memory_capture");
    assert.equal(audit.length,3);
    assert.ok(audit.every(row=>!JSON.stringify(row.arguments).includes("private-")));

  } finally {
    await stop(child);
    const resolvedRoot = join(tmpdir(), root.slice(tmpdir().length));
    assert.equal(resolvedRoot, root);
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
