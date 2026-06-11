import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { servers } from "../db/schema.js";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { NodeSSH } from "node-ssh";
import "dotenv/config";

const execFileAsync = promisify(execFile);
const SSH_KEYS_DIR = process.env.SSH_KEYS_DIR ?? "/workspace/.ssh-keys";

const AddServerSchema = z.object({
  name: z.string().min(1).max(100),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  sshUser: z.string().min(1),
});

async function generateSshKeyPair(keyPath: string): Promise<string> {
  mkdirSync(join(keyPath, ".."), { recursive: true });
  await execFileAsync("ssh-keygen", [
    "-t", "ed25519",
    "-f", keyPath,
    "-N", "", // no passphrase
    "-C", "remote-ops-mcp",
  ]);
  return readFileSync(`${keyPath}.pub`, "utf8").trim();
}

export async function serverRoutes(app: FastifyInstance) {
  // List servers
  app.get(
    "/api/servers",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const result = db
        .select()
        .from(servers)
        .where(eq(servers.userId, req.user.id))
        .all();
      // Don't expose private key path
      const sanitized = result.map(({ privateKeyPath, ...s }) => s);
      return reply.send({ servers: sanitized });
    }
  );

  // Add server (generates SSH key pair)
  app.post(
    "/api/servers",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const body = AddServerSchema.safeParse(req.body);
      if (!body.success) {
        return reply.status(400).send({ error: "Invalid input" });
      }

      const { name, host, port, sshUser } = body.data;
      const userId = req.user.id;
      const username = req.user.username;

      // Generate unique key pair for this server
      const keyDir = join(SSH_KEYS_DIR, username);
      const safeHost = host.replace(/[^a-zA-Z0-9.-]/g, "_");
      const keyPath = join(keyDir, `${safeHost}_${Date.now()}`);

      let publicKey: string;
      try {
        publicKey = await generateSshKeyPair(keyPath);
      } catch (err) {
        return reply.status(500).send({ error: "Failed to generate SSH key pair" });
      }

      const result = db
        .insert(servers)
        .values({
          userId,
          name,
          host,
          port,
          sshUser,
          privateKeyPath: keyPath,
          publicKey,
          status: "pending",
        })
        .returning()
        .get();

      return reply.status(201).send({
        server: { ...result, privateKeyPath: undefined },
        publicKey,
        instructions: `Add this public key to ${sshUser}@${host}:~/.ssh/authorized_keys, then call /api/servers/${result.id}/test`,
      });
    }
  );

  // Get server details + public key
  app.get(
    "/api/servers/:id",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const server = db
        .select()
        .from(servers)
        .where(and(eq(servers.id, Number(id)), eq(servers.userId, req.user.id)))
        .get();
      if (!server) return reply.status(404).send({ error: "Not found" });
      const { privateKeyPath, ...safe } = server;
      return reply.send({ server: safe });
    }
  );

  // Test connectivity
  app.post(
    "/api/servers/:id/test",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const server = db
        .select()
        .from(servers)
        .where(and(eq(servers.id, Number(id)), eq(servers.userId, req.user.id)))
        .get();
      if (!server) return reply.status(404).send({ error: "Not found" });

      const ssh = new NodeSSH();
      try {
        await ssh.connect({
          host: server.host,
          port: server.port ?? 22,
          username: server.sshUser,
          privateKeyPath: server.privateKeyPath,
          readyTimeout: 10000,
        });
        const result = await ssh.execCommand("echo ok");
        ssh.dispose();

        db.update(servers)
          .set({ status: "connected" })
          .where(eq(servers.id, server.id))
          .run();

        return reply.send({ ok: true, output: result.stdout });
      } catch (err: any) {
        db.update(servers)
          .set({ status: "failed" })
          .where(eq(servers.id, server.id))
          .run();
        return reply.status(502).send({ ok: false, error: err.message });
      }
    }
  );

  // Push public key to server (requires password auth for initial setup)
  app.post(
    "/api/servers/:id/push-key",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { password } = req.body as { password?: string };
      if (!password) return reply.status(400).send({ error: "Password required for initial key push" });

      const server = db
        .select()
        .from(servers)
        .where(and(eq(servers.id, Number(id)), eq(servers.userId, req.user.id)))
        .get();
      if (!server) return reply.status(404).send({ error: "Not found" });

      const ssh = new NodeSSH();
      try {
        await ssh.connect({
          host: server.host,
          port: server.port ?? 22,
          username: server.sshUser,
          password,
          readyTimeout: 10000,
        });

        // Ensure .ssh dir exists and append public key
        await ssh.execCommand(`
          mkdir -p ~/.ssh && chmod 700 ~/.ssh &&
          echo '${server.publicKey}' >> ~/.ssh/authorized_keys &&
          chmod 600 ~/.ssh/authorized_keys
        `);
        ssh.dispose();

        return reply.send({ ok: true, message: "Public key added. Run /test to verify." });
      } catch (err: any) {
        return reply.status(502).send({ ok: false, error: err.message });
      }
    }
  );

  // Delete server
  app.delete(
    "/api/servers/:id",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const server = db
        .select()
        .from(servers)
        .where(and(eq(servers.id, Number(id)), eq(servers.userId, req.user.id)))
        .get();
      if (!server) return reply.status(404).send({ error: "Not found" });

      db.delete(servers).where(eq(servers.id, Number(id))).run();
      return reply.send({ ok: true });
    }
  );
}
