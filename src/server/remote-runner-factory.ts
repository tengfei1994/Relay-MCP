import { AgentRemoteRunner } from "../shared/agent-remote-runner.js";
import { RemoteRunner } from "../shared/remote-runner.js";

export interface ManagedServerConnection {
  userId: number;
  host: string;
  port: number | null;
  sshUser: string;
  privateKeyPath: string;
  os: string | null;
  status: string | null;
  connectionMode: string | null;
  agentId: string | null;
}

export function createManagedServerRunner(server: ManagedServerConnection): RemoteRunner {
  if ((server.connectionMode ?? "ssh") === "agent") {
    if (!server.agentId) throw new Error("Agent server has no Agent ID");
    return new AgentRemoteRunner(server.userId, server.agentId, server.os === "linux" ? "linux" : "windows");
  }
  if (server.status !== "connected") {
    throw new Error(`SSH server is not connected; current status is '${server.status ?? "unknown"}'`);
  }
  return new RemoteRunner({
    host: server.host,
    port: server.port ?? 22,
    username: server.sshUser,
    privateKeyPath: server.privateKeyPath,
    os: server.os === "windows" ? "windows" : "linux",
  });
}
