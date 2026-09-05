import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface RequestActivity {
  begin(): () => void;
  middleware: RequestHandler;
  waitForDrain(): Promise<void>;
}

/** Track both HTTP response lifetime and async handler lifetime during shutdown. */
export function createRequestActivity(): RequestActivity {
  let activeRequests = 0;
  const drainWaiters = new Set<() => void>();

  const begin = (): (() => void) => {
    activeRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeRequests = Math.max(0, activeRequests - 1);
      if (activeRequests !== 0) return;
      for (const resolve of drainWaiters) resolve();
      drainWaiters.clear();
    };
  };

  const middleware: RequestHandler = (_req: Request, res: Response, next: NextFunction): void => {
    const release = begin();
    res.once("finish", release);
    res.once("close", release);
    next();
  };

  return {
    begin,
    middleware,
    waitForDrain: () => activeRequests === 0
      ? Promise.resolve()
      : new Promise((resolve) => drainWaiters.add(resolve)),
  };
}
