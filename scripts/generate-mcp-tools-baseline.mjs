import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerToolsForUser } from "../src/mcp/register-tools.ts";
import { TOOL_CATALOG } from "../src/shared/tool-catalog.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "tests/fixtures/mcp-tools-baseline.json");
const generationCommand = "npm run generate:mcp-baseline";

function gitOutput(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function readMcpSdkVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(root, "node_modules/@modelcontextprotocol/sdk/package.json"), "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

function normalizeTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? null,
    execution: tool.execution ?? null,
  };
}

const server = new McpServer({ name: "contract-baseline-generator", version: "baseline" });
// Registration must not open the application database or invoke a tool handler.
const registry = new Proxy({}, { get: () => () => [] });
registerToolsForUser(
  { id: 7, username: "baseline-generator", allowAllProjects: true },
  { server, registry },
);

const handlers = server.server._requestHandlers;
const listHandler = handlers.get("tools/list");
if (!listHandler) throw new Error("McpServer did not install a tools/list handler");
const listed = await listHandler({ method: "tools/list", params: {} });
const tools = listed.tools.map(normalizeTool).sort((left, right) => left.name.localeCompare(right.name));

const infoHandler = server._registeredTools?.relay_mcp_info?.handler;
if (!infoHandler) throw new Error("relay_mcp_info handler is required to capture legacy aliases");
const info = await infoHandler({});
const metadata = JSON.parse(info.content?.[0]?.text ?? "{}");

const sourceVersion = {
  gitCommit: gitOutput(["rev-parse", "HEAD"]) || "unknown",
  mcpSdkVersion: readMcpSdkVersion(),
  generationCommand,
  generatedAt: new Date().toISOString(),
  worktreeDirty: Boolean(gitOutput(["status", "--porcelain"])),
};

const baseline = {
  schemaVersion: 1,
  generatedFrom: "McpServer tools/list",
  sourceVersion,
  tools,
  legacyAliases: metadata.legacyAliases ?? {},
  capabilityMatrix: TOOL_CATALOG.map((entry) => ({
    name: entry.name,
    category: entry.category,
    ...(entry.entity ? { entity: entry.entity } : {}),
    ...(entry.capability ? { capability: entry.capability } : {}),
  })),
};

writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
console.log(`Wrote ${tools.length} MCP tool contract(s) to ${outputPath}`);
console.log(`Source commit: ${sourceVersion.gitCommit}; MCP SDK: ${sourceVersion.mcpSdkVersion}`);
