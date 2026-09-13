import assert from "node:assert/strict";
import test from "node:test";
import { inspectSampleManagerDeploymentRuntime } from "../src/shared/samplemanager-runtime-inspection.ts";

test("runtime inspection uses exact paths, bounded module checks, and content timestamps for logs", async () => {
  let script = "";
  const runner = {
    execPowerShell: async (value: string) => {
      script = value;
      return { stdout: JSON.stringify({ ok: true, summary: { healthy: true }, files: [], assemblies: [], services: [], processes: [], loadedModules: [], moduleErrors: [], logs: {} }), stderr: "", code: 0 };
    },
  } as any;
  const output = await inspectSampleManagerDeploymentRuntime(runner, {
    instance: { name: "VGSM", rootPath: "C:\\Thermo\\SampleManager\\Server\\VGSM", services: [{ name: "smpVGSM" }] },
    filePaths: ["C:\\Thermo\\SampleManager\\Server\\VGSM\\Exe\\Forms\\Review.frm"],
    assemblyPaths: ["C:\\Thermo\\SampleManager\\Server\\VGSM\\Exe\\SolutionAssemblies\\Review.dll"],
    logMinutes: 15,
    maxErrors: 7,
  });
  assert.equal(JSON.parse(output).ok, true);
  assert.match(script, /Get-FileHash/);
  assert.match(script, /Get-Process -Id/);
  assert.match(script, /DateTimeOffset\]::Parse/);
  assert.match(script, /maxLogFiles=10/);
  assert.match(script, /maxErrors=7/);
  assert.match(script, /\$since = \(Get-Date\)\.AddMinutes\(-15\)/);
  assert.match(script, /smpVGSM/);
  assert.doesNotMatch(script, /commandLine/);
  assert.doesNotMatch(script, /Remove-Item|Stop-Service|Start-Service|UPDATE\s|INSERT\s|DELETE\s/i);
});

test("runtime inspection rejects unsafe or oversized paths before remote dispatch", async () => {
  let called = false;
  const runner = { execPowerShell: async () => { called = true; return { stdout: "", stderr: "", code: 0 }; } } as any;
  await assert.rejects(() => inspectSampleManagerDeploymentRuntime(runner, {
    instance: "VGSM",
    filePaths: ["C:\\Temp\\bad\npath"],
  }), /Invalid file path/);
  assert.equal(called, false);
});
