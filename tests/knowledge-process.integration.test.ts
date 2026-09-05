import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";

test("a separate process closes the Job/Deployment spool-to-Candidate loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-process-"));
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const cli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const childScript = fileURLToPath(new URL("./knowledge-process-child.ts", import.meta.url));
  const child = spawn(process.execPath, [cli, childScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      WORKSPACE_ROOT: root,
      RELAY_STATE_ROOT: root,
      DB_PATH: join(root, "app.db"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

  try {
    const result = await Promise.race([
      once(child, "exit").then(([code, signal]) => ({ code, signal })),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("process e2e timed out")), 15_000)),
    ]);
    assert.equal(result.code, 0, stderr);
    const payload = JSON.parse(stdout) as { jobStatus: string; captured: number; documents: Array<{ kind: string; body: string }> };
    assert.equal(payload.jobStatus, "succeeded");
    assert.equal(payload.captured, 0, "routine success events are telemetry-only");
    assert.equal(payload.documents.filter((document) => document.kind === "candidate").length, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
