import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSampleManagerEntitySchema, runSampleManagerEntitySchema } from "../src/shared/samplemanager-entity-schema.ts";

test("entity schema keeps SQL physical type separate from PackedDecimal logical semantics", () => {
  const response = analyzeSampleManagerEntitySchema({
    ok: true,
    requestedTable: "SAMPLE",
    requestedEntity: "Sample",
    connection: { databaseName: "VGSM" },
    physical: [{ columnName: "ID_NUMERIC", sqlType: "decimal", precision: 18, scale: 0, isPrimaryKey: true }],
    logical: {
      status: "ok",
      rows: [{ TABLE_ID: "SAMPLE", IDENTITY: "ID_NUMERIC", FIELD_TYPE: "PackedDecimal", PROMPT_TYPE: "Numeric" }],
    },
    entityDefinition: { status: "ok", rows: [{ NAME: "Sample", TABLE_NAME: "SAMPLE" }] },
  }, { queryId: "schema-1", instanceVersion: "21.3.0.0" });

  assert.equal(response.physical.columns[0].sqlType, "decimal");
  assert.equal(response.logical.fields[0].logicalType, "PackedDecimal");
  assert.equal(response.logical.fields[0].serialization.sqlConversionIsSufficient, false);
  assert.equal(response.logical.fields[0].serialization.requiresRuntimeValidation, true);
  assert.equal(response.queryMetadata.mutationAttempted, false);
});

test("entity schema uses bounded dynamic metadata discovery", async () => {
  let script = "";
  const runner = {
    execPowerShell: async (value: string) => {
      script = value;
      return { stdout: JSON.stringify({ ok: true, requestedTable: "SAMPLE", physical: [], logical: { status: "missing", rows: [] }, entityDefinition: { status: "missing", rows: [] } }), stderr: "", code: 0 };
    },
  } as any;

  const output = JSON.parse(await runSampleManagerEntitySchema(runner, {
    database: "VGSM",
    databaseHost: "localhost\\SQLEXPRESS",
    table: "dbo.SAMPLE",
    entity: "Sample",
  }));

  assert.equal(output.ok, true);
  assert.match(script, /SCHEMA_TABLE_FIELD/);
  assert.match(script, /ENTITY_DEFINITION/);
  assert.match(script, /sys\.columns/);
  await assert.rejects(() => runSampleManagerEntitySchema(runner, { database: "VGSM", databaseHost: "localhost", table: "dbo.SAMPLE;DROP" }), /Invalid table name/);
});
