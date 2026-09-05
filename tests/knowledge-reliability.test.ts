import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { assertKnowledgeDbIsolated, canonicalPath, pathsEqual } from "../src/shared/canonical-path.ts";
import { parseBoundedNumber } from "../src/shared/runtime-config.ts";

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}

test("knowledge and operational database paths compare canonically", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-paths-"));
  try {
    const appPath = join(root, "data", "app.db");
    const alias = join(root, "data", ".", "app.db");
    assert.equal(pathsEqual(appPath, alias), true);
    assert.equal(canonicalPath(alias), canonicalPath(appPath));
    assert.throws(() => assertKnowledgeDbIsolated(alias, appPath), /must point to different files/);
    assert.throws(() => createKnowledgeStore({ dbPath: alias, appDbPath: appPath }), /must point to different files/);
    assert.equal(existsSync(appPath), false, "the isolation check must run before creating the Knowledge database");
  } finally {
    cleanup(root);
  }
});

test("migration failures close the native SQLite handle before rethrowing", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-knowledge-migration-close-"));
  const dbPath = join(root, "knowledge.db");
  try {
    const raw = new Database(dbPath);
    raw.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)");
    raw.close();

    assert.throws(
      () => createKnowledgeStore({ dbPath, appDbPath: join(root, "app.db") }),
      /applied_at|no column named/i,
    );

    // This open would fail on Windows if the constructor leaked its handle.
    const reopened = new Database(dbPath);
    assert.equal(reopened.prepare("SELECT 1 AS ok").get().ok, 1);
    reopened.close();
  } finally {
    cleanup(root);
  }
});

test("bounded runtime settings fall back safely and never return NaN", () => {
  assert.equal(parseBoundedNumber("abc", 1000, 250, 60_000), 1000);
  assert.equal(parseBoundedNumber("", 1000, 250, 60_000), 1000);
  assert.equal(parseBoundedNumber("100.9", 1000, 250, 60_000), 250);
  assert.equal(parseBoundedNumber("10", 1000, 250, 60_000), 250);
  assert.equal(parseBoundedNumber("999999", 1000, 250, 60_000), 60_000);
  assert.ok(Number.isFinite(parseBoundedNumber("NaN", 1000, 250, 60_000)));
  assert.equal(
    parseBoundedNumber("60000", 30 * 24 * 60 * 60 * 1000, 60 * 60 * 1000, 10 * 365 * 24 * 60 * 60 * 1000),
    60 * 60 * 1000,
    "retention settings are clamped to the one-hour operational minimum",
  );
});
