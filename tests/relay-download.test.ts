import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("relay downloader resumes a 69 KB artifact and verifies size and SHA-256", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-download-client-"));
  const destination = join(root, "evidence.zip");
  const partial = `${destination}.part`;
  const bytes = Buffer.alloc(69_437);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(partial, bytes.subarray(0, 10_000));

  const server = createServer((req, res) => {
    assert.equal(req.headers["x-relay-download-token"], "test-token");
    const range = req.headers.range;
    const start = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0) : 0;
    res.statusCode = start > 0 ? 206 : 200;
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(bytes.length - start));
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Relay-Artifact-Bytes", String(bytes.length));
    res.setHeader("X-Relay-SHA256", sha256);
    if (start > 0) res.setHeader("Content-Range", `bytes ${start}-${bytes.length - 1}/${bytes.length}`);
    res.end(bytes.subarray(start));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port");
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "scripts/relay-download.mjs",
        "--url", `http://127.0.0.1:${address.port}/artifact`,
        "--token", "test-token",
        "--file", destination,
        "--expected-bytes", String(bytes.length),
        "--expected-sha256", sha256,
      ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(readFileSync(destination), bytes);
    assert.equal(existsSync(partial), false);
    const output = JSON.parse(result.stdout);
    assert.equal(output.resumedFrom, 10_000);
    assert.equal(output.sha256, sha256);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
