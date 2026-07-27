import assert from "node:assert/strict";
import test from "node:test";
import {
  quoteSqlIdentifier,
  renderSqlIdentifiers,
  runSqlMutation,
  sqlContainsMutation,
} from "../src/shared/samplemanager-tools.ts";

test("sqlContainsMutation identifies statements that change data or permissions", () => {
  assert.equal(sqlContainsMutation("select * from sample"), false);
  assert.equal(sqlContainsMutation("with rows as (select 1 id) update sample set active='T'"), true);
  assert.equal(sqlContainsMutation("grant select on sample to analyst"), true);
});

test("sqlContainsMutation ignores keywords inside comments, strings, and identifiers", () => {
  assert.equal(sqlContainsMutation("select 'update sample' as note"), false);
  assert.equal(sqlContainsMutation("-- delete all rows\nselect 1"), false);
  assert.equal(sqlContainsMutation("select [update] from audit"), false);
});

test("SQL identifiers are escaped through named placeholders", () => {
  assert.equal(quoteSqlIdentifier("dbo.IDENTITY"), "[dbo].[IDENTITY]");
  assert.equal(
    renderSqlIdentifiers("select {{column}} from {{table}}", {
      column: "IDENTITY",
      table: "dbo.SAMPLE",
    }),
    "select [IDENTITY] from [dbo].[SAMPLE]"
  );
  assert.throws(() => quoteSqlIdentifier("sample;drop table x"), /Invalid SQL identifier/);
  assert.throws(() => renderSqlIdentifiers("select {{column}}", {}), /Missing SQL identifier/);
});

test("structured SQL mutation generates before, backup, update, after, and rollback", async () => {
  let executedScript = "";
  const runner = {
    execPowerShell: async (script: string) => {
      executedScript = script;
      return { stdout: JSON.stringify({ ok: true, resultSets: [] }), stderr: "", code: 0 };
    },
  } as any;

  const result = JSON.parse(await runSqlMutation(runner, "vgsm", {
    operation: "update",
    table: "dbo.MASTER_MENU",
    values: { DESCRIPTION: "Updated" },
    where: "IDENTITY = @identity",
    parameters: { identity: "AST284" },
    dryRun: true,
    createBackup: true,
  }));

  const encodedSql = executedScript.match(/FromBase64String\('([^']+)'\)/)?.[1];
  assert.ok(encodedSql);
  const sql = Buffer.from(encodedSql!, "base64").toString("utf8");
  assert.match(sql, /SELECT 'before'/);
  assert.match(sql, /SELECT \* INTO \[dbo\]\.\[RELAY_BACKUP_MASTER_MENU_/);
  assert.match(sql, /UPDATE \[dbo\]\.\[MASTER_MENU\]/);
  assert.match(sql, /SELECT 'after'/);
  assert.match(sql, /ROLLBACK TRANSACTION/);
  assert.equal(result.dryRun, true);
  assert.equal(result.backupPersisted, false);
});

test("structured SQL mutation rejects update without a where predicate", async () => {
  await assert.rejects(
    runSqlMutation({} as any, "vgsm", {
      operation: "update",
      table: "dbo.MASTER_MENU",
      values: { DESCRIPTION: "Unsafe" },
    }),
    /where is required/
  );
});
