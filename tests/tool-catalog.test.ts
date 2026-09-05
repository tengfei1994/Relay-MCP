import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "fs";
import { TOOL_CATALOG } from "../src/shared/tool-catalog.ts";
import { SAMPLEMANAGER_ENTITY_CATALOG } from "../src/shared/samplemanager-capabilities.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerToolsForUser } from "../src/mcp/register-tools.ts";

const mcpBaseline = JSON.parse(readFileSync(new URL("./fixtures/mcp-tools-baseline.json", import.meta.url), "utf8")) as {
  schemaVersion: number;
  generatedFrom: string;
  sourceVersion: {
    gitCommit: string;
    mcpSdkVersion: string;
    generationCommand: string;
    generatedAt: string;
    worktreeDirty: boolean;
  };
  tools: Array<{ name: string; description?: string; inputSchema?: unknown; annotations?: unknown; execution?: unknown }>;
  legacyAliases: Record<string, string>;
  capabilityMatrix: Array<{ name: string; category: string; entity?: string; capability?: string }>;
};

function normalizeRuntimeTool(tool: { name: string; description?: string; inputSchema?: unknown; annotations?: unknown; execution?: unknown }) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? null,
    execution: tool.execution ?? null,
  };
}

const registrarSource = () => [
  "../src/mcp/register-tools.ts",
  "../src/mcp/tools/project.ts",
  "../src/mcp/tools/remote.ts",
  "../src/mcp/tools/workspace.ts",
  "../src/mcp/tools/jobs.ts",
  "../src/mcp/tools/playwright.ts",
  "../src/mcp/tools/samplemanager.ts",
  "../src/mcp/tools/knowledge.ts",
  "../src/mcp/tools/diagnostics.ts",
  "../src/mcp/tools/deployment.ts",
  "../src/mcp/tools/deployment-logs.ts",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");

test("every registered MCP tool is categorized and described exactly once", () => {
  const source = registrarSource();
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const registered = [
    ...source.matchAll(/server\.tool\(\s*"([^"]+)"/g),
    ...source.matchAll(/registerRelayAlias\([^,]+,\s*"([^"]+)"/g),
  ].map((match) => match[1]).sort();
  const catalogued = TOOL_CATALOG.map((entry) => entry.name).sort();
  assert.deepEqual(catalogued, registered);
  assert.equal(new Set(catalogued).size, catalogued.length);
  for (const entry of TOOL_CATALOG) {
    assert.ok(entry.category);
    assert.ok(entry.description.length >= 12);
    assert.ok(readme.includes(`\`${entry.name}\``), `README is missing ${entry.name}`);
    if (entry.category === "samplemanager" && entry.entity) {
      const entity = SAMPLEMANAGER_ENTITY_CATALOG.find((item) => item.id === entry.entity);
      assert.ok(entity, `Unknown SampleManager entity '${entry.entity}' for ${entry.name}`);
      if (entry.capability) {
        assert.ok(entity.inspectors.some((item) => item.id === entry.capability), `Unknown capability '${entry.entity}.${entry.capability}' for ${entry.name}`);
      }
    }
  }
});

test("runtime MCP tools/list matches the catalog and exposes concrete schemas", async () => {
  const server = new McpServer({ name: "contract-test", version: "test" });
  const registry = new Proxy({}, { get: () => () => [] });
  registerToolsForUser({ id: 7, username: "tester", allowAllProjects: true }, { server, registry: registry as any });
  const handlers = (server.server as any)._requestHandlers as Map<string, (request: unknown, extra?: unknown) => Promise<unknown> | unknown>;
  const handler = handlers.get("tools/list");
  assert.ok(handler, "McpServer did not install the tools/list handler");
  const result = await handler({ method: "tools/list", params: {} });
  const tools = (result as { tools: Array<{ name: string; inputSchema?: unknown; description?: string; annotations?: unknown }> }).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOL_CATALOG.map((entry) => entry.name).sort());
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length >= 12, `${tool.name} has no runtime description`);
    assert.ok(tool.inputSchema && typeof tool.inputSchema === "object", `${tool.name} has no runtime input schema`);
  }
  const wait = tools.find((tool) => tool.name === "job_wait");
  assert.deepEqual(wait?.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});

test("runtime tools/list matches the versioned P00 contract snapshot", async () => {
  assert.equal(mcpBaseline.schemaVersion, 1);
  assert.equal(mcpBaseline.generatedFrom, "McpServer tools/list");
  assert.match(mcpBaseline.sourceVersion.gitCommit, /^(?:[0-9a-f]{40}|unknown)$/i);
  assert.match(mcpBaseline.sourceVersion.mcpSdkVersion, /^(?:\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?|unknown)$/);
  assert.equal(mcpBaseline.sourceVersion.generationCommand, "npm run generate:mcp-baseline");
  assert.doesNotThrow(() => new Date(mcpBaseline.sourceVersion.generatedAt).toISOString());
  assert.equal(typeof mcpBaseline.sourceVersion.worktreeDirty, "boolean");
  const server = new McpServer({ name: "contract-snapshot-test", version: "test" });
  const registry = new Proxy({}, { get: () => () => [] });
  registerToolsForUser({ id: 7, username: "tester", allowAllProjects: true }, { server, registry: registry as any });
  const handlers = (server.server as any)._requestHandlers as Map<string, (request: unknown, extra?: unknown) => Promise<unknown> | unknown>;
  const listed = await handlers.get("tools/list")?.({ method: "tools/list", params: {} }) as { tools: Array<{ name: string; description?: string; inputSchema?: unknown; annotations?: unknown; execution?: unknown }> };
  assert.deepEqual(
    listed.tools.map(normalizeRuntimeTool).sort((a, b) => a.name.localeCompare(b.name)),
    mcpBaseline.tools.map(normalizeRuntimeTool).sort((a, b) => a.name.localeCompare(b.name)),
    "runtime tool names, descriptions, input schemas, annotations, and execution hints must match the frozen baseline",
  );

  const infoHandler = (server as any)._registeredTools?.relay_mcp_info?.handler as ((args: unknown) => Promise<{ content?: Array<{ text?: string }> }>);
  assert.ok(infoHandler, "relay_mcp_info handler must be available for alias-contract verification");
  const info = await infoHandler({});
  const metadata = JSON.parse(info.content?.[0]?.text ?? "{}");
  assert.deepEqual(metadata.legacyAliases, mcpBaseline.legacyAliases);

  const currentCapabilities = TOOL_CATALOG.map((entry) => ({
    name: entry.name,
    category: entry.category,
    ...(entry.entity ? { entity: entry.entity } : {}),
    ...(entry.capability ? { capability: entry.capability } : {}),
  }));
  assert.deepEqual(currentCapabilities, mcpBaseline.capabilityMatrix, "the frozen capability matrix must be reviewed with catalog changes");
});

test("form cache cleanup is classified as a mutating tool", () => {
  const source = readFileSync(new URL("../src/server/routes/tools.ts", import.meta.url), "utf8");
  const mutationPattern = source.match(/const mutating = \/\(\^\|_\)\((?<operations>[^)]+)\)/)?.groups?.operations ?? "";
  assert.match(mutationPattern, /(^|\|)clear(\||$)/);
});

test("job wait is exposed as a categorized MCP tool", () => {
  assert.ok(TOOL_CATALOG.some((entry) => entry.name === "job_wait" && entry.category === "jobs"));
});

test("SampleManager form and assembly inspectors are categorized semantic tools", () => {
  assert.ok(TOOL_CATALOG.some((entry) => entry.name === "samplemanager_inspect_assembly_type" && entry.entity === "deployment"));
  assert.ok(TOOL_CATALOG.some((entry) => entry.name === "samplemanager_validate_form_task_contract" && entry.entity === "form_task" && entry.capability === "contract"));
  assert.ok(TOOL_CATALOG.some((entry) => entry.name === "samplemanager_create_deployment_manifest" && entry.entity === "deployment"));
});

test("SampleManager deployment start persists the resolved project link environment", () => {
  const source = registrarSource();
  const block = source.match(/server\.tool\(\s*"samplemanager_deployment_start"[\s\S]*?(?=\n\s*server\.tool\()/)?.[0] ?? "";
  assert.match(block, /environment:\s*ps\.environment/);
  assert.doesNotMatch(block, /environment:\s*environment\s*\?\?/);
});

test("table-loader package preserves unknown timeout status from deployment steps", () => {
  const source = registrarSource();
  const block = source.match(/server\.tool\(\s*"samplemanager_deploy_table_loader_package"[\s\S]*?(?=\n\s*server\.tool\()/)?.[0] ?? "";
  assert.match(block, /catch \(error\)[\s\S]*deploymentFailureDisposition\(error/);
  assert.doesNotMatch(block, /catch \(error\)[\s\S]*?status:\s*"failed"/);
});
