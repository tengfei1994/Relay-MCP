import type { FastifyInstance } from "fastify";
import { TOOL_CATALOG } from "../../shared/tool-catalog.js";

function classifyTool(name: string, category: string) {
  const mutating = /(^|_)(deploy|restart|write|delete|move|patch|upload|sync|create|convert|restore|mutation|loader|run_command|run_utility|run_suite|build)/i.test(name);
  const asyncCapable = category === "remote-execution" || category === "playwright" || category === "remote-files" || category === "samplemanager";
  const preferred = name.startsWith("relay_") || !/^exec_remote(_powershell|_script)?$/.test(name);
  return {
    access: mutating ? "mutation" : "read-only",
    execution: asyncCapable ? "remote-capable" : "local-service",
    lifecycle: name.startsWith("relay_") ? "preferred" : preferred ? "standard" : "legacy",
  } as const;
}

export async function toolRoutes(app: FastifyInstance) {
  app.get("/api/tools", { onRequest: [app.authenticate] }, async () => ({
    tools: TOOL_CATALOG.map((tool) => ({
      ...tool,
      ...classifyTool(tool.name, tool.category),
    })),
    categories: [
      { id: "project", label: "Project", description: "Project scope, server links, and Relay route identity." },
      { id: "remote-execution", label: "Remote execution", description: "Commands, PowerShell, deployments, services, and logs." },
      { id: "playwright", label: "Playwright", description: "Agent-owned browser runtime, suites, test runs, and downloadable artifacts." },
      { id: "remote-files", label: "Remote files", description: "Read, write, patch, download, and transfer remote files." },
      { id: "workspace", label: "Workspace", description: "Relay workspace files, uploads, staging, and synchronization." },
      { id: "jobs", label: "Jobs", description: "Track, inspect, and cancel asynchronous work." },
      { id: "context", label: "Context", description: "Durable project facts and search." },
      { id: "samplemanager", label: "SampleManager", description: "Instances, SQL, utilities, builds, forms, and deployment workflows." },
    ],
  }));
}
