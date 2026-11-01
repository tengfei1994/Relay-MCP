import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("Project file operations preview, rename, delete, and enforce workspace ownership", async () => {
  const root = mkdtempSync(join(process.cwd(), ".tmp-project-files-"));
  const previous = { DB_PATH: process.env.DB_PATH, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
  process.env.DB_PATH = join(root, "app.db");
  process.env.WORKSPACE_ROOT = join(root, "workspaces");
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "folder"), { recursive: true });
  writeFileSync(join(workspace, "notes.txt"), "line one\nline two\n", "utf8");
  writeFileSync(join(workspace, "folder", "nested.txt"), "nested", "utf8");
  const { default: Fastify } = await import("fastify");
  const { db, runMigrations } = await import("../src/server/db/index.js");
  const { users, projects } = await import("../src/server/db/schema.js");
  const { projectRoutes } = await import("../src/server/routes/projects.js");
  runMigrations();
  db.insert(users).values({ id: 7, username: "owner", passwordHash: "test" }).run();
  db.insert(users).values({ id: 8, username: "other", passwordHash: "test" }).run();
  db.insert(projects).values({ id: 1, userId: 7, name: "fixture", workspacePath: workspace }).run();
  const app = Fastify();
  app.decorate("authenticate", async (request: any) => { request.user = request.headers["x-other"] ? { id: 8, username: "other", isAdmin: false } : { id: 7, username: "owner", isAdmin: false }; });
  await app.register(projectRoutes);
  try {
    const listed = await app.inject({ method: "GET", url: "/api/projects/1/files" });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().entries.map((entry: any) => entry.name).sort(), ["folder", "notes.txt"]);

    const preview = await app.inject({ method: "GET", url: "/api/projects/1/files/content?path=notes.txt" });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().content, "line one\nline two\n");

    const renamed = await app.inject({ method: "PATCH", url: "/api/projects/1/files", payload: { path: "notes.txt", name: "renamed.txt" } });
    assert.equal(renamed.statusCode, 200);
    assert.equal(readFileSync(join(workspace, "renamed.txt"), "utf8"), "line one\nline two\n");

    const deleted = await app.inject({ method: "DELETE", url: "/api/projects/1/files?path=folder" });
    assert.equal(deleted.statusCode, 200);
    assert.equal(await import("node:fs").then(({ existsSync }) => existsSync(join(workspace, "folder"))), false);

    const traversal = await app.inject({ method: "GET", url: "/api/projects/1/files/content?path=..%2Foutside.txt" });
    assert.equal(traversal.statusCode, 400);
    const denied = await app.inject({ method: "GET", url: "/api/projects/1/files", headers: { "x-other": "1" } });
    assert.equal(denied.statusCode, 404);
  } finally {
    await app.close();
    (db as any).session.client.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

