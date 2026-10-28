import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createKnowledgeStore } from "../src/knowledge/store.js";
import { CANDIDATE_INSIGHT_KINDS } from "../src/knowledge/candidate-insight.js";
import { CONFIRMED_MEMORY_TYPES, validateConfirmedMemoryDetails, type ConfirmedMemoryInput } from "../src/knowledge/confirmed-memory.js";

test("Candidate Insight kinds are exactly the four reviewable insight kinds", () => {
  assert.deepEqual(CANDIDATE_INSIGHT_KINDS, ["fact", "decision", "case", "pattern"]);
});

test("Confirmed Memory validates a discriminated type and required provenance", () => {
  assert.deepEqual(CONFIRMED_MEMORY_TYPES, ["Fact", "Decision", "Case", "Pattern"]);
  assert.doesNotThrow(() => validateConfirmedMemoryDetails("Fact", { subject: "timeout", value: "retry" }));
  assert.throws(() => validateConfirmedMemoryDetails("Decision", { subject: "wrong" }), /rationale|decision/i);
});

test("confirmed memory migration creates an isolated typed table", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-confirmed-memory-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    const table = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_confirmed_memories'").get() as { name?: string };
    assert.equal(table.name, "knowledge_confirmed_memories");
    const checks = store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_confirmed_memories'").get() as { sql: string };
    assert.match(checks.sql, /Fact/);
    assert.match(checks.sql, /confirmed_by/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

void ({} as ConfirmedMemoryInput);
