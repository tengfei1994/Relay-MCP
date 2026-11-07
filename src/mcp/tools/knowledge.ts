import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpUser } from "../register-tools.js";
import type { KnowledgeStore } from "../../knowledge/store.js";
import { CONFIRMED_MEMORY_TYPES } from "../../knowledge/confirmed-memory.js";
import { getConfirmedMemory, getMemorySubmission, searchConfirmedMemories, submitMemory, type MemoryAccess } from "../../knowledge/memory-v2.js";
import { readPublicProduct, searchPublicProductChunks } from "../../knowledge/product-search-v2.js";
import { serializeKnowledgeResult } from "../knowledge-output.js";

export interface KnowledgeToolsContext {
  server: McpServer; user: McpUser; knowledge?: KnowledgeStore;
  knowledgeAvailable?: () => boolean; currentIsAdmin?: () => boolean;
  resolveProjectName?: (project?: string) => string;
  resolveProjectId?: (projectId: string) => string;
  resolveProjectNameToId?: (name: string) => string;
}

/** The five public Knowledge tools share explicit user and current-token authorization. */
export function registerKnowledgeTools(context: McpServer | KnowledgeToolsContext): void {
  const ctx: KnowledgeToolsContext = ("user" in context && "server" in context)
    ? context : { server: context as McpServer, user: { id: 0, username: "boundary" } };
  const { server, user } = ctx;
  const requireStore = () => { if (!ctx.knowledge) throw new Error("Knowledge Plane is unavailable"); return ctx.knowledge; };
  const canReadProduct = () => ctx.knowledgeAvailable ? ctx.knowledgeAvailable() : user.knowledgeEnabled === true;
  const assertProduct = () => { if (!canReadProduct()) throw new Error("Product Knowledge and general Memory access denied"); };
  const assertProject = (id: string) => {
    if (ctx.resolveProjectId) { ctx.resolveProjectId(id); return; }
    if (!requireStore().canRead(user.id, id)) throw new Error("Knowledge access denied for project");
  };
  const canonicalProject = (id: string) => ctx.resolveProjectId ? ctx.resolveProjectId(id) : id;
  const access = (): MemoryAccess => ({ actorId: user.id, isAdmin: ctx.currentIsAdmin ? ctx.currentIsAdmin() : Boolean(user.isAdmin), canReadGeneral: canReadProduct, assertProject });
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: serializeKnowledgeResult(value) }] });
  const selectedProject = () => user.defaultProjectId ? String(user.defaultProjectId)
    : user.defaultProject && ctx.resolveProjectNameToId ? ctx.resolveProjectNameToId(user.defaultProject) : undefined;
  const readOnly = { readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false };
  const submission = { readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false };

  server.tool("knowledge_search", "Search authorized published Product and Solution source chunks, independent of Project access.", {
    query: z.string().trim().min(1).max(4000), productVersion: z.string().optional(), solution: z.string().optional(),
    module: z.string().optional(), language: z.string().optional(), limit: z.number().int().min(1).max(100).optional(),
  }, readOnly, async (input) => {
    assertProduct(); const found = await searchPublicProductChunks(requireStore(), input); assertProduct(); return result(found);
  });

  server.tool("knowledge_get", "Read an authorized published Product document or one verified source chunk.", {
    documentId: z.string().min(1), chunkId: z.string().min(1).optional(),
  }, readOnly, async (input) => {
    assertProduct(); const document = await readPublicProduct(requireStore(), input); assertProduct(); return result(document);
  });

  server.tool("memory_search", "Search human-confirmed Project or general Memory. General Memory requires Product Knowledge access.", {
    query: z.string().max(4000).optional(), scope: z.enum(["project", "general", "both"]).optional(), projectId: z.string().optional(),
    type: z.enum(CONFIRMED_MEMORY_TYPES).optional(), environment: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1000000).optional(),
  }, readOnly, async (input) => {
    const requested = input.projectId ?? (input.scope === "general" ? undefined : selectedProject());
    const projectId = requested ? canonicalProject(requested) : undefined;
    return result(searchConfirmedMemories(requireStore(), access(), { ...input, projectId }));
  });

  server.tool("knowledge_confirmed_memory_get", "Read one human-confirmed Memory after checking its Project or general access.", {
    memoryId: z.string().min(1),
  }, readOnly, async ({ memoryId }) => result({ memory: getConfirmedMemory(requireStore(), access(), memoryId) }));

  server.tool("memory_capture", "Submit a carefully selected reusable experience for administrator review, or check your submission status. Submit only after local investigation; do not upload routine calls, hidden reasoning, or credentials.", {
    action: z.enum(["submit", "status"]), id: z.string().optional(), idempotencyKey: z.string().min(1).max(300).optional(),
    requestedScope: z.enum(["project", "general"]).optional(), projectId: z.string().optional(), title: z.string().min(1).max(300).optional(),
    memoryType: z.enum(CONFIRMED_MEMORY_TYPES).optional(), statement: z.string().min(1).max(8000).optional(),
    objective: z.string().max(4000).optional(), outcome: z.string().max(4000).optional(), applicability: z.string().max(2000).optional(),
    unknowns: z.array(z.string().max(1000)).max(50).optional(), evidenceRefs: z.array(z.string().min(1)).max(100).optional(), sourceRefs:z.array(z.string().trim().min(1).max(2000)).max(25).optional().describe("Agent-supplied citations; they are not independently verified."),
    workSessionId: z.string().optional(),
  }, submission, async (input) => {
    const store = requireStore();
    if (input.action === "status") {
      if (!input.id) throw new Error("Submission id is required");
      const submission = getMemorySubmission(store, access(), input.id);
      return result({ submission: { id: submission.id, status: submission.status, reviewReason: submission.reviewReason, memoryId: submission.memoryId, updatedAt: submission.updatedAt } });
    }
    if (!input.idempotencyKey || !input.requestedScope || !input.title || !input.memoryType || !input.statement) throw new Error("Submission key, scope, title, memory type and statement are required");
    const requested = input.projectId ?? (input.requestedScope === "project" ? selectedProject() : undefined);
    const projectId = requested ? canonicalProject(requested) : undefined;
    const submission = submitMemory(store, access(), { ...input, idempotencyKey: input.idempotencyKey, requestedScope: input.requestedScope, title: input.title, memoryType: input.memoryType, statement: input.statement, projectId });
    return result({ submission: { id: submission.id, status: submission.status, createdAt: submission.createdAt } });
  });
}
