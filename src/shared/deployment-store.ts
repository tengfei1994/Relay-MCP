import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { validateStateId } from "./state-id.js";
import "dotenv/config";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const STATE_ROOT = process.env.RELAY_STATE_ROOT ?? join(WORKSPACE_ROOT, ".relay-mcp");
const DEPLOYMENT_ROOT = join(STATE_ROOT, "deployments");

export type DeploymentStatus = "running" | "succeeded" | "failed" | "unknown";

export interface DeploymentRecord {
  id: string;
  userId: number;
  username: string;
  project: string;
  environment: string;
  host: string;
  branch?: string;
  kind?: "git" | "samplemanager-assembly" | "samplemanager-change-set";
  instance?: string;
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
  steps?: Array<{
    name: string;
    status: "pending" | "running" | "succeeded" | "failed" | "rolled-back" | "unknown";
    startedAt?: string;
    finishedAt?: string;
    summary?: string;
    error?: string;
  }>;
  artifacts?: Record<string, unknown>;
  lastCompletedPhase?: string;
  pendingPhases?: string[];
  committedMutations?: string[];
  dryRunOnlyMutations?: string[];
  failedMutation?: string;
  recommendedResumeAction?: string;
  idempotencyKeys?: Record<string, {
    status: "running" | "dry_run" | "succeeded" | "failed" | "unknown";
    at: string;
    result?: unknown;
  }>;
}

export function deploymentFailureDisposition(
  error: unknown,
  options: { rollbackRequested: boolean; backupAvailable: boolean }
): {
  status: "failed" | "unknown";
  stepStatus: "failed" | "unknown";
  rollbackAllowed: boolean;
  retrySafe: boolean;
  category: string;
} {
  const category = error instanceof Error && "category" in error
    ? String((error as Error & { category?: string }).category ?? "unknown")
    : "unknown";
  const executionUnknown = category === "timeout";
  return {
    status: executionUnknown ? "unknown" : "failed",
    stepStatus: executionUnknown ? "unknown" : "failed",
    rollbackAllowed: !executionUnknown && options.rollbackRequested && options.backupAvailable,
    retrySafe: false,
    category,
  };
}

export interface DeploymentReuseTarget {
  userId: number;
  project: string;
  environment: string;
  instance: string;
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
    kind: input.kind,
    instance: input.instance,
    steps: input.steps,
    artifacts: input.artifacts,
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
  Partial<Pick<DeploymentRecord, "commitBefore" | "commitAfter" | "output" | "outputTruncated" | "outputLength" | "error" | "steps" | "artifacts" | "lastCompletedPhase" | "pendingPhases" | "committedMutations" | "dryRunOnlyMutations" | "failedMutation" | "recommendedResumeAction" | "idempotencyKeys">>
): DeploymentRecord {
  const existing = getDeployment(id);
  if (!existing) throw new Error(`Deployment '${id}' not found`);
  return save({ ...existing, ...updates, finishedAt: new Date().toISOString() });
}

export function updateDeployment(
  id: string,
  updates: Partial<Pick<DeploymentRecord, "status" | "output" | "outputTruncated" | "outputLength" | "error" | "steps" | "artifacts" | "rollback" | "lastCompletedPhase" | "pendingPhases" | "committedMutations" | "dryRunOnlyMutations" | "failedMutation" | "recommendedResumeAction" | "idempotencyKeys">>
): DeploymentRecord {
  const existing = getDeployment(id);
  if (!existing) throw new Error(`Deployment '${id}' not found`);
  return save({
    ...existing,
    ...updates,
    artifacts: updates.artifacts === undefined
      ? existing.artifacts
      : { ...existing.artifacts, ...updates.artifacts },
  });
}

export function appendDeploymentOperationArtifact(
  id: string,
  operation: Record<string, unknown>,
  latestCompatibilityFields: Record<string, unknown> = {}
): DeploymentRecord {
  const existing = getDeployment(id);
  if (!existing) throw new Error(`Deployment '${id}' not found`);
  const currentOperations = Array.isArray(existing.artifacts?.operations)
    ? existing.artifacts.operations
    : [];
  return updateDeployment(id, {
    artifacts: {
      ...latestCompatibilityFields,
      operations: [...currentOperations, operation],
    },
  });
}

export function getDeployment(id: string): DeploymentRecord | undefined {
  ensureRoot();
  const path = recordPath(id);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as DeploymentRecord;
}

export function requireRunningDeployment(
  id: string,
  target: DeploymentReuseTarget
): DeploymentRecord {
  const deployment = getDeployment(id);
  if (!deployment || deployment.userId !== target.userId || deployment.project !== target.project) {
    throw new Error(`Deployment '${id}' not found for project '${target.project}'`);
  }
  if (deployment.status !== "running") {
    throw new Error(`Deployment '${id}' is '${deployment.status}' and cannot accept new operations`);
  }
  if (deployment.environment.localeCompare(target.environment, undefined, { sensitivity: "accent" }) !== 0) {
    throw new Error(`Deployment '${id}' environment '${deployment.environment}' does not match '${target.environment}'`);
  }
  if (!deployment.instance || deployment.instance.localeCompare(target.instance, undefined, { sensitivity: "accent" }) !== 0) {
    throw new Error(`Deployment '${id}' instance '${deployment.instance}' does not match '${target.instance}'`);
  }
  return deployment;
}
