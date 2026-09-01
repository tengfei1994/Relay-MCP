import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectSampleManagerAssemblyType,
  validateSampleManagerFormTaskContract,
} from "../src/shared/samplemanager-inspection-tools.ts";

test("assembly inspection uses bounded flattened reflection and exact member filtering", async () => {
  let script = "";
  const runner = {
    execPowerShell: async (value: string) => {
      script = value;
      return {
        stdout: JSON.stringify({
          assembly: { path: "C:\\LIMS\\Tasks.dll", sha256: "abc" },
          type: { fullName: "Thermo.Prompt", baseTypes: ["System.Object"] },
          properties: [{ name: "IsMandatory", canRead: true, canWrite: true }],
          methods: [],
          events: [],
          truncated: false,
        }),
        stderr: "",
        code: 0,
      };
    },
  } as any;

  const result = JSON.parse(await inspectSampleManagerAssemblyType(runner, {
    assemblyPath: "C:\\LIMS\\Tasks.dll",
    typeName: "Thermo.Prompt",
    memberFilter: "Mandatory",
    includeInherited: true,
    maxMembers: 25,
  }));

  assert.equal(result.properties[0].name, "IsMandatory");
  assert.match(script, /GetFileHash|Get-FileHash/);
  assert.match(script, /BindingFlags/);
  assert.match(script, /ReflectionOnlyLoadFrom/);
  assert.match(script, /memberFilter/);
  assert.match(script, /maxMembers/);
  assert.match(script, /canWrite/);
  assert.doesNotMatch(script, /\?\?/);
  assert.doesNotMatch(script, /ConvertTo-Jsons+-Depths+20/);
});

test("assembly inspection rejects unbounded and unsafe inputs before dispatch", async () => {
  let called = false;
  const runner = { execPowerShell: async () => { called = true; return { stdout: "{}", stderr: "", code: 0 }; } } as any;
  await assert.rejects(
    inspectSampleManagerAssemblyType(runner, { assemblyPath: "C:\\x.dll\nboom", typeName: "X", maxMembers: 10 }),
    /assemblyPath/i,
  );
  await assert.rejects(
    inspectSampleManagerAssemblyType(runner, { assemblyPath: "C:\\x.dll", typeName: "X", maxMembers: 501 }),
    /maxMembers/i,
  );
  assert.equal(called, false);
});

test("form task preflight aggregates database, XML, cache, and assembly evidence without mutation", async () => {
  const scripts: string[] = [];
  const runner = {
    execPowerShell: async (script: string) => {
      scripts.push(script);
      if (script.includes("relay-form-contract:filesystem")) {
        return { stdout: JSON.stringify({
          formFiles: [{ path: "C:\\Forms\\Stocks.xml", identity: "Stocks", controls: [{ name: "Prompt", type: "Prompt" }] }],
          cacheFiles: ["C:\\FormsBin\\Stocks.binform"],
        }), stderr: "", code: 0 };
      }
      if (script.includes("relay-form-contract:database")) {
        return { stdout: JSON.stringify({ matches: [
          { table: "FORM", column: "NAME", value: "Stocks", searched: "Stocks" },
          { table: "MASTER_MENU", column: "TASK_NAME", value: "StocksTask", searched: "StocksTask" },
        ], masterMenuBindingRows: [{ row: { FORM_NAME: "Stocks", TASK_NAME: "StocksTask" }, containsForm: true, containsTask: true }] }), stderr: "", code: 0 };
      }
      return { stdout: JSON.stringify({ assembly: { sha256: "abc" }, type: { fullName: "StocksTask" }, properties: [] }), stderr: "", code: 0 };
    },
  } as any;

  const result = JSON.parse(await validateSampleManagerFormTaskContract(runner, {
    instance: { name: "VGSM", formsPath: "C:\\Forms", formsBinPath: "C:\\FormsBin" },
    databaseHost: "localhost\\SQLEXPRESS",
    databaseName: "VGSM",
    formName: "Stocks",
    taskName: "StocksTask",
    assemblyPath: "C:\\LIMS\\Tasks.dll",
    typeName: "StocksTask",
    controlNames: ["Prompt"],
  }));

  assert.equal(result.readOnly, true);
  assert.equal(result.mutationAttempted, false);
  assert.equal(result.checks.formDefinition.status, "pass");
  assert.equal(result.checks.databaseBinding.status, "pass");
  assert.equal(result.checks.assemblyContract.status, "pass");
  assert.ok(result.findings.some((item: any) => item.code === "compiled_form_cache_present"));
  assert.equal(scripts.length, 3);
  assert.match(scripts[1], /INFORMATION_SCHEMA.COLUMNS/);
  assert.match(scripts[1], /MASTER_MENU/);
  assert.doesNotMatch(scripts.join("\n"), /DELETE|UPDATE|INSERT|DROP/i);
});

test("form task preflight reports missing controls and unknown assembly checks", async () => {
  const runner = {
    execPowerShell: async (script: string) => {
      if (script.includes("filesystem")) return { stdout: JSON.stringify({ formFiles: [{ path: "x.xml", identity: "Stocks", controls: [] }], cacheFiles: [] }), stderr: "", code: 0 };
      if (script.includes("database")) return { stdout: JSON.stringify({ matches: [] }), stderr: "", code: 0 };
      throw new Error("dependency resolution failed");
    },
  } as any;
  const result = JSON.parse(await validateSampleManagerFormTaskContract(runner, {
    instance: "VGSM",
    databaseHost: "localhost",
    databaseName: "VGSM",
    formName: "Stocks",
    taskName: "StocksTask",
    assemblyPath: "C:\\Tasks.dll",
    controlNames: ["Prompt"],
  }));
  assert.ok(result.findings.some((item: any) => item.code === "form_control_missing"));
  assert.equal(result.checks.assemblyContract.status, "unknown");
  assert.ok(result.unknowns.length > 0);
});
