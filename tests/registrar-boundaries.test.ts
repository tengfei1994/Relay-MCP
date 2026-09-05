import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_CATALOG } from "../src/shared/tool-catalog.ts";
import { registerProjectTools } from "../src/mcp/tools/project.ts";
import { registerRemoteTools } from "../src/mcp/tools/remote.ts";
import { registerWorkspaceTools } from "../src/mcp/tools/workspace.ts";
import { registerPlaywrightTools } from "../src/mcp/tools/playwright.ts";
import { registerSampleManagerTools } from "../src/mcp/tools/samplemanager.ts";
import { registerDeploymentTools } from "../src/mcp/tools/deployment.ts";
import { registerDeploymentLogTools } from "../src/mcp/tools/deployment-logs.ts";
import { registerJobTools } from "../src/mcp/tools/jobs.ts";
import { registerKnowledgeTools } from "../src/mcp/tools/knowledge.ts";
import { registerDiagnosticTools } from "../src/mcp/tools/diagnostics.ts";

function registeredNames(server: McpServer): string[] {
  return Object.keys((server as any)._registeredTools ?? {});
}

function registeredEntries(server: McpServer): Record<string, { inputSchema?: unknown; annotations?: unknown; description?: string }> {
  return (server as any)._registeredTools ?? {};
}

function makeServer(): McpServer {
  return new McpServer({ name: "boundary-test", version: "test" });
}

const user = { id: 1, username: "boundary" };
const neverExecuted = () => {
  throw new Error("boundary tests never execute remote calls");
};

// Registration-time dependencies only: handlers are wired but never invoked here.
const baseContext = {
  user,
  registry: new Proxy({}, { get: () => () => [] }),
  resolveProjectName: () => "Demo",
  listAllowedProjects: () => [],
  projectLinkSummaries: () => [],
  assertServerAllowed: () => undefined,
  getRunner: neverExecuted,
  getSampleManagerDatabaseTarget: neverExecuted,
  relayRoute: (tool: string) => ({ route: "relay_mcp", tool, transport: "mcp" }),
  executionForJob: () => ({}),
  waitForTrackedJob: async () => undefined,
  relayPublicUrl: "http://localhost:3000",
  relayMcpVersion: "test",
  mcpPort: 3001,
};

function registerByDomain(): Record<string, string[]> {
  const domains: Record<string, (server: McpServer) => void> = {
    project: (server) => registerProjectTools({ ...baseContext, server } as any),
    // The remote alias block wraps project_server_links_list, so the project
    // tools must exist first — exactly as in the composition root. Only the
    // tools added by the remote registrar itself are attributed to it.
    remote: (server) => {
      registerProjectTools({ ...baseContext, server } as any);
      const before = new Set(registeredNames(server));
      registerRemoteTools({ ...baseContext, server } as any);
      (server as any)._boundaryOwned = registeredNames(server).filter((name) => !before.has(name));
    },
    workspace: (server) => registerWorkspaceTools({ ...baseContext, server } as any),
    playwright: (server) => registerPlaywrightTools({ ...baseContext, server } as any),
    samplemanager: (server) => registerSampleManagerTools({ ...baseContext, server } as any),
    deployment: (server) => registerDeploymentTools({ ...baseContext, server } as any),
    "deployment-logs": (server) => registerDeploymentLogTools({ server, user, resolveProjectName: baseContext.resolveProjectName, getRunner: baseContext.getRunner }),
    jobs: (server) => registerJobTools({ server, user, resolveProjectName: baseContext.resolveProjectName }),
    knowledge: (server) => registerKnowledgeTools(server),
    diagnostics: (server) => registerDiagnosticTools(server),
  };
  const result: Record<string, string[]> = {};
  for (const [name, register] of Object.entries(domains)) {
    const server = makeServer();
    register(server);
    const owned = (server as any)._boundaryOwned as string[] | undefined;
    result[name] = (owned ?? registeredNames(server)).sort();
  }
  return result;
}

test("every registrar owns an exact tool set, domains never overlap, and the union equals the catalog", () => {
  const sets = registerByDomain();

  assert.deepEqual(sets.knowledge, ["knowledge_evidence_get", "knowledge_feedback", "knowledge_get", "knowledge_ingest", "knowledge_playbook_get", "knowledge_reindex", "knowledge_relation_query", "knowledge_search"]);
  assert.deepEqual(sets.diagnostics, ["samplemanager_diagnose", "samplemanager_impact_analysis"]);

  const seen = new Map<string, string>();
  for (const [domain, tools] of Object.entries(sets)) {
    for (const tool of tools) {
      assert.ok(!seen.has(tool), `tool '${tool}' is registered by both '${seen.get(tool)}' and '${domain}'`);
      seen.set(tool, domain);
    }
  }

  const catalogued = TOOL_CATALOG.map((entry) => entry.name).sort();
  assert.deepEqual([...seen.keys()].sort(), catalogued, "union of domain registrations must equal the tool catalog exactly");

  // Spot-check domain ownership that the refactor must preserve.
  assert.ok(sets.remote.includes("relay_exec_remote") && sets.remote.includes("exec_remote"));
  assert.ok(sets.remote.includes("relay_unicode_check"));
  assert.ok(sets.project.includes("relay_project_server_links_list") === false, "the project-links alias belongs to the remote alias block");
  assert.ok(sets.remote.includes("relay_project_server_links_list"));
  assert.ok(sets.playwright.every((tool) => tool.startsWith("playwright_")));
  assert.ok(sets.samplemanager.every((tool) => tool.startsWith("samplemanager_")));
  assert.ok(sets.samplemanager.length >= 20, "the SampleManager domain carries the full capability surface");
  assert.deepEqual(sets.jobs, ["context_record_fact", "context_search", "job_cancel", "job_list", "job_status", "job_wait"]);
});

test("relay aliases expose the same input schema as their source tools", () => {
  const server = makeServer();
  // project_server_links_list must exist before its alias is created.
  registerProjectTools({ ...baseContext, server } as any);
  registerRemoteTools({ ...baseContext, server } as any);
  const tools = registeredEntries(server);
  const pairs: Array<[string, string]> = [
    ["exec_remote", "relay_exec_remote"],
    ["exec_remote_powershell", "relay_exec_remote_powershell"],
    ["exec_remote_script", "relay_exec_remote_script"],
    ["project_server_links_list", "relay_project_server_links_list"],
  ];
  for (const [source, alias] of pairs) {
    assert.ok(tools[source], `missing source tool ${source}`);
    assert.ok(tools[alias], `missing alias ${alias}`);
    assert.equal(tools[alias].inputSchema, tools[source].inputSchema, `${alias} must reuse the ${source} schema`);
    assert.ok(tools[alias].description && tools[alias].description.length >= 12, `${alias} needs its own description`);
  }
});

test("legacy callback short-circuits domain registration without registering tools", () => {
  const server = makeServer();
  const context = { ...baseContext, server } as any;
  const called: string[] = [];
  registerRemoteTools(context, () => called.push("remote"));
  registerWorkspaceTools(context, () => called.push("workspace"));
  registerPlaywrightTools(context, () => called.push("playwright"));
  registerSampleManagerTools(context, () => called.push("samplemanager"));
  registerDeploymentTools(context, () => called.push("deployment"));
  assert.deepEqual(called, ["remote", "workspace", "playwright", "samplemanager", "deployment"]);
  assert.equal(registeredNames(server).length, 0);
});
