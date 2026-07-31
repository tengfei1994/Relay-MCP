import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import "dotenv/config";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const STATE_ROOT = process.env.RELAY_STATE_ROOT ?? join(WORKSPACE_ROOT, ".relay-mcp");
const QUERY_ROOT = join(STATE_ROOT, "query-artifacts");

export interface QueryArtifactInput {
  queryId: string;
  rawResponse: string;
  provenance: Record<string, unknown>;
}

export interface QueryArtifact {
  queryId: string;
  path: string;
  bytes: number;
  sha256: string;
  createdAt: string;
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
  };
}
