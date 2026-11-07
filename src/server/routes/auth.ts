import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { z } from "zod";
import { writeAudit } from "../../shared/job-store.js";
import { isSafeWorkspaceUserName } from "../../shared/workspace-path.js";

const LoginSchema = z.object({
  username: z.string().min(2).max(50),
  password: z.string().min(6),
});

export async function authRoutes(app: FastifyInstance) {
  // Register
  app.post("/api/auth/register", async (req, reply) => {
    const body = LoginSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Invalid input" });
    }
    const { username, password } = body.data;

    if (!isSafeWorkspaceUserName(username)) return reply.status(400).send({ error: "Username must use letters, numbers, hyphens or underscores" });

    const existing = db.select().from(users).where(eq(users.username, username)).get();
    if (existing) {
      return reply.status(409).send({ error: "Username already taken" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    let created;
    try {
      // The first-account check and insert must be atomic across server processes.
      created = db.transaction((tx) => {
        const isAdmin = !tx.select({ id: users.id }).from(users).limit(1).get();
        const result = tx.insert(users)
          .values({ username, passwordHash, isAdmin, knowledgeEnabled: false, accountStatus: isAdmin ? "active" : "pending" })
          .returning({ id: users.id, username: users.username, isAdmin: users.isAdmin, knowledgeEnabled: users.knowledgeEnabled, accountStatus: users.accountStatus })
          .get();
        return { result, isAdmin };
      }, { behavior: "immediate" });
    } catch (error) {
      if (db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()) {
        return reply.status(409).send({ error: "Username already taken" });
      }
      throw error;
    }
    const { result, isAdmin } = created;
    writeAudit({ event: isAdmin ? "initial_admin_created" : "registration_submitted", userId: result.id });
    if (!isAdmin) return reply.status(201).send({ status: "pending" });
    const token = app.jwt.sign({ id: result.id, username: result.username, isAdmin: true }, { expiresIn: "12h" });
    return reply.status(201).send({ status: "active", token, user: result });
  });

  // Login
  app.post("/api/auth/login", async (req, reply) => {
    const body = LoginSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Invalid input" });
    }
    const { username, password } = body.data;

    const user = db.select().from(users).where(eq(users.username, username)).get();
    if (!user) {
      return reply.status(401).send({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: "Invalid credentials" });
    }

    if (user.accountStatus !== "active") {
      const message = user.accountStatus === "pending" ? "Your access request is awaiting administrator review."
        : user.accountStatus === "rejected" ? "Your access request was not approved."
        : "This account is disabled. Contact an administrator.";
      return reply.status(403).send({ error: message, status: user.accountStatus });
    }

    const token = app.jwt.sign({ id: user.id, username: user.username, isAdmin: user.isAdmin ?? false }, { expiresIn: "12h" });
    return reply.send({
      token,
      user: { id: user.id, username: user.username, isAdmin: user.isAdmin ?? false, knowledgeEnabled: user.knowledgeEnabled ?? false },
    });
  });

  // Get current user
  app.get(
    "/api/auth/me",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      return reply.send({ user: req.user });
    }
  );
}
