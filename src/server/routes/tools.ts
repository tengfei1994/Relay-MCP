import type { FastifyInstance } from "fastify";
import { TOOL_CATALOG } from "../../shared/tool-catalog.js";
import { SAMPLEMANAGER_ENTITY_CATALOG } from "../../shared/samplemanager-capabilities.js";

function classifyTool(name: string, category: string) {
  const knowledgeAccess: Record<string, "read-only" | "mutation"> = { knowledge_search: "read-only", knowledge_get: "read-only", memory_search: "read-only", knowledge_confirmed_memory_get: "read-only", memory_capture: "mutation" };
  // These operations can write even when their names do not contain a typical
  // mutation verb (for example a SQL query with allowMutation=true).
  const mutations = new Set(["exec_remote","exec_remote_powershell","exec_remote_script","relay_exec_remote","relay_exec_remote_powershell","relay_exec_remote_script",
    "job_cancel","cleanup_workspace_staging","download_remote_file","playwright_artifact_download","samplemanager_sql_query","samplemanager_sql_execute_file",
    "samplemanager_apply_change_set","samplemanager_deployment_start","samplemanager_deployment_finish"]);
  const readOnly = new Set(["samplemanager_inspect_deployment_runtime","samplemanager_discover_build_tools","samplemanager_deployment_status"]);
  const mutating = /(^|_)(deploy|restart|clear|write|delete|move|patch|upload|sync|create|convert|restore|mutation|loader|run_command|run_utility|run_suite|build)/i.test(name);
  const asyncCapable = category === "remote-execution" || category === "playwright" || category === "remote-files" || category === "samplemanager";
  const preferred = name.startsWith("relay_") || !/^exec_remote(_powershell|_script)?$/.test(name);
  return {
    access: knowledgeAccess[name] ?? (readOnly.has(name) ? "read-only" : mutations.has(name) || mutating ? "mutation" : "read-only"),
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
      { id: "context", label: "Knowledge", description: "Search product Knowledge and confirmed Memory, or submit a Memory candidate for review." },
      { id: "samplemanager", label: "SampleManager", description: "Instances, SQL, utilities, builds, forms, and deployment workflows." },
    ],
    sampleManagerEntities: SAMPLEMANAGER_ENTITY_CATALOG,
  }));
}
