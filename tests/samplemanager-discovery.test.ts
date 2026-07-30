import assert from "node:assert/strict";
import test from "node:test";
import {
  DATABASE_ASSOCIATION_RANK,
  discoverSampleManagerInstances,
} from "../src/shared/samplemanager-discovery.ts";

test("instance discovery returns a normalized candidate list and keeps the scan read-only", async () => {
  let script = "";
  const runner = {
    execPowerShell: async (value: string) => {
      script = value;
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          name: "VGSM",
          version: "21.1",
          runtimeKind: "framework",
          rootPath: "C:\\Thermo\\SampleManager\\Server\\VGSM",
          exePath: "C:\\Thermo\\SampleManager\\Server\\VGSM\\Exe",
          formsPath: "",
          formsBinPath: "",
          solutionAssembliesPath: "",
          logfilePath: "",
          dataPath: "",
          databaseHost: "SQL01",
          databaseName: "VGSM",
          databaseAuthType: "windows",
          databaseConfigSource: "server.config",
          services: [],
          buildProfile: { kind: "msbuild", candidates: [] },
          confidence: 80,
          warnings: [],
        }),
      };
    },
  } as any;

  const result = await discoverSampleManagerInstances(runner, ["D:\\Custom\\SM"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].databaseName, "VGSM");
  assert.match(script, /D:\\Custom\\SM/);
  assert.match(script, /name = \$_.Name/);
  assert.match(script, /displayName = \$_.DisplayName/);
  assert.match(script, /EntityContext\[-_\]/);
  assert.match(script, /AttachDbFilename/);
  assert.match(script, /function Normalize-LocalSqlServer/);
  assert.match(script, /localhost\\\$\(\$trimmed\.Substring\(2\)\)/);
  assert.match(script, /\$env:COMPUTERNAME/);
  assert.match(script, /\^MSSQL\\\$\(\.\+\)\$/);
  assert.match(script, /localhost\\\$\(\$matches\[1\]\)/);
  assert.match(script, /foreach \(\$sqlServer in @\(\$sqlServers\)\)/);
  assert.match(script, /SELECT name FROM sys\.databases/);
  assert.match(script, /sampleManagerTableCount/);
  assert.match(script, /Probe with the Agent\/SSH Windows identity/);
  assert.doesNotMatch(script, /if \(\$candidate\.authType -ne 'windows' -or \$candidate\.auxiliary\)/);
  assert.match(script, /if \(\$databaseProbe\.status -eq 'verified'\)/);
  assert.match(script, /LabSystems\\SampleManager Server\\\$name/);
  assert.match(script, /smp\$ado_connection_string/);
  assert.match(script, /LabSystems\\\$name\\Setup/);
  assert.match(script, /sourceKind = 'instance-registry'/);
  assert.match(script, /sourceKind = 'instance-config'/);
  assert.match(script, /sourceKind = 'machine-inventory'/);
  assert.match(script, /Sort-Object @\{Expression = \{ \$_.associationRank \}/);
  assert.ok(DATABASE_ASSOCIATION_RANK.instanceRegistry > DATABASE_ASSOCIATION_RANK.instanceConfig);
  assert.ok(DATABASE_ASSOCIATION_RANK.instanceConfig > DATABASE_ASSOCIATION_RANK.machineInventory);
  assert.ok(DATABASE_ASSOCIATION_RANK.machineInventory > DATABASE_ASSOCIATION_RANK.inferredInstanceName);
  assert.doesNotMatch(script, /Restart-Service|Remove-Item|Copy-Item/);
});
