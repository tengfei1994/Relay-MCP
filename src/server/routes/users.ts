import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { z } from "zod";

function requireAdmin(req: any, reply: any, done: any) {
  if (!req.user?.isAdmin) {
    reply.status(403).send({ error: "Admin required" });
    return;
  }
  done();
}

export async function userRoutes(app: FastifyInstance) {
  // List all users (admin only)
  app.get(
    "/api/users",
    { onRequest: [app.authenticate, requireAdmin] },
    async (_req, reply) => {
      const result = db
        .select({ id: users.id, username: users.username, isAdmin: users.isAdmin, createdAt: users.createdAt })
        .from(users)
        .all();
      return reply.send({ users: result });
    }
  );

  // Create user (admin only)
  app.post(
    "/api/users",
    { onRequest: [app.authenticate, requireAdmin] },
    async (req, reply) => {
      const Schema = z.object({
        username: z.string().min(2).max(50),
        password: z.string().min(6),
        isAdmin: z.boolean().default(false),
      });
      const body = Schema.safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: "Invalid input" });

      const existing = db.select().from(users).where(eq(users.username, body.data.username)).get();
      if (existing) return reply.status(409).send({ error: "Username already taken" });

      const passwordHash = await bcrypt.hash(body.data.password, 12);
      const result = db
        .insert(users)
        .values({ username: body.data.username, passwordHash, isAdmin: body.data.isAdmin })
        .returning({ id: users.id, username: users.username, isAdmin: users.isAdmin })
        .get();

      return reply.status(201).send({ user: result });
    }
  );

  // Change password (admin: any user; regular: own account only)
  app.patch(
    "/api/users/:id/password",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const targetId = Number(id);

      if (!req.user.isAdmin && req.user.id !== targetId) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      const Schema = z.object({ password: z.string().min(6) });
      const body = Schema.safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: "Password must be at least 6 characters" });

      const user = db.select().from(users).where(eq(users.id, targetId)).get();
      if (!user) return reply.status(404).send({ error: "User not found" });

      const passwordHash = await bcrypt.hash(body.data.password, 12);
      db.update(users).set({ passwordHash }).where(eq(users.id, targetId)).run();

      return reply.send({ ok: true });
    }
  );

  // Toggle admin status (admin only, cannot demote yourself)
  app.patch(
    "/api/users/:id/admin",
    { onRequest: [app.authenticate, requireAdmin] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const targetId = Number(id);

      if (req.user.id === targetId) {
        return reply.status(400).send({ error: "Cannot change your own admin status" });
      }

      const Schema = z.object({ isAdmin: z.boolean() });
      const body = Schema.safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: "Invalid input" });

      db.update(users).set({ isAdmin: body.data.isAdmin }).where(eq(users.id, targetId)).run();
      return reply.send({ ok: true });
    }
  );

  // Delete user (admin only, cannot delete yourself)
  app.delete(
    "/api/users/:id",
    { onRequest: [app.authenticate, requireAdmin] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const targetId = Number(id);

      if (req.user.id === targetId) {
        return reply.status(400).send({ error: "Cannot delete your own account" });
      }

      const user = db.select().from(users).where(eq(users.id, targetId)).get();
      if (!user) return reply.status(404).send({ error: "User not found" });

      db.delete(users).where(eq(users.id, targetId)).run();
      return reply.send({ ok: true });
    }
  );
}
