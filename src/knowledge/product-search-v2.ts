import type { KnowledgeStore } from "./store.js";
import { MigrationController } from "./migration-control.js";
import { tokenize } from "./providers.js";
import { managedControlPlane } from "./engine-service.js";
import { WeKnoraError, type WeKnoraClient, type WeKnoraReferenceMetadata } from "./weknora.js";
import { publicSourceLocation } from "./source-display.js";

type Row = Record<string, unknown>;
type Control = { knowledgeBaseId: string; client: Pick<WeKnoraClient, "search" | "getChunk" | "readDocument" | "requestJson"> };
export interface ProductSearchInput { query: string; productVersion?: string; solution?: string; module?: string; language?: string; limit?: number; }

function engineRows(store: KnowledgeStore, knowledgeBaseId: string, input: Partial<ProductSearchInput> = {}): Row[] {
  const rows = store.db.prepare(`SELECT w.*,
    (SELECT md.local_document_id FROM knowledge_migration_documents md JOIN knowledge_migrations m ON m.id=md.migration_id
      WHERE md.document_id=w.id AND md.status='published' AND m.status='published' ORDER BY m.published_at DESC LIMIT 1) AS local_document_id
    FROM knowledge_weknora_documents w WHERE w.status='published' AND w.upstream_verified_at IS NOT NULL
      AND w.upstream_verified_at<>'' AND w.external_knowledge_base_id=? ORDER BY w.id`).all(knowledgeBaseId) as Row[];
  const classification = store.db.prepare("SELECT classification FROM knowledge_product_classifications WHERE document_id=?");
  return rows.filter(row => {
    // A mapped canonical document always determines classification, not its engine shadow.
    const key = String(row.local_document_id ?? row.id);
    const state = classification.get(key) as { classification?: string } | undefined;
    const local = row.local_document_id ? store.db.prepare("SELECT lifecycle FROM knowledge_documents WHERE id=? AND kind='product_document'").get(row.local_document_id) as {lifecycle?:string} | undefined : undefined;
    return state?.classification === "product" && (!row.local_document_id || (local && ["approved","verified"].includes(String(local.lifecycle)))) && (!input.productVersion || row.product_version === input.productVersion)
      && (!input.solution || row.solution === input.solution) && (!input.module || row.module === input.module)
      && (!input.language || row.language === input.language);
  });
}
function chunks(row: Row): string[] {
  try { const value = JSON.parse(String(row.external_chunk_ids_json)); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []; } catch { return []; }
}
function sourceMetadata(row: Row): WeKnoraReferenceMetadata {
  return { title: String(row.title ?? ""), version: row.product_version ? String(row.product_version) : undefined,
    solution: row.solution ? String(row.solution) : undefined, module: row.module ? String(row.module) : undefined,
    language: row.language ? String(row.language) : undefined, sourcePath: publicSourceLocation(row.source_path),
    sourceSha256: String(row.raw_sha256 ?? row.normalized_content_sha256 ?? "") };
}
function activeControl(store: KnowledgeStore, injected?: Control): Control { return injected ?? managedControlPlane(store); }
async function engine<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    const code = error instanceof WeKnoraError ? error.code : "unavailable";
    throw new WeKnoraError(code, `Product Knowledge engine is unavailable or degraded (${code}); no local fallback was used`);
  }
}
function unchanged(original: Row, current: Row | undefined): boolean {
  return Boolean(current && ["id", "local_document_id", "external_document_id", "external_knowledge_base_id", "external_chunk_ids_json", "normalized_content_sha256", "raw_sha256", "upstream_verified_at"].every(key => current[key] === original[key]));
}

/** Product retrieval is independent of project scope; only reviewed product classifications are eligible. */
export async function searchPublicProductChunks(store: KnowledgeStore, input: ProductSearchInput, injected?: Control) {
  const query = input.query.trim(); if (!query) throw new Error("query is required");
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 10)));
  if (new MigrationController(store).activeProductProvider() === "relay_local") {
    const tokens = tokenize(query).slice(0, 32);
    if (!tokens.length) return { references: [], provider: "relay_local" };
    const where = ["knowledge_product_chunk_fts MATCH ?", "d.kind='product_document'", "d.lifecycle IN ('approved','verified')", "classification.classification='product'"];
    const params: unknown[] = [tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(" OR ")];
    for (const [column, value] of [["d.samplemanager_version", input.productVersion], ["d.solution", input.solution], ["d.module", input.module], ["p.language", input.language]] as const) if (value) { where.push(`${column}=?`); params.push(value); }
    const rows = store.db.prepare(`SELECT d.id AS document_id,c.id AS chunk_id,c.content,c.ordinal,d.title,d.samplemanager_version,d.solution,d.module,d.source_locator,d.source_sha256,p.language,p.source_path,bm25(knowledge_product_chunk_fts) AS rank
      FROM knowledge_product_chunk_fts JOIN knowledge_documents d ON d.id=knowledge_product_chunk_fts.document_id
      JOIN knowledge_chunks c ON c.id=knowledge_product_chunk_fts.chunk_id AND c.document_id=d.id AND c.content=knowledge_product_chunk_fts.body
      JOIN knowledge_product_documents p ON p.id=d.id JOIN knowledge_product_classifications classification ON classification.document_id=d.id
      WHERE ${where.join(" AND ")} ORDER BY rank,d.id,c.ordinal LIMIT ?`).all(...params, limit) as Row[];
    return { provider: "relay_local", references: rows.map(row => ({ documentId: row.document_id, chunkId: row.chunk_id, title: row.title, snippet: row.content, version: row.samplemanager_version, solution: row.solution, module: row.module, language: row.language, sourceLocator: publicSourceLocation(row.source_locator), sourcePath: publicSourceLocation(row.source_path), sourceSha256: row.source_sha256, ordinal:row.ordinal, citation:{ documentId:row.document_id, chunkId:row.chunk_id, ordinal:row.ordinal, sourceLocator:publicSourceLocation(row.source_locator) }, score: row.rank })) };
  }
  const control = await engine(async () => activeControl(store, injected)), rows = engineRows(store, control.knowledgeBaseId, input);
  if (!rows.length) {
    // An empty authorized catalogue must still distinguish an unreachable
    // engine from a healthy engine that simply has no eligible documents.
    await engine(() => control.client.requestJson("GET",`/api/v1/knowledge-bases/${encodeURIComponent(control.knowledgeBaseId)}`));
    return { provider: "weknora", references: [] };
  }
  const byExternal = new Map(rows.map(row => [String(row.external_document_id), row]));
  const metadata = Object.fromEntries(rows.map(row => [String(row.external_document_id), sourceMetadata(row)]));
  const result = await engine(() => control.client.search({ query, knowledgeIds: [...byExternal.keys()], documentMetadata: metadata, limit, distinctDocuments: false }));
  if (result.degraded) throw new Error("Product Knowledge engine is unavailable");
  const references = [];
  for (const ref of result.references) {
    const row = byExternal.get(ref.documentId);
    if (!row || !ref.chunkId || !chunks(row).includes(ref.chunkId)) throw new Error("Product Knowledge returned an unverified chunk");
    const chunk = await engine(() => control.client.getChunk(ref.chunkId!));
    if (chunk.chunkId !== ref.chunkId || chunk.documentId !== ref.documentId || chunk.isEnabled === false || (chunk.indexStatus && chunk.indexStatus !== "ready")) throw new Error("Product Knowledge returned an invalid chunk");
    const documentId = String(row.local_document_id ?? row.id);
    references.push({ provider:"weknora" as const, documentId, externalDocumentId:ref.documentId, chunkId:ref.chunkId,
      ...sourceMetadata(row), snippet:chunk.content, sourceLocators:chunk.sourceLocators, score:ref.score, retrievalRunId:result.retrievalRunId,
      citation:{documentId,chunkId:ref.chunkId,sourceLocators:chunk.sourceLocators} });
  }
  // Publication/classification may change while waiting for the engine.
  const current = new Map(engineRows(store, control.knowledgeBaseId, input).map(row => [String(row.external_document_id), row]));
  if (references.some(ref => !unchanged(byExternal.get(ref.externalDocumentId)!, current.get(ref.externalDocumentId)))) throw new Error("Product publication changed during search");
  return { provider: "weknora", retrievalRunId: result.retrievalRunId, references };
}

export async function readPublicProduct(store: KnowledgeStore, input: { documentId: string; chunkId?: string }, injected?: Control) {
  if (new MigrationController(store).activeProductProvider() === "relay_local") {
    const row = store.db.prepare(`SELECT d.*,p.source_path,p.version,p.language FROM knowledge_documents d
      JOIN knowledge_product_documents p ON p.id=d.id JOIN knowledge_product_classifications c ON c.document_id=d.id
      WHERE d.id=? AND d.kind='product_document' AND d.lifecycle IN ('approved','verified') AND c.classification='product'`).get(input.documentId) as Row | undefined;
    if (!row) throw new Error("Product document not found or access denied");
    const chunk = input.chunkId ? store.db.prepare("SELECT id,content,ordinal FROM knowledge_chunks WHERE id=? AND document_id=?").get(input.chunkId, input.documentId) as Row | undefined : undefined;
    if (input.chunkId && !chunk) throw new Error("Product chunk not found");
    return { id: row.id, documentId: row.id, chunkId: chunk?.id, title: row.title, body: chunk ? chunk.content : row.body, version: row.version, language: row.language, sourceLocator: publicSourceLocation(row.source_locator), sourcePath: publicSourceLocation(row.source_path), sourceSha256: row.source_sha256, citations:[{documentId:row.id,chunkId:chunk?.id,sourceLocator:publicSourceLocation(row.source_locator),sourcePath:publicSourceLocation(row.source_path),sourceSha256:row.source_sha256,version:row.version,ordinal:chunk?.ordinal}] };
  }
  const control = await engine(async () => activeControl(store, injected)), rows = engineRows(store, control.knowledgeBaseId);
  const row = rows.find(item => [item.id, item.local_document_id, item.external_document_id].some(id => id === input.documentId));
  if (!row) throw new Error("Product document not found or access denied");
  const documentId = String(row.external_document_id), allowed = chunks(row);
  let body: string, sourceLocators: unknown;
  if (input.chunkId) {
    if (!allowed.includes(input.chunkId)) throw new Error("Product chunk not found");
    const chunk = await engine(() => control.client.getChunk(input.chunkId!));
    if (chunk.chunkId !== input.chunkId || chunk.documentId !== documentId || chunk.isEnabled === false || (chunk.indexStatus && chunk.indexStatus !== "ready")) throw new Error("Product chunk is unavailable");
    body = chunk.content; sourceLocators = chunk.sourceLocators;
  } else {
    const doc = await engine(() => control.client.readDocument(documentId, { expectedNormalizedSha256: String(row.normalized_content_sha256) }));
    if (doc.documentId !== documentId || doc.parseStatus !== "completed" || !doc.chunks.length || doc.chunks.some(chunk => chunk.documentId !== documentId || !allowed.includes(chunk.chunkId) || chunk.isEnabled === false || (chunk.indexStatus && chunk.indexStatus !== "ready"))) throw new Error("Product document contains unverified chunks");
    body = doc.content; sourceLocators = doc.chunks.flatMap(chunk => chunk.sourceLocators ?? []);
  }
  if (!unchanged(row,engineRows(store, control.knowledgeBaseId).find(item => item.id === row.id))) throw new Error("Product publication changed during read");
  return { documentId: String(row.local_document_id ?? row.id), externalDocumentId: documentId, chunkId: input.chunkId, title: row.title, body, ...sourceMetadata(row), sourceLocators, citations:[{documentId:String(row.local_document_id ?? row.id),chunkId:input.chunkId,sourceLocators}] };
}
