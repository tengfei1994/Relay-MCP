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
  os: z.enum(["linux", "windows"]).default("linux"),
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

      const { name, host, port, sshUser, os } = body.data;
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
          os,
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

  // Edit server
  app.put(
    "/api/servers/:id",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const EditSchema = z.object({
        name: z.string().min(1).max(100).optional(),
        host: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        sshUser: z.string().min(1).optional(),
        os: z.enum(["linux", "windows"]).optional(),
      });
      const body = EditSchema.safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: "Invalid input" });

      const server = db
        .select()
        .from(servers)
        .where(and(eq(servers.id, Number(id)), eq(servers.userId, req.user.id)))
        .get();
      if (!server) return reply.status(404).send({ error: "Not found" });

      const updated = db
        .update(servers)
        .set({ ...body.data, status: "pending" })
        .where(eq(servers.id, Number(id)))
        .returning()
        .get();

      const { privateKeyPath, ...safe } = updated;
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

  // Setup: push key via password + test (SSE streaming)
  app.post(
    "/api/servers/:id/setup",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { password } = req.body as { password?: string };
      if (!password) return reply.status(400).send({ error: "Password required" });

      const server = db
        .select()
        .from(servers)
        .where(and(eq(servers.id, Number(id)), eq(servers.userId, req.user.id)))
        .get();
      if (!server) return reply.status(404).send({ error: "Not found" });

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const send = (type: "log" | "success" | "error", message: string) => {
        reply.raw.write(`data: ${JSON.stringify({ type, message })}\n\n`);
      };

      try {
        send("log", `Connecting to ${server.sshUser}@${server.host}:${server.port ?? 22} with password...`);
        const ssh1 = new NodeSSH();
        await ssh1.connect({
          host: server.host,
          port: server.port ?? 22,
          username: server.sshUser,
          password,
          readyTimeout: 15000,
        });
        const isWindows = server.os === "windows";
        send("log", `Target OS: ${isWindows ? "Windows" : "Linux/Unix"}`);

        let keyWritten = false;
        if (isWindows) {
          // Windows: write to administrators_authorized_keys with correct permissions
          send("log", "Writing public key to C:\\ProgramData\\ssh\\administrators_authorized_keys...");
          const keyPath = "C:\\ProgramData\\ssh\\administrators_authorized_keys";
          const r1 = await ssh1.execCommand(
            `powershell -Command "Add-Content -Path '${keyPath}' -Value '${server.publicKey}'; icacls '${keyPath}' /inheritance:r /grant 'SYSTEM:(F)' /grant 'Administrators:(F)' | Out-Null; Write-Output KEY_ADDED"`
          );
          if (r1.stdout) send("log", r1.stdout.trim());
          if (r1.stderr) send("log", r1.stderr.trim());
          keyWritten = r1.stdout.includes("KEY_ADDED");
        } else {
          // Linux/Unix
          send("log", "Writing public key to ~/.ssh/authorized_keys...");
          const r1 = await ssh1.execCommand(
            `mkdir -p ~/.ssh; chmod 700 ~/.ssh; echo '${server.publicKey}' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; echo KEY_ADDED`
          );
          if (r1.stdout) send("log", r1.stdout.trim());
          if (r1.stderr) send("log", r1.stderr.trim());
          keyWritten = r1.stdout.includes("KEY_ADDED");
        }
        ssh1.dispose();

        if (!keyWritten) {
          throw new Error("Failed to write public key");
        }
        send("log", "Public key written. Testing key-based auth...");

        const ssh2 = new NodeSSH();
        await ssh2.connect({
          host: server.host,
          port: server.port ?? 22,
          username: server.sshUser,
          privateKeyPath: server.privateKeyPath,
          readyTimeout: 15000,
        });
        const r2 = await ssh2.execCommand("echo SSH_OK");
        ssh2.dispose();

        if (r2.stdout.includes("SSH_OK")) {
          db.update(servers).set({ status: "connected" }).where(eq(servers.id, server.id)).run();
          send("success", "Setup complete — server is now connected!");
        } else {
          throw new Error("Key auth test failed");
        }
      } catch (err: any) {
        db.update(servers).set({ status: "failed" }).where(eq(servers.id, server.id)).run();
        send("error", `Setup failed: ${err.message}`);
      }

      reply.raw.end();
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
