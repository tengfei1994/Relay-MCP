import type { Server } from "node:http";

export interface McpShutdownOptions {
  server: Server;
  waitForDrain: () => Promise<void>;
  closeSharedResources: () => void;
  timers: Array<NodeJS.Timeout>;
  graceMs: number;
}

export function installMcpShutdown(options: McpShutdownOptions): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const timer of options.timers) clearInterval(timer);
    let forceCloseTimer: NodeJS.Timeout | undefined;
    const resourcesAfterDrain = options.waitForDrain().then(options.closeSharedResources);
    const finishAfterDrain = (exitCode: number): void => {
      void resourcesAfterDrain.then(() => {
        if (forceCloseTimer) clearTimeout(forceCloseTimer);
        process.exit(exitCode);
      }, () => process.exit(1));
    };
    options.server.close((error) => {
      if (error) {
        try { process.stderr.write(`[relay-mcp] shutdown failed: ${error.message}\n`); } catch { /* ignore */ }
        finishAfterDrain(1);
        return;
      }
      finishAfterDrain(0);
    });
    options.server.closeIdleConnections?.();
    forceCloseTimer = setTimeout(() => {
      try { process.stderr.write(`[relay-mcp] forced shutdown after ${options.graceMs}ms\n`); } catch { /* ignore logging failure */ }
      options.closeSharedResources();
      options.server.closeAllConnections?.();
      process.exit(process.exitCode ?? 0);
    }, options.graceMs);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
