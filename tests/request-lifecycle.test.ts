import assert from "node:assert/strict";
import test from "node:test";
import { createRequestActivity } from "../src/mcp/request-lifecycle.ts";

test("request drain waits for the async handler lifetime", async () => {
  const activity = createRequestActivity();
  const releaseHandler = activity.begin();
  let drained = false;
  const drain = activity.waitForDrain().then(() => { drained = true; });

  await Promise.resolve();
  assert.equal(drained, false);
  releaseHandler();
  await drain;
  assert.equal(drained, true);
});

test("response finish and close release a tracked HTTP request only once", async () => {
  const activity = createRequestActivity();
  const listeners = new Map<string, () => void>();
  activity.middleware(
    {} as never,
    { once: (event: string, listener: () => void) => { listeners.set(event, listener); } } as never,
    () => undefined,
  );

  assert.equal(listeners.size, 2);
  const drain = activity.waitForDrain();
  listeners.get("finish")?.();
  listeners.get("close")?.();
  await drain;
});
