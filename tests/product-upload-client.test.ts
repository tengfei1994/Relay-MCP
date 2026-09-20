import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

test("product upload uses top-level URL and capability token from the API", async () => {
  const source = readFileSync(new URL("../frontend/src/pages/KnowledgeProduct.tsx", import.meta.url), "utf8");
  const functionSource = source.slice(source.indexOf("  const uploadFile ="), source.indexOf("  const submit ="));
  const calls: any[] = [];
  const file = { name: "21.1 Docs.zip" };
  const uploadFile = runInNewContext(ts.transpile(`${functionSource}\nuploadFile;`), {
    localStorage: { getItem: () => "test-auth" },
    fetch: async (url: string, options: any) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ upload: { path: "knowledge/product-docs/21.1 Docs.zip", status: "pending" }, token: "test-capability", uploadUrl: "/api/uploads/test-session" }) };
    },
  });
  assert.equal(await uploadFile(file, 7), "knowledge/product-docs/21.1 Docs.zip");
  assert.equal(calls[1].url, "/api/uploads/test-session");
  assert.equal(calls[1].options.headers["X-Relay-Upload-Token"], "test-capability");
  assert.equal(calls[1].options.body, file);
});
