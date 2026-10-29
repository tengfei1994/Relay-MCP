import { createHash, randomUUID } from "node:crypto";
import { diffLines } from "diff";
import type { KnowledgeStore } from "./store.js";
import { MigrationController } from "./migration-control.js";
import { searchKnowledgeProducts, diffKnowledgeProducts, type ProductDocumentDiff, type ProductDocumentSearchRequest } from "./knowledge-products.js";
import { WeKnoraError, type WeKnoraClient, type WeKnoraReferenceMetadata, type KnowledgeReference } from "./weknora.js";

export interface ProductBackendControlPlane {
  knowledgeBaseId: string;
  client: Pick<WeKnoraClient, "search" | "readDocument">;
}
export interface ProductBackendScope { userId: number; isAdmin?: boolean; projectId?: string; environment?: string; }
export type ProductBackendSearchInput = ProductDocumentSearchRequest & ProductBackendScope & {engineOnly?: boolean};
type Row = Record<string, unknown>;
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function parse(value: unknown, fallback: unknown): unknown { try { return JSON.parse(String(value)); } catch { return fallback; } }
function chunkIds(row: Row): string[] {
  const ids = parse(row.external_chunk_ids_json, null);
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new WeKnoraError("invalid_response", "Product source chunk mapping is invalid");
  return ids;
}
function assertScope(store: KnowledgeStore, input: ProductBackendScope): void {
  const projectId = text(input.projectId), environment = text(input.environment);
  if (environment && !projectId) throw new Error("environment requires projectId");
  if (!projectId || input.isAdmin) return;
  if (!store.canRead(input.userId, projectId)) throw new Error("Knowledge access denied");
}
export function assertProductScope(store: KnowledgeStore, input: ProductBackendScope): void { assertScope(store, input); }
export function productDocumentVisible(store: KnowledgeStore, row: Row, input: ProductBackendScope): boolean { return localAllowed(store, row, input); }
function localAllowed(store: KnowledgeStore, row: Row, input: ProductBackendScope): boolean {
  const projectId = text(row.project_id), environment = text(row.environment);
  const requestedProject = text(input.projectId), requestedEnvironment = text(input.environment);
  if (!projectId && !environment) return true;
  if (!requestedProject || projectId !== requestedProject || environment !== requestedEnvironment) return false;
  return Boolean(input.isAdmin || store.canRead(input.userId, requestedProject));
}
async function engine<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    const code = error instanceof WeKnoraError ? error.code : "unavailable";
    throw new WeKnoraError(code, "Product Knowledge engine is unavailable or degraded (" + code + "); no local fallback was used");
  }
}
async function controlPlane(store: KnowledgeStore, injected?: ProductBackendControlPlane): Promise<ProductBackendControlPlane> {
  if (injected) return injected;
  return engine(async () => {
    const { managedControlPlane } = await import("./engine-service.js");
    return managedControlPlane(store);
  });
}
function legacyMetadataByDocument(store: KnowledgeStore): Map<string, Row> {
  const rows = store.db.prepare(`SELECT md.document_id,md.local_document_id,d.id AS local_exists,d.project_name_snapshot,d.source_commit,p.document_family_id,p.document_type,p.authority,p.diff_review_status
    FROM knowledge_migration_documents md JOIN knowledge_migrations m ON m.id=md.migration_id
    LEFT JOIN knowledge_documents d ON d.id=md.local_document_id AND d.kind='product_document'
    LEFT JOIN knowledge_product_documents p ON p.id=md.local_document_id
    WHERE md.status='published' AND m.status='published'
    ORDER BY m.published_at DESC,md.local_document_id`).all() as Row[];
  const result = new Map<string, Row>();
  for (const row of rows) {
    const documentId = String(row.document_id);
    if (result.has(documentId)) continue;
    result.set(documentId, row.local_exists ? {
      project_name_snapshot: row.project_name_snapshot, source_commit: row.source_commit, document_family_id: row.document_family_id,
      document_type: row.document_type, authority: row.authority, diff_review_status: row.diff_review_status, localDocumentId: row.local_document_id,
    } : { localDocumentId: row.local_document_id });
  }
  return result;
}
function publishedRows(store: KnowledgeStore, input: ProductBackendSearchInput, knowledgeBaseId: string): Row[] {
  const projectId = text(input.projectId), environment = text(input.environment);
  const conditions = ["status='published'", "upstream_verified_at IS NOT NULL", "upstream_verified_at<>''", "external_knowledge_base_id=?"];
  const params: Array<string | null> = [knowledgeBaseId];
  if (!projectId) conditions.push("project_id IS NULL", "environment IS NULL");
  else {
    conditions.push("((project_id IS ? AND environment IS ?) OR (project_id IS NULL AND environment IS NULL))");
    params.push(projectId, environment ?? null);
  }
  const legacy = legacyMetadataByDocument(store);
  return (store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE " + conditions.join(" AND ") + " ORDER BY updated_at DESC,id").all(...params) as Row[])
    .map(row => ({ ...row, legacy: legacy.get(String(row.id)) ?? {} }))
    .filter(row => {
      const source = row as Row, metadata = source.legacy as Row;
      return (!input.product || metadata.project_name_snapshot === input.product) &&
        (!input.sampleManagerVersion || text(source.product_version) === input.sampleManagerVersion) &&
        (!input.solution || text(source.solution) === input.solution) &&
        (!input.module || text(source.module) === input.module) &&
        (!input.language || text(source.language) === input.language) &&
        (!input.documentType || metadata.document_type === input.documentType) &&
        (!input.authority || metadata.authority === input.authority);
    });
}
function metadata(row: Row): WeKnoraReferenceMetadata {
  return { title: text(row.title), version: text(row.product_version), topicId: text(row.topic_id), solution: text(row.solution),
    module: text(row.module), language: text(row.language), projectId: text(row.project_id), environment: text(row.environment),
    sourcePath: text(row.source_path), sourceSha256: text(row.raw_sha256) ?? text(row.normalized_content_sha256) };
}
function locatedSource(row: Row, locators?: KnowledgeReference["sourceLocators"]): string | undefined {
  const path = metadata(row).sourcePath, position = locators?.[0];
  if (!path) return undefined;
  if (position?.type === "pdf" && position.page) return `${path.split("#")[0]}#page=${position.page}`;
  if (position?.type === "text" && position.start !== undefined) return `${path.split("#")[0]}#char=${position.start}-${position.end ?? position.start}`;
  return path;
}
function dto(row: Row, reference?: KnowledgeReference): Row {
  const legacy = (row.legacy ?? {}) as Row, id = text(legacy.localDocumentId) ?? String(row.id);
  const source = metadata(row);
  return {
    id, documentId: id, externalDocumentId: row.external_document_id, kind: "product_document", provider: "weknora",
    title: row.title, lifecycle: "approved", status: "published", projectId: source.projectId, environment: source.environment,
    sampleManagerVersion: source.version, version: source.version, topicId: source.topicId, solution: source.solution, module: source.module, language: source.language,
    sourcePath: source.sourcePath, sourceLocator: locatedSource(row, reference?.sourceLocators), sourceSha256: source.sourceSha256,
    projectNameSnapshot: legacy.project_name_snapshot, sourceCommit: legacy.source_commit, documentFamilyId: legacy.document_family_id,
    documentType: legacy.document_type, authority: legacy.authority, diffReviewStatus: legacy.diff_review_status,
    parserVersion: row.parser_version, createdAt: row.created_at, updatedAt: row.updated_at,
    snippet: reference?.snippet, summary: reference?.snippet ?? String(row.title), score: reference?.score,
    rank: reference?.score === undefined ? undefined : -reference.score, matchReason: reference?.matchReason,
    retrievalRunId: reference?.retrievalRunId, citation: locatedSource(row, reference?.sourceLocators), chunkId: reference?.chunkId,
    sourceLocators: reference?.sourceLocators, sections: [], metadata: { provider: "weknora", parserVersion: row.parser_version },
  };
}
function citation(row: Row, chunkId?: string, locators?: KnowledgeReference["sourceLocators"]): Row {
  const source = metadata(row);
  return { documentId: text((row.legacy as Row | undefined)?.localDocumentId) ?? String(row.id), chunkId, provider: "weknora",
    sourceLocator: locatedSource(row, locators), sourceSha256: source.sourceSha256, version: source.version, topicId: source.topicId, sourceLocators: locators };
}

/** Catalog metadata must describe the same published, scoped corpus as content reads. */
export async function productCatalogVisibility(store: KnowledgeStore, input: ProductBackendScope, injected?: ProductBackendControlPlane): Promise<{ provider: "relay_local" | "weknora"; documents: Array<{ documentId: string; productVersion?: string }> }> {
  assertScope(store, input);
  const provider = new MigrationController(store).activeProductProvider();
  if (provider === "relay_local") {
    const rows = store.db.prepare("SELECT id,project_id,environment FROM knowledge_documents WHERE kind='product_document'").all() as Row[];
    return { provider, documents: rows.filter(row => localAllowed(store, row, input)).map(row => ({ documentId: String(row.id) })) };
  }
  const control = await controlPlane(store, injected); assertScope(store, input);
  const published = new Map(publishedRows(store, input, control.knowledgeBaseId).map(row => [String(row.id), row]));
  const mappings = store.db.prepare(`SELECT md.document_id,md.local_document_id,d.project_id,d.environment FROM knowledge_migration_documents md
    JOIN knowledge_migrations m ON m.id=md.migration_id JOIN knowledge_documents d ON d.id=md.local_document_id
    WHERE md.status='published' AND m.status='published' AND d.kind='product_document'`).all() as Row[];
  const visible = new Map<string, { documentId: string; productVersion?: string }>();
  for (const mapping of mappings) {
    const row = published.get(String(mapping.document_id));
    if (!row || !localAllowed(store, mapping, input)) continue;
    const document = { documentId: String(mapping.local_document_id), productVersion: text(row.product_version) };
    visible.set(JSON.stringify(document), document);
  }
  return { provider, documents: [...visible.values()] };
}

/** Both old Product HTTP/MCP callers use this boundary after the explicit provider switch. */
export async function searchProductBackend(store: KnowledgeStore, input: ProductBackendSearchInput, injected?: ProductBackendControlPlane): Promise<Row[]> {
  assertScope(store, input);
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 50)));
  if (!input.engineOnly && new MigrationController(store).activeProductProvider() === "relay_local") {
    return searchKnowledgeProducts(store, { ...input, scope: { projectId: text(input.projectId), environment: text(input.environment) }, limit: 500 }).filter(result => {
      const row = store.db.prepare("SELECT project_id,environment FROM knowledge_documents WHERE id=?").get(result.id) as Row | undefined;
      return Boolean(row && localAllowed(store, row, input));
    }).slice(0, limit);
  }
  const control = await controlPlane(store, injected), rows = publishedRows(store, input, control.knowledgeBaseId);
  if (!rows.length) return [];
  // Unqueried listings are control-plane summaries; content is always read from the selected engine.
  if (!input.query?.trim()) return rows.slice(0, limit).map(row => dto(row));
  const byExternalId = new Map(rows.map(row => [String(row.external_document_id), row]));
  const result = await engine(() => control.client.search({ query: input.query!.trim(), knowledgeIds: [...byExternalId.keys()], limit: Math.min(200, limit), distinctDocuments: true,
    documentMetadata: Object.fromEntries(rows.map(row => [String(row.external_document_id), metadata(row)])) }));
  if (result.degraded) throw new WeKnoraError("unavailable", "Product Knowledge search is degraded; no local fallback was used");
  assertScope(store, input);
  const current = new Map(publishedRows(store, input, control.knowledgeBaseId).map(row => [String(row.external_document_id), row]));
  const found = new Map<string, Row>();
  for (const ref of result.references) {
    const row = byExternalId.has(ref.documentId) ? current.get(ref.documentId) : undefined;
    if (!row) throw new WeKnoraError("invalid_response", "Product Knowledge returned a reference outside the authorized scope");
    if (!ref.chunkId || !chunkIds(row).includes(ref.chunkId)) throw new WeKnoraError("invalid_response", "Product Knowledge returned an unverified chunk reference");
    const previous = found.get(ref.documentId);
    if (previous) (previous.citations as Row[]).push(citation(row, ref.chunkId, ref.sourceLocators));
    else found.set(ref.documentId, { ...dto(row, ref), citations: [citation(row, ref.chunkId, ref.sourceLocators)] });
  }
  return [...found.values()].slice(0, limit);
}

export async function getProductBackend(store: KnowledgeStore, input: ProductBackendScope & { documentId: string }, injected?: ProductBackendControlPlane): Promise<Row> {
  assertScope(store, input);
  const provider = new MigrationController(store).activeProductProvider();
  const directEngine = provider === "relay_local" && Boolean(store.db.prepare(`SELECT 1 FROM knowledge_weknora_documents
    WHERE (id=? OR external_document_id=?) AND project_id IS NULL AND environment IS NULL`).get(input.documentId, input.documentId));
  if (provider === "relay_local" && !directEngine) {
    const row = store.db.prepare(`SELECT d.*,p.document_family_id,p.document_type,p.language,p.authority,p.source_path,p.version,p.sections_json,p.metadata_json,p.diff_review_status
      FROM knowledge_documents d LEFT JOIN knowledge_product_documents p ON p.id=d.id WHERE d.id=? AND d.kind='product_document'`).get(input.documentId) as Row | undefined;
    if (!row || !localAllowed(store, row, input)) throw new Error("Product document not found or access denied");
    return { id: row.id, kind: "product_document", provider: "relay_local", title: row.title, body: row.body, lifecycle: row.lifecycle,
      projectId: text(row.project_id), environment: text(row.environment), projectNameSnapshot: row.project_name_snapshot,
      sampleManagerVersion: row.samplemanager_version, version: row.version, solution: row.solution, module: row.module,
      sourceLocator: row.source_locator, sourcePath: row.source_path, sourceSha256: row.source_sha256, sourceCommit: row.source_commit,
      documentFamilyId: row.document_family_id, documentType: row.document_type, language: row.language, authority: row.authority,
      sections: parse(row.sections_json, []), metadata: parse(row.metadata_json, {}), createdAt: row.created_at, updatedAt: row.updated_at,
      citations: [{ documentId: row.id, sourceLocator: row.source_locator, sourceSha256: row.source_sha256, version: row.samplemanager_version }] };
  }
  const control = await controlPlane(store, injected);
  const rows = publishedRows(store, input, control.knowledgeBaseId);
  let row = rows.find(item => item.id === input.documentId || item.external_document_id === input.documentId);
  if (!row) {
    const mappings = store.db.prepare(`SELECT md.document_id FROM knowledge_migration_documents md JOIN knowledge_migrations m ON m.id=md.migration_id
      WHERE md.local_document_id=? AND md.status='published' AND m.status='published' ORDER BY m.published_at DESC`).all(input.documentId) as Row[];
    row = mappings.map(mapping => rows.find(item => item.id === mapping.document_id)).find(Boolean);
    if (row) row = { ...row, legacy: { ...(row.legacy as Row), localDocumentId: input.documentId } };
  }
  if (!row) throw new Error("Published Product document not found or access denied; a published migration is required for legacy IDs");
  const expectedHash = text(row.normalized_content_sha256);
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new WeKnoraError("invalid_response", "Product normalized source hash is invalid");
  const remote = await engine(() => control.client.readDocument(String(row!.external_document_id), { expectedNormalizedSha256: expectedHash }));
  assertScope(store, input);
  const refreshed = publishedRows(store, input, control.knowledgeBaseId).find(item => item.id === row!.id);
  if (!refreshed) throw new Error("Product publication changed or access denied during the read");
  row = { ...refreshed, legacy: row.legacy };
  if (remote.documentId !== row.external_document_id) throw new WeKnoraError("invalid_response", "Product Knowledge returned a mismatched document reference");
  if (remote.parseStatus !== "completed") throw new WeKnoraError("parse_failed", "Product document is not fully parsed and ready");
  const allowedChunks = new Set(chunkIds(row));
  if (!remote.chunks.length || remote.chunks.some(chunk => chunk.documentId !== row!.external_document_id || !allowedChunks.has(chunk.chunkId) || chunk.isEnabled === false))
    throw new WeKnoraError("invalid_response", "Product Knowledge returned an unverified or mismatched chunk reference");
  // Recheck after the network await against the current publication as well as
  // the identity captured before the read. Injected clients cannot bypass this.
  if (row.normalized_content_sha256 !== expectedHash || createHash("sha256").update(remote.content, "utf8").digest("hex") !== expectedHash)
    throw new WeKnoraError("invalid_response", "Product normalized source hash does not match the published identity");
  return { ...dto(row), body: remote.content, summary: remote.content.slice(0, 500),
    citations: remote.chunks.map(chunk => citation(row!, chunk.chunkId, chunk.sourceLocators)),
    sections: remote.chunks.map(chunk => ({ key: chunk.chunkId, path: text(row!.source_path), title: text(chunk.sourceLocators?.[0]?.title) ?? String(row!.title),
      text: chunk.content, chunkId: chunk.chunkId, sourceLocators: chunk.sourceLocators, seq: chunk.seq })),
  };
}


/** The named engine search and Context Pack share the same citation/ACL boundary as standard Product search. */
export async function searchEngineProductReferences(store:KnowledgeStore,input:ProductBackendSearchInput,injected?:ProductBackendControlPlane):Promise<{retrievalRunId:string;references:KnowledgeReference[];degraded?:Record<string,string>}> {
  let products:Row[];
  try { products=await searchProductBackend(store,{...input,engineOnly:true},injected); }
  catch(error) {
    if(!(error instanceof WeKnoraError)||!["timeout","unavailable","rate_limited","unauthorized"].includes(error.code))throw error;
    // Only the Product section degrades; callers can still return confirmed Relay memory.
    // ACL errors and malformed/unverified source references remain fail-closed.
    return {retrievalRunId:randomUUID(),references:[],degraded:{productKnowledge:error.code}};
  }
  const references:KnowledgeReference[]=products.map(row=>({
    provider:"weknora",documentId:String(row.externalDocumentId),chunkId:row.chunkId?String(row.chunkId):undefined,
    title:String(row.title),snippet:row.snippet?String(row.snippet):undefined,score:typeof row.score==="number"?row.score:undefined,
    version:row.version?String(row.version):undefined,solution:row.solution?String(row.solution):undefined,module:row.module?String(row.module):undefined,
    topicId:row.topicId?String(row.topicId):undefined,language:row.language?String(row.language):undefined,
    projectId:row.projectId?String(row.projectId):undefined,environment:row.environment?String(row.environment):undefined,
    sourceLocator:row.sourceLocator?String(row.sourceLocator):undefined,sourceSha256:row.sourceSha256?String(row.sourceSha256):undefined,
    sourcePath:row.sourcePath?String(row.sourcePath):undefined,sourceLocators:row.sourceLocators as KnowledgeReference["sourceLocators"],matchReason:row.matchReason?String(row.matchReason):undefined,
    citation:row.citation?String(row.citation):undefined,retrievalRunId:String(row.retrievalRunId??"engine-empty")
  }));
  return {retrievalRunId:references[0]?.retrievalRunId??"engine-empty",references};
}


export async function listEngineProductBackend(store: KnowledgeStore, input: ProductBackendSearchInput & { offset?: number; status?: string }, injected?: ProductBackendControlPlane) {
  assertScope(store,input);
  const limit=Math.max(1,Math.min(500,Math.trunc(input.limit??100))),offset=Math.max(0,Math.trunc(input.offset??0));
  // The public Product catalog contains only current verified publications.
  // UI lifecycle "approved" and engine "published" name that same state.
  const status=text(input.status);
  if(status&&!['approved','published'].includes(status))return {documents:[],page:{limit,offset,total:0},provider:"weknora"};
  const control=await controlPlane(store,injected); assertScope(store,input);
  const rows=publishedRows(store,input,control.knowledgeBaseId);
  return {documents:rows.slice(offset,offset+limit).map(row=>dto(row)),page:{limit,offset,total:rows.length},provider:"weknora"};
}

export async function diffProductBackend(store:KnowledgeStore,input:ProductBackendScope & {leftId:string;rightId:string},injected?:ProductBackendControlPlane):Promise<ProductDocumentDiff> {
  const left=await getProductBackend(store,{...input,documentId:input.leftId},injected);
  const right=await getProductBackend(store,{...input,documentId:input.rightId},injected);
  if(left.provider!==right.provider)throw new Error("Product provider changed during diff; retry the request");
  if(!left.documentFamilyId||left.documentFamilyId!==right.documentFamilyId)throw new Error("Product document diff requires the same document family");
  if(left.provider==="relay_local")return diffKnowledgeProducts(store,input.leftId,input.rightId);
  const a=String(left.body??""),b=String(right.body??"");
  return {leftId:input.leftId,rightId:input.rightId,leftVersion:text(left.version),rightVersion:text(right.version),leftSourceSha256:text(left.sourceSha256),rightSourceSha256:text(right.sourceSha256),reviewStatus:String(right.diffReviewStatus??"not_reviewed"),
    changes:[{key:"body",path:text(right.sourcePath),status:a===b?"unchanged":"modified",left:{text:a,citations:left.citations},right:{text:b,citations:right.citations},textDiff:diffLines(a,b).map(part=>({value:part.value,...(part.added?{added:true}:{}),...(part.removed?{removed:true}:{})}))}]};
}
