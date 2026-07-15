import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { validateStateId } from "./state-id.js";
import "dotenv/config";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const STATE_ROOT = process.env.RELAY_STATE_ROOT ?? join(WORKSPACE_ROOT, ".relay-mcp");
const DOWNLOAD_ROOT = join(STATE_ROOT, "downloads");
const DEFAULT_TTL_MS = Number(process.env.RELAY_DOWNLOAD_TTL_MS ?? 15 * 60 * 1000);

export interface DownloadSession {
  id: string;
  userId: number;
  projectId: number;
  project: string;
  path: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

function ensureRoot(): void {
  mkdirSync(DOWNLOAD_ROOT, { recursive: true });
}

function sessionPath(id: string): string {
  return join(DOWNLOAD_ROOT, `${validateStateId(id, "download id")}.json`);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createDownloadSession(input: {
  userId: number;
  projectId: number;
  project: string;
  path: string;
  ttlMs?: number;
}): { session: DownloadSession; token: string } {
  ensureRoot();
  cleanupExpiredDownloadSessions();
  const now = Date.now();
  const token = randomBytes(32).toString("base64url");
  const session: DownloadSession = {
    id: `download-${now}-${randomBytes(4).toString("hex")}`,
    userId: input.userId,
    projectId: input.projectId,
    project: input.project,
    path: input.path,
    tokenHash: hashToken(token),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(60_000, input.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
  };
  writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
  return { session, token };
}

export function authenticateDownloadSession(id: string, token: string): DownloadSession {
  ensureRoot();
  const path = sessionPath(id);
  if (!existsSync(path)) throw new Error("Download session not found");
  const session = JSON.parse(readFileSync(path, "utf8")) as DownloadSession;
  if (Date.parse(session.expiresAt) <= Date.now()) throw new Error("Download session expired");
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(session.tokenHash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid download token");
  }
  return session;
}

export function cleanupExpiredDownloadSessions(retentionMs = 24 * 60 * 60 * 1000): void {
  ensureRoot();
  const cutoff = Date.now() - retentionMs;
  for (const name of readdirSync(DOWNLOAD_ROOT)) {
    if (!name.endsWith(".json")) continue;
    const path = join(DOWNLOAD_ROOT, name);
    try {
      const session = JSON.parse(readFileSync(path, "utf8")) as DownloadSession;
      if (Date.parse(session.expiresAt) < cutoff) unlinkSync(path);
    } catch {
      // Preserve malformed records for manual inspection.
    }
  }
}
