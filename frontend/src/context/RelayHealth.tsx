import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";

type Health = "checking" | "healthy" | "degraded" | "offline";

export const healthLabels: Record<Health, string> = {
  checking: "Checking",
  healthy: "Connected",
  degraded: "Degraded",
  offline: "Offline",
};

const RelayHealth = createContext<Health>("checking");

export function RelayHealthProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    let mounted = true;
    let nextCheck: number | undefined;
    let pending: AbortController | undefined;

    async function check() {
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), 8000);
      try {
        const result = await api.health(controller.signal);
        if (mounted) setHealth(result.ok === true ? "healthy" : "degraded");
      } catch (reason) {
        if (mounted) setHealth(reason instanceof TypeError || controller.signal.aborted ? "offline" : "degraded");
      } finally {
        window.clearTimeout(timeout);
        if (mounted) nextCheck = window.setTimeout(check, 30000);
      }
    }

    void check();
    return () => {
      mounted = false;
      window.clearTimeout(nextCheck);
      pending?.abort();
    };
  }, []);

  return <RelayHealth.Provider value={health}>{children}</RelayHealth.Provider>;
}

export function useRelayHealth() {
  return useContext(RelayHealth);
}
