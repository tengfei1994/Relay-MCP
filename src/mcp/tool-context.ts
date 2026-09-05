import type { ProjectInfo, ProjectServer, LimsInstanceInfo } from "./project-registry.js";
import type { JobContext, JobRecord } from "../shared/job-store.js";
import type { RemoteRunner } from "../shared/remote-runner.js";

/** Exact selector accepted by every project/server-aware registrar. */
export interface ProjectSelector {
  serverId?: number;
  serverName?: string;
}

/** The resolved project, link and remote runner selected for one MCP call. */
export interface RunnerConnection {
  project: ProjectInfo;
  ps: ProjectServer;
  runner: RemoteRunner;
}

export type ResolveProjectName = (project?: string) => string;
export type GetRunner = (
  project?: string,
  environment?: string,
  selector?: ProjectSelector,
) => RunnerConnection;

export type ExecutionForJob = (context?: JobContext) => Record<string, unknown>;
export type WaitForTrackedJob = (jobId: string, waitMs: number) => Promise<JobRecord | undefined>;

export interface ProjectLinkSummary {
  linkId: number;
  serverId: number;
  serverName: string;
  displayName: string;
  environment: string;
  connectionMode: "ssh" | "agent";
  status: string;
  host?: string;
  agentId?: string;
  remotePath: string;
  limsInstance?: Pick<
    LimsInstanceInfo,
    "id" | "name" | "version" | "runtimeKind" | "databaseHost" | "databaseName"
  >;
}

export interface SampleManagerDatabaseTarget extends RunnerConnection {
  database: string;
  databaseHost: string;
  configuredInstance?: LimsInstanceInfo;
}
