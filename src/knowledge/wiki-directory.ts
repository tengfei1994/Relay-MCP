import type { KnowledgeStore } from "./store.js";

type Row = Record<string, unknown>;

export interface WikiDirectoryPathInput {
  title: string;
  sourceRefs?: string[];
  solution?: string;
  module?: string;
}

interface GraphEntity {
  id: string;
  name: string;
  kind: string;
  documentId: string;
  confidence: number;
}

interface GraphRelation {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  confidence: number;
}

const METADATA_RELATIONS = new Set(["has_product", "has_product_version", "has_solution", "has_module"]);
const IGNORED_ENTITY_KINDS = new Set(["document", "product", "product_version", "solution", "module", "identifier"]);
const RELATION_PRIORITY = new Map([
  ["contains", 0],
  ["depends_on", 1],
  ["requires", 2],
  ["related_to", 3],
  ["references", 4],
  ["see_also", 5],
  ["links_to", 6],
  ["impacts", 7],
  ["used_by", 8],
]);

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function label(value: unknown): string | undefined {
  const result = text(value).replace(/[\\/]+/g, " — ");
  if (!result || normalized(result) === "unassigned") return undefined;
  return result;
}

function boundedConfidence(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function placeholders(values: string[]): string {
  return values.map(() => "?").join(",");
}

function graphRows(store: KnowledgeStore, sourceRefs: string[]): { entities: GraphEntity[]; relations: GraphRelation[]; metadata: Map<string, { solution?: string; module?: string }> } {
  const marks = placeholders(sourceRefs);
  const entities = (store.db.prepare(`SELECT id,name,kind,document_id,confidence FROM knowledge_product_graph_entities WHERE document_id IN (${marks})`).all(...sourceRefs) as Row[])
    .map((row) => ({ id: text(row.id), name: text(row.name), kind: text(row.kind), documentId: text(row.document_id), confidence: boundedConfidence(row.confidence) }))
    .filter((row) => row.id && row.documentId && row.name);
  const relations = (store.db.prepare(`SELECT id,from_entity_id,to_entity_id,relation_type,confidence FROM knowledge_product_graph_relations WHERE document_id IN (${marks})`).all(...sourceRefs) as Row[])
    .map((row) => ({ id: text(row.id), fromEntityId: text(row.from_entity_id), toEntityId: text(row.to_entity_id), relationType: text(row.relation_type), confidence: boundedConfidence(row.confidence) }))
    .filter((row) => row.id && row.fromEntityId && row.toEntityId && row.relationType);
  const metadata = new Map<string, { solution?: string; module?: string }>();
  const sourceRows = store.db.prepare(`SELECT id,solution,module FROM knowledge_documents WHERE id IN (${marks})`).all(...sourceRefs) as Row[];
  for (const row of sourceRows) metadata.set(text(row.id), { solution: label(row.solution), module: label(row.module) });
  return { entities, relations, metadata };
}

function commonPrefix(paths: string[][]): string[] {
  if (!paths.length) return [];
  const result: string[] = [];
  for (let index = 0; index < paths[0].length; index += 1) {
    const candidate = paths[0][index];
    if (!paths.every((path) => path[index] && normalized(path[index]) === normalized(candidate))) break;
    result.push(candidate);
  }
  return result;
}

function relationPath(sourceId: string, entities: GraphEntity[], relations: GraphRelation[], fallback: { solution?: string; module?: string }): string[] {
  const entityById = new Map(entities.filter((entity) => entity.documentId === sourceId).map((entity) => [entity.id, entity]));
  const document = [...entityById.values()].find((entity) => entity.kind === "document" || entity.id.endsWith(`:${sourceId}`) || normalized(entity.name) === normalized(sourceId));
  const outgoing = new Map<string, GraphRelation[]>();
  for (const relation of relations) {
    if (!entityById.has(relation.fromEntityId) || !entityById.has(relation.toEntityId)) continue;
    const current = outgoing.get(relation.fromEntityId) ?? [];
    current.push(relation);
    outgoing.set(relation.fromEntityId, current);
  }
  const edges = (entityId: string) => (outgoing.get(entityId) ?? [])
    .map((relation) => ({ relation, target: entityById.get(relation.toEntityId)! }))
    .filter(({ target }) => Boolean(target))
    .sort((left, right) => {
      const priority = (RELATION_PRIORITY.get(left.relation.relationType) ?? 99) - (RELATION_PRIORITY.get(right.relation.relationType) ?? 99);
      if (priority !== 0) return priority;
      const confidence = (right.relation.confidence + right.target.confidence) - (left.relation.confidence + left.target.confidence);
      return confidence || left.target.name.localeCompare(right.target.name);
    });
  const result = [label(fallback.solution), label(fallback.module)].filter((value): value is string => Boolean(value));
  if (!document) return result;

  const metadata = new Map<string, string>();
  for (const { relation, target } of edges(document.id)) {
    if (relation.relationType === "has_solution" || target.kind === "solution") metadata.set("solution", target.name);
    if (relation.relationType === "has_module" || target.kind === "module") metadata.set("module", target.name);
  }
  const metadataPath = [label(metadata.get("solution")) ?? label(fallback.solution), label(metadata.get("module")) ?? label(fallback.module)]
    .filter((value): value is string => Boolean(value));
  result.splice(0, result.length, ...metadataPath);

  const visited = new Set<string>([document.id]);
  let current = document.id;
  for (let depth = 0; depth < 2; depth += 1) {
    const next = edges(current).find(({ relation, target }) => !METADATA_RELATIONS.has(relation.relationType) && !IGNORED_ENTITY_KINDS.has(target.kind) && !visited.has(target.id) && Boolean(label(target.name)));
    if (!next) break;
    visited.add(next.target.id);
    result.push(label(next.target.name)!);
    current = next.target.id;
  }
  return result;
}

/**
 * Build the persisted/displayed directory from the Product graph. The first
 * folders come from document -> solution/module relations; the next folders
 * follow bounded entity edges (for example document -> heading -> concept).
 * Shared prefixes across product versions keep one Wiki page in one stable
 * location even when a version has an extra relationship.
 */
export function buildWikiDirectoryPath(store: KnowledgeStore, input: WikiDirectoryPathInput): string {
  const title = label(input.title) ?? "Untitled topic";
  const sourceRefs = [...new Set((input.sourceRefs ?? []).map(text).filter(Boolean))];
  const fallback = [label(input.solution), label(input.module)].filter((value): value is string => Boolean(value));
  if (!sourceRefs.length) return [...fallback, title].join("/");

  try {
    const graph = graphRows(store, sourceRefs);
    const paths = sourceRefs.map((sourceId) => relationPath(sourceId, graph.entities, graph.relations, {
      solution: graph.metadata.get(sourceId)?.solution ?? input.solution,
      module: graph.metadata.get(sourceId)?.module ?? input.module,
    }));
    const prefix = commonPrefix(paths);
    return [...(prefix.length ? prefix : fallback), title].join("/");
  } catch {
    // Older databases may not have the graph projection yet; directory
    // rendering remains usable from the existing page metadata.
    return [...fallback, title].join("/");
  }
}
