import type { KnowledgeStore } from "./store.js";

/** Topic bindings inherit the ACL of their concrete Product Knowledge document. */
export function canReadTopicBinding(store: KnowledgeStore, actorId: number, projectId: unknown): boolean {
  if (projectId !== undefined && projectId !== null && String(projectId).trim()) return store.canRead(actorId, String(projectId));
  return Boolean(store.db.prepare("SELECT 1 FROM knowledge_acl WHERE user_id=? AND can_read=1 LIMIT 1").get(actorId));
}
