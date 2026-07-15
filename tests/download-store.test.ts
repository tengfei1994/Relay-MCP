import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

test("download sessions authenticate a short-lived capability token", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-download-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/download-store.ts?test=${Date.now()}`);
    const { session, token } = store.createDownloadSession({
      userId: 1,
      projectId: 2,
      project: "demo",
      path: "artifacts/package.smpkg",
    });
    assert.equal(store.authenticateDownloadSession(session.id, token).path, "artifacts/package.smpkg");
    assert.throws(() => store.authenticateDownloadSession(session.id, "wrong-token"), /Invalid download token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
