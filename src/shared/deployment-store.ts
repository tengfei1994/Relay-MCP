import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { validateStateId } from "./state-id.js";
import { emitRelayEvent, type RelayEventSink } from "../knowledge/event-sink.js";
import "dotenv/config";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const STATE_ROOT = process.env.RELAY_STATE_ROOT ?? join(WORKSPACE_ROOT, ".relay-mcp");
const DEPLOYMENT_ROOT = join(STATE_ROOT, "deployments");
let eventSink: RelayEventSink | undefined;
let resolveProjectId: ((userId: number, projectName: string) => number | undefined) | undefined;

export type DeploymentStatus = "running" | "succeeded" | "failed" | "unknown" | "needs-review" | "pending-validation";

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
  /** Persisted once the started event has been durably written to the spool. */
  startedEventEmittedAt?: string;
  finishedAt?: string;
  /** Persisted once the terminal event(s) are durably written to the spool. */
  terminalEventEmittedAt?: string;
  /** Preserves interrupted-vs-unknown semantics during startup recovery. */
  terminalEventKind?: "finished" | "failed" | "unknown" | "interrupted" | "needs-review" | "pending-validation";
  /** Stable project identity used to make terminal-event replay immutable. */
  projectIdSnapshot?: string;
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

function resolveProjectIdSnapshot(userId: number, projectName: string): string | undefined {
  try {
    const projectId = resolveProjectId?.(userId, projectName);
    return projectId === undefined ? undefined : String(projectId);
  } catch {
    // Project resolution is advisory for operational state. The event keeps
    // projectNameSnapshot so the capture worker can resolve it later.
    return undefined;
  }
}

function startedDeploymentEvent(record: Pick<DeploymentRecord, "id" | "userId" | "project" | "environment" | "instance" | "kind" | "startedAt" | "projectIdSnapshot">): Parameters<typeof emitRelayEvent>[1] {
  return {
    type: "deployment.started",
    eventKey: `deployment:${record.id}:started`,
    occurredAt: record.startedAt,
    actorId: record.userId,
    projectId: record.projectIdSnapshot,
    projectNameSnapshot: record.project,
    deploymentId: record.id,
    payload: { environment: record.environment, instance: record.instance, kind: record.kind },
  };
}

function emitStartedDeploymentEvent(record: DeploymentRecord): boolean {
  return emitRelayEvent(eventSink, startedDeploymentEvent(record));
}

function markStartedEventEmitted(record: DeploymentRecord): DeploymentRecord {
  const marked = { ...record, startedEventEmittedAt: new Date().toISOString() };
  save(marked);
  return marked;
}

function terminalDeploymentEvent(record: DeploymentRecord): Parameters<typeof emitRelayEvent>[1] | undefined {
  if (!record.finishedAt) return undefined;
  const eventKind = record.terminalEventKind ?? (record.status === "succeeded" ? "finished" : record.status === "failed" ? "failed" : record.status === "unknown" ? "unknown" : record.status === "needs-review" ? "needs-review" : record.status === "pending-validation" ? "pending-validation" : undefined);
  const eventType = eventKind === "finished" ? "deployment.finished"
    : eventKind === "failed" ? "deployment.failed"
      : eventKind === "unknown" ? "deployment.unknown"
        : eventKind === "interrupted" ? "deployment.interrupted"
          : eventKind === "needs-review" ? "deployment.needs_review"
            : eventKind === "pending-validation" ? "deployment.pending_validation"
          : undefined;
  if (!eventType || !eventKind) return undefined;
  return {
    type: eventType,
    eventKey: `deployment:${record.id}:${eventKind}`,
    occurredAt: record.finishedAt,
    actorId: record.userId,
    projectId: record.projectIdSnapshot,
    projectNameSnapshot: record.project,
    deploymentId: record.id,
    payload: {
      status: record.status,
      kind: record.kind,
      environment: record.environment,
      instance: record.instance,
      branch: record.branch,
      commitBefore: record.commitBefore,
      commitAfter: record.commitAfter,
      error: record.error,
      rollback: record.rollback,
      output: record.output,
      outputTruncated: record.outputTruncated,
      outputLength: record.outputLength,
      steps: record.steps,
      artifacts: record.artifacts,
      lastCompletedPhase: record.lastCompletedPhase,
      pendingPhases: record.pendingPhases,
      committedMutations: record.committedMutations,
      dryRunOnlyMutations: record.dryRunOnlyMutations,
      failedMutation: record.failedMutation,
      recommendedResumeAction: record.recommendedResumeAction,
    },
  };
}

function emitTerminal(record: DeploymentRecord): boolean {
  const event = terminalDeploymentEvent(record);
  if (!event) return false;
  let emitted = emitRelayEvent(eventSink, event);
  if (emitted && record.rollback.attempted && record.rollback.status === "succeeded") {
    emitted = emitRelayEvent(eventSink, {
      type: "deployment.rolled_back",
      eventKey: `deployment:${record.id}:rolled_back`,
      occurredAt: record.finishedAt,
      actorId: record.userId,
      projectId: record.projectIdSnapshot,
      projectNameSnapshot: record.project,
      deploymentId: record.id,
      payload: { environment: record.environment, instance: record.instance },
    });
  }
  return emitted;
}

function markTerminalEventEmitted(record: DeploymentRecord): DeploymentRecord {
  const marked = { ...record, terminalEventEmittedAt: new Date().toISOString() };
  save(marked);
  return marked;
}

/** Replay terminal records left without a durable event marker after a crash. */
export function recoverUnemittedTerminalDeploymentEvents(): number {
  ensureRoot();
  let count = 0;
  for (const name of readdirSync(DEPLOYMENT_ROOT)) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(DEPLOYMENT_ROOT, name), "utf8")) as DeploymentRecord;
      if (record.status === "running" || record.terminalEventEmittedAt || !record.finishedAt) continue;
      if (emitTerminal(record)) {
        markTerminalEventEmitted(record);
        count += 1;
      }
    } catch {
      // Preserve malformed records for manual inspection.
    }
  }
  return count;
}

/** Replay running records left without a durable started event after a crash. */
export function recoverUnemittedStartedDeploymentEvents(): number {
  ensureRoot();
  let count = 0;
  for (const name of readdirSync(DEPLOYMENT_ROOT)) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(DEPLOYMENT_ROOT, name), "utf8")) as DeploymentRecord;
      if (record.status !== "running" || record.startedEventEmittedAt || !record.startedAt) continue;
      if (emitStartedDeploymentEvent(record)) {
        markStartedEventEmitted(record);
        count += 1;
      }
    } catch {
      // Preserve malformed records for manual inspection.
    }
  }
  return count;
}

/** Composition-root injection point; never required for deployment availability. */
export function configureDeploymentStore(options: { eventSink?: RelayEventSink; resolveProjectId?: (userId: number, projectName: string) => number | undefined } = {}): void {
  eventSink = options.eventSink;
  resolveProjectId = options.resolveProjectId;
  recoverUnemittedStartedDeploymentEvents();
  recoverUnemittedTerminalDeploymentEvents();
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
  const projectIdSnapshot = resolveProjectIdSnapshot(input.userId, input.project);
  const record = save({
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
    ...(projectIdSnapshot !== undefined ? { projectIdSnapshot } : {}),
    rollback: {
      requested: input.rollbackRequested,
      attempted: false,
      status: input.rollbackRequested ? "not-needed" : "not-requested",
    },
  });
  if (emitStartedDeploymentEvent(record)) return markStartedEventEmitted(record);
  return record;
}

export function finishDeployment(
  id: string,
  updates: Pick<DeploymentRecord, "status" | "rollback"> &
  Partial<Pick<DeploymentRecord, "commitBefore" | "commitAfter" | "output" | "outputTruncated" | "outputLength" | "error" | "steps" | "artifacts" | "lastCompletedPhase" | "pendingPhases" | "committedMutations" | "dryRunOnlyMutations" | "failedMutation" | "recommendedResumeAction" | "idempotencyKeys">>
): DeploymentRecord {
  const existing = getDeployment(id);
  if (!existing) throw new Error(`Deployment '${id}' not found`);
  const record = save({ ...existing, ...updates, finishedAt: new Date().toISOString() });
  if (existing.status === "running" && record.status !== "running" && emitTerminal(record)) return markTerminalEventEmitted(record);
  return record;
}

export function updateDeployment(
  id: string,
  updates: Partial<Pick<DeploymentRecord, "status" | "output" | "outputTruncated" | "outputLength" | "error" | "steps" | "artifacts" | "rollback" | "lastCompletedPhase" | "pendingPhases" | "committedMutations" | "dryRunOnlyMutations" | "failedMutation" | "recommendedResumeAction" | "idempotencyKeys">>
): DeploymentRecord {
  const existing = getDeployment(id);
  if (!existing) throw new Error(`Deployment '${id}' not found`);
  const record = save({
    ...existing,
    ...updates,
    ...(existing.status === "running" && updates.status && updates.status !== "running" ? { finishedAt: new Date().toISOString() } : {}),
    artifacts: updates.artifacts === undefined
      ? existing.artifacts
      : { ...existing.artifacts, ...updates.artifacts },
  });
  if (existing.status === "running" && record.status !== "running" && emitTerminal(record)) return markTerminalEventEmitted(record);
  if (record.status !== "running" && !record.terminalEventEmittedAt && emitTerminal(record)) return markTerminalEventEmitted(record);
  return record;
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

/**
 * Startup recovery: deployments left in "running" by a crashed or restarted
 * Relay can never reach a terminal state on their own. Mark them unknown so
 * requireRunningDeployment() refuses to reuse them, and emit a terminal event
 * for the Knowledge Plane (spooled until the sink is configured).
 */
export function markInterruptedDeployments(): number {
  ensureRoot();
  recoverUnemittedStartedDeploymentEvents();
  let count = 0;
  for (const name of readdirSync(DEPLOYMENT_ROOT)) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(DEPLOYMENT_ROOT, name), "utf8")) as DeploymentRecord;
      if (record.status !== "running") continue;
      const projectIdSnapshot = record.projectIdSnapshot ?? resolveProjectIdSnapshot(record.userId, record.project);
      const terminal = {
        ...record,
        status: "unknown",
        terminalEventKind: "interrupted",
        finishedAt: new Date().toISOString(),
        error: record.error ?? "Relay MCP restarted before this deployment reached a terminal state; remaining steps and remote state are unknown",
        recommendedResumeAction: "Relay restarted while the deployment was running. Verify target state and collected evidence before any further operation; do not resume blindly.",
        ...(projectIdSnapshot !== undefined ? { projectIdSnapshot } : {}),
      } satisfies DeploymentRecord;
      save(terminal);
      if (emitRelayEvent(eventSink, {
        type: "deployment.interrupted",
        eventKey: `deployment:${record.id}:interrupted`,
        occurredAt: terminal.finishedAt,
        actorId: record.userId,
        projectId: terminal.projectIdSnapshot,
        projectNameSnapshot: record.project,
        deploymentId: record.id,
        payload: { status: "unknown", environment: record.environment, instance: record.instance, kind: record.kind, reason: "relay_restart" },
      })) markTerminalEventEmitted(terminal);
      count += 1;
    } catch {
      // Preserve malformed records for manual inspection.
    }
  }
  recoverUnemittedTerminalDeploymentEvents();
  return count;
}

markInterruptedDeployments();
