import assert from "node:assert/strict";
import test from "node:test";
import {
  clearFormCache,
  quoteSqlIdentifier,
  renderSqlIdentifiers,
  instancePaths,
  restartSampleManagerInstance,
  runSqlMutation,
  runSql,
  sqlContainsMutation,
} from "../src/shared/samplemanager-tools.ts";

test("form cache cleanup recursively removes exact binform entries and verifies deletion", async () => {
  let script = "";
  const runner = {
    execPowerShell: async (value: string) => {
      script = value;
      return {
        stdout: JSON.stringify({
          Instance: "VGSM",
          Form: "Stocks",
          Matched: ["C:\\Cache\\FormsBin\\Translation\\zh\\zh-CN\\Stocks.binform"],
          Removed: ["C:\\Cache\\FormsBin\\Translation\\zh\\zh-CN\\Stocks.binform"],
          Remaining: [],
          Success: true,
        }),
        stderr: "",
        code: 0,
      };
    },
  } as any;

  const result = JSON.parse(await clearFormCache(runner, {
    name: "VGSM",
    formsBinPath: "C:\\Cache\\FormsBin",
  }, "Stocks"));

  assert.equal(result.Success, true);
  assert.match(script, /Get-ChildItem[^\n]+-Recurse[^\n]+-File/);
  assert.match(script, /Stocks\.binform|\$expectedName/);
  assert.match(script, /Remove-Item[^\n]+-ErrorAction Stop/);
  assert.match(script, /Remaining/);
  assert.match(script, /Test-Path -LiteralPath/);
  assert.doesNotMatch(script, /-Filter "\$formName\*"/);
});

test("form cache cleanup forwards tracked execution options", async () => {
  let receivedExecution: unknown;
  const runner = {
    execPowerShell: async (_script: string, _timeout: number, execution: unknown) => {
      receivedExecution = execution;
      return {
        stdout: JSON.stringify({ Success: true, Matched: [], Removed: [], Remaining: [] }),
        stderr: "",
        code: 0,
      };
    },
  } as any;
  const execution = { onPhase: (_phase: string) => undefined };

  await clearFormCache(runner, "VGSM", "Stocks", execution);

  assert.equal(receivedExecution, execution);
});

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
    databaseHost: "SQL01\\HKJC",
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
  assert.match(executedScript, /Server=SQL01\\HKJC;Database=vgsm/);
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

test("SQL query script captures connection identity metadata", async () => {
  let executedScript = "";
  const runner = {
    execPowerShell: async (script: string) => {
      executedScript = script;
      return {
        stdout: JSON.stringify({
          ok: true,
          connection: {
            loginName: "NT AUTHORITY\\SYSTEM",
            originalLogin: "WORKGROUP\\HOST$",
            databaseName: "VGSM",
            serverName: "HOST\\SQLEXPRESS",
          },
          rows: [],
          rowCount: 0,
          rowsReturned: 0,
          hasMore: false,
          nextOffset: null,
          truncated: false,
        }),
        stderr: "",
        code: 0,
      };
    },
  } as any;

  const result = JSON.parse(await runSql(runner, "VGSM", "SELECT 1", {
    databaseHost: "localhost\\SQLEXPRESS",
    maxRows: 10,
  }));
  assert.equal(result.connection.loginName, "NT AUTHORITY\\SYSTEM");
  assert.match(executedScript, /SUSER_SNAME\(\)/);
  assert.match(executedScript, /ORIGINAL_LOGIN\(\)/);
  assert.match(executedScript, /@@SERVERNAME/);
});

test("instance paths honor discovered custom roots and directories", () => {
  const paths = instancePaths({
    name: "SM22",
    rootPath: "D:\\LIMS\\SM22",
    exePath: "D:\\LIMS\\SM22\\Runtime",
    formsPath: "E:\\SharedForms",
    formsBinPath: "D:\\Cache\\FormsBin",
    solutionAssembliesPath: "D:\\LIMS\\SM22\\Assemblies",
    logfilePath: "E:\\Logs\\SM22",
    dataPath: "E:\\Data\\SM22",
  });
  assert.equal(paths.root, "D:\\LIMS\\SM22");
  assert.equal(paths.exe, "D:\\LIMS\\SM22\\Runtime");
  assert.equal(paths.forms, "E:\\SharedForms");
  assert.equal(paths.solutionAssemblies, "D:\\LIMS\\SM22\\Assemblies");
  assert.equal(paths.logfile, "E:\\Logs\\SM22");
});

test("instance restart uses explicit service names and instance-scoped process cleanup", async () => {
  let script = "";
  const runner = {
    execPowerShell: async (value: string) => {
      script = value;
      return { stdout: "{}", stderr: "", code: 0 };
    },
  } as any;
  await restartSampleManagerInstance(runner, {
    name: "SM22",
    rootPath: "D:\\LIMS\\SM22",
    services: [{ name: "SM22.Queue" }, { name: "SM22.Server" }],
  });
  assert.match(script, /SM22\.Queue/);
  assert.match(script, /SM22\.Server/);
  assert.match(script, /D:\\LIMS\\SM22/);
  assert.doesNotMatch(script, /Get-Process SampleManagerServerHost/);
  assert.match(script, /Get-CimInstance Win32_Process/);
});
