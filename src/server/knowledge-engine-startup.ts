import { setTimeout as delay } from "node:timers/promises";

export type EngineStartupResult = "ready" | "not_installed" | "exhausted" | "stopped";
export interface EngineStartupOptions {
  installed(): boolean;
  initialize(): Promise<unknown>;
  report(event: { state: "retrying" | "exhausted"; attempt: number; nextDelayMs?: number }): void;
  retryDelaysMs?: readonly number[];
}

export function createEngineStartupReconciler(options: EngineStartupOptions) {
  // Ten attempts cover a slow supervised process startup without an endless
  // bootstrap loop for invalid provider configuration.
  const delays = (options.retryDelaysMs ?? [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]).slice(0, 9);
  const controller = new AbortController();
  let running: Promise<EngineStartupResult> | undefined;
  async function run(): Promise<EngineStartupResult> {
    for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
      if (controller.signal.aborted) return "stopped";
      try {
        if (!options.installed()) return "not_installed";
        await options.initialize();
        return controller.signal.aborted ? "stopped" : "ready";
      } catch {
        if (controller.signal.aborted) return "stopped";
        const nextDelayMs = delays[attempt - 1];
        // Never forward upstream exceptions, configuration, or credentials to logs.
        if (nextDelayMs === undefined) {
          options.report({ state: "exhausted", attempt });
          return "exhausted";
        }
        options.report({ state: "retrying", attempt, nextDelayMs });
        try { await delay(nextDelayMs, undefined, { signal: controller.signal }); }
        catch { return "stopped"; }
      }
    }
    return "exhausted";
  }
  return {
    start(): Promise<EngineStartupResult> {
      if (controller.signal.aborted) return Promise.resolve("stopped");
      return running ??= run();
    },
    async stop(): Promise<void> {
      controller.abort();
      // Keep the model gateway serving until an already-started initialization
      // settles; no new attempt is allowed after shutdown begins.
      await running;
    },
  };
}
