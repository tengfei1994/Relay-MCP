import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = resolve(root, "src/mcp/index.ts");
const indexSource = readFileSync(indexPath, "utf8");
const errors = [];

const indexLines = indexSource.split(/\r?\n/).length;
if (indexLines > 350) {
  errors.push(`src/mcp/index.ts has ${indexLines} lines; the P00 boundary limit is 350`);
}
if (/\bserver\.(?:tool|registerTool)\s*\(/.test(indexSource)) {
  errors.push("src/mcp/index.ts must not register MCP tools directly");
}

const registrarFiles = [
  "src/mcp/register-tools.ts",
  "src/mcp/tools/project.ts",
  "src/mcp/tools/remote.ts",
  "src/mcp/tools/workspace.ts",
  "src/mcp/tools/jobs.ts",
  "src/mcp/tools/playwright.ts",
  "src/mcp/tools/samplemanager.ts",
  "src/mcp/tools/knowledge.ts",
  "src/mcp/tools/diagnostics.ts",
  "src/mcp/tools/deployment.ts",
  "src/mcp/tools/deployment-logs.ts",
];

const registered = [];
for (const relativePath of registrarFiles) {
  const source = readFileSync(resolve(root, relativePath), "utf8");
  for (const match of source.matchAll(/server\.tool\(\s*"([^"]+)"/g)) registered.push(match[1]);
  for (const match of source.matchAll(/registerRelayAlias\(\s*"[^"]+"\s*,\s*"([^"]+)"/g)) registered.push(match[1]);
}

const catalogSource = readFileSync(resolve(root, "src/shared/tool-catalog.ts"), "utf8");
const catalogued = [...catalogSource.matchAll(/\{\s*name:\s*"([^"]+)"/g)].map((match) => match[1]);

function checkSet(label, values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const [value, count] of counts) {
    if (count > 1) errors.push(`${label} contains duplicate tool '${value}'`);
  }
  return new Set(values);
}

const registeredSet = checkSet("registrars", registered);
const catalogSet = checkSet("TOOL_CATALOG", catalogued);
for (const name of registeredSet) if (!catalogSet.has(name)) errors.push(`registered tool '${name}' is missing from TOOL_CATALOG`);
for (const name of catalogSet) if (!registeredSet.has(name)) errors.push(`TOOL_CATALOG tool '${name}' is not registered by a registrar`);

if (errors.length > 0) {
  console.error(["MCP boundary check failed:", ...errors.map((error) => `- ${error}`)].join("\n"));
  process.exitCode = 1;
} else {
  console.log(`MCP boundary check passed (${indexLines} lines, ${registeredSet.size} registered tools)`);
}
