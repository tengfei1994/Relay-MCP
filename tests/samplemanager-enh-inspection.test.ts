import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSampleManagerEnhInspection, runSampleManagerEnhInspection } from "../src/shared/samplemanager-enh-inspection.ts";

const table = (name: string, rows: Record<string, unknown>[]) => ({ table: name, status: "ok", phase: "direct", rows, rowCount: rows.length });

test("ENH validator groups components and reports sequence, field, format, and reference problems", () => {
  const response = analyzeSampleManagerEnhInspection({
    ok: true,
    discoveredTables: ["ENH_FOLDER", "ENH_GRID_CONFIG", "ENH_ACTION"],
    tokens: ["D1", "F1"],
    tables: [
      table("ENH_FOLDER", [{ ID: "F1", DASHBOARD_ID: "D1", ORDER_NUM: 1 }, { ID: "F2", DASHBOARD_ID: "D1", ORDER_NUM: 1 }]),
      table("ENH_GRID_CONFIG", [{ ID: "G1", FOLDER_ID: "F1", TABLE_NAME: "SAMPLE", FIELD_NAME: "MISSING_FIELD", CONFIG_JSON: "{bad" }]),
      table("ENH_ACTION", [{ ID: "A1", GRID_ID: "MISSING_GRID" }]),
    ],
    fieldReferences: [{ sourceTable: "ENH_GRID_CONFIG", table: "SAMPLE", field: "MISSING_FIELD", valid: false }],
    formatChecks: [{ table: "ENH_GRID_CONFIG", column: "CONFIG_JSON", kind: "json", valid: false, error: "invalid JSON" }],
    bounded: true,
  }, { mode: "validate", target: { dashboardId: "D1" }, queryId: "enh-1", instanceVersion: "21.1" });

  const ruleIds = response.violations.map((item) => item.ruleId);
  assert.equal(response.componentCounts.folders, 2);
  assert.equal(response.componentCounts.grids, 1);
  assert.ok(ruleIds.includes("duplicate_sequence"));
  assert.ok(ruleIds.includes("invalid_field_reference"));
  assert.ok(ruleIds.includes("invalid_storage_format"));
  assert.ok(ruleIds.includes("unresolved_enh_reference"));
  assert.equal(response.queryMetadata.mutationAttempted, false);
});

test("ENH inspection discovers version-specific tables and related tokens in one remote call", async () => {
  let script = "";
  const runner = {
    execPowerShell: async (value: string) => {
      script = value;
      return { stdout: JSON.stringify({ ok: true, tables: [], discoveredTables: [], tokens: [], formatChecks: [], fieldReferences: [] }), stderr: "", code: 0 };
    },
  } as any;

  const output = JSON.parse(await runSampleManagerEnhInspection(runner, {
    database: "VGSM",
    databaseHost: "localhost\\SQLEXPRESS",
    target: { dashboardId: "DASH-1" },
    maxRows: 40,
  }));

  assert.equal(output.ok, true);
  assert.match(script, /t\.name LIKE 'ENH%'/);
  assert.match(script, /Get-RelayTokens/);
  assert.match(script, /SCHEMA_TABLE_FIELD/);
  assert.match(script, /\$maxRows = 40/);
  await assert.rejects(() => runSampleManagerEnhInspection(runner, { database: "VGSM", databaseHost: "localhost", target: {} }), /At least one ENH/);
});
