import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { z } from "zod";
import { writeAudit } from "../../shared/job-store.js";
import { isSafeWorkspaceUserName } from "../../shared/workspace-path.js";

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
        .select({ id: users.id, username: users.username, isAdmin: users.isAdmin, knowledgeEnabled: users.knowledgeEnabled, accountStatus: users.accountStatus, reviewedBy: users.reviewedBy, reviewedAt: users.reviewedAt, reviewReason: users.reviewReason, createdAt: users.createdAt })
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
        knowledgeEnabled: z.boolean().default(false),
      });
      const body = Schema.safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: "Invalid input" });
      if (!isSafeWorkspaceUserName(body.data.username)) return reply.status(400).send({ error: "Username must use letters, numbers, hyphens or underscores" });

      const existing = db.select().from(users).where(eq(users.username, body.data.username)).get();
      if (existing) return reply.status(409).send({ error: "Username already taken" });

      const passwordHash = await bcrypt.hash(body.data.password, 12);
      const result = db
        .insert(users)
        .values({ username: body.data.username, passwordHash, isAdmin: body.data.isAdmin, knowledgeEnabled: body.data.knowledgeEnabled })
        .returning({ id: users.id, username: users.username, isAdmin: users.isAdmin, knowledgeEnabled: users.knowledgeEnabled, accountStatus: users.accountStatus })
        .get();

      writeAudit({ event: "user_created", userId: req.user.id, targetUserId: result.id });
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

      const Schema = z.object({ password: z.string().min(6), currentPassword: z.string().optional() });
      const body = Schema.safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: "Password must be at least 6 characters" });

      const user = db.select().from(users).where(eq(users.id, targetId)).get();
      if (!user) return reply.status(404).send({ error: "User not found" });
      if (req.user.id === targetId && (!body.data.currentPassword || !(await bcrypt.compare(body.data.currentPassword, user.passwordHash)))) {
        return reply.status(403).send({ error: "Current password is incorrect" });
      }

      const passwordHash = await bcrypt.hash(body.data.password, 12);
      db.update(users).set({ passwordHash }).where(eq(users.id, targetId)).run();
      writeAudit({ event: "user_password_changed", userId: req.user.id, targetUserId: targetId });

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

      const changed = db.update(users).set({ isAdmin: body.data.isAdmin }).where(eq(users.id, targetId)).run();
      if (!changed.changes) return reply.status(404).send({ error: "User not found" });
      writeAudit({ event: "user_admin_changed", userId: req.user.id, targetUserId: targetId, isAdmin: body.data.isAdmin });
      return reply.send({ ok: true });
    }
  );

  // Registration reviews and account suspension use the same live account status.
  app.patch("/api/users/:id/status", { onRequest: [app.authenticate, requireAdmin] }, async (req, reply) => {
    const targetId = Number((req.params as { id: string }).id);
    const body = z.object({ status: z.enum(["active", "rejected", "disabled"]), reason: z.string().trim().max(500).optional() }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid account status" });
    if (req.user.id === targetId) return reply.status(400).send({ error: "You cannot change your own account status" });
    const target = db.select({ accountStatus: users.accountStatus }).from(users).where(eq(users.id, targetId)).get();
    if (!target) return reply.status(404).send({ error: "User not found" });
    if (body.data.status === "rejected" && target.accountStatus !== "pending") return reply.status(409).send({ error: "Only pending requests can be rejected" });
    if (body.data.status === "disabled" && target.accountStatus !== "active") return reply.status(409).send({ error: "Only active accounts can be disabled" });
    const reviewedAt = new Date().toISOString();
    const reason = body.data.reason || null;
    db.update(users).set({ accountStatus: body.data.status, reviewedBy: req.user.id, reviewedAt, reviewReason: reason }).where(eq(users.id, targetId)).run();
    writeAudit({ event: "user_account_status_changed", userId: req.user.id, targetUserId: targetId, from: target.accountStatus, status: body.data.status, reason });
    return reply.send({ ok: true, status: body.data.status, reviewedAt, reviewedBy: req.user.id, reviewReason: reason });
  });
  // Product Knowledge and general Memory are a user-level grant.
  app.patch(
    "/api/users/:id/knowledge",
    { onRequest: [app.authenticate, requireAdmin] },
    async (req, reply) => {
      const targetId = Number((req.params as { id: string }).id);
      const body = z.object({ knowledgeEnabled: z.boolean() }).safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: "Invalid input" });
      const changed = db.update(users).set({ knowledgeEnabled: body.data.knowledgeEnabled }).where(eq(users.id, targetId)).run();
      if (!changed.changes) return reply.status(404).send({ error: "User not found" });
      writeAudit({ event: "knowledge_access_changed", userId: req.user.id, targetUserId: targetId, enabled: body.data.knowledgeEnabled });
      return reply.send({ ok: true, knowledgeEnabled: body.data.knowledgeEnabled });
    },
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
      writeAudit({ event: "user_deleted", userId: req.user.id, targetUserId: targetId });
      return reply.send({ ok: true });
    }
  );
}
