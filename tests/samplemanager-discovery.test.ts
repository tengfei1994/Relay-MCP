import assert from "node:assert/strict";
import test from "node:test";
import { discoverSampleManagerInstances } from "../src/shared/samplemanager-discovery.ts";

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
  assert.doesNotMatch(script, /Restart-Service|Remove-Item|Copy-Item/);
});
