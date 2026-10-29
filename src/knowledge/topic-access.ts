import type { KnowledgeStore } from "./store.js";

/** Global Product topic bindings have no project ACL; scoped bindings inherit their project ACL. */
export function canReadTopicBinding(store: KnowledgeStore, actorId: number, projectId: unknown): boolean {
  if (projectId !== undefined && projectId !== null && String(projectId).trim()) return store.canRead(actorId, String(projectId));
  return true;
}
