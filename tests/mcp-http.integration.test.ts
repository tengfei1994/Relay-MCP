import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`MCP server exited before becoming ready: ${output()}`);
    try {
      const response = await fetch(`${url}/mcp/health/live`);
      if (response.status === 200) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`MCP server did not become healthy: ${lastError}\n${output()}`);
}

async function readRpc(response: Response): Promise<any> {
  const raw = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const data = raw.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!data) throw new Error(`MCP response did not contain an SSE data event: ${raw}`);
    return JSON.parse(data.slice("data:".length).trim());
  }
  return JSON.parse(raw);
}

async function stop(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  child.kill("SIGTERM");
  const exitCode = await Promise.race([
    once(child, "exit").then(([code]) => code as number | null),
    new Promise<undefined>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (exitCode !== undefined) return exitCode;
  child.kill("SIGKILL");
  const [code] = await once(child, "exit");
  return code as number | null;
}

function seedPermissionDatabase(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      workspace_path TEXT NOT NULL
    );
    CREATE TABLE servers (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER DEFAULT 22,
      ssh_user TEXT NOT NULL,
      private_key_path TEXT NOT NULL,
      public_key TEXT NOT NULL,
      connection_mode TEXT DEFAULT 'ssh',
      agent_id TEXT,
      os TEXT DEFAULT 'linux',
      status TEXT DEFAULT 'connected'
    );
    CREATE TABLE lims_instances (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      version TEXT DEFAULT '',
      runtime_kind TEXT DEFAULT 'unknown',
      root_path TEXT NOT NULL,
      exe_path TEXT NOT NULL,
      forms_path TEXT NOT NULL,
      forms_bin_path TEXT NOT NULL,
      solution_assemblies_path TEXT NOT NULL,
      logfile_path TEXT NOT NULL,
      data_path TEXT NOT NULL,
      database_host TEXT DEFAULT '',
      database_name TEXT DEFAULT '',
      database_auth_type TEXT DEFAULT 'unknown',
      services_json TEXT DEFAULT '[]',
      build_profile_json TEXT DEFAULT '{}'
    );
    CREATE TABLE project_servers (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      server_id INTEGER NOT NULL,
      remote_path TEXT NOT NULL,
      environment TEXT DEFAULT 'production',
      connection_mode TEXT DEFAULT 'ssh',
      lims_instance_id INTEGER
    );
    CREATE TABLE mcp_tokens (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      project_id INTEGER,
      project_server_id INTEGER,
      default_server_id INTEGER,
      environment TEXT DEFAULT 'production',
      allow_all_projects INTEGER DEFAULT 0,
      can_create_projects INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      last_used_at TEXT
    );
    CREATE TABLE mcp_token_project_scopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL
    );
    CREATE TABLE mcp_token_server_scopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id INTEGER NOT NULL,
      server_id INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)").run(7, "scoped", "unused", 0);
  db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)").run(8, "other", "unused", 0);
  db.prepare("INSERT INTO projects (id, user_id, name, description, workspace_path) VALUES (?, ?, ?, ?, ?)").run(101, 7, "allowed-project", "", "workspace/scoped/allowed-project");
  db.prepare("INSERT INTO projects (id, user_id, name, description, workspace_path) VALUES (?, ?, ?, ?, ?)").run(102, 7, "forbidden-project", "", "workspace/scoped/forbidden-project");
  const insertServer = db.prepare("INSERT INTO servers (id, user_id, name, host, port, ssh_user, private_key_path, public_key, connection_mode, os, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insertServer.run(201, 7, "allowed-server", "allowed.example", 22, "relay", "key", "ssh-ed25519 allowed", "ssh", "linux", "connected");
  insertServer.run(202, 7, "forbidden-server", "forbidden.example", 22, "relay", "key", "ssh-ed25519 forbidden", "ssh", "linux", "connected");
  const insertLink = db.prepare("INSERT INTO project_servers (id, project_id, server_id, remote_path, environment, connection_mode) VALUES (?, ?, ?, ?, ?, ?)");
  insertLink.run(301, 101, 201, "/srv/allowed", "production", "ssh");
  insertLink.run(302, 101, 202, "/srv/forbidden", "staging", "ssh");
  insertLink.run(303, 102, 201, "/srv/other-project", "production", "ssh");
  db.prepare("INSERT INTO mcp_tokens (id, user_id, token_id, name, project_id, project_server_id, default_server_id, environment, allow_all_projects, can_create_projects, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(1, 7, "scope-token", "scope", 101, 301, 201, "production", 0, 0, 1);
  db.prepare("INSERT INTO mcp_tokens (id, user_id, token_id, name, environment, allow_all_projects, can_create_projects, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(2, 8, "other-token", "other", "production", 1, 0, 1);
  db.prepare("INSERT INTO mcp_token_project_scopes (token_id, project_id) VALUES (?, ?)").run(1, 101);
  db.prepare("INSERT INTO mcp_token_server_scopes (token_id, server_id) VALUES (?, ?)").run(1, 201);
  db.close();
}

async function callMcpTool(base: string, token: string, id: number, name: string, args: Record<string, unknown> = {}): Promise<{ response: Response; rpc: any }> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  return { response, rpc: await readRpc(response) };
}

function rpcText(rpc: any): string {
  return rpc?.result?.content?.map((item: { text?: string }) => item.text ?? "").join("\n") ?? "";
}

test("real MCP HTTP server enforces auth and serves tools/list, tools/call, and readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-mcp-http-"));
  const port = await freePort();
  const secret = "integration-secret-that-is-at-least-32-characters";
  const token = jwt.sign({ id: 7, username: "integration" }, secret);
  const appDbPath = join(root, "app.db");
  // Run the MCP entry point in this process, not through the tsx CLI wrapper.
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: "test",
      JWT_SECRET: secret,
      MCP_PORT: String(port),
      DB_PATH: appDbPath,
      WORKSPACE_ROOT: root,
      RELAY_STATE_ROOT: join(root, "state"),
      RELAY_MCP_VERSION: "0.6.3",
      KNOWLEDGE_CAPTURE_INTERVAL_MS: "60000",
      KNOWLEDGE_OUTBOX_PRUNE_INTERVAL_MS: "86400000",
      RELAY_MCP_ALLOW_QUERY_TOKEN: "false",
      RELAY_MCP_SHUTDOWN_GRACE_MS: "250",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stopped = false;
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const base = `http://127.0.0.1:${port}`;

  try {
    await waitForHealth(base, child, () => output);

    const live = await fetch(`${base}/mcp/health/live`);
    assert.equal(live.status, 200);
    const health = await fetch(`${base}/mcp/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(
      ((await health.json()) as Record<string, unknown>),
      {
        ok: true,
        route: "relay_mcp",
        namespace: "relay_",
        version: "0.6.3",
        transport: "streamable-http",
        mcpPort: port,
        knowledge: { available: true, status: "available" },
      },
      "legacy health identity fields must remain stable while Knowledge status is additive",
    );
    const ready = await fetch(`${base}/mcp/health/ready`);
    assert.equal(ready.status, 200, output);
    assert.equal((await ready.json()).ok, true);
    assert.equal(existsSync(join(root, "state", "knowledge.db")), true, "the default Knowledge DB is anchored under RELAY_STATE_ROOT");

    const unauthorized = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(unauthorized.status, 401);
    const invalidToken = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer definitely-not-a-valid-jwt",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/list", params: {} }),
    });
    assert.equal(invalidToken.status, 401, "an invalid MCP token must be rejected by the HTTP authentication boundary");
    const malformed = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error?.code, -32700);
    const queryUnauthorized = await fetch(`${base}/mcp?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }),
    });
    assert.equal(queryUnauthorized.status, 401, "query-token authentication remains disabled by default");

    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2025-06-18",
    };
    const listedResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(listedResponse.status, 200, output);
    const listed = await readRpc(listedResponse);
    assert.ok(Array.isArray(listed.result?.tools));
    assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === "relay_mcp_info"));

    const calledResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "relay_mcp_info", arguments: {} } }),
    });
    assert.equal(calledResponse.status, 200, output);
    const called = await readRpc(calledResponse);
    assert.equal(called.result?.isError, undefined);
    assert.match(called.result?.content?.[0]?.text ?? "", /relay_mcp/);
    assert.match(
      readFileSync(join(root, "state", "audit.jsonl"), "utf8"),
      /"event":"tool_called".*"tool":"relay_mcp_info"/,
      "real tools/call requests are auditable",
    );

    const parallelResponses = await Promise.all(
      Array.from({ length: 12 }, (_, offset) => fetch(`${base}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 100 + offset, method: "tools/list", params: {} }),
      })),
    );
    for (const response of parallelResponses) {
      assert.equal(response.status, 200, output);
      assert.ok(Array.isArray((await readRpc(response)).result?.tools));
    }

    const exitCode = await stop(child);
    stopped = true;
    // Windows implements child.kill("SIGTERM") as forced process termination,
    // so the Node signal callback cannot run there. POSIX runs verify the
    // graceful handler; every platform still verifies the DB can be reopened.
    if (process.platform !== "win32") {
      assert.equal(exitCode, 0, `MCP process did not shut down gracefully: ${output}`);
      assert.doesNotMatch(output, /\[relay-mcp\] forced shutdown after/, "completed requests, including rejected auth requests, must not force shutdown");
    }
    // The process-level registry must release its app.db handle during the
    // shutdown sequence; this reopen catches leaked Windows file locks.
    const reopened = new Database(appDbPath);
    reopened.close();
  } finally {
    if (!stopped) await stop(child);
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("real MCP HTTP handlers enforce project, server, project-create, and Job ownership permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-mcp-permissions-"));
  const stateRoot = join(root, "state");
  const appDbPath = join(root, "app.db");
  const port = await freePort();
  const secret = "integration-secret-that-is-at-least-32-characters";
  seedPermissionDatabase(appDbPath);
  mkdirSync(join(stateRoot, "jobs"), { recursive: true });
  writeFileSync(join(stateRoot, "jobs", "owned-job.json"), JSON.stringify({
    id: "owned-job",
    userId: 7,
    username: "scoped",
    project: "allowed-project",
    kind: "test",
    status: "succeeded",
    phase: "completed",
    input: {},
    startedAt: "2026-09-03T00:00:00.000Z",
    finishedAt: "2026-09-03T00:00:01.000Z",
    logs: [],
  }), "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: "test",
      JWT_SECRET: secret,
      MCP_PORT: String(port),
      DB_PATH: appDbPath,
      WORKSPACE_ROOT: root,
      RELAY_STATE_ROOT: stateRoot,
      KNOWLEDGE_CAPTURE_INTERVAL_MS: "60000",
      KNOWLEDGE_OUTBOX_PRUNE_INTERVAL_MS: "86400000",
      RELAY_MCP_SHUTDOWN_GRACE_MS: "250",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  const scopedToken = jwt.sign({ id: 7, username: "scoped", tokenId: "scope-token" }, secret);
  const otherUserToken = jwt.sign({ id: 8, username: "other", tokenId: "other-token" }, secret);

  try {
    await waitForHealth(base, child, () => output);

    const projectDenied = await callMcpTool(base, scopedToken, 20, "project_server_links_list", { project: "forbidden-project" });
    assert.equal(projectDenied.response.status, 200, output);
    assert.equal(projectDenied.rpc.result?.isError, true, "a project outside the token scope must be rejected by the real tool handler");
    assert.match(rpcText(projectDenied.rpc), /not allowed for this MCP token/i);

    const serverDenied = await callMcpTool(base, scopedToken, 21, "relay_route_check", { project: "allowed-project", serverId: 202 });
    assert.equal(serverDenied.response.status, 200, output);
    assert.match(rpcText(serverDenied.rpc), /not allowed for this MCP token/i, "a linked server outside the token scope must be rejected");

    const createDenied = await callMcpTool(base, scopedToken, 22, "project_create", { name: "should-not-be-created" });
    assert.equal(createDenied.response.status, 200, output);
    assert.equal(createDenied.rpc.result?.isError, true, "project_create must enforce canCreateProjects");
    assert.match(rpcText(createDenied.rpc), /not allowed to create projects/i);
    const verifyDb = new Database(appDbPath, { readonly: true });
    assert.equal(verifyDb.prepare("SELECT COUNT(*) AS count FROM projects WHERE name = 'should-not-be-created'").get()?.count, 0);
    verifyDb.close();

    const ownerCanRead = await callMcpTool(base, scopedToken, 23, "job_status", { jobId: "owned-job" });
    assert.equal(ownerCanRead.response.status, 200, output);
    assert.notEqual(ownerCanRead.rpc.result?.isError, true, "the owning user may read its Job");
    assert.match(rpcText(ownerCanRead.rpc), /owned-job/);

    const nonOwnerDenied = await callMcpTool(base, otherUserToken, 24, "job_status", { jobId: "owned-job" });
    assert.equal(nonOwnerDenied.response.status, 200, output);
    assert.equal(nonOwnerDenied.rpc.result?.isError, true, "a different user must not read another user's Job");
    assert.match(rpcText(nonOwnerDenied.rpc), /not found/i);
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("MCP request failures return JSON-RPC errors and do not wedge the HTTP process", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-mcp-http-failure-"));
  const appDbDirectory = join(root, "app-db-directory");
  mkdirSync(appDbDirectory, { recursive: true });
  const port = await freePort();
  const secret = "integration-secret-that-is-at-least-32-characters";
  const token = jwt.sign({ id: 7, username: "integration" }, secret);
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: "test",
      JWT_SECRET: secret,
      MCP_PORT: String(port),
      DB_PATH: appDbDirectory,
      WORKSPACE_ROOT: root,
      RELAY_STATE_ROOT: join(root, "state"),
      KNOWLEDGE_CAPTURE_INTERVAL_MS: "60000",
      KNOWLEDGE_OUTBOX_PRUNE_INTERVAL_MS: "86400000",
      RELAY_MCP_SHUTDOWN_GRACE_MS: "250",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(base, child, () => output);
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
    });
    assert.equal(response.status, 500, output);
    const error = await response.json() as { jsonrpc?: string; id?: unknown; error?: { code?: number; message?: string } };
    assert.equal(error.jsonrpc, "2.0");
    assert.equal(error.id, 7);
    assert.equal(error.error?.code, -32603);
    assert.equal(error.error?.message, "Internal server error");
    assert.equal((await fetch(`${base}/mcp/health/live`)).status, 200, "one failed request must not wedge the process");
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("real MCP HTTP server supports legacy query-token auth after explicit opt-in", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-mcp-query-token-"));
  const port = await freePort();
  const secret = "integration-secret-that-is-at-least-32-characters";
  const token = jwt.sign({ id: 7, username: "integration" }, secret);
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: "test",
      JWT_SECRET: secret,
      MCP_PORT: String(port),
      DB_PATH: join(root, "app.db"),
      WORKSPACE_ROOT: root,
      RELAY_STATE_ROOT: join(root, "state"),
      KNOWLEDGE_CAPTURE_INTERVAL_MS: "60000",
      KNOWLEDGE_OUTBOX_PRUNE_INTERVAL_MS: "86400000",
      RELAY_MCP_ALLOW_QUERY_TOKEN: "true",
      RELAY_MCP_SHUTDOWN_GRACE_MS: "250",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(base, child, () => output);
    const response = await fetch(`${base}/mcp?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} }),
    });
    assert.equal(response.status, 200, output);
    const result = await readRpc(response);
    assert.ok(Array.isArray(result.result?.tools));
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("MCP startup rejects Knowledge and app DB aliases before migration", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-mcp-db-boundary-"));
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const appPath = join(root, "app.db");
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/index.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      JWT_SECRET: "integration-secret-that-is-at-least-32-characters",
      MCP_PORT: "0",
      DB_PATH: appPath,
      KNOWLEDGE_DB_PATH: join(root, ".", "app.db"),
      WORKSPACE_ROOT: root,
      RELAY_STATE_ROOT: join(root, "state"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  try {
    const result = await Promise.race([
      once(child, "exit").then(([code]) => ({ code })),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`boundary test timed out\n${output}`)), 5_000);
        timer.unref?.();
      }),
    ]);
    assert.notEqual(result.code, 0);
    assert.match(output, /must point to different files/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
