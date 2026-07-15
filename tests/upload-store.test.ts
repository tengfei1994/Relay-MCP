import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

test("upload sessions authenticate tokens and record completion metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-upload-"));
  process.env.RELAY_STATE_ROOT = root;
  try {
    const store = await import(`../src/shared/upload-store.ts?test=${Date.now()}`);
    const { session, token } = store.createUploadSession({
      userId: 1,
      projectId: 2,
      project: "demo",
      path: "artifacts/file.dll",
      maxBytes: 1024,
      expectedSha256: "a".repeat(64),
    });
    assert.equal(store.authenticateUploadSession(session.id, token).status, "pending");
    assert.throws(() => store.authenticateUploadSession(session.id, "wrong-token"), /Invalid upload token/);

    const completed = store.completeUploadSession(session.id, 128, "a".repeat(64));
    assert.equal(completed.status, "completed");
    assert.equal(completed.bytesWritten, 128);
    assert.equal("tokenHash" in store.publicUploadSession(completed), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
