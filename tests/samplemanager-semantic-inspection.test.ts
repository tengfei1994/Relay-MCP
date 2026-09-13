import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSampleManagerSemanticInspection,
  runSampleManagerSemanticInspection,
} from "../src/shared/samplemanager-semantic-inspection.ts";
import { runSqlChangeSet } from "../src/shared/samplemanager-tools.ts";

const table = (name: string, rows: Record<string, unknown>[], status = "ok") => ({
  table: name,
  status,
  columns: rows.length ? Object.keys(rows[0]) : [],
  rows,
  rowCount: rows.length,
});

test("Lab Method inspection reports identity, reference, type, placeholder, and instruction risks", () => {
  const response = analyzeSampleManagerSemanticInspection({
    ok: true,
    target: { labMethodId: "LM-1", labMethodVersion: "2" },
    connection: { loginName: "DOMAIN\\relay", databaseName: "VGSM" },
    tables: [
      table("LAB_METHOD", [{ ID: "LM-1", VERSION: "2", NAME: "Method" }]),
      table("LAB_METHOD_STEP", [
        { ID: "S1", NAME: "步骤", INSTRUCTION_BLOB: "<binary 10 bytes>" },
        { ID: "S1", NAME: "步骤", INSTRUCTION_BLOB: "" },
      ]),
      table("LAB_METHOD_PARAMETER", [{ ID: "P1", NAME: "Amount", TYPE: "Numeric", FORMULA: "StepOne.UnknownValue or {{MissingValue}} or \"\"", DEFAULT_VALUE: "abc", MAX_LENGTH: 2, READ_ONLY: 0, TRUE_WORD: "Yes" }]),
      table("LAB_METHOD_VARIABLE", [{ ID: "V1", NAME: "变量", TYPE: "Text", INSTRUCTION: "ok" }]),
    ],
  }, { entryPoint: "lab_method_definition", queryId: "inspect-test", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" });
  const ids = response.violations.map((item) => item.ruleId);
  assert.ok(ids.includes("duplicate_step_id"));
  assert.ok(ids.includes("non_english_internal_name"));
  assert.ok(ids.includes("unresolved_placeholder"));
  assert.ok(ids.includes("numeric_empty_string"));
  assert.ok(ids.includes("non_boolean_true_false_words"));
  assert.ok(ids.includes("calculation_not_readonly"));
  assert.ok(ids.includes("default_value_type_mismatch"));
  assert.ok(ids.includes("default_value_length_exceeded"));
  assert.ok(ids.includes("cross_step_reference_unknown"));
  assert.ok(ids.includes("instruction_missing"));
  assert.ok(ids.includes("instruction_encoding_unknown"));
  assert.equal(response.queryMetadata.mutationAttempted, false);
  assert.equal(response.partial, false);
});

test("Plate plan validation reports duplicate, out-of-range, empty, count, and missing Test evidence", () => {
  const response = analyzeSampleManagerSemanticInspection({
    ok: true,
    tables: [table("BATCH_ENTRY", [
      { ROW: 1, COLUMN: 1, ENTRY_TYPE: "Sample", TEST: "T-1" },
      { ROW: 1, COLUMN: 1, ENTRY_TYPE: "Sample", TEST: "" },
      { ROW: 3, COLUMN: 1, ENTRY_TYPE: "Control", TEST: "T-2" },
    ])],
  }, {
    entryPoint: "plate_batch_integrity",
    plan: { rows: 2, columns: 2, startPosition: "A1", fillDirection: "row-major", expectedEmptyPositions: ["R1C1"], expectedEntries: [{ entryType: "Sample", count: 1, positions: ["R1C2"] }] },
  });
  const ids = response.violations.map((item) => item.ruleId);
  assert.ok(ids.includes("duplicate_well_position"));
  assert.ok(ids.includes("batch_entry_test_missing"));
  assert.ok(ids.includes("well_out_of_range"));
  assert.ok(ids.includes("expected_empty_position_occupied"));
  assert.ok(ids.includes("entry_count_mismatch"));
  assert.ok(ids.includes("entry_positions_mismatch"));
});

test("all semantic entry points preserve the facts/inferences/unknowns/evidence envelope", () => {
  for (const entryPoint of ["execution_readiness", "plate_batch_integrity", "test_result_lineage", "lab_method_definition"] as const) {
    const response = analyzeSampleManagerSemanticInspection({ ok: true, tables: [] }, { entryPoint });
    assert.ok(Array.isArray(response.facts));
    assert.ok(Array.isArray(response.inferences));
    assert.ok(Array.isArray(response.unknowns));
    assert.ok(Array.isArray(response.evidence));
    assert.ok(Array.isArray(response.errors));
    assert.equal(response.queryMetadata.readOnly, true);
    assert.equal(response.queryMetadata.mutationAttempted, false);
  }
});

test("change-set SQL includes stable statement evidence, row-count guards, assertions, and rollback metadata", async () => {
  let generatedScript = "";
  const runner = {
    execPowerShell: async (script: string) => {
      generatedScript = script;
      return { stdout: JSON.stringify({ ok: true, resultSets: [], resultSetCount: 0 }), stderr: "", code: 0 };
    },
  } as any;
  const output = JSON.parse(await runSqlChangeSet(runner, "VGSM", [{
    idempotencyKey: "update-menu",
    operation: "update",
    table: "MASTER_MENU",
    values: { TASK_NAME: "Review" },
    where: "ID = @menuId",
    parameters: { menuId: "M1" },
    expectedAffectedRows: 1,
  }], {
    dryRun: false,
    createBackup: true,
    databaseHost: "localhost\\SQLEXPRESS",
    assertions: { labMethodId: "LM-1", labMethodVersion: "2" },
  }));
  const encodedSql = generatedScript.match(/FromBase64String\('([^']+)'\)/)?.[1];
  assert.ok(encodedSql, "the SQL batch should be transferred as UTF-8 Base64");
  const generatedSql = Buffer.from(encodedSql, "base64").toString("utf8");
  assert.match(generatedSql, /statementIndex/);
  assert.match(generatedSql, /Expected affected-row count did not match/);
  assert.match(generatedSql, /COL_LENGTH/);
  assert.match(generatedSql, /PRODUCT_VERSION/);
  assert.match(generatedSql, /RELAY_BACKUP_MASTER_MENU/);
  assert.equal(output.transaction, "committed");
  assert.equal(output.changes[0].expectedAffectedRows, 1);
  assert.ok(output.rollback.sql);
  await assert.rejects(() => runSqlChangeSet(runner, "VGSM", [{ idempotencyKey: "bad", operation: "update", table: "T", values: { X: 1 }, where: "ID = 1" }], { verifySql: "DELETE FROM T" }), /verifySql must be read-only/);
});

test("semantic remote inspection rejects an empty target before dispatch", async () => {
  let called = false;
  const runner = { execPowerShell: async () => { called = true; return { stdout: "", stderr: "", code: 0 }; } } as any;
  await assert.rejects(() => runSampleManagerSemanticInspection(runner, {
    database: "VGSM",
    databaseHost: "localhost",
    entryPoint: "execution_readiness",
    target: {},
  }), /At least one inspection target identity is required/);
  assert.equal(called, false);
});
