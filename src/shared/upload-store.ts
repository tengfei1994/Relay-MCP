import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import "dotenv/config";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const STATE_ROOT = process.env.RELAY_STATE_ROOT ?? join(WORKSPACE_ROOT, ".relay-mcp");
const UPLOAD_ROOT = join(STATE_ROOT, "uploads");
const DEFAULT_TTL_MS = Number(process.env.RELAY_UPLOAD_TTL_MS ?? 15 * 60 * 1000);
const DEFAULT_MAX_BYTES = Number(process.env.RELAY_UPLOAD_MAX_BYTES ?? 256 * 1024 * 1024);

export type UploadStatus = "pending" | "completed" | "failed" | "expired";

export interface UploadSession {
  id: string;
  userId: number;
  projectId: number;
  project: string;
  path: string;
  tokenHash: string;
  status: UploadStatus;
  maxBytes: number;
  expectedSha256?: string;
  bytesWritten?: number;
  sha256?: string;
  error?: string;
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
}

export interface CreatedUploadSession {
  session: UploadSession;
  token: string;
}

function ensureUploadRoot(): void {
  mkdirSync(UPLOAD_ROOT, { recursive: true });
}

function sessionPath(id: string): string {
  return join(UPLOAD_ROOT, `${id}.json`);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createUploadSession(input: {
  userId: number;
  projectId: number;
  project: string;
  path: string;
  maxBytes?: number;
  expectedSha256?: string;
  ttlMs?: number;
}): CreatedUploadSession {
  ensureUploadRoot();
  cleanupExpiredUploadSessions();

  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const maxBytes = Math.max(1, Math.min(input.maxBytes ?? DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES));
  const expectedSha256 = input.expectedSha256?.toLowerCase();
  if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("expectedSha256 must be a 64-character hexadecimal SHA-256 value");
  }

  const session: UploadSession = {
    id: `upload-${now}-${randomBytes(4).toString("hex")}`,
    userId: input.userId,
    projectId: input.projectId,
    project: input.project,
    path: input.path,
    tokenHash: hashToken(token),
    status: "pending",
    maxBytes,
    expectedSha256,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(60_000, input.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
  };
  saveUploadSession(session);
  return { session, token };
}

export function saveUploadSession(session: UploadSession): void {
  ensureUploadRoot();
  writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
}

export function getUploadSession(id: string): UploadSession | undefined {
  ensureUploadRoot();
  const path = sessionPath(id);
  if (!existsSync(path)) return undefined;
  const session = JSON.parse(readFileSync(path, "utf8")) as UploadSession;
  if (session.status === "pending" && Date.parse(session.expiresAt) <= Date.now()) {
    session.status = "expired";
    session.error = "Upload session expired";
    saveUploadSession(session);
  }
  return session;
}

export function authenticateUploadSession(id: string, token: string): UploadSession {
  const session = getUploadSession(id);
  if (!session) throw new Error("Upload session not found");
  if (session.status !== "pending") throw new Error(`Upload session is ${session.status}`);
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(session.tokenHash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid upload token");
  }
  return session;
}

export function completeUploadSession(id: string, bytesWritten: number, sha256: string): UploadSession {
  const session = getUploadSession(id);
  if (!session) throw new Error("Upload session not found");
  const completed: UploadSession = {
    ...session,
    status: "completed",
    bytesWritten,
    sha256,
    completedAt: new Date().toISOString(),
    error: undefined,
  };
  saveUploadSession(completed);
  return completed;
}

export function failUploadSession(id: string, error: string): void {
  const session = getUploadSession(id);
  if (!session) return;
  saveUploadSession({
    ...session,
    status: "failed",
    error,
    completedAt: new Date().toISOString(),
  });
}

export function publicUploadSession(session: UploadSession): Omit<UploadSession, "tokenHash"> {
  const { tokenHash: _tokenHash, ...safe } = session;
  return safe;
}

export function cleanupExpiredUploadSessions(retentionMs = 24 * 60 * 60 * 1000): void {
  ensureUploadRoot();
  const cutoff = Date.now() - retentionMs;
  for (const name of readdirSync(UPLOAD_ROOT)) {
    if (!name.endsWith(".json")) continue;
    const path = join(UPLOAD_ROOT, name);
    try {
      const session = JSON.parse(readFileSync(path, "utf8")) as UploadSession;
      if (Date.parse(session.expiresAt) < cutoff) unlinkSync(path);
    } catch {
      // Keep malformed records for manual inspection.
    }
  }
}
