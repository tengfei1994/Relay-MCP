import Fastify from "fastify";
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
    };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: true });

// Run DB migrations
runMigrations();

// Plugins
await app.register(fastifyCors, {
  origin: process.env.CORS_ORIGIN ?? true,
});

await app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET ?? "dev-secret-change-in-production",
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
if (existsSync(frontendDist)) {
  await app.register(fastifyStatic, {
    root: frontendDist,
    prefix: "/",
  });
  // SPA fallback
  app.setNotFoundHandler((req, reply) => {
    if (!req.url.startsWith("/api")) {
      reply.sendFile("index.html");
    } else {
      reply.status(404).send({ error: "Not found" });
    }
  });
}

// Routes
await app.register(authRoutes);
await app.register(projectRoutes);
await app.register(serverRoutes);
await app.register(projectServerRoutes);
await app.register(userRoutes);
await app.register(tokenRoutes);
await app.register(uploadRoutes);
await app.register(downloadRoutes);

// Health check
app.get("/api/health", async () => ({ ok: true, ts: new Date().toISOString() }));

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

await app.listen({ port, host });
console.log(`Web server running on http://${host}:${port}`);
