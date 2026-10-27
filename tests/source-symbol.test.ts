import assert from "node:assert/strict";
import test from "node:test";
import { compareSourceSymbolText } from "../src/knowledge/source-symbol.ts";

test("C# symbols distinguish project, baseline, matching and conflicting method changes", () => {
  const old = "public class Example {\n public int Run() { return 1; }\n}\n";
  const project = old.replace("return 1", "return 2");
  const matching = old.replace("return 1", "return 3");
  const conflict = old.replace("return 1", "return 4");
  const projectOnly = compareSourceSymbolText({ path: "Example.cs", language: "csharp", old, project, next: old });
  const run = projectOnly.find(change => change.name === "Run");
  assert.equal(run?.status, "PROJECT_ONLY");
  assert.equal(run?.potentialConflict, undefined);
  assert.equal(run?.old?.sha256, projectOnly.find(change => change.name === "Run")?.next?.sha256);
  assert.equal(compareSourceSymbolText({ path: "Example.cs", language: "csharp", old, project: old, next: matching }).find(change => change.name === "Run")?.status, "BASELINE_ONLY");
  assert.equal(compareSourceSymbolText({ path: "Example.cs", language: "csharp", old, project: matching, next: matching }).find(change => change.name === "Run")?.status, "PROJECT_ONLY");
  const both = compareSourceSymbolText({ path: "Example.cs", language: "csharp", old, project, next: conflict }).find(change => change.name === "Run");
  assert.equal(both?.status, "BOTH_CHANGED");
  assert.equal(both?.potentialConflict, true);
});

test("SQL and VGL symbols cover object addition and body changes", () => {
  const sqlOld = "CREATE PROCEDURE dbo.Run AS BEGIN SELECT 1 END;\n";
  const sqlNext = sqlOld.replace("SELECT 1", "SELECT 2") + "CREATE TABLE dbo.Added (id int);\n";
  const sql = compareSourceSymbolText({ path: "Example.sql", language: "sql", old: sqlOld, project: sqlOld, next: sqlNext });
  assert.equal(sql.find(change => change.name === "dbo.Run")?.status, "BASELINE_ONLY");
  assert.equal(sql.find(change => change.name === "dbo.Added")?.status, "ADDED");

  const vglOld = "SUB Calculate\nRETURN 1\nEND SUB\n";
  const vgl = compareSourceSymbolText({ path: "Example.vgl", language: "vgl", old: vglOld, project: vglOld.replace("RETURN 1", "RETURN 2"), next: vglOld });
  assert.equal(vgl.find(change => change.name === "Calculate")?.status, "PROJECT_ONLY");
});

test("XML named elements compare values and additions without treating unnamed nodes as symbols", () => {
  const old = "<configuration><appSettings><add key=\"Retries\" value=\"1\" /><add key=\"Mode\" value=\"A\" /></appSettings></configuration>";
  const next = old.replace("Retries\" value=\"1", "Retries\" value=\"2").replace("</appSettings>", "<add key=\"NewSetting\" value=\"x\" /></appSettings>");
  const changes = compareSourceSymbolText({ path: "App.config", language: "xml", old, project: old, next });
  assert.equal(changes.find(change => change.name === "Retries")?.status, "BASELINE_ONLY");
  assert.equal(changes.find(change => change.name === "NewSetting")?.status, "ADDED");
  assert.equal(changes.some(change => change.name === "appSettings"), false);
});
