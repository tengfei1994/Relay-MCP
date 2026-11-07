import type { KnowledgeStore } from "./store.js";

type Row = Record<string, unknown>;

/** Validate each source independently; a page cannot widen its sources' visibility. */
export function wikiSourcesVisible(store: KnowledgeStore, refs: string[], pageProjectId: string | undefined, canReadProduct: boolean): boolean {
  for (const ref of new Set(refs)) {
    const local = store.db.prepare(`SELECT d.id,COALESCE(d.project_id,(SELECT s.source_project_id FROM knowledge_scope_bindings s WHERE s.document_id=d.id AND s.source_project_id IS NOT NULL ORDER BY s.updated_at DESC LIMIT 1)) AS project_id,d.lifecycle,c.classification FROM knowledge_documents d
      LEFT JOIN knowledge_product_classifications c ON c.document_id=d.id WHERE d.id=? AND d.kind='product_document'`).get(ref) as Row | undefined;
    const engine = !local ? store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE id=? OR external_document_id=? LIMIT 1").get(ref, ref) as Row | undefined : undefined;
    let source = local;
    if (engine) {
      const mapped = store.db.prepare(`SELECT d.id,COALESCE(d.project_id,(SELECT s.source_project_id FROM knowledge_scope_bindings s WHERE s.document_id=d.id AND s.source_project_id IS NOT NULL ORDER BY s.updated_at DESC LIMIT 1)) AS project_id,d.lifecycle,c.classification FROM knowledge_migration_documents m
        JOIN knowledge_documents d ON d.id=m.local_document_id LEFT JOIN knowledge_product_classifications c ON c.document_id=d.id
        WHERE m.document_id=? ORDER BY (m.status='published') DESC LIMIT 1`).get(engine.id) as Row | undefined;
      const classification = store.db.prepare("SELECT classification FROM knowledge_product_classifications WHERE document_id=?").get(engine.id) as Row | undefined;
      source = mapped ?? { project_id:engine.project_id, lifecycle:engine.status === "published" && engine.upstream_verified_at ? "approved" : "draft", classification:classification?.classification };
      if (engine.status !== "published" || !engine.upstream_verified_at) return false;
    }
    if (!source) return false;
    if (canReadProduct && source.classification === "product" && ["approved", "verified"].includes(String(source.lifecycle))) continue;
    if (pageProjectId && String(source.project_id ?? "") === pageProjectId && source.classification !== "product") continue;
    return false;
  }
  return true;
}

export function wikiPageVisible(store: KnowledgeStore, row: Row, canReadProduct: boolean, projectId?: string): boolean {
  const sourceProject = row.project_id ? String(row.project_id) : undefined;
  if (sourceProject ? sourceProject !== projectId : !canReadProduct) return false;
  let refs: unknown;
  try { refs = JSON.parse(String(row.source_refs_json ?? "[]")); } catch { return false; }
  if (!Array.isArray(refs) || refs.some(ref => typeof ref !== "string")) return false;
  const citations = store.db.prepare(`SELECT DISTINCT c.document_id FROM knowledge_wiki_section_citations c
    JOIN knowledge_wiki_sections s ON s.id=c.section_id WHERE s.page_id=?`).all(row.id) as Array<{document_id:string}>;
  return wikiSourcesVisible(store, [...refs as string[], ...citations.map(item => item.document_id)], sourceProject, canReadProduct);
}

export function visibleWikiPageIds(store: KnowledgeStore, canReadProduct: boolean, projectId?: string): string[] {
  const rows = store.db.prepare("SELECT id,project_id,source_refs_json FROM knowledge_wiki_pages").all() as Row[];
  return rows.filter(row => wikiPageVisible(store, row, canReadProduct, projectId)).map(row => String(row.id));
}

/** A page's current sources are not proof of what an older revision contained. */
export function wikiRevisionVisible(store: KnowledgeStore, pageId:string, revision:number, canReadProduct:boolean, projectId?:string):boolean {
  const page=store.db.prepare("SELECT id,project_id,source_refs_json FROM knowledge_wiki_pages WHERE id=?").get(pageId) as Row|undefined;
  if (!page || !wikiPageVisible(store,page,canReadProduct,projectId)) return false;
  const snapshot=store.db.prepare("SELECT source_refs_json FROM knowledge_wiki_revision_sources WHERE page_id=? AND revision=?").get(pageId,revision) as Row|undefined;
  if (!snapshot) return false;
  try {
    const refs=JSON.parse(String(snapshot.source_refs_json));
    return Array.isArray(refs) && refs.every(ref=>typeof ref === "string") && wikiSourcesVisible(store,refs,page.project_id?String(page.project_id):undefined,canReadProduct);
  } catch { return false; }
}
