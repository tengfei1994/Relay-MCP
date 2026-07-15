import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "fs";
import { TOOL_CATALOG } from "../src/shared/tool-catalog.ts";

test("every registered MCP tool is categorized and described exactly once", () => {
  const source = readFileSync(new URL("../src/mcp/index.ts", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const registered = [...source.matchAll(/server\.tool\(\s*"([^"]+)"/g)].map((match) => match[1]).sort();
  const catalogued = TOOL_CATALOG.map((entry) => entry.name).sort();
  assert.deepEqual(catalogued, registered);
  assert.equal(new Set(catalogued).size, catalogued.length);
  for (const entry of TOOL_CATALOG) {
    assert.ok(entry.category);
    assert.ok(entry.description.length >= 12);
    assert.ok(readme.includes(`\`${entry.name}\``), `README is missing ${entry.name}`);
  }
});
