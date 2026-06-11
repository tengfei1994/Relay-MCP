import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { z } from "zod";

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

    const existing = db.select().from(users).where(eq(users.username, username)).get();
    if (existing) {
      return reply.status(409).send({ error: "Username already taken" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    // First user becomes admin
    const userCount = db.select().from(users).all().length;
    const isAdmin = userCount === 0;

    const result = db
      .insert(users)
      .values({ username, passwordHash, isAdmin })
      .returning({ id: users.id, username: users.username, isAdmin: users.isAdmin })
      .get();

    const token = app.jwt.sign({ id: result.id, username: result.username, isAdmin: result.isAdmin ?? false });
    return reply.send({ token, user: result });
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

    const token = app.jwt.sign({ id: user.id, username: user.username, isAdmin: user.isAdmin ?? false });
    return reply.send({
      token,
      user: { id: user.id, username: user.username, isAdmin: user.isAdmin ?? false },
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
