import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSampleManagerProject,
  clearFormCache,
  quoteSqlIdentifier,
  renderSqlIdentifiers,
  instancePaths,
  restartSampleManagerInstance,
  SampleManagerRestartError,
  buildSettingsMetadata,
  redactSensitiveBuildOutput,
  runSqlMutation,
  runSql,
  sqlContainsMutation,
  validateBuildEnvironmentVariables,
  validateBuildMsbuildProperties,
} from "../src/shared/samplemanager-tools.ts";
import { RemoteCommandTimeoutError } from "../src/shared/remote-runner.ts";

test("build settings reject secret-like names for environment variables and MSBuild properties", () => {
  assert.throws(() => validateBuildEnvironmentVariables({ SERVICE_APIKEY: "secret" }), /SERVICE_APIKEY/);
  assert.throws(() => validateBuildEnvironmentVariables({ CLIENT_BEARER: "secret" }), /CLIENT_BEARER/);
  assert.throws(() => validateBuildMsbuildProperties({ API_KEY: "secret" }), /API_KEY/);
  assert.throws(() => validateBuildMsbuildProperties({ CLIENT_SECRET: "secret" }), /CLIENT_SECRET/);
});

test("build setting metadata and captured output never retain raw input values", () => {
  const values = { CUSTOM_ROOT: "D:\\Private Build Root", FEATURE_FLAG: "enabled" };
  assert.deepEqual(buildSettingsMetadata(values), {
    keys: ["CUSTOM_ROOT", "FEATURE_FLAG"],
    count: 2,
    valuesRedacted: true,
  });
  const output = redactSensitiveBuildOutput("root=D:\\Private Build Root flag=enabled", values);
  assert.equal(output, "root=[REDACTED] flag=[REDACTED]");
});

test("SampleManager build redacts supplied property and environment values from returned output", async () => {
  const runner = {
    execPowerShell: async () => ({
      stdout: "CUSTOM_ROOT=D:\\Raw Build Input FEATURE_FLAG=enabled",
      stderr: "",
      code: 0,
    }),
  } as any;

  const result = await buildSampleManagerProject(
    runner,
    "D:\\Work\\Project.csproj",
    "Release",
    "C:\\BuildTools\\MSBuild.exe",
    { kind: "msbuild" },
    60000,
    {},
    {
      msbuildProperties: { CUSTOM_ROOT: "D:\\Raw Build Input" },
      environmentVariables: { FEATURE_FLAG: "enabled" },
    }
  );

  assert.doesNotMatch(result, /Raw Build Input|enabled/);
  assert.match(result, /\[REDACTED\]/);
});

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

test("SampleManager build injects instance paths, validated properties, and environment variables into MSBuild", async () => {
  let script = "";
  const runner = {
    execPowerShell: async (value: string) => {
      script = value;
      return { stdout: "Build succeeded.", stderr: "", code: 0 };
    },
  } as any;

  await buildSampleManagerProject(
    runner,
    "D:\\Work\\InstrumentUsage.sln",
    "Release",
    "C:\\BuildTools\\MSBuild.exe",
    { kind: "msbuild" },
    60000,
    {},
    {
      instance: { name: "VGSM", rootPath: "D:\\Lims\\VGSM", exePath: "D:\\Lims\\VGSM\\Exe" },
      msbuildProperties: { TreatWarningsAsErrors: "false" },
      environmentVariables: { NUGET_PACKAGES: "D:\\NuGet" },
      expectedAssemblyPath: "D:\\Work\\out\\InstrumentUsage.Tasks.dll",
    }
  );

  assert.match(script, /\/p:VGSM_EXE=D:\\Lims\\VGSM\\Exe/);
  assert.match(script, /\/p:SAMPLEMANAGER_EXE=D:\\Lims\\VGSM\\Exe/);
  assert.match(script, /\/p:TreatWarningsAsErrors=false/);
  assert.match(script, /NUGET_PACKAGES/);
  assert.match(script, /D:\\NuGet/);
  assert.match(script, /& \$toolPath @arguments/);
});

test("SampleManager build preflight returns resolved context without invoking a build", async () => {
  let script = "";
  const runner = {
    execPowerShell: async (value: string) => {
      script = value;
      return {
        stdout: JSON.stringify({
          preflightOnly: true,
          projectOrSolutionPath: "D:\\Work\\InstrumentUsage.csproj",
          tool: { kind: "dotnet", path: "C:\\Program Files\\dotnet\\dotnet.exe" },
          instance: { name: "VGSM", root: "D:\\Lims\\VGSM", exe: "D:\\Lims\\VGSM\\Exe" },
          effectiveProperties: { VGSM_EXE: "D:\\Lims\\VGSM\\Exe", SAMPLEMANAGER_EXE: "D:\\Lims\\VGSM\\Exe" },
          effectiveEnvironment: { DOTNET_CLI_HOME: "D:\\DotnetHome" },
          expectedAssemblyPath: "D:\\Work\\out\\InstrumentUsage.Tasks.dll",
        }),
        stderr: "",
        code: 0,
      };
    },
  } as any;

  const result = JSON.parse(await buildSampleManagerProject(
    runner,
    "D:\\Work\\InstrumentUsage.csproj",
    "Release",
    "C:\\Program Files\\dotnet\\dotnet.exe",
    { kind: "dotnet" },
    60000,
    {},
    {
      instance: { name: "VGSM", rootPath: "D:\\Lims\\VGSM", exePath: "D:\\Lims\\VGSM\\Exe" },
      environmentVariables: { DOTNET_CLI_HOME: "D:\\DotnetHome" },
      expectedAssemblyPath: "D:\\Work\\out\\InstrumentUsage.Tasks.dll",
      preflightOnly: true,
    }
  ));

  assert.equal(result.preflightOnly, true);
  assert.equal(result.tool.kind, "dotnet");
  assert.match(script, /expectedAssemblyPath/);
  assert.match(script, /VGSM_EXE/);
  assert.doesNotMatch(script, /& \$dotnet @arguments/);
  assert.doesNotMatch(script, /& \$msbuild @arguments/);
});

test("SampleManager build preflight validates configured instance root and Exe directories", async () => {
  let script = "";
  const runner = {
    execPowerShell: async (value: string) => {
      script = value;
      return { stdout: "{}", stderr: "", code: 0 };
    },
  } as any;

  await buildSampleManagerProject(
    runner,
    "D:\\Work\\InstrumentUsage.csproj",
    "Release",
    "C:\\BuildTools\\MSBuild.exe",
    { kind: "msbuild" },
    60000,
    {},
    {
      instance: { name: "VGSM", rootPath: "D:\\Lims\\VGSM", exePath: "D:\\Lims\\VGSM\\Exe" },
      preflightOnly: true,
    }
  );

  assert.match(script, /SampleManager instance root not found/);
  assert.match(script, /SampleManager instance Exe directory not found/);
  assert.match(script, /\$instanceRoot = 'D:\\Lims\\VGSM'/);
  assert.match(script, /\$instanceExe = 'D:\\Lims\\VGSM\\Exe'/);
  assert.match(script, /Test-Path -LiteralPath \$instanceRoot -PathType Container/);
  assert.match(script, /Test-Path -LiteralPath \$instanceExe -PathType Container/);
});

test("SampleManager build normalizes a leading-digit instance name to a valid MSBuild property", async () => {
  let script = "";
  const runner = {
    execPowerShell: async (value: string) => {
      script = value;
      return { stdout: "Build succeeded.", stderr: "", code: 0 };
    },
  } as any;

  await buildSampleManagerProject(
    runner,
    "D:\\Work\\InstrumentUsage.csproj",
    "Release",
    "C:\\BuildTools\\MSBuild.exe",
    { kind: "msbuild" },
    60000,
    {},
    { instance: { name: "21.3-VGSM", exePath: "D:\\Lims\\VGSM\\Exe" } }
  );

  assert.match(script, /\/p:_21_3_VGSM_EXE=D:\\Lims\\VGSM\\Exe/);
  assert.doesNotMatch(script, /\/p:21_3_VGSM_EXE=/);
});

test("SampleManager dotnet build forwards properties through its non-preflight invocation path", async () => {
  let script = "";
  const runner = {
    execPowerShell: async (value: string) => {
      script = value;
      return { stdout: "Build succeeded.", stderr: "", code: 0 };
    },
  } as any;

  await buildSampleManagerProject(
    runner,
    "D:\\Work\\InstrumentUsage.csproj",
    "Release",
    "C:\\Program Files\\dotnet\\dotnet.exe",
    { kind: "dotnet" },
    60000,
    {},
    {
      instance: { name: "VGSM", exePath: "D:\\Lims\\VGSM\\Exe" },
      msbuildProperties: { CustomBuildFlag: "enabled" },
      environmentVariables: { NUGET_PACKAGES: "D:\\NuGet" },
      preflightOnly: false,
    }
  );

  assert.match(script, /\/p:CustomBuildFlag=enabled/);
  assert.match(script, /& \$toolPath @arguments/);
  assert.match(script, /\$arguments = @\("build", \$project/);
  assert.doesNotMatch(script, /if \(\$true\) \{/);
  assert.match(script, /\$buildEnvironment = \[ordered\]@\{/);
  assert.match(script, /'NUGET_PACKAGES' = 'D:\\NuGet'/);
  assert.match(script, /Set-Item -Path "Env:\$\(\$entry.Key\)" -Value \$entry.Value/);
});

test("SampleManager build rejects unsafe MSBuild property and environment names", async () => {
  await assert.rejects(
    buildSampleManagerProject(
      {} as any,
      "D:\\Work\\InstrumentUsage.csproj",
      "Release",
      undefined,
      { kind: "msbuild" },
      60000,
      {},
      { msbuildProperties: { "Bad;Property": "value" } }
    ),
    /Invalid MSBuild property name/
  );
  await assert.rejects(
    buildSampleManagerProject(
      {} as any,
      "D:\\Work\\InstrumentUsage.csproj",
      "Release",
      undefined,
      { kind: "msbuild" },
      60000,
      {},
      { environmentVariables: { "BAD-NAME": "value" } }
    ),
    /Invalid environment variable name/
  );
});

test("SampleManager build rejects direct secret-bearing environment variables before remote dispatch", async () => {
  for (const name of [
    "API_TOKEN",
    "DEPLOY_SECRET",
    "SQL_PASSWORD",
    "SQL_PWD",
    "SERVICE_PASS",
    "SIGNING_KEY",
    "DB_CREDENTIAL",
    "DEPLOY_AUTH",
    "GITHUB_PAT",
    "SQL_CONNECTION_STRING",
    "SQL_CONNECTIONSTRING",
  ]) {
    await assert.rejects(
      buildSampleManagerProject(
        {} as any,
        "D:\\Work\\InstrumentUsage.csproj",
        "Release",
        undefined,
        { kind: "msbuild" },
        60000,
        {},
        { environmentVariables: { [name]: "do-not-queue-me" } }
      ),
      /Direct secret-bearing environment variables are not supported; preconfigure secrets on the target service account/
    );
  }
});

test("instance restart uses explicit service names and instance-scoped process cleanup", async () => {
  const scripts: string[] = [];
  const runner = {
    execPowerShell: async (value: string) => {
      scripts.push(value);
      if (value.includes("relay-restart:preflight")) {
        return {
          stdout: JSON.stringify({
            configuredServices: ["SM22.Queue", "SM22.Server"],
            missingServices: [],
            services: [
              { name: "SM22.Queue", before: "Running" },
              { name: "SM22.Server", before: "Running" },
            ],
          }),
          stderr: "",
          code: 0,
        };
      }
      if (value.includes("relay-restart:service-transition")) {
        const stopped = value.includes("$desiredState = 'Stopped'");
        return { stdout: JSON.stringify({ reached: true, lastState: stopped ? "Stopped" : "Running", actionElapsedMs: 1, waitElapsedMs: 1, elapsedMs: 2 }), stderr: "", code: 0 };
      }
      if (value.includes("relay-restart:terminate")) {
        return { stdout: JSON.stringify({ terminatedProcessIds: [], terminationFailures: [] }), stderr: "", code: 0 };
      }
      if (value.includes("relay-restart:health")) {
        return { stdout: JSON.stringify({ readyServices: ["SM22.Queue", "SM22.Server"], notRunningServices: [] }), stderr: "", code: 0 };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  } as any;
  await restartSampleManagerInstance(runner, {
    name: "SM22",
    rootPath: "D:\\LIMS\\SM22",
    services: [{ name: "SM22.Queue" }, { name: "SM22.Server" }],
  });
  const combined = scripts.join("\n");
  assert.match(combined, /SM22\.Queue/);
  assert.match(combined, /SM22\.Server/);
  assert.match(combined, /D:\\LIMS\\SM22/);
  assert.doesNotMatch(combined, /Get-Process SampleManagerServerHost/);
  assert.match(combined, /Get-CimInstance Win32_Process/);
});

test("instance restart reports ordered service phases and structured evidence", async () => {
  const phases: string[] = [];
  const scripts: Array<{ script: string; timeout: number }> = [];
  const runner = {
    execPowerShell: async (script: string, timeout: number) => {
      scripts.push({ script, timeout });
      let payload: unknown;
      if (script.includes("relay-restart:preflight")) {
        payload = {
          configuredServices: ["SM22.Wcf", "SM22.Daemon", "SM22.Server", "SM22.Queue"],
          missingServices: [],
          services: [
            { name: "SM22.Queue", before: "Running" },
            { name: "SM22.Server", before: "Running" },
            { name: "SM22.Daemon", before: "Running" },
            { name: "SM22.Wcf", before: "Running" },
          ],
        };
      } else if (script.includes("relay-restart:service-transition")) {
        const stopped = script.includes("$desiredState = 'Stopped'");
        payload = { reached: true, lastState: stopped ? "Stopped" : "Running", actionElapsedMs: 4, waitElapsedMs: 12, elapsedMs: 16 };
      } else if (script.includes("relay-restart:terminate")) {
        payload = { terminatedProcessIds: [701, 702], terminationFailures: [] };
      } else if (script.includes("relay-restart:health")) {
        payload = { readyServices: ["SM22.Queue", "SM22.Server", "SM22.Daemon", "SM22.Wcf"], notRunningServices: [] };
      } else payload = {};
      return { stdout: JSON.stringify(payload), stderr: "", code: 0 };
    },
  } as any;

  const result = JSON.parse(await restartSampleManagerInstance(
    runner,
    {
      name: "SM22",
      rootPath: "D:\\LIMS\\SM22",
      services: [{ name: "SM22.Queue" }, { name: "SM22.Server" }, { name: "SM22.Daemon" }, { name: "SM22.Wcf" }],
    },
    { onPhase: (phase) => phases.push(phase) }
  ));

  assert.deepEqual(phases, [
    "restart_preflight",
    "stopping:SM22.Wcf",
    "waiting:SM22.Wcf",
    "stopping:SM22.Daemon",
    "waiting:SM22.Daemon",
    "stopping:SM22.Server",
    "waiting:SM22.Server",
    "stopping:SM22.Queue",
    "waiting:SM22.Queue",
    "terminating_instance_processes",
    "starting:SM22.Queue",
    "waiting:SM22.Queue",
    "starting:SM22.Server",
    "waiting:SM22.Server",
    "starting:SM22.Daemon",
    "waiting:SM22.Daemon",
    "starting:SM22.Wcf",
    "waiting:SM22.Wcf",
    "health_check",
    "completed",
  ]);
  assert.deepEqual(result.configuredServices, ["SM22.Queue", "SM22.Server", "SM22.Daemon", "SM22.Wcf"]);
  assert.deepEqual(result.missingServices, []);
  assert.deepEqual(result.terminatedProcessIds, [701, 702]);
  assert.equal(result.health.state, "healthy");
  assert.equal(result.failedServices.length, 0);
  assert.equal(result.services[0].before, "Running");
  assert.equal(result.services[0].after, "Running");
  assert.equal(result.services[0].stop.elapsedMs, 4);
  assert.equal(result.services[0].wait.start.elapsedMs, 12);
  assert.ok(result.finishedAt);
  assert.ok(result.elapsedMs >= 0);

  const waitScript = scripts.find(({ script }) => script.includes("relay-restart:service-transition"))?.script ?? "";
  assert.match(waitScript, /\$deadline = \(Get-Date\)\.AddMilliseconds\(60000\)/);
  assert.match(waitScript, /\$lastState/);
  assert.match(waitScript, /Start-Sleep -Milliseconds 1000/);
  assert.match(waitScript, /reached = \$reached/);
  assert.ok(scripts.filter(({ script }) => script.includes("relay-restart:service-transition")).every(({ timeout }) => timeout >= 60000));
  assert.equal(scripts.length, 11);
  const transition = scripts.find(({ script }) => script.includes("relay-restart:service-transition"))?.script ?? "";
  assert.match(transition, /Stop-Service/);
  assert.match(transition, /\$deadline = \(Get-Date\)\.AddMilliseconds\(60000\)/);
});

test("instance restart surfaces bounded wait failures with service evidence", async () => {
  const phases: string[] = [];
  const stderr: string[] = [];
  const runner = {
    execPowerShell: async (script: string) => {
      if (script.includes("relay-restart:preflight")) {
        return {
          stdout: JSON.stringify({
            configuredServices: ["SM22.Queue"],
            missingServices: [],
            services: [{ name: "SM22.Queue", before: "Stopped" }],
          }),
          stderr: "",
          code: 0,
        };
      }
      if (script.includes("relay-restart:service-transition") && script.includes("$desiredState = 'Running'")) {
        return {
          stdout: JSON.stringify({ reached: false, desiredState: "Running", lastState: "StartPending", actionElapsedMs: 1, waitElapsedMs: 60000, elapsedMs: 60001 }),
          stderr: "",
          code: 0,
        };
      }
      if (script.includes("relay-restart:terminate")) {
        return { stdout: JSON.stringify({ terminatedProcessIds: [], terminationFailures: [] }), stderr: "", code: 0 };
      }
      return { stdout: JSON.stringify({ reached: true, lastState: "Stopped", actionElapsedMs: 1, waitElapsedMs: 1, elapsedMs: 2 }), stderr: "", code: 0 };
    },
  } as any;

  await assert.rejects(
    restartSampleManagerInstance(
      runner,
      { name: "SM22", rootPath: "D:\\LIMS\\SM22", services: [{ name: "SM22.Queue" }] },
      { onPhase: (phase) => phases.push(phase), onStderr: (text) => stderr.push(text) }
    ),
    (error: unknown) => {
      assert.ok(error instanceof SampleManagerRestartError);
      assert.equal(error.category, "timeout");
      assert.match(error.message, /Service 'SM22\.Queue' did not reach 'Running' within 60000ms; last state: StartPending/);
      return true;
    }
  );

  assert.deepEqual(phases, [
    "restart_preflight",
    "stopping:SM22.Queue",
    "waiting:SM22.Queue",
    "terminating_instance_processes",
    "starting:SM22.Queue",
    "waiting:SM22.Queue",
  ]);
  const evidence = JSON.parse(stderr.at(-1) ?? "{}");
  assert.equal(evidence.failedServices[0].service, "SM22.Queue");
  assert.equal(evidence.failedServices[0].desiredState, "Running");
  assert.equal(evidence.failedServices[0].lastState, "StartPending");
  assert.equal(evidence.health.state, "failed");
});

test("instance restart treats configured missing services as a typed preflight failure", async () => {
  const runner = {
    execPowerShell: async (script: string) => {
      if (script.includes("relay-restart:preflight")) {
        return {
          stdout: JSON.stringify({
            configuredServices: ["SM22.Queue", "SM22.Server"],
            missingServices: ["SM22.Server"],
            services: [{ name: "SM22.Queue", before: "Running" }],
          }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  } as any;

  await assert.rejects(
    restartSampleManagerInstance(
      runner,
      { name: "SM22", services: [{ name: "SM22.Queue" }, { name: "SM22.Server" }] }
    ),
    (error: unknown) => {
      assert.ok(error instanceof SampleManagerRestartError);
      assert.deepEqual(error.evidence.missingServices, ["SM22.Server"]);
      assert.equal(error.evidence.failure?.stage, "preflight");
      assert.equal(error.evidence.health.state, "failed");
      return true;
    }
  );
});

test("instance restart wraps service action transport failures in typed evidence", async () => {
  const runner = {
    execPowerShell: async (script: string) => {
      if (script.includes("relay-restart:preflight")) {
        return {
          stdout: JSON.stringify({
            configuredServices: ["SM22.Queue"],
            missingServices: [],
            services: [{ name: "SM22.Queue", before: "Stopped" }],
          }),
          stderr: "",
          code: 0,
        };
      }
      if (script.includes("relay-restart:terminate")) {
        return { stdout: JSON.stringify({ terminatedProcessIds: [], terminationFailures: [] }), stderr: "", code: 0 };
      }
      if (script.includes("relay-restart:service-transition") && script.includes("$action = 'start'")) {
        return { stdout: "", stderr: "Access denied while starting service", code: 1 };
      }
      if (script.includes("relay-restart:service-transition")) {
        return { stdout: JSON.stringify({ reached: true, lastState: "Stopped", actionElapsedMs: 1, waitElapsedMs: 1, elapsedMs: 2 }), stderr: "", code: 0 };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  } as any;

  await assert.rejects(
    restartSampleManagerInstance(runner, { name: "SM22", services: [{ name: "SM22.Queue" }] }),
    (error: unknown) => {
      assert.ok(error instanceof SampleManagerRestartError);
      assert.equal(error.evidence.failure?.stage, "start");
      assert.equal(error.evidence.failure?.service, "SM22.Queue");
      assert.equal(error.evidence.failedServices[0].desiredState, "Running");
      assert.match(error.message, /SM22\.Queue/);
      return true;
    }
  );
});

test("instance restart verifies process termination and reports unconfirmed PIDs as failures", async () => {
  const scripts: string[] = [];
  const runner = {
    execPowerShell: async (script: string) => {
      scripts.push(script);
      if (script.includes("relay-restart:preflight")) {
        return {
          stdout: JSON.stringify({ configuredServices: ["SM22.Queue"], missingServices: [], services: [{ name: "SM22.Queue", before: "Stopped" }] }),
          stderr: "",
          code: 0,
        };
      }
      if (script.includes("relay-restart:terminate")) {
        return {
          stdout: JSON.stringify({
            terminatedProcessIds: [],
            terminationFailures: [{ processId: 701, lastState: "Running", error: "Process still exists after terminate" }],
          }),
          stderr: "",
          code: 0,
        };
      }
      if (script.includes("relay-restart:service-transition")) {
        return { stdout: JSON.stringify({ reached: true, lastState: "Stopped", actionElapsedMs: 1, waitElapsedMs: 1, elapsedMs: 2 }), stderr: "", code: 0 };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  } as any;

  await assert.rejects(
    restartSampleManagerInstance(runner, { name: "SM22", services: [{ name: "SM22.Queue" }] }),
    (error: unknown) => {
      assert.ok(error instanceof SampleManagerRestartError);
      assert.equal(error.evidence.failure?.stage, "termination");
      assert.deepEqual(error.evidence.terminationFailures?.map((item) => item.processId), [701]);
      assert.deepEqual(error.evidence.terminatedProcessIds, []);
      const terminationScript = scripts.find((script) => script.includes("relay-restart:terminate")) ?? "";
      assert.match(terminationScript, /\$terminationResult\.ReturnValue/);
      assert.match(terminationScript, /TrimEnd\('\\', '\/'\)/);
      assert.match(terminationScript, /StartsWith\(\$normalizedRoot \+ '\\'/);
      assert.match(terminationScript, /\[Regex\]::Escape\(\$instanceName\)/);
      assert.match(terminationScript, /\(\?<\!\[A-Za-z0-9_\.\-\]\).*\(\?!\[A-Za-z0-9_\.\-\]\)/);
      assert.doesNotMatch(terminationScript, /IndexOf\(\$instanceName/);
      return true;
    }
  );
});

test("instance restart keeps service action phases durable until each consolidated transition returns", async () => {
  const phases: string[] = [];
  let releaseStop: ((value: unknown) => void) | undefined;
  let releaseStart: ((value: unknown) => void) | undefined;
  let stopStarted: (() => void) | undefined;
  let startStarted: (() => void) | undefined;
  const waitForStop = new Promise<void>((resolve) => { stopStarted = resolve; });
  const waitForStart = new Promise<void>((resolve) => { startStarted = resolve; });
  const runner = {
    execPowerShell: async (script: string) => {
      if (script.includes("relay-restart:preflight")) {
        return { stdout: JSON.stringify({ configuredServices: ["SM22.Queue"], missingServices: [], services: [{ name: "SM22.Queue", before: "Running" }] }), stderr: "", code: 0 };
      }
      if (script.includes("relay-restart:service-transition") && script.includes("$action = 'stop'")) {
        stopStarted?.();
        const payload = await new Promise<unknown>((resolve) => { releaseStop = resolve; });
        return { stdout: JSON.stringify(payload), stderr: "", code: 0 };
      }
      if (script.includes("relay-restart:terminate")) {
        return { stdout: JSON.stringify({ terminatedProcessIds: [], terminationFailures: [] }), stderr: "", code: 0 };
      }
      if (script.includes("relay-restart:service-transition") && script.includes("$action = 'start'")) {
        startStarted?.();
        const payload = await new Promise<unknown>((resolve) => { releaseStart = resolve; });
        return { stdout: JSON.stringify(payload), stderr: "", code: 0 };
      }
      return { stdout: JSON.stringify({ readyServices: ["SM22.Queue"], notRunningServices: [] }), stderr: "", code: 0 };
    },
  } as any;

  const restart = restartSampleManagerInstance(
    runner,
    { name: "SM22", services: [{ name: "SM22.Queue" }] },
    { onPhase: (phase) => phases.push(phase) }
  );
  await waitForStop;
  assert.deepEqual(phases, ["restart_preflight", "stopping:SM22.Queue"]);
  releaseStop?.({ reached: true, lastState: "Stopped", actionElapsedMs: 1, waitElapsedMs: 1, elapsedMs: 2 });
  await waitForStart;
  assert.deepEqual(phases, [
    "restart_preflight",
    "stopping:SM22.Queue",
    "waiting:SM22.Queue",
    "terminating_instance_processes",
    "starting:SM22.Queue",
  ]);
  releaseStart?.({ reached: true, lastState: "Running", actionElapsedMs: 1, waitElapsedMs: 1, elapsedMs: 2 });
  await restart;
  assert.deepEqual(phases, [
    "restart_preflight",
    "stopping:SM22.Queue",
    "waiting:SM22.Queue",
    "terminating_instance_processes",
    "starting:SM22.Queue",
    "waiting:SM22.Queue",
    "health_check",
    "completed",
  ]);
});

test("instance restart preserves the original timeout category and cause in typed evidence", async () => {
  const timeout = new RemoteCommandTimeoutError(123);
  const runner = {
    execPowerShell: async () => { throw timeout; },
  } as any;

  await assert.rejects(
    restartSampleManagerInstance(runner, { name: "SM22", services: [{ name: "SM22.Queue" }] }),
    (error: unknown) => {
      assert.ok(error instanceof SampleManagerRestartError);
      assert.equal(error.category, "timeout");
      assert.equal(error.cause, timeout);
      assert.equal(error.evidence.failure?.stage, "preflight");
      return true;
    }
  );
});
