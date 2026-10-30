import Fastify from "fastify";
import { safeRequestLogSerializers, safeRequestLogHooks, sendSafeNotFound } from "./request-log.js";
import fastifyJwt from "@fastify/jwt";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import "dotenv/config";
import { runMigrations } from "./db/index.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { serverRoutes } from "./routes/servers.js";
import { projectServerRoutes } from "./routes/project-servers.js";
import { userRoutes } from "./routes/users.js";
import { tokenRoutes } from "./routes/tokens.js";
import { uploadRoutes } from "./routes/uploads.js";
import { downloadRoutes } from "./routes/downloads.js";
import { agentRoutes } from "./routes/agents.js";
import { agentTokenRoutes } from "./routes/agent-tokens.js";
import { instanceRoutes } from "./routes/instances.js";
import { toolRoutes } from "./routes/tools.js";
import { knowledgeEngineRoutes } from "./routes/knowledge-engine.js";
import { getEngineManager } from "../knowledge/engine-service.js";
import { createEngineStartupReconciler } from "./knowledge-engine-startup.js";
import { startCandidateInsightDispatcher } from "../knowledge/candidate-dispatch.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { requireJwtSecret } from "../shared/auth-secret.js";
import { getKnowledgeStore } from "./knowledge-context.js";
import { ensureWikiGeneration, runPendingIngestJobs, recoverInterruptedIngestJobs } from "../knowledge/ingest-worker.js";
import { stopIngestJobs } from "../knowledge/ingest-dispatch.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      id: number;
      username: string;
      isAdmin: boolean;
      tokenKind?: string;
      tokenId?: string;
      defaultProject?: string;
      defaultEnvironment?: string;
      projectServerId?: number;
      defaultServerId?: number;
      agentId?: string;
    };
    user: {
      id: number;
      username: string;
      isAdmin: boolean;
      tokenKind?: string;
      tokenId?: string;
      defaultProject?: string;
      defaultEnvironment?: string;
      projectServerId?: number;
      defaultServerId?: number;
      agentId?: string;
    };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: { serializers: safeRequestLogSerializers, hooks: safeRequestLogHooks } });
const RELAY_VERSION = process.env.RELAY_VERSION ?? "0.6.3";
const RELAY_BUILD_COMMIT = process.env.RELAY_BUILD_COMMIT ?? "development";
const RELAY_BUILD_TIME = process.env.RELAY_BUILD_TIME ?? "unknown";

// Run DB migrations
runMigrations();

// Plugins
await app.register(fastifyCors, {
  origin: process.env.CORS_ORIGIN ?? true,
});

await app.register(fastifyJwt, {
  secret: requireJwtSecret("relay-web"),
});

// Auth decorator
app.decorate("authenticate", async (req: any, reply: any) => {
  try {
    await req.jwtVerify();
  } catch (err) {
    reply.send(err);
  }
});

// Serve frontend build if it exists
const frontendDist = join(__dirname, "../../frontend/dist");
const frontendAvailable = existsSync(frontendDist);
if (frontendAvailable) {
  await app.register(fastifyStatic, {
    root: frontendDist,
    prefix: "/",
  });
}
// Use a safe 404 even without frontend assets; the default logs the raw URL.
app.setNotFoundHandler((req, reply) => {
  if (frontendAvailable && !req.url.startsWith("/api")) return reply.sendFile("index.html");
  return sendSafeNotFound(reply);
});

// Model setup remains the only configuration flow; reconcile internal aliases afterwards.
app.addHook("onResponse", async (request, reply) => {
  if (["POST","PUT"].includes(request.method) && request.url.startsWith("/api/knowledge/providers/managed/") && reply.statusCode < 300) {
    const manager = getEngineManager(getKnowledgeStore());
    if (manager.runtime()) void manager.initialize({actorId:request.user?.id??0}).catch(() => app.log.warn("Knowledge engine model reconciliation pending"));
  }
});

// Routes
await app.register(authRoutes);
await app.register(projectRoutes);
await app.register(serverRoutes);
await app.register(projectServerRoutes);
await app.register(userRoutes);
await app.register(tokenRoutes);
await app.register(uploadRoutes);
await app.register(downloadRoutes);
await app.register(agentRoutes);
await app.register(agentTokenRoutes);
await app.register(instanceRoutes);
await app.register(toolRoutes);
await app.register(knowledgeRoutes);
await app.register(knowledgeEngineRoutes);
// Resume durable document imports after a process restart. The worker claims
// only queued rows and keeps the HTTP server responsive while large packages
// are parsed.
ensureWikiGeneration(getKnowledgeStore());
recoverInterruptedIngestJobs(getKnowledgeStore());
void runPendingIngestJobs(getKnowledgeStore()).catch((error) => app.log.error(error, "knowledge ingest recovery failed"));

// Health check
app.get("/api/health", async () => ({
  ok: true,
  version: RELAY_VERSION,
  commit: RELAY_BUILD_COMMIT,
  buildTime: RELAY_BUILD_TIME,
  process: "remote-ops-web",
  ts: new Date().toISOString(),
}));

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const engineManager = getEngineManager(getKnowledgeStore());
const engineStartup = createEngineStartupReconciler({
  installed: () => Boolean(engineManager.runtime()),
  initialize: () => engineManager.initialize({ actorId: 0 }),
  report: event => app.log.warn(event, event.state === "exhausted"
    ? "Knowledge engine startup reconciliation exhausted; inspect Relay provider configuration"
    : "Knowledge engine startup reconciliation will retry"),
});
const candidateDispatcher = startCandidateInsightDispatcher(() => getKnowledgeStore(), {onError:()=>app.log.warn("Candidate worker cycle failed; queued work remains durable")});
app.addHook("onClose", async () => { await candidateDispatcher.stop(); await engineStartup.stop(); });
await app.listen({ port, host });
void engineStartup.start();
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void candidateDispatcher.stop().then(() => engineStartup.stop()).then(() => stopIngestJobs()).then(() => app.close()).finally(() => process.exit(0));
});
console.log(`Web server running on http://${host}:${port}`);
