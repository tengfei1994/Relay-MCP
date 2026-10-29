import { createHash } from "node:crypto";
import type { KnowledgeStore } from "./store.js";

export const PRODUCT_GRAPH_EXTRACTION_VERSION = "product-graph-1";

type Metadata = Record<string, unknown>;

export interface ProductGraphEntity {
  id: string;
  canonicalKey: string;
  name: string;
  kind: string;
  documentId: string;
  sourceLocator: string;
  sourceSha256: string;
  productVersion?: string;
  solution?: string;
  module?: string;
  projectId?: string;
  environment?: string;
  confidence: number;
  extractionVersion: string;
}

export interface ProductGraphRelation {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  documentId: string;
  sourceLocator: string;
  sourceSha256: string;
  productVersion?: string;
  solution?: string;
  module?: string;
  projectId?: string;
  environment?: string;
  confidence: number;
  verified: boolean;
  extractionVersion: string;
}

export interface ProductGraph {
  entities: ProductGraphEntity[];
  relations: ProductGraphRelation[];
}

/** Input deliberately accepts both importer terminology (body, locator, version)
 * and parser terminology (text, sourceLocator, productVersion). */
export interface ProductGraphInput {
  documentId: string;
  title?: string;
  body?: string;
  text?: string;
  metadata?: Metadata;
  sourceLocator?: string;
  locator?: string;
  sourceSha256?: string;
  sourceHash?: string;
  productVersion?: string;
  version?: string;
  sampleManagerVersion?: string;
  product?: string;
  solution?: string;
  module?: string;
  projectId?: string;
  environment?: string;
  confidence?: number;
  extractionVersion?: string;
}

export interface ProductGraphPersistenceResult {
  entityCount: number;
  relationCount: number;
  documentId: string;
  extractionVersion: string;
}

export interface ProductGraphQueryRequest {
  actorId?: number;
  isAdmin?: boolean;
  projectId?: string;
  environment?: string;
  productVersion?: string;
  solution?: string;
  module?: string;
  query?: string;
  relationType?: string;
  relationTypes?: readonly string[];
  includeDeprecated?: boolean;
  limit?: number;
}

export interface ProductGraphQueryResult {
  entities: ProductGraphEntity[];
  relations: ProductGraphRelation[];
}

interface NormalizedInput {
  documentId: string;
  title: string;
  text: string;
  metadata: Metadata;
  sourceLocator: string;
  sourceSha256: string;
  product?: string;
  productVersion?: string;
  solution?: string;
  module?: string;
  projectId?: string;
  environment?: string;
  confidence: number;
  extractionVersion: string;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const optional = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
};
const clean = (value: string): string => value.replace(/\s+/g, " ").trim();
const keyPart = (value: string): string => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 240) || "unnamed";
const boundedConfidence = (value: unknown, fallback = 0.8): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
};
const parseMetadata = (value: unknown): Metadata => value && typeof value === "object" && !Array.isArray(value) ? value as Metadata : {};

function normalizeInput(input: ProductGraphInput): NormalizedInput {
  if (!input || typeof input !== "object" || !optional(input.documentId)) throw new Error("Product graph documentId is required");
  const metadata = parseMetadata(input.metadata);
  const scope = parseMetadata(metadata.scope);
  const text = String(input.body ?? input.text ?? "");
  const sourceSha256 = optional(input.sourceSha256) ?? optional(input.sourceHash) ?? sha256(text);
  const sourceLocator = optional(input.sourceLocator) ?? optional(input.locator) ?? `product-document:${input.documentId}`;
  const version = optional(input.productVersion) ?? optional(input.version) ?? optional(input.sampleManagerVersion) ?? optional(metadata.productVersion) ?? optional(metadata.version) ?? optional(scope.productVersion) ?? optional(scope.version);
  const title = optional(input.title) ?? optional(metadata.title) ?? input.documentId;
  return {
    documentId: String(input.documentId), title, text, metadata, sourceLocator, sourceSha256,
    product: optional(input.product) ?? optional(metadata.product),
    productVersion: version,
    solution: optional(input.solution) ?? optional(metadata.solution) ?? optional(scope.solution),
    module: optional(input.module) ?? optional(metadata.module) ?? optional(scope.module),
    projectId: optional(input.projectId) ?? optional(metadata.projectId) ?? optional(scope.projectId),
    environment: optional(input.environment) ?? optional(metadata.environment) ?? optional(scope.environment),
    confidence: boundedConfidence(input.confidence ?? metadata.confidence),
    extractionVersion: optional(input.extractionVersion) ?? PRODUCT_GRAPH_EXTRACTION_VERSION,
  };
}

function entityId(documentId: string, canonicalKey: string, extractionVersion: string): string {
  return `product-graph-entity-${sha256(`${documentId}\0${canonicalKey}\0${extractionVersion}`).slice(0, 32)}`;
}
function relationId(documentId: string, from: string, to: string, relationType: string, locator: string, extractionVersion: string): string {
  return `product-graph-relation-${sha256(`${documentId}\0${from}\0${to}\0${relationType}\0${locator}\0${extractionVersion}`).slice(0, 32)}`;
}
function anchor(value: string): string { return keyPart(value); }

/** Extract headings, stable metadata identifiers, links, and explicitly labelled
 * relations. The parser intentionally does not infer semantic relations from
 * prose: every edge is backed by a heading, link, or relation label. */
export function extractProductGraph(input: ProductGraphInput): ProductGraph {
  const source = normalizeInput(input);
  const entities = new Map<string, ProductGraphEntity>();
  const relations: ProductGraphRelation[] = [];
  const addEntity = (canonicalKey: string, name: string, kind: string, locator = source.sourceLocator, confidence = source.confidence): ProductGraphEntity => {
    const existing = entities.get(canonicalKey);
    if (existing) return existing;
    const value: ProductGraphEntity = {
      id: entityId(source.documentId, canonicalKey, source.extractionVersion), canonicalKey, name: clean(name) || canonicalKey,
      kind, documentId: source.documentId, sourceLocator: locator, sourceSha256: source.sourceSha256,
      productVersion: source.productVersion, solution: source.solution, module: source.module, projectId: source.projectId,
      environment: source.environment, confidence: boundedConfidence(confidence), extractionVersion: source.extractionVersion,
    };
    entities.set(canonicalKey, value);
    return value;
  };
  const addRelation = (from: ProductGraphEntity, to: ProductGraphEntity, relationType: string, locator = source.sourceLocator, confidence = source.confidence): void => {
    const type = keyPart(relationType).replaceAll("-", "_");
    const id = relationId(source.documentId, from.id, to.id, type, locator, source.extractionVersion);
    if (relations.some((relation) => relation.id === id)) return;
    relations.push({ id, fromEntityId: from.id, toEntityId: to.id, relationType: type, documentId: source.documentId,
      sourceLocator: locator, sourceSha256: source.sourceSha256, productVersion: source.productVersion, solution: source.solution,
      module: source.module, projectId: source.projectId, environment: source.environment, confidence: boundedConfidence(confidence),
      verified: false, extractionVersion: source.extractionVersion });
  };

  const document = addEntity(`document:${source.documentId}`, source.title, "document", source.sourceLocator, 1);
  const stable = parseMetadata(source.metadata.stableIdentifiers ?? source.metadata.identifiers);
  for (const [name, raw] of Object.entries(stable)) {
    const value = optional(raw); if (!value) continue;
    const target = addEntity(`identifier:${keyPart(name)}:${keyPart(value)}`, value, "identifier", `${source.sourceLocator}#${anchor(name)}`, 0.95);
    addRelation(document, target, "identifies", `${source.sourceLocator}#${anchor(name)}`, 0.95);
  }
  const knownMetadata: Array<[string, string | undefined, string]> = [
    ["product", source.product, "product"], ["product_version", source.productVersion, "product_version"],
    ["solution", source.solution, "solution"], ["module", source.module, "module"],
  ];
  for (const [kind, value, relationType] of knownMetadata) {
    if (!value) continue;
    const target = addEntity(`${kind}:${keyPart(value)}`, value, kind, `${source.sourceLocator}#${anchor(kind)}`, 0.95);
    addRelation(document, target, "has_" + relationType, `${source.sourceLocator}#${anchor(kind)}`, 0.95);
  }

  const headingByLine: Array<{ line: number; entity: ProductGraphEntity }> = [];
  const lines = source.text.split(/\r?\n/);
  let fence = false;
  const headingStack: string[] = [];
  lines.forEach((line, lineNumber) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) return;
    const depth = match[1].length;
    const heading = clean(match[2]); headingStack.splice(depth - 1); headingStack[depth - 1] = heading;
    const path = headingStack.filter(Boolean).join(" / ");
    const target = addEntity(`heading:${keyPart(path)}`, heading, "heading", `${source.sourceLocator}#${anchor(heading)}`, Math.max(0.7, source.confidence));
    headingByLine.push({ line: lineNumber, entity: target });
    addRelation(document, target, "contains", target.sourceLocator, target.confidence);
  });
  const currentHeading = (lineNumber: number): ProductGraphEntity => {
    let result = document;
    for (const item of headingByLine) { if (item.line > lineNumber) break; result = item.entity; }
    return result;
  };

  const addLink = (label: string, href: string, lineNumber: number): void => {
    const url = clean(href).replace(/[)>.,;]+$/, ""); if (!url) return;
    const name = clean(label) || url;
    const target = addEntity(`link:${url.toLowerCase()}`, name, "reference", `${source.sourceLocator}#line-${lineNumber + 1}`, 0.9);
    addRelation(currentHeading(lineNumber), target, "links_to", `${source.sourceLocator}#line-${lineNumber + 1}`, 0.9);
  };
  lines.forEach((line, lineNumber) => {
    for (const match of line.matchAll(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) addLink(match[1], match[2], lineNumber);
    for (const match of line.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi)) addLink(match[2].replace(/<[^>]+>/g, ""), match[1], lineNumber);
  });
  const metadataLinks = [
    ...(Array.isArray(source.metadata.links) ? source.metadata.links : []),
    ...(Array.isArray(source.metadata.references) ? source.metadata.references : []),
  ];
  for (const item of metadataLinks) {
    const value = typeof item === "string" ? item : parseMetadata(item).href ?? parseMetadata(item).url ?? parseMetadata(item).path;
    const label = typeof item === "string" ? item : parseMetadata(item).title ?? parseMetadata(item).text ?? parseMetadata(item).name ?? value;
    if (optional(value)) addLink(String(label ?? value), String(value), 0);
  }

  const relationPattern = /^\s*(?:[-*]\s*)?(?:\*\*)?(depends?\s+on|requires?|references?|related\s+to|relates?\s+to|see\s+also|links?\s+to)(?:\*\*)?\s*[:\-]\s*(.+?)\s*$/i;
  const relationNames: Record<string, string> = { "depends on": "depends_on", "depend on": "depends_on", depend: "depends_on", depends: "depends_on", requires: "requires", require: "requires", reference: "references", references: "references", "related to": "related_to", "relates to": "related_to", "see also": "see_also", "link to": "links_to", "links to": "links_to" };
  lines.forEach((line, lineNumber) => {
    const match = line.match(relationPattern); if (!match) return;
    const relationType = relationNames[clean(match[1]).toLowerCase()] ?? keyPart(match[1]).replaceAll("-", "_");
    const values = match[2].split(/\s*(?:,|;|\band\b)\s*/i).map(clean).filter(Boolean);
    for (const value of values) {
      const link = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const name = clean(link?.[1] ?? value); const canonical = link ? `link:${link[2].toLowerCase()}` : `concept:${keyPart(name)}`;
      const target = addEntity(canonical, name, link ? "reference" : "concept", `${source.sourceLocator}#line-${lineNumber + 1}`, 0.88);
      addRelation(currentHeading(lineNumber), target, relationType, `${source.sourceLocator}#line-${lineNumber + 1}`, 0.88);
    }
  });
  const explicitRelations = source.metadata.relations;
  if (Array.isArray(explicitRelations)) for (const item of explicitRelations) {
    const relation = parseMetadata(item); const type = optional(relation.relationType ?? relation.type); const targetName = optional(relation.to ?? relation.target ?? relation.name);
    if (!type || !targetName) continue;
    const fromName = optional(relation.from); const from = fromName ? addEntity(`concept:${keyPart(fromName)}`, fromName, "concept", source.sourceLocator, 0.85) : document;
    const target = addEntity(`concept:${keyPart(targetName)}`, targetName, "concept", source.sourceLocator, 0.85);
    addRelation(from, target, type, source.sourceLocator, 0.85);
  }
  return { entities: [...entities.values()].sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey)), relations: relations.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function persistProductGraph(store: KnowledgeStore, graph: ProductGraph): ProductGraphPersistenceResult {
  if (!graph || !Array.isArray(graph.entities) || !Array.isArray(graph.relations)) throw new Error("Invalid Product graph");
  const documentIds = [...new Set([...graph.entities.map((entity) => entity.documentId), ...graph.relations.map((relation) => relation.documentId)])];
  if (documentIds.length !== 1) throw new Error("A Product graph persistence operation must contain exactly one source document");
  const documentId = documentIds[0];
  if (!store.db.prepare("SELECT 1 FROM knowledge_documents WHERE id=? AND kind='product_document'").get(documentId)) throw new Error(`Product graph source document not found: ${documentId}`);
  const extractionVersions = [...new Set(graph.entities.map((entity) => entity.extractionVersion).concat(graph.relations.map((relation) => relation.extractionVersion)))];
  if (extractionVersions.length !== 1) throw new Error("A Product graph persistence operation must contain exactly one extraction version");
  const extractionVersion = extractionVersions[0];
  const entityIds = new Set(graph.entities.map((entity) => entity.id));
  for (const relation of graph.relations) if (!entityIds.has(relation.fromEntityId) || !entityIds.has(relation.toEntityId)) throw new Error(`Product graph relation references an entity outside the graph: ${relation.id}`);
  const now = new Date().toISOString();
  store.db.transaction(() => {
    // Replacing the source document's projection makes retries and corrected
    // documents idempotent while retaining the authoritative source document.
    store.db.prepare("DELETE FROM knowledge_product_graph_relations WHERE document_id=?").run(documentId);
    store.db.prepare("DELETE FROM knowledge_product_graph_entities WHERE document_id=?").run(documentId);
    const entityInsert = store.db.prepare(`INSERT INTO knowledge_product_graph_entities
      (id,canonical_key,name,kind,document_id,source_locator,source_sha256,product_version,solution,module,project_id,environment,confidence,extraction_version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const entity of graph.entities) entityInsert.run(entity.id, entity.canonicalKey, entity.name, entity.kind, entity.documentId, entity.sourceLocator, entity.sourceSha256, entity.productVersion ?? null, entity.solution ?? null, entity.module ?? null, entity.projectId ?? null, entity.environment ?? null, boundedConfidence(entity.confidence), entity.extractionVersion, now, now);
    const relationInsert = store.db.prepare(`INSERT INTO knowledge_product_graph_relations
      (id,from_entity_id,to_entity_id,relation_type,document_id,source_locator,source_sha256,product_version,solution,module,project_id,environment,confidence,verified,extraction_version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const relation of graph.relations) relationInsert.run(relation.id, relation.fromEntityId, relation.toEntityId, relation.relationType, relation.documentId, relation.sourceLocator, relation.sourceSha256, relation.productVersion ?? null, relation.solution ?? null, relation.module ?? null, relation.projectId ?? null, relation.environment ?? null, boundedConfidence(relation.confidence), relation.verified ? 1 : 0, relation.extractionVersion, now, now);
  }).immediate();
  return { entityCount: graph.entities.length, relationCount: graph.relations.length, documentId, extractionVersion };
}
export interface ProductGraphRebuildOptions {
  /** Number of source documents to process in this batch. */
  limit?: number;
  /** Resume after this document ID for bounded operational backfills. */
  afterDocumentId?: string;
  /** Include deprecated source projections so a later lifecycle restore is complete. */
  includeDeprecated?: boolean;
}

export interface ProductGraphRebuildResult {
  scanned: number;
  rebuilt: number;
  failed: number;
  entityCount: number;
  relationCount: number;
  lastDocumentId?: string;
  complete: boolean;
  errors: Array<{ documentId: string; error: string }>;
}

/** Rebuilds graph projections from authoritative Product source rows. The
 * operation is batchable, per-document idempotent, and safe to retry after a
 * process interruption. */
export function rebuildProductGraph(store: KnowledgeStore, options: ProductGraphRebuildOptions = {}): ProductGraphRebuildResult {
  const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 200)));
  const clauses = ["d.kind='product_document'"];
  const params: unknown[] = [];
  if (!options.includeDeprecated) clauses.push("d.lifecycle IN ('approved','verified')");
  if (options.afterDocumentId) { clauses.push("d.id>?"); params.push(options.afterDocumentId); }
  const rows = store.db.prepare(`SELECT d.id,d.title,d.body,d.lifecycle,d.project_id,d.environment,d.samplemanager_version,d.solution,d.module,d.project_name_snapshot,d.source_locator,d.source_sha256,
      p.source_path,p.source_sha256 AS product_source_sha256,p.version,p.metadata_json
    FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id
    WHERE ${clauses.join(" AND ")} ORDER BY d.id LIMIT ?`).all(...params, limit) as Array<Record<string, unknown>>;
  const result: ProductGraphRebuildResult = { scanned: rows.length, rebuilt: 0, failed: 0, entityCount: 0, relationCount: 0, complete: rows.length < limit, errors: [] };
  for (const row of rows) {
    const documentId = String(row.id);
    result.lastDocumentId = documentId;
    try {
      const metadata = parseMetadata(row.metadata_json ? JSON.parse(String(row.metadata_json)) : {});
      const graph = extractProductGraph({
        documentId,
        title: String(row.title ?? documentId),
        body: String(row.body ?? ""),
        metadata,
        sourceLocator: optional(row.source_locator) ?? `product-doc:${String(row.source_path ?? documentId)}`,
        sourceSha256: optional(row.product_source_sha256) ?? optional(row.source_sha256),
        product: optional(row.project_name_snapshot),
        productVersion: optional(row.version) ?? optional(row.samplemanager_version),
        solution: optional(row.solution),
        module: optional(row.module),
        projectId: optional(row.project_id),
        environment: optional(row.environment),
      });
      const persisted = persistProductGraph(store, graph);
      result.rebuilt++;
      result.entityCount += persisted.entityCount;
      result.relationCount += persisted.relationCount;
    } catch (error) {
      result.failed++;
      result.errors.push({ documentId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}


function entityFromRow(row: Record<string, unknown>): ProductGraphEntity {
  return { id: String(row.id), canonicalKey: String(row.canonical_key), name: String(row.name), kind: String(row.kind), documentId: String(row.document_id), sourceLocator: String(row.source_locator), sourceSha256: String(row.source_sha256), productVersion: optional(row.product_version), solution: optional(row.solution), module: optional(row.module), projectId: optional(row.project_id), environment: optional(row.environment), confidence: Number(row.confidence), extractionVersion: String(row.extraction_version) };
}
function relationFromRow(row: Record<string, unknown>): ProductGraphRelation {
  return { id: String(row.id), fromEntityId: String(row.from_entity_id), toEntityId: String(row.to_entity_id), relationType: String(row.relation_type), documentId: String(row.document_id), sourceLocator: String(row.source_locator), sourceSha256: String(row.source_sha256), productVersion: optional(row.product_version), solution: optional(row.solution), module: optional(row.module), projectId: optional(row.project_id), environment: optional(row.environment), confidence: Number(row.confidence), verified: Number(row.verified) === 1, extractionVersion: String(row.extraction_version) };
}

/** Query only approved Product documents and scope-compatible graph rows. When
 * actorId is supplied, project reads are checked through Relay's ACL boundary;
 * global Product documents remain visible without a project ACL. */
export function queryProductGraph(store: KnowledgeStore, request: ProductGraphQueryRequest = {}): ProductGraphQueryResult {
  const projectId = optional(request.projectId);
  const environment = optional(request.environment);
  if (projectId && request.actorId === undefined && !request.isAdmin) throw new Error("Product graph actorId is required for project-scoped queries");
  if (projectId && !request.isAdmin && request.actorId !== undefined && !store.canRead(request.actorId, projectId)) throw new Error("Knowledge access denied for project");
  const clauses = ["e.document_id=d.id", "d.kind='product_document'", "e.project_id IS d.project_id", "e.environment IS d.environment"];
  const params: unknown[] = [];
  if (!request.includeDeprecated) clauses.push("d.lifecycle IN ('approved','verified')");
  // A Product projection must be approved when the type-specific row exists.
  clauses.push("(p.id IS NULL OR p.review_status='approved')");
  if (projectId) { clauses.push("((d.project_id=? AND (d.environment IS ? OR (d.environment IS NULL AND ? IS NULL))) OR (d.project_id IS NULL AND d.environment IS NULL))"); params.push(projectId, environment ?? null, environment ?? null); }
  else { clauses.push("d.project_id IS NULL AND d.environment IS NULL"); }
  for (const [column, value] of [["e.product_version", request.productVersion], ["e.solution", request.solution], ["e.module", request.module]] as Array<[string, unknown]>) if (optional(value)) { clauses.push(`${column}=?`); params.push(String(value)); }
  if (optional(request.relationType)) { /* applied to relations below */ }
  const rows = store.db.prepare(`SELECT e.* FROM knowledge_product_graph_entities e JOIN knowledge_documents d ON ${clauses[0]} LEFT JOIN knowledge_product_documents p ON p.id=d.id WHERE ${clauses.slice(1).join(" AND ")} ORDER BY e.canonical_key,e.id LIMIT ?`).all(...params, 500) as Array<Record<string, unknown>>;
  let entities = rows.map(entityFromRow);
  const terms = optional(request.query)?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  if (terms.length) entities = entities.filter((entity) => terms.every((term) => `${entity.name} ${entity.canonicalKey} ${entity.kind}`.toLowerCase().includes(term)));
  const limit = Math.max(1, Math.min(500, Math.trunc(request.limit ?? 100)));
  entities = entities.slice(0, limit);
  const visible = new Set(entities.map((entity) => entity.id));
  const relationClauses = ["r.document_id=d.id", "d.kind='product_document'", "r.project_id IS d.project_id", "r.environment IS d.environment"]; const relationParams: unknown[] = [];
  if (!request.includeDeprecated) relationClauses.push("d.lifecycle IN ('approved','verified')");
  relationClauses.push("(p.id IS NULL OR p.review_status='approved')");
  if (projectId) { relationClauses.push("((d.project_id=? AND (d.environment IS ? OR (d.environment IS NULL AND ? IS NULL))) OR (d.project_id IS NULL AND d.environment IS NULL))"); relationParams.push(projectId, environment ?? null, environment ?? null); }
  else relationClauses.push("d.project_id IS NULL AND d.environment IS NULL");
  if (optional(request.relationType)) { relationClauses.push("r.relation_type=?"); relationParams.push(String(request.relationType)); }
  else {
    const relationTypes = (request.relationTypes ?? []).map(optional).filter((value): value is string => Boolean(value)).slice(0, 16);
    if (relationTypes.length) { relationClauses.push(`r.relation_type IN (${relationTypes.map(() => "?").join(",")})`); relationParams.push(...relationTypes); }
  }
  const visibleIds = [...visible].slice(0, 500);
  if (!visibleIds.length) return { entities, relations: [] };
  const endpointPlaceholders = visibleIds.map(() => "?").join(",");
  relationClauses.push(`(r.from_entity_id IN (${endpointPlaceholders}) OR r.to_entity_id IN (${endpointPlaceholders}))`);
  relationParams.push(...visibleIds, ...visibleIds);
  const relationLimit = Math.min(5000, Math.max(100, limit * 8));
  const relationRows = store.db.prepare(`SELECT r.* FROM knowledge_product_graph_relations r JOIN knowledge_documents d ON ${relationClauses[0]} LEFT JOIN knowledge_product_documents p ON p.id=d.id WHERE ${relationClauses.slice(1).join(" AND ")} ORDER BY r.id LIMIT ?`).all(...relationParams, relationLimit) as Array<Record<string, unknown>>;
  const relations = relationRows.map(relationFromRow).filter((relation) => visible.has(relation.fromEntityId) && visible.has(relation.toEntityId));
  return { entities, relations };
}
