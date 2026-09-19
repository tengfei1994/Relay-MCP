import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSampleManagerVglSource, readSampleManagerVglSource } from "../src/shared/samplemanager-vgl-inspection.ts";

test("VGL inspector reports parameter passing, constants, joins, calls, and source lines", () => {
  const source = `{ comment with ROUTINE ignored() }
JOIN LIBRARY $LIB_UTILS
CONSTANT MODE = "Review"
GLOBAL ROUTINE Main(entity, VALUE mode)
  result = CALL_ROUTINE("Child", $LIB_UTILS, entity, mode)
  result2 = CALL_ROUTINE(dynamic_name, $LIB_UTILS, entity)
ENDROUTINE

ROUTINE Child(item, VALUE requested_mode)
  RETURN(item)
ENDROUTINE`;
  const response = analyzeSampleManagerVglSource({
    path: "D:\\LIMS\\main.rpf",
    bytes: Buffer.byteLength(source),
    sha256: "a".repeat(64),
    contentBase64: Buffer.from(source, "utf8").toString("base64"),
  }, { sourcePath: "D:\\LIMS\\main.rpf", entrypoint: "Main", maxCallDepth: 4, queryId: "vgl-1" });

  assert.equal(response.entrypoint?.global, true);
  assert.deepEqual(response.entrypoint?.parameters.map((item) => item.passing), ["reference", "value"]);
  assert.equal(response.constants[0].name, "MODE");
  assert.equal(response.joins[0].name, "$LIB_UTILS");
  assert.equal(response.callChain[0].callee, "Child");
  assert.equal(response.callChain[0].resolvedInFile, true);
  assert.ok(response.unknowns.some((item) => item.includes("dynamic")));
  assert.equal(response.queryMetadata.mutationAttempted, false);
});

test("VGL source read is bounded and uses exact remote path", async () => {
  let script = "";
  const runner = {
    execPowerShell: async (value: string) => {
      script = value;
      return { stdout: JSON.stringify({ path: "D:\\LIMS\\main.rpf", bytes: 10, sha256: "a".repeat(64), contentBase64: "" }), stderr: "", code: 0 };
    },
  } as any;

  const raw = JSON.parse(await readSampleManagerVglSource(runner, { sourcePath: "D:\\LIMS\\main.rpf", maxBytes: 4096 }));
  assert.equal(raw.bytes, 10);
  assert.match(script, /Test-Path -LiteralPath \$path/);
  assert.match(script, /\$maxBytes = 4096/);
  assert.match(script, /Get-FileHash/);
});
