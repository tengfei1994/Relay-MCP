import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("HTTP and MCP upgrade comparisons return the same classifications and source evidence references", async () => {
  const root = mkdtempSync(join(tmpdir(), "source-baseline-api-"));
  const previous = { DB_PATH: process.env.DB_PATH, KNOWLEDGE_DB_PATH: process.env.KNOWLEDGE_DB_PATH, RELAY_STATE_ROOT: process.env.RELAY_STATE_ROOT };
  process.env.DB_PATH = join(root, "app.db");
  process.env.KNOWLEDGE_DB_PATH = join(root, "knowledge.db");
  process.env.RELAY_STATE_ROOT = root;
  const { default: Fastify } = await import("fastify");
  const { db, runMigrations } = await import("../src/server/db/index.js");
  const { knowledgeRoutes } = await import("../src/server/routes/knowledge.js");
  const { getKnowledgeStore } = await import("../src/server/knowledge-context.js");
  const { registerKnowledgeTools } = await import("../src/mcp/tools/knowledge.js");
  runMigrations();
  const store = getKnowledgeStore();
  store.grantAcl("p1", 7, true);
  const now = new Date().toISOString();
  const insertSet = store.db.prepare("INSERT INTO knowledge_artifact_sets(id,kind,name,version,source_locator,sha256,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)");
  const insertBaseline = store.db.prepare("INSERT INTO knowledge_source_baselines(id,artifact_set_id,solution,version,manifest_sha256,root_locator,created_at) VALUES(?,?,?,?,?,?,?)");
  for (const [id, version] of [["old", "1"], ["new", "2"]] as const) {
    insertSet.run(`${id}-set`, "solution", "Demo", version, `fixture://${id}`, `${id}-manifest`, "published", now, now);
    insertBaseline.run(id, `${id}-set`, "Demo", version, `${id}-manifest`, `fixture://${id}`, now);
    store.db.prepare("INSERT INTO knowledge_artifact_publications(artifact_set_id,status) VALUES(?,?)").run(`${id}-set`, "published");
  }
  store.db.prepare("INSERT INTO knowledge_project_snapshots(id,project_id,name,source_locator,manifest_sha256,created_at) VALUES(?,?,?,?,?,?)").run("project", "p1", "Current", "fixture://project", "project-manifest", now);

  const sides: Record<string, Record<string, string | undefined>> = {
    old: { "unchanged.cs": "A", "project.cs": "A", "baseline.cs": "A", "conflict.cs": "A", "added.cs": undefined, "deleted.cs": "A" },
    project: { "unchanged.cs": "A", "project.cs": "B", "baseline.cs": "A", "conflict.cs": "B", "added.cs": undefined, "deleted.cs": undefined },
    new: { "unchanged.cs": "A", "project.cs": "A", "baseline.cs": "B", "conflict.cs": "C", "added.cs": "A", "deleted.cs": undefined },
  };
  const evidenceIds: Record<string, Record<string, string>> = { old: {}, project: {}, new: {} };
  for (const [side, files] of Object.entries(sides)) {
    for (const [path, sha256] of Object.entries(files)) {
      if (!sha256) continue;
      const id = `${side}-evidence-${path}`;
      evidenceIds[side][path] = id;
      if (side === "project") store.db.prepare("INSERT INTO knowledge_project_snapshot_files(id,snapshot_id,relative_path,sha256,size_bytes,created_at) VALUES(?,?,?,?,?,?)").run(id, "project", path, sha256, 1, now);
      else store.db.prepare("INSERT INTO knowledge_source_files(id,baseline_id,relative_path,sha256,size_bytes,created_at) VALUES(?,?,?,?,?,?)").run(id, side, path, sha256, 1, now);
    }
  }

  const app = Fastify();
  app.decorate("authenticate", async (request: any) => { request.user = { id: 7, isAdmin: true }; });
  await app.register(knowledgeRoutes);
  const callbacks = new Map<string, (...args: any[]) => any>();
  registerKnowledgeTools({ server: { tool: (name: string, ...args: any[]) => callbacks.set(name, args.at(-1)), resource: () => undefined } as any, user: { id: 7, username: "fixture", isAdmin: true }, knowledge: store });
  try {
    const payload = { oldBaselineId: "old", projectSnapshotId: "project", newBaselineId: "new" };
    const httpResponse = await app.inject({ method: "POST", url: "/api/knowledge/source-baselines/compare", payload });
    assert.equal(httpResponse.statusCode, 200, httpResponse.body);
    const http = httpResponse.json();
    const mcpResponse = await callbacks.get("knowledge_solution_upgrade_analysis")!({ oldBaselineId: "old", currentProjectSnapshotId: "project", newBaselineId: "new" });
    const mcp = JSON.parse(mcpResponse.content[0].text);
    const expected = { "unchanged.cs": "UNCHANGED", "project.cs": "PROJECT_ONLY", "baseline.cs": "BASELINE_ONLY", "conflict.cs": "BOTH_CHANGED", "added.cs": "ADDED", "deleted.cs": "DELETED" };
    for (const change of http.changes) {
      assert.equal(change.status, expected[change.path as keyof typeof expected]);
      assert.equal(change.potentialConflict ?? false, change.status === "BOTH_CHANGED");
      for (const side of ["old", "project", "next"] as const) {
        const manifestSide = side === "next" ? "new" : side;
        assert.equal(change.evidenceRefs[side], evidenceIds[manifestSide][change.path]);
      }
    }
    assert.deepEqual(mcp.changes, http.changes);
    assert.deepEqual(mcp.counts, { UNCHANGED: 1, PROJECT_ONLY: 1, BASELINE_ONLY: 1, BOTH_CHANGED: 1, ADDED: 1, DELETED: 1 });
    const baselinePage = (await app.inject({ url: "/api/knowledge/source-baselines?limit=1&offset=1" })).json();
    assert.equal(baselinePage.baselines.length, 1); assert.equal(baselinePage.baselines[0].id, "new"); assert.deepEqual(baselinePage.page, { limit: 1, offset: 1, total: 2 });
    const snapshotPage = (await app.inject({ url: "/api/knowledge/project-snapshots?limit=1&offset=0" })).json();
    assert.equal(snapshotPage.snapshots[0].id, "project"); assert.equal(snapshotPage.snapshots[0].file_count, 4); assert.deepEqual(snapshotPage.page, { limit: 1, offset: 0, total: 1 });
    const filePage = (await app.inject({ url: "/api/knowledge/source-baselines/old/files?limit=2&offset=2" })).json();
    assert.equal(filePage.files.length, 2); assert.deepEqual(filePage.page, { limit: 2, offset: 2, total: 5 });
  } finally {
    await app.close();
    store.close();
    (db as any).session.client.close();
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP upgrade comparison enforces the project snapshot ACL", async () => {
  const root = mkdtempSync(join(tmpdir(), "source-baseline-mcp-acl-"));
  const store = (await import("../src/knowledge/store.js")).createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  const now = new Date().toISOString();
  try {
    store.grantAcl("other", 7, false);
    for (const id of ["old", "new"]) {
      store.db.prepare("INSERT INTO knowledge_artifact_sets(id,kind,name,source_locator,sha256,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(`${id}-set`, "solution", "Demo", `fixture://${id}`, id, "published", now, now);
      store.db.prepare("INSERT INTO knowledge_source_baselines(id,artifact_set_id,solution,version,manifest_sha256,root_locator,created_at) VALUES(?,?,?,?,?,?,?)").run(id, `${id}-set`, "Demo", id, id, `fixture://${id}`, now);
      store.db.prepare("INSERT INTO knowledge_artifact_publications(artifact_set_id,status) VALUES(?,?)").run(`${id}-set`, "published");
    }
    store.db.prepare("INSERT INTO knowledge_project_snapshots(id,project_id,name,source_locator,manifest_sha256,created_at) VALUES(?,?,?,?,?,?)").run("private", "p1", "Private", "fixture://private", "private", now);
    store.db.prepare("INSERT INTO knowledge_project_snapshot_files(id,snapshot_id,relative_path,sha256,size_bytes,created_at) VALUES(?,?,?,?,?,?)").run("private-file", "private", "file.cs", "A", 1, now);
    for (const id of ["old", "new"]) store.db.prepare("INSERT INTO knowledge_source_files(id,baseline_id,relative_path,sha256,size_bytes,created_at) VALUES(?,?,?,?,?,?)").run(`${id}-file`, id, "file.cs", "A", 1, now);
    const callbacks = new Map<string, (...args: any[]) => any>();
    (await import("../src/mcp/tools/knowledge.js")).registerKnowledgeTools({ server: { tool: (name: string, ...args: any[]) => callbacks.set(name, args.at(-1)), resource: () => undefined } as any, user: { id: 7, username: "fixture", isAdmin: false }, knowledge: store });
    await assert.rejects(() => callbacks.get("knowledge_solution_upgrade_analysis")!({ oldBaselineId: "old", currentProjectSnapshotId: "private", newBaselineId: "new" }), /access denied|not found/i);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
