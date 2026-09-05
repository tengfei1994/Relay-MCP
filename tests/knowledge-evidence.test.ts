import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EvidenceStore } from "../src/knowledge/evidence-store.ts";
import { createKnowledgeStore } from "../src/knowledge/store.ts";

test("evidence is sanitised, content addressed and ACL deduplicated across projects", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-evidence-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db"), evidenceRoot: join(root, "evidence") });
  try {
    const evidence = new EvidenceStore(store, join(root, "evidence"));
    const first = evidence.put({ content: Buffer.from("token: one\nServer=db;Password=secret"), mimeType: "text/plain", sourceKind: "log", projectId: "p1", locator: "test:p1" });
    const second = evidence.put({ content: Buffer.from("token: two\nServer=db;Password=other"), mimeType: "text/plain", sourceKind: "log", projectId: "p2", locator: "test:p2" });
    assert.equal(first.id, second.id, "redacted content should deduplicate");
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM knowledge_evidence").get().count, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM knowledge_evidence_acl").get().count, 2);
    store.grantAcl("p2", 7);
    assert.match(evidence.metadata(7, first.id).sha256, /^[a-f0-9]{64}$/);
    assert.match(readFileSync(first.storagePath, "utf8"), /\[REDACTED\]/);
    assert.throws(() => evidence.read(8, first.id), /access denied/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("retention cleanup preserves holds and supports purge recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-evidence-retention-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db"), evidenceRoot: join(root, "evidence") });
  try {
    const evidence = new EvidenceStore(store, join(root, "evidence")); const old = new Date("2020-01-01T00:00:00.000Z");
    const standard = evidence.put({ content: Buffer.from("standard"), mimeType: "text/plain", sourceKind: "test", projectId: "p1", locator: "test:standard" });
    const held = evidence.put({ content: Buffer.from("held"), mimeType: "text/plain", sourceKind: "test", projectId: "p1", locator: "test:held", retention: "gmp_hold" });
    store.db.prepare("UPDATE knowledge_evidence SET created_at = ?").run(old.toISOString());
    const result = evidence.cleanup({ retentionMs: 1, now: new Date("2021-01-01T00:00:00.000Z") });
    assert.equal(result.deleted, 1); assert.equal(result.skippedHeld, 1); assert.equal(evidence.verify(standard.id).ok, false); assert.equal(evidence.verify(held.id).ok, true);
    store.grantAcl("p1", 3, true); assert.throws(() => evidence.purge(held.id, 3), /hold cannot be deleted/);
    const restored = evidence.put({ content: Buffer.from("standard"), mimeType: "text/plain", sourceKind: "test", projectId: "p1", locator: "test:restore" });
    assert.equal(restored.id, standard.id); assert.equal(evidence.verify(standard.id).ok, true); assert.ok(statSync(restored.storagePath).size > 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
