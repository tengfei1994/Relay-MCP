// Local-only browser fixture. Run after npm run build; never points at production.
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "relay-provider-browser-"));
Object.assign(process.env, {
  NODE_ENV: "test", HOST: "127.0.0.1", PORT: "19742", DB_PATH: join(root, "app.db"),
  KNOWLEDGE_DB_PATH: join(root, "knowledge.db"), RELAY_STATE_ROOT: root,
  PROVIDER_SECRET_KEY_FILE: join(root, "provider.key"), JWT_SECRET: "browser-fixture-jwt-secret-at-least-32-characters",
});
const gateway = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (!["Bearer e2e-provider-token", "Bearer e2e-replacement-token"].includes(String(req.headers.authorization))) {
    res.writeHead(401); res.end(JSON.stringify({ error: "Unauthorized" })); return;
  }
  let payload = "";
  for await (const chunk of req) payload += chunk;
  if (req.url === "/models-unavailable/models" || req.url === "/embedding-unavailable/embeddings") {
    res.setHeader("x-request-id", "fixture-gateway-request-502");
    res.writeHead(502); res.end(JSON.stringify({ error: "private gateway detail" })); return;
  }
  if (["/v1/models", "/embedding-unavailable/models"].includes(req.url ?? "") && req.method === "GET") {
    res.end(JSON.stringify({ data: [{ id: "fixture-embedding" }, { id: "fixture-chat" }, { id: "fixture-rerank" }] })); return;
  }
  const body = JSON.parse(payload || "{}");
  if (req.url === "/v1/embeddings" && body.model === "fixture-embedding") res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
  else if (req.url === "/v1/chat/completions" && body.model === "fixture-chat") res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  else if (req.url === "/v1/rerank" && body.model === "fixture-rerank") res.end(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }));
  else { res.writeHead(400); res.end(JSON.stringify({ error: "Model does not support this purpose" })); }
});
await new Promise<void>((resolve) => gateway.listen(19743, "127.0.0.1", resolve));
await import("../../dist/server/index.js");
const registered = await fetch("http://127.0.0.1:19742/api/auth/register", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "browseradmin", password: "local-browser-fixture" }),
});
if (!registered.ok) throw new Error("Unable to register local fixture admin");
console.log("Browser fixture ready: http://127.0.0.1:19742; gateway http://127.0.0.1:19743");
console.log("Temporary state directory: " + root);
