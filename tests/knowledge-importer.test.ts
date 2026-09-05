import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { importCasebook, importContextFacts } from "../src/knowledge/importer.ts";

test("imports typed casebook projections, evidence and ingestion runs", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-importer-"));
  const source = join(root, "casebook"); mkdirSync(source); mkdirSync(join(source, "evidence"));
  writeFileSync(join(source, "evidence", "run.log"), "password=secret token: abc123\nresult=passed");
  writeFileSync(join(source, "case.yaml"), [
    "id: CASE-1", "title: Cache issue", "kind: case", "status: verified", "scope:", "  samplemanager: '21.1'",
    "symptoms: stale cache", "root_cause: stale file", "fix: clear cache", "evidence:", "  - path: evidence/run.log",
  ].join("\n"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db"), evidenceRoot: join(root, "stored") });
  try {
    const report = importCasebook(store, { root: source, evidenceRoot: join(root, "stored") });
    assert.equal(report.imported, 1); assert.equal(store.db.prepare("SELECT status FROM knowledge_cases WHERE id='CASE-1'").get().status, "verified");
    const evidence = store.db.prepare("SELECT storage_path FROM knowledge_evidence").get() as { storage_path: string };
    assert.match(readFileSync(evidence.storage_path, "utf8"), /\[REDACTED\]/); assert.equal(store.db.prepare("SELECT status FROM knowledge_ingest_runs WHERE id=?").get(report.runId).status, "completed");
    const retry = importCasebook(store, { root: source, evidenceRoot: join(root, "stored") }); assert.equal(retry.skipped, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("resolves context project names and preserves unresolved facts", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-facts-")); const facts = join(root, "facts.jsonl");
  writeFileSync(facts, `${JSON.stringify({ text: "mapped", projectName: "Demo" })}\n${JSON.stringify({ text: "unmapped", projectName: "Missing" })}\n`);
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    const report = importContextFacts(store, { files: [facts], userId: 7, projectResolver: (_user, name) => name === "Demo" ? "p1" : undefined });
    assert.equal(report.imported, 2); assert.equal(report.unresolved, 1);
    const rows = store.db.prepare("SELECT project_id,status,project_name_snapshot FROM knowledge_facts ORDER BY text").all() as Array<Record<string, unknown>>;
    assert.equal(rows[0].project_id, "p1"); assert.equal(rows[1].status, "unresolved"); assert.equal(rows[1].project_name_snapshot, "Missing"); assert.equal(readFileSync(facts, "utf8").split("\n").filter(Boolean).length, 2);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
