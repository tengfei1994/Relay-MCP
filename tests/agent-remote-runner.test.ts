import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentRemoteRunner } from "../src/shared/agent-remote-runner.ts";

test("Agent upload splits large files into bounded PowerShell chunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-agent-upload-"));
  const path = join(root, "payload.bin");
  const payload = Buffer.alloc(150_000);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  writeFileSync(path, payload);
  const previousChunkSize = process.env.RELAY_AGENT_UPLOAD_CHUNK_BYTES;
  process.env.RELAY_AGENT_UPLOAD_CHUNK_BYTES = String(64 * 1024);
  try {
    const scripts: string[] = [];
    const runner = new AgentRemoteRunner(7, "demo-agent");
    runner.execPowerShell = async (script: string) => {
      scripts.push(script);
      return { stdout: "", stderr: "", code: 0 };
    };

    await runner.uploadFile(path, "C:\\Relay\\payload.bin");

    assert.equal(scripts.length, 4);
    assert.match(scripts[0], /WriteAllBytes/);
    assert.ok(scripts.slice(1).every((script) => script.includes("FileMode]::Append")));
    const chunks = scripts.slice(1).map((script) => {
      const encoded = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
      assert.ok(encoded);
      return Buffer.from(encoded, "base64");
    });
    assert.deepEqual(Buffer.concat(chunks), payload);
    assert.ok(Math.max(...scripts.map((script) => script.length)) < 100_000);
  } finally {
    if (previousChunkSize === undefined) delete process.env.RELAY_AGENT_UPLOAD_CHUNK_BYTES;
    else process.env.RELAY_AGENT_UPLOAD_CHUNK_BYTES = previousChunkSize;
    rmSync(root, { recursive: true, force: true });
  }
});
