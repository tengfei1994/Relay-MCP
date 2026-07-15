import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { validateStateId } from "./state-id.js";
import "dotenv/config";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const STATE_ROOT = process.env.RELAY_STATE_ROOT ?? join(WORKSPACE_ROOT, ".relay-mcp");
const DEPLOYMENT_ROOT = join(STATE_ROOT, "deployments");

export type DeploymentStatus = "running" | "succeeded" | "failed";

export interface DeploymentRecord {
  id: string;
  userId: number;
  username: string;
  project: string;
  environment: string;
  host: string;
  branch: string;
  status: DeploymentStatus;
  startedAt: string;
  finishedAt?: string;
  commitBefore?: string;
  commitAfter?: string;
  rollback: {
    requested: boolean;
    attempted: boolean;
    status: "not-requested" | "not-needed" | "succeeded" | "failed";
    commit?: string;
    error?: string;
  };
  output?: string;
  outputTruncated?: boolean;
  outputLength?: number;
  error?: string;
}

function ensureRoot(): void {
  mkdirSync(DEPLOYMENT_ROOT, { recursive: true });
}

function recordPath(id: string): string {
  return join(DEPLOYMENT_ROOT, `${validateStateId(id, "deployment id")}.json`);
}

function save(record: DeploymentRecord): DeploymentRecord {
  ensureRoot();
  writeFileSync(recordPath(record.id), JSON.stringify(record, null, 2), "utf8");
  return record;
}

export function startDeployment(input: Omit<DeploymentRecord, "id" | "status" | "startedAt" | "rollback"> & {
  rollbackRequested: boolean;
}): DeploymentRecord {
  return save({
    id: `deploy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId: input.userId,
    username: input.username,
    project: input.project,
    environment: input.environment,
    host: input.host,
    branch: input.branch,
    status: "running",
    startedAt: new Date().toISOString(),
    rollback: {
      requested: input.rollbackRequested,
      attempted: false,
      status: input.rollbackRequested ? "not-needed" : "not-requested",
    },
  });
}

export function finishDeployment(
  id: string,
  updates: Pick<DeploymentRecord, "status" | "rollback"> &
    Partial<Pick<DeploymentRecord, "commitBefore" | "commitAfter" | "output" | "outputTruncated" | "outputLength" | "error">>
): DeploymentRecord {
  const existing = getDeployment(id);
  if (!existing) throw new Error(`Deployment '${id}' not found`);
  return save({ ...existing, ...updates, finishedAt: new Date().toISOString() });
}

export function getDeployment(id: string): DeploymentRecord | undefined {
  ensureRoot();
  const path = recordPath(id);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as DeploymentRecord;
}
