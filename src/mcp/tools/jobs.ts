import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cancelJob, getJob, listJobs, waitForJobRecord, writeAudit, type JobRecord } from "../../shared/job-store.js";
import { compactTextWithMetadata, summarizeJson } from "../../shared/output.js";
import { recordFact, searchFacts } from "../../shared/context-store.js";
import type { ResolveProjectName } from "../tool-context.js";

export interface JobToolsContext {
  server: McpServer;
  user: { id: number; username: string };
  resolveProjectName: ResolveProjectName;
}

function jobSnapshot(job: JobRecord) {
  return {
    ...job,
    executionState:
      job.status === "succeeded" ? "Completed"
      : job.status === "failed" ? "Failed"
      : job.status === "unknown" || job.status === "interrupted" ? "Unknown"
      : job.status === "cancelled" ? "Cancelled"
      : job.phase === "not_started" ? "NotStarted"
      : "Running",
    dispatchState:
      job.status === "unknown" || job.phase === "unknown" ? "remote_completion_unknown"
      : job.phase === "agent_claimed" ? "agent_claimed"
      : job.phase === "waiting_agent" ? "waiting_agent"
      : job.phase === "queued" ? "queued"
      : job.phase === "connecting" ? "connecting"
      : job.status === "succeeded" ? "completed"
      : job.status === "failed" ? "remote_or_relay_failed"
      : job.status,
    agentClaimedAt: job.logs?.find((entry) => entry.message === "phase=agent_claimed")?.at,
    logs: job.logs?.slice(-40),
    summary: job.summary ? compactTextWithMetadata(job.summary, 6000) : undefined,
  };
}

export function registerJobTools({ server, user, resolveProjectName }: JobToolsContext): void {
  server.tool(
    "job_status",
    "Get status/result for an asynchronous Relay-MCP job",
    { jobId: z.string().describe("Job id returned by an async tool") },
    async ({ jobId }) => {
      const job = getJob(jobId);
      if (!job || job.userId !== user.id) throw new Error(`Job '${jobId}' not found`);
      return { content: [{ type: "text", text: summarizeJson(jobSnapshot(job)) }] };
    },
  );

  server.tool(
    "job_wait",
    "Wait for an asynchronous Relay-MCP job to finish or change phase. A wait deadline returns the latest snapshot instead of changing the job status.",
    {
      jobId: z.string().describe("Job id returned by an async tool"),
      waitMs: z.number().int().min(0).max(110000).optional().describe("Maximum long-poll wait; default 90000."),
      pollMs: z.number().int().min(50).max(5000).optional().describe("Polling interval; default 500."),
      returnOnPhaseChange: z.boolean().optional().describe("Return when phase changes even if the job remains running."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ jobId, waitMs = 90000, pollMs = 500, returnOnPhaseChange = false }) => {
      const waited = await waitForJobRecord(jobId, user.id, { waitMs, pollMs, returnOnPhaseChange });
      const response = {
        ...jobSnapshot(waited.job),
        wait: { reason: waited.reason, waitedMs: waited.waitedMs, initialPhase: waited.initialPhase, finalPhase: waited.job.phase, terminal: waited.job.status !== "running" },
      };
      return { structuredContent: response, content: [{ type: "text", text: summarizeJson(response) }] };
    },
  );

  server.tool(
    "job_list",
    "List recent asynchronous Relay-MCP jobs for the current user",
    { limit: z.number().optional().describe("Maximum jobs to return (default 20)") },
    async ({ limit = 20 }) => {
      const jobs = listJobs(user.id, limit).map((job) => ({ ...job, logs: job.logs?.slice(-8), summary: job.summary ? compactTextWithMetadata(job.summary, 1200) : undefined }));
      return { content: [{ type: "text", text: summarizeJson(jobs) }] };
    },
  );

  server.tool(
    "job_cancel",
    "Request cancellation of a running asynchronous Relay-MCP job and close its active SSH command when supported.",
    {
      jobId: z.string().describe("Running job id returned by an async tool"),
      reason: z.string().max(2_000).optional().describe("Optional bounded reason retained with the cancellation event"),
    },
    async ({ jobId, reason }) => ({ content: [{ type: "text", text: summarizeJson(cancelJob(jobId, user.id, reason)) }] }),
  );

  server.tool(
    "context_record_fact",
    "Record a durable project fact so future LLM calls do not need chat history",
    {
      project: z.string().optional(),
      text: z.string().describe("Short fact, pitfall, path, or project convention"),
      tags: z.array(z.string()).optional(),
    },
    async ({ project, text, tags = [] }) => {
      const resolvedProjectName = resolveProjectName(project);
      const fact = recordFact(user, resolvedProjectName, text, tags);
      writeAudit({ userId: user.id, username: user.username, project: resolvedProjectName, tool: "context_record_fact", tags });
      return { content: [{ type: "text", text: summarizeJson(fact) }] };
    },
  );

  server.tool(
    "context_search",
    "Search durable project facts recorded on the MCP server",
    { project: z.string().optional(), query: z.string().optional(), limit: z.number().optional() },
    async ({ project, query = "", limit = 10 }) => {
      const resolvedProjectName = resolveProjectName(project);
      return { content: [{ type: "text", text: summarizeJson(searchFacts(user.id, resolvedProjectName, query, limit)) }] };
    },
  );
}
