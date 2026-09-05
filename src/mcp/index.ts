import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import { join } from "path";
import { registerToolsForUser, RELAY_MCP_VERSION, type McpUser } from "./register-tools.js";
import { closeSharedProjectRegistry } from "./project-registry.js";
import { writeAudit } from "../shared/job-store.js";
import { configureJobStore } from "../shared/job-store.js";
import { configureDeploymentStore } from "../shared/deployment-store.js";
import { createKnowledgeStore } from "../knowledge/store.js";
import { captureKnowledgeCandidates, ProjectResolutionUnavailableError } from "../knowledge/capture-worker.js";
import { drainRelayEventSpool, relayEventSpoolHealth } from "../knowledge/event-sink.js";
import { sanitizeAuditArguments } from "../shared/audit-sanitizer.js";
import { TOOL_CATALOG_BY_NAME } from "../shared/tool-catalog.js";
import { extractMcpToken, queryTokenAuthEnabled } from "./auth.js";
import { requireJwtSecret } from "../shared/auth-secret.js";
import { assertKnowledgeDbIsolated } from "../shared/canonical-path.js";
import { parseBoundedNumber } from "../shared/runtime-config.js";
import { createRequestActivity } from "./request-lifecycle.js";
import "dotenv/config";

const MCP_PORT = Number(process.env.MCP_PORT ?? 3001);
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const RELAY_STATE_ROOT = process.env.RELAY_STATE_ROOT ?? join(WORKSPACE_ROOT, ".relay-mcp");
const DB_PATH = process.env.DB_PATH ?? "./data/app.db";
// Keep the Knowledge Plane under the relay state root by default. This avoids
// accidentally applying Knowledge migrations to the operational app database.
const KNOWLEDGE_DB_PATH = process.env.KNOWLEDGE_DB_PATH ?? join(RELAY_STATE_ROOT, "knowledge.db");
const KNOWLEDGE_OUTBOX_RETENTION_MS = parseBoundedNumber(
  process.env.KNOWLEDGE_OUTBOX_RETENTION_MS,
  30 * 24 * 60 * 60 * 1000,
  60 * 60 * 1000,
  10 * 365 * 24 * 60 * 60 * 1000,
);
const MCP_SHUTDOWN_GRACE_MS = parseBoundedNumber(
  process.env.RELAY_MCP_SHUTDOWN_GRACE_MS,
  10_000,
  250,
  60_000,
);
// A path configuration error is fatal and must not be converted into a
// recoverable Knowledge outage.
assertKnowledgeDbIsolated(KNOWLEDGE_DB_PATH, DB_PATH);
// A known default secret lets anyone forge JWTs. Refuse it outside explicit
// development/test runs; ecosystem.config.cjs sets NODE_ENV=production.
const JWT_SECRET = requireJwtSecret("relay-mcp");
if (queryTokenAuthEnabled()) console.warn("[relay-mcp] legacy ?token= authentication is enabled; Authorization: Bearer is recommended and query-token support is a compatibility exception.");
function lookupStableProjectId(userId: number, projectName: string): number | undefined {
  let db: Database.Database | undefined;
  try {
    db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare("SELECT id FROM projects WHERE user_id = ? AND name = ?").get(userId, projectName) as { id?: number } | undefined;
    return row?.id;
  } finally {
    db?.close();
  }
}

// Operational producers stay failure-isolated when app.db is unavailable;
// their event snapshot still enters the relay spool for later capture.
const resolveStableProjectId = (userId: number, projectName: string): number | undefined => {
  try { return lookupStableProjectId(userId, projectName); }
  catch { return undefined; }
};

// Capture needs the unavailable distinction so it can use long exponential
// retry rather than the ordinary poison-event limit.
const resolveStableProjectIdForCapture = (userId: number, projectName: string): number | undefined => {
  try { return lookupStableProjectId(userId, projectName); }
  catch (error) { throw new ProjectResolutionUnavailableError("project resolver unavailable", { cause: error }); }
};
let knowledgeStatus: { available: boolean; error?: string } = { available: false, error: "not initialized" };
let knowledge: ReturnType<typeof createKnowledgeStore> | undefined;
let captureRunning = false;
let captureConsecutiveFailures = 0;
let captureLastSuccessAt: string | undefined;
let captureLastError: string | undefined;
let captureLastErrorAt: string | undefined;

function recordCaptureFailure(error: unknown): void {
  captureConsecutiveFailures += 1;
  captureLastError = error instanceof Error ? error.message : String(error);
  captureLastErrorAt = new Date().toISOString();
}
function attemptKnowledgeRecovery(): void {
  if (knowledge) {
    try { knowledge.db.prepare("SELECT 1").get(); drainRelayEventSpool(knowledge); knowledgeStatus = { available: true }; return; }
    catch (error) { try { knowledge.close(); } catch { /* ignore */ } knowledge = undefined; knowledgeStatus = { available: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  try {
    knowledge = createKnowledgeStore({ dbPath: KNOWLEDGE_DB_PATH, appDbPath: DB_PATH, casebookRoot: process.env.KNOWLEDGE_CASEBOOK_ROOT, evidenceRoot: process.env.KNOWLEDGE_EVIDENCE_ROOT });
    configureJobStore({ eventSink: knowledge, resolveProjectId: resolveStableProjectId });
    configureDeploymentStore({ eventSink: knowledge, resolveProjectId: resolveStableProjectId });
    drainRelayEventSpool(knowledge);
    knowledgeStatus = { available: true };
  } catch (error) {
    knowledge = undefined;
    configureJobStore({ resolveProjectId: resolveStableProjectId }); configureDeploymentStore({ resolveProjectId: resolveStableProjectId });
    knowledgeStatus = { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}
attemptKnowledgeRecovery();
const recoveryTimer = setInterval(attemptKnowledgeRecovery, 10000);
recoveryTimer.unref?.();

// The capture consumer is part of the production composition root. Events are
// first persisted to the domain/outbox tables, then periodically claimed and
// materialized into candidate documents with lease/ownership semantics.
const captureTimer = setInterval(() => {
  if (!knowledge || captureRunning) return;
  try { knowledge.heartbeatConsumer("knowledge-capture"); } catch (error) { recordCaptureFailure(error); }
  captureRunning = true;
  let failureReported = false;
  void captureKnowledgeCandidates(knowledge, "knowledge-capture", 20, (actorId, projectName) => actorId === undefined ? undefined : resolveStableProjectIdForCapture(actorId, projectName), {
    onFailure: (error) => { failureReported = true; recordCaptureFailure(error); },
    onSuccess: () => { captureConsecutiveFailures = 0; captureLastSuccessAt = new Date().toISOString(); },
  })
    .catch((error) => {
      // Covers failures before the worker hook boundary, including a failed
      // store.claim() or a failure raised by the injected worker itself.
      if (!failureReported) recordCaptureFailure(error);
      try { process.stderr.write(`[knowledge-capture] cycle failed: ${error instanceof Error ? error.message : String(error)}\n`); } catch { /* ignore */ }
    })
    .finally(() => { captureRunning = false; });
}, parseBoundedNumber(process.env.KNOWLEDGE_CAPTURE_INTERVAL_MS, 1000, 250, 60_000));
captureTimer.unref?.();
const retentionTimer = setInterval(() => {
  try { knowledge?.pruneOutbox(KNOWLEDGE_OUTBOX_RETENTION_MS, ["knowledge-capture"]); }
  catch (error) { try { process.stderr.write(`[knowledge-retention] prune failed: ${error instanceof Error ? error.message : String(error)}\n`); } catch { /* ignore */ } }
}, parseBoundedNumber(process.env.KNOWLEDGE_OUTBOX_PRUNE_INTERVAL_MS, 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000));
retentionTimer.unref?.();
function knowledgeReadiness(): { ready: boolean; status: "available" | "degraded" | "unavailable" } {
  const spool = relayEventSpoolHealth();
  const backlog = knowledge?.consumerBacklog("knowledge-capture");
  const backlogAgeMs = backlog?.oldestAvailableAt ? Date.now() - Date.parse(backlog.oldestAvailableAt) : 0;
  const degraded = spool.degraded || spool.oldestPendingAgeMs > 30_000 || captureConsecutiveFailures >= 3 || backlogAgeMs > 60_000;
  return { ready: knowledgeStatus.available && !degraded, status: knowledgeStatus.available ? (degraded ? "degraded" : "available") : "unavailable" };
}

function verifyToken(req: express.Request): McpUser {
  const token = extractMcpToken(req.headers, req.query as Record<string, unknown>, { allowQueryToken: queryTokenAuthEnabled() });
  if (!token) throw new Error("Missing or invalid authentication");
  const payload = jwt.verify(token, JWT_SECRET) as McpUser;
  if (!payload.tokenId) return payload;
  const db = new Database(DB_PATH, { readonly: false });
  try {
    const row = db.prepare(`SELECT mt.id, mt.project_id, mt.project_server_id, mt.environment, mt.allow_all_projects, mt.can_create_projects, p.name AS project_name, mt.default_server_id FROM mcp_tokens mt LEFT JOIN projects p ON p.id = mt.project_id WHERE mt.token_id = ? AND mt.user_id = ? AND mt.active = 1`).get(payload.tokenId, payload.id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("MCP token is disabled or not found");
    db.prepare("UPDATE mcp_tokens SET last_used_at = datetime('now') WHERE token_id = ?").run(payload.tokenId);
    payload.tokenDbId = Number(row.id);
    payload.defaultProjectId = row.project_id ? Number(row.project_id) : undefined;
    payload.defaultProject = typeof row.project_name === "string" ? row.project_name : undefined;
    payload.defaultEnvironment = typeof row.environment === "string" ? row.environment : "production";
    payload.projectServerId = row.project_server_id ? Number(row.project_server_id) : undefined;
    payload.defaultServerId = row.default_server_id ? Number(row.default_server_id) : undefined;
    payload.allowAllProjects = Boolean(row.allow_all_projects);
    payload.canCreateProjects = Boolean(row.can_create_projects);
  } finally { db.close(); }
  return payload;
}

const app = express();
const requestActivity = createRequestActivity();
// Track parsing, health, diagnostics, and MCP requests. The MCP route adds a
// second handler-lifetime guard because a response can finish before
// transport/server cleanup has completed.
app.use(requestActivity.middleware);
app.use(express.json());

interface McpRequestBody {
  id?: unknown;
  jsonrpc?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown };
}

function requestId(body: unknown): string | number | null {
  if (!body || typeof body !== "object" || !("id" in body)) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

function writeMcpRequestError(res: express.Response, body: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.status(500).json({
    jsonrpc: "2.0",
    id: requestId(body),
    error: { code: -32603, message: "Internal server error" },
  });
}

function logMcpRequestFailure(error: unknown): void {
  try {
    process.stderr.write(`[relay-mcp] request failed: ${error instanceof Error ? error.message : String(error)}\n`);
  } catch { /* ignore logging failure */ }
}

app.all("/mcp", async (req, res) => {
  const releaseHandler = requestActivity.begin();
  const body = req.body as McpRequestBody;
  let server: ReturnType<typeof registerToolsForUser> | undefined;
  let transport: StreamableHTTPServerTransport | undefined;
  let cleanedUp = false;
  const closeRequestResources = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    const closeResults = await Promise.allSettled([
      ...(server ? [Promise.resolve().then(() => server!.close())] : []),
      ...(transport ? [Promise.resolve().then(() => transport!.close())] : []),
    ]);
    for (const result of closeResults) {
      if (result.status === "rejected") logMcpRequestFailure(result.reason);
    }
  };
  const responseClosed = () => { void closeRequestResources(); };
  res.once("finish", responseClosed);
  res.once("close", responseClosed);

  try {
    let user: McpUser;
    try {
      user = verifyToken(req);
    } catch {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (body?.method === "tools/call" && typeof body.params?.name === "string") {
      const metadata = TOOL_CATALOG_BY_NAME.get(body.params.name);
      writeAudit({ event: "tool_called", userId: user.id, username: user.username, tool: body.params.name, category: metadata?.category ?? "unclassified", description: metadata?.description, arguments: sanitizeAuditArguments(body.params.arguments) });
    }
    server = registerToolsForUser(user, { knowledge });
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logMcpRequestFailure(error);
    await closeRequestResources();
    writeMcpRequestError(res, body);
  } finally {
    await closeRequestResources();
    releaseHandler();
  }
});
app.get("/mcp/health", (_req, res) => {
  // Health is unauthenticated: expose only coarse availability state. Detailed
  // spool counters, timestamps, and error classes stay in process logs and are
  // intentionally not disclosed through the public endpoint.
  const readiness = knowledgeReadiness();
  res.json({
    ok: true,
    // Keep these fields stable for existing MCP health consumers. The
    // Knowledge status is additive and must not change the Relay identity
    // contract used by the tool metadata.
    route: "relay_mcp",
    namespace: "relay_",
    version: RELAY_MCP_VERSION,
    transport: "streamable-http",
    mcpPort: MCP_PORT,
    knowledge: {
      available: readiness.ready,
      status: readiness.status,
    },
  });
});
app.get("/mcp/health/live", (_req, res) => res.status(200).json({ ok: true, status: "alive" }));
app.get("/mcp/health/ready", (_req, res) => {
  const readiness = knowledgeReadiness();
  return res.status(readiness.ready ? 200 : 503).json({ ok: readiness.ready, status: readiness.status });
});
app.get("/mcp/diagnostics", (req, res) => {
  let user: McpUser;
  try { user = verifyToken(req); } catch { return res.status(401).json({ error: "Unauthorized" }); }
  if (!user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  const spool = relayEventSpoolHealth();
  const backlog = knowledge?.consumerBacklog("knowledge-capture");
  return res.json({ knowledge: { ...knowledgeStatus, spool }, capture: { consecutiveFailures: captureConsecutiveFailures, lastSuccessAt: captureLastSuccessAt, lastError: captureLastError, lastErrorAt: captureLastErrorAt, backlog } });
});
// express.json() runs before the MCP route, so syntactically invalid JSON
// reaches this boundary instead of becoming an unhandled async rejection or
// an HTML error page.
app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return;
  res.status(400).json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error" },
  });
});
const mcpHttpServer = app.listen(MCP_PORT, "0.0.0.0", () => console.log(`MCP server running on port ${MCP_PORT}`));
let shuttingDown = false;
let sharedResourcesClosed = false;

function closeSharedResources(): void {
  if (sharedResourcesClosed) return;
  sharedResourcesClosed = true;
  try { knowledge?.close(); } catch { /* ignore */ }
  try { closeSharedProjectRegistry(); } catch { /* ignore */ }
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(recoveryTimer);
  clearInterval(captureTimer);
  clearInterval(retentionTimer);
  let forceCloseTimer: NodeJS.Timeout | undefined;
  // server.close() stops new connections immediately. Shared database
  // handles are closed only after every active request has finished its
  // handler and transport cleanup; the force path is the bounded fallback.
  const resourcesAfterDrain = requestActivity.waitForDrain().then(closeSharedResources);
  const finishAfterDrain = (exitCode: number): void => {
    void resourcesAfterDrain.then(() => {
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
      process.exit(exitCode);
    }, () => process.exit(1));
  };
  mcpHttpServer.close((error) => {
    if (error) {
      try { process.stderr.write(`[relay-mcp] shutdown failed: ${error.message}\n`); } catch { /* ignore */ }
      finishAfterDrain(1);
      return;
    }
    // Explicitly finish here because third-party HTTP/MCP internals can retain
    // inert handles after server.close(), especially on Windows. Wait for the
    // request drain promise so the callback cannot exit before DB cleanup.
    finishAfterDrain(0);
  });
  // HTTP clients commonly leave keep-alive sockets open after a stateless MCP
  // request. Release idle sockets while active requests continue draining.
  mcpHttpServer.closeIdleConnections?.();
  forceCloseTimer = setTimeout(() => {
    // The grace period expired; terminate the process after making a best
    // effort to release native handles. Active work is no longer allowed to
    // keep shutdown alive beyond this bounded fallback.
    try { process.stderr.write(`[relay-mcp] forced shutdown after ${MCP_SHUTDOWN_GRACE_MS}ms\n`); } catch { /* ignore logging failure */ }
    closeSharedResources();
    mcpHttpServer.closeAllConnections?.();
    process.exit(process.exitCode ?? 0);
  }, MCP_SHUTDOWN_GRACE_MS);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
