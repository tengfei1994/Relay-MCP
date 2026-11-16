import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { users } from "./db/schema.js";

/** Resolve account state on every web request, including existing sessions. */
export function registerSessionAuthentication(app: FastifyInstance): void {
  app.decorate("authenticate", async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
      if (req.user.tokenKind) return reply.status(401).send({ error: "A web session is required" });
      const current = db.select({ id: users.id, username: users.username, isAdmin: users.isAdmin, knowledgeEnabled: users.knowledgeEnabled, accountStatus: users.accountStatus }).from(users).where(eq(users.id, req.user.id)).get();
      if (!current || current.accountStatus !== "active") return reply.status(401).send({ error: "Account is unavailable" });
      req.user = { ...req.user, username: current.username, isAdmin: Boolean(current.isAdmin), knowledgeEnabled: Boolean(current.knowledgeEnabled) };
    } catch (error) {
      return reply.send(error);
    }
  });
}
