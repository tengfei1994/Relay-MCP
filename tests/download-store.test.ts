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
      bytes: 69437,
      sha256: "d046e6eede14bc8f5da5171f838dd59a4d8514950e5e01b374fed2b5be77d833",
      contentType: "application/zip",
      fileName: "package.smpkg",
      mtimeMs: 123456789,
    });
    const authenticated = store.authenticateDownloadSession(session.id, token);
    assert.equal(authenticated.path, "artifacts/package.smpkg");
    assert.equal(authenticated.bytes, 69437);
    assert.equal(authenticated.contentType, "application/zip");
    assert.equal(authenticated.sha256, "d046e6eede14bc8f5da5171f838dd59a4d8514950e5e01b374fed2b5be77d833");
    assert.throws(() => store.authenticateDownloadSession(session.id, "wrong-token"), /Invalid download token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
