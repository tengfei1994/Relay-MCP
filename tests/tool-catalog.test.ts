import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "fs";
import { TOOL_CATALOG } from "../src/shared/tool-catalog.ts";
import { SAMPLEMANAGER_ENTITY_CATALOG } from "../src/shared/samplemanager-capabilities.ts";

test("every registered MCP tool is categorized and described exactly once", () => {
  const source = readFileSync(new URL("../src/mcp/index.ts", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const registered = [
    ...source.matchAll(/server\.tool\(\s*"([^"]+)"/g),
    ...source.matchAll(/registerRelayAlias\([^,]+,\s*"([^"]+)"/g),
  ].map((match) => match[1]).sort();
  const catalogued = TOOL_CATALOG.map((entry) => entry.name).sort();
  assert.deepEqual(catalogued, registered);
  assert.equal(new Set(catalogued).size, catalogued.length);
  for (const entry of TOOL_CATALOG) {
    assert.ok(entry.category);
    assert.ok(entry.description.length >= 12);
    assert.ok(readme.includes(`\`${entry.name}\``), `README is missing ${entry.name}`);
    if (entry.category === "samplemanager" && entry.entity) {
      const entity = SAMPLEMANAGER_ENTITY_CATALOG.find((item) => item.id === entry.entity);
      assert.ok(entity, `Unknown SampleManager entity '${entry.entity}' for ${entry.name}`);
      if (entry.capability) {
        assert.ok(entity.inspectors.some((item) => item.id === entry.capability), `Unknown capability '${entry.entity}.${entry.capability}' for ${entry.name}`);
      }
    }
  }
});

test("form cache cleanup is classified as a mutating tool", () => {
  const source = readFileSync(new URL("../src/server/routes/tools.ts", import.meta.url), "utf8");
  const mutationPattern = source.match(/const mutating = \/\(\^\|_\)\((?<operations>[^)]+)\)/)?.groups?.operations ?? "";
  assert.match(mutationPattern, /(^|\|)clear(\||$)/);
});

test("job wait is exposed as a categorized MCP tool", () => {
  assert.ok(TOOL_CATALOG.some((entry) => entry.name === "job_wait" && entry.category === "jobs"));
});

test("SampleManager form and assembly inspectors are categorized semantic tools", () => {
  assert.ok(TOOL_CATALOG.some((entry) => entry.name === "samplemanager_inspect_assembly_type" && entry.entity === "deployment"));
  assert.ok(TOOL_CATALOG.some((entry) => entry.name === "samplemanager_validate_form_task_contract" && entry.entity === "form_task" && entry.capability === "contract"));
  assert.ok(TOOL_CATALOG.some((entry) => entry.name === "samplemanager_create_deployment_manifest" && entry.entity === "deployment"));
});

test("SampleManager deployment start persists the resolved project link environment", () => {
  const source = readFileSync(new URL("../src/mcp/index.ts", import.meta.url), "utf8");
  const block = source.match(/server\.tool\(\s*"samplemanager_deployment_start"[\s\S]*?(?=\n\s*server\.tool\()/)?.[0] ?? "";
  assert.match(block, /environment:\s*ps\.environment/);
  assert.doesNotMatch(block, /environment:\s*environment\s*\?\?/);
});

test("table-loader package preserves unknown timeout status from deployment steps", () => {
  const source = readFileSync(new URL("../src/mcp/index.ts", import.meta.url), "utf8");
  const block = source.match(/server\.tool\(\s*"samplemanager_deploy_table_loader_package"[\s\S]*?(?=\n\s*server\.tool\()/)?.[0] ?? "";
  assert.match(block, /catch \(error\)[\s\S]*deploymentFailureDisposition\(error/);
  assert.doesNotMatch(block, /catch \(error\)[\s\S]*?status:\s*"failed"/);
});
