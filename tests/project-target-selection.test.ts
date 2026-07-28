import assert from "node:assert/strict";
import test from "node:test";
import { selectProjectTarget } from "../src/shared/project-target-selection.ts";

const links = [
  { id: 10, environment: "production", server: { id: 1, name: "HKJC_Demo" } },
  { id: 11, environment: "internal-review", server: { id: 2, name: "HKJC_Internal" } },
];

test("project target selection supports server name and case-insensitive environment", () => {
  const byName = selectProjectTarget("HKJC", links, {
    serverName: "hkjc_internal",
    allowedServerIds: [1, 2],
  });
  assert.equal(byName.server.id, 2);

  const byEnvironment = selectProjectTarget("HKJC", links, {
    environment: "INTERNAL-REVIEW",
    allowedServerIds: [1, 2],
  });
  assert.equal(byEnvironment.server.name, "HKJC_Internal");
});

test("project target errors return selectable environment and server mappings", () => {
  assert.throws(
    () => selectProjectTarget("HKJC", links, {
      environment: "missing",
      allowedServerIds: [1, 2],
    }),
    /Available links: production -> HKJC_Demo.*internal-review -> HKJC_Internal/
  );
});

test("explicit server selection still enforces token server scopes", () => {
  assert.throws(
    () => selectProjectTarget("HKJC", links, {
      serverId: 2,
      allowedServerIds: [1],
    }),
    /not allowed for this MCP token/
  );
});
