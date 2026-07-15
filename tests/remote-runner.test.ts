import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanPowerShellText,
  RemoteCommandCancelledError,
  RemoteCommandTimeoutError,
  runWithTimeout,
} from "../src/shared/remote-runner.ts";

test("cleanPowerShellText preserves normal output and removes module preparation noise", () => {
  const value = [
    "Preparing modules for first use.",
    "useful output",
    "WARNING: Preparing modules for first use.",
  ].join("\r\n");

  assert.equal(cleanPowerShellText(value), "useful output");
});

test("cleanPowerShellText removes progress records from marked CLIXML", () => {
  const value = [
    "plain output",
    "#< CLIXML",
    '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">',
    "  <Obj S=\"progress\"><MS><S S=\"progress\">Preparing modules for first use.</S></MS></Obj>",
    "  <S S=\"Error\">Build failed_x000D__x000A_at step 2</S>",
    "</Objs>",
  ].join("\r\n");

  assert.equal(cleanPowerShellText(value), "plain output\nBuild failed\nat step 2");
});

test("cleanPowerShellText recognizes raw CLIXML without a marker", () => {
  const value = [
    '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">',
    "  <S S=\"progress\">50 percent</S>",
    "  <S S=\"Warning\">Check &lt;configuration&gt; &amp; retry</S>",
    "</Objs>",
  ].join("\n");

  assert.equal(cleanPowerShellText(value), "Check <configuration> & retry");
});

test("cleanPowerShellText drops a raw progress-only CLIXML payload", () => {
  const value = [
    '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">',
    "  <S S=\"progress\">Working</S>",
    "</Objs>",
  ].join("\n");

  assert.equal(cleanPowerShellText(value), "");
});

test("runWithTimeout returns a completed operation", async () => {
  const result = await runWithTimeout(Promise.resolve("done"), 100);
  assert.equal(result, "done");
});

test("runWithTimeout rejects and invokes cleanup when the deadline is exceeded", async () => {
  let cleanedUp = false;
  const neverCompletes = new Promise<string>(() => {});

  await assert.rejects(
    runWithTimeout(neverCompletes, 10, () => {
      cleanedUp = true;
    }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteCommandTimeoutError);
      assert.equal(error.timeoutMs, 10);
      return true;
    }
  );
  assert.equal(cleanedUp, true);
});

test("runWithTimeout preserves the timeout error when cleanup fails", async () => {
  const neverCompletes = new Promise<string>(() => {});

  await assert.rejects(
    runWithTimeout(neverCompletes, 10, () => {
      throw new Error("cleanup failed");
    }),
    RemoteCommandTimeoutError
  );
});

test("runWithTimeout rejects invalid timeout values", async () => {
  await assert.rejects(
    runWithTimeout(Promise.resolve("done"), 0),
    /timeoutMs must be a positive finite number/
  );
});

test("runWithTimeout cancels an active operation through AbortSignal", async () => {
  const controller = new AbortController();
  const neverCompletes = new Promise<string>(() => {});
  const pending = runWithTimeout(neverCompletes, 1000, undefined, controller.signal);
  controller.abort();
  await assert.rejects(pending, RemoteCommandCancelledError);
});
