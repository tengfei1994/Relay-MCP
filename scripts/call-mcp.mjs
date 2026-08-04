import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [toolName, argsJson = "{}"] = process.argv.slice(2);
const endpoint = process.env.RELAY_MCP_URL ?? "http://ftd1994.mycloudnas.com:7231/mcp";
const token = process.env.RELAY_MCP_TOKEN;

if (!token) {
  throw new Error("RELAY_MCP_TOKEN is not set");
}

const url = new URL(endpoint);
url.searchParams.set("token", token);

const client = new Client(
  { name: "codex-relay-direct", version: "1.0.0" },
  { capabilities: {} },
);

const transport = new StreamableHTTPClientTransport(url);

try {
  await client.connect(transport);

  if (!toolName || toolName === "--list") {
    const result = await client.listTools();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const args = JSON.parse(argsJson);
    const result = await client.callTool({ name: toolName, arguments: args });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} finally {
  await client.close();
}
