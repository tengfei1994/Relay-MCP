import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import "dotenv/config";
import { validateStateId } from "./state-id.js";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const STATE_ROOT = process.env.RELAY_STATE_ROOT ?? join(WORKSPACE_ROOT, ".relay-mcp");
const QUERY_ROOT = join(STATE_ROOT, "query-artifacts");

export interface QueryArtifactInput {
  queryId: string;
  rawResponse: string;
  provenance: Record<string, unknown>;
}

export interface QueryArtifactReadOptions {
  offset?: number;
  maxCharacters?: number;
}

export interface QueryArtifactReadResult {
  queryId: string;
  path: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  provenance: Record<string, unknown>;
  rawResponse: string;
  rawResponseLength: number;
  rawResponseSha256: string;
  page: {
    offset: number;
    maxCharacters: number;
    nextOffset: number | null;
    hasMore: boolean;
    truncated: boolean;
  };
}

export interface QueryArtifact {
  queryId: string;
  path: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  rawResponseSha256: string;
}

export function buildQueryArtifactPayload(input: QueryArtifactInput): string {
  return JSON.stringify({
    queryId: input.queryId,
    createdAt: new Date().toISOString(),
    provenance: input.provenance,
    rawResponse: input.rawResponse,
  }, null, 2);
}

export function persistQueryArtifact(input: QueryArtifactInput): QueryArtifact {
  mkdirSync(QUERY_ROOT, { recursive: true });
  const payload = buildQueryArtifactPayload(input);
  const bytes = Buffer.byteLength(payload, "utf8");
  const sha256 = createHash("sha256").update(payload, "utf8").digest("hex");
  const path = join(QUERY_ROOT, `${input.queryId}.json`);
  writeFileSync(path, payload, "utf8");
  return {
    queryId: input.queryId,
    path,
    bytes,
    sha256,
    createdAt: new Date().toISOString(),
    rawResponseSha256: createHash("sha256").update(input.rawResponse, "utf8").digest("hex"),
  };
}

/**
 * Read a bounded page from a persisted query artifact without re-running SQL.
 * The query id is validated before it is used as a file name, and callers must
 * enforce user ownership from the stored provenance at the MCP boundary.
 */
export function readQueryArtifact(
  queryId: string,
  options: QueryArtifactReadOptions = {},
): QueryArtifactReadResult {
  const safeQueryId = validateStateId(queryId, "query id");
  const path = join(QUERY_ROOT, `${safeQueryId}.json`);
  if (!existsSync(path)) throw new Error(`Query artifact '${safeQueryId}' not found`);

  const payload = JSON.parse(readFileSync(path, "utf8")) as {
    queryId?: string;
    createdAt?: string;
    provenance?: Record<string, unknown>;
    rawResponse?: string;
  };
  if (payload.queryId !== safeQueryId || typeof payload.rawResponse !== "string") {
    throw new Error(`Query artifact '${safeQueryId}' is invalid`);
  }

  const rawResponse = payload.rawResponse;
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const maxCharacters = Math.max(1_000, Math.min(Math.trunc(options.maxCharacters ?? 100_000), 1_000_000));
  const pageText = rawResponse.slice(offset, offset + maxCharacters);
  const nextOffset = offset + pageText.length < rawResponse.length ? offset + pageText.length : null;
  const file = readFileSync(path);
  const bytes = statSync(path).size;
  return {
    queryId: safeQueryId,
    path,
    bytes,
    sha256: createHash("sha256").update(file).digest("hex"),
    createdAt: payload.createdAt ?? new Date(0).toISOString(),
    provenance: payload.provenance ?? {},
    rawResponse: pageText,
    rawResponseLength: rawResponse.length,
    rawResponseSha256: createHash("sha256").update(rawResponse, "utf8").digest("hex"),
    page: {
      offset,
      maxCharacters,
      nextOffset,
      hasMore: nextOffset !== null,
      truncated: offset > 0 || nextOffset !== null,
    },
  };
}
