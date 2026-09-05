import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

test("better-sqlite3 native binding is available for Knowledge integration tests", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE binding_probe (value INTEGER NOT NULL)");
    db.prepare("INSERT INTO binding_probe(value) VALUES (?)").run(7);
    assert.equal(db.prepare("SELECT value FROM binding_probe").get().value, 7);
  } finally {
    db.close();
  }
});

