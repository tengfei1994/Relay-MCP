import { createHash } from "node:crypto";
import { createManagedProviderRegistry } from "./provider-setup.js";
import type { ManagedProviderHandle } from "./provider-registry.js";
import type { KnowledgeStore } from "./store.js";
import { WikiService, type WikiCitation, type WikiGenerationInput, type WikiSectionKind } from "./wiki.js";

type Row = Record<string, unknown>;
type TopicSource = {
  id: string;
  title: string;
  body: string;
  version: string;
  sourcePath?: string;
  sourceSha256?: string;
  projectId?: string;
  environment?: string;
  solution?: string;
  module?: string;
  chunks: Array<{ id: string; content: string }>;
};

export interface WikiGenerationRequest {
  topicGroupIds?: string[];
  projectId?: string;
  environment?: string;
}
export interface WikiGenerationResult {
  topicGroupId: string;
  pageId: string;
  title: string;
  supportedVersions: string[];
  sectionCount: number;
  sourceCount: number;
  fingerprint: string;
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}
function parseJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(trimmed); } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Wiki provider returned invalid JSON");
  }
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function object(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function strings(value: unknown): string[] { return array(value).filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(item => item.trim()); }
function slug(value: string): string { return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "topic"; }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
function isUsableDocument(row: Row): boolean { return ["approved", "verified"].includes(String(row.lifecycle)); }

function topicWhere(topicGroupId: string): { sql: string; params: string[] } {
  return {
    sql: "(p.topic_group_id=? OR b.topic_id=? OR (p.topic_group_id IS NULL AND ('family:' || p.document_family_id)=?))",
    params: [topicGroupId, topicGroupId, topicGroupId],
  };
}

function loadSources(store: KnowledgeStore, input: { topicGroupId: string; projectId?: string; environment?: string }): TopicSource[] {
  const topic = topicWhere(input.topicGroupId);
  const conditions = [`d.kind='product_document'`, `d.lifecycle IN ('approved','verified')`, topic.sql];
  const params: unknown[] = [...topic.params];
  if (input.projectId) {
    conditions.push("((d.project_id IS NULL AND d.environment IS NULL) OR (d.project_id=? AND d.environment IS ?))");
    params.push(input.projectId, input.environment ?? null);
  } else conditions.push("d.project_id IS NULL AND d.environment IS NULL");
  const rows = store.db.prepare(`SELECT d.id,d.title,d.body,d.lifecycle,d.project_id,d.environment,d.solution,d.module,
    p.version,p.source_path,p.source_sha256,p.topic_group_id,p.document_family_id
    FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id
    LEFT JOIN knowledge_product_document_bindings b ON b.document_id=d.id
    WHERE ${conditions.join(" AND ")} ORDER BY p.version,d.title,d.id`).all(...params) as Row[];
  const byId = new Map<string, TopicSource>();
  for (const row of rows) {
    if (!isUsableDocument(row)) continue;
    const id = String(row.id);
    if (byId.has(id)) continue;
    const chunks = (store.db.prepare("SELECT id,content FROM knowledge_chunks WHERE document_id=? ORDER BY ordinal").all(id) as Row[])
      .map(chunk => ({ id: String(chunk.id), content: String(chunk.content ?? "") })).filter(chunk => chunk.content.trim());
    byId.set(id, {
      id, title: String(row.title ?? id), body: String(row.body ?? ""), version: String(row.version ?? "unspecified"), sourcePath: text(row.source_path), sourceSha256: text(row.source_sha256),
      projectId: text(row.project_id), environment: text(row.environment), solution: text(row.solution), module: text(row.module), chunks: chunks.length ? chunks : [{ id: `${id}:chunk:0`, content: String(row.body ?? "") }],
    });
  }
  return [...byId.values()];
}

function promptFor(topicGroupId: string, sources: TopicSource[]): string {
  const catalog = sources.map(source => ({
    documentId: source.id, title: source.title, version: source.version,
    chunks: source.chunks.map(chunk => ({ chunkId: chunk.id, content: chunk.content.slice(0, 8_000) })),
  }));
  return `You are generating one source-grounded operational Wiki page for topic group ${topicGroupId}.
Return JSON only. Do not return Markdown fences or prose outside JSON.
The page must contain one or more sections. Each section must have:
{"key": string, "kind": "common"|"version"|"difference", "productVersion": string|null, "title": string, "body": string, "sourceRefs": string[], "chunkRefs": string[]}
Use only documentId and chunkId values from the source catalog. Never invent facts, versions, or citations.
Common sections may contain only claims supported by every represented product version; otherwise put the claim in the corresponding version section or a difference section.
Version sections must cite chunks from exactly that product version. Difference sections must cite the versions being compared.
Preserve useful headings and procedures, remove duplication, and state conflicts explicitly.
Use concise Markdown in each body. Include a top-level title in the JSON as "title".

SOURCE CATALOG:
${JSON.stringify(catalog)}`;
}

function sectionCandidates(parsed: Row): Array<Row & { fallbackKind?: WikiSectionKind; fallbackVersion?: string }> {
  const result: Array<Row & { fallbackKind?: WikiSectionKind; fallbackVersion?: string }> = [];
  if (Array.isArray(parsed.sections)) result.push(...parsed.sections.map(item => ({ ...object(item) })));
  const common = object(parsed.common);
  if (typeof parsed.common === "string") result.push({ body: parsed.common, title: "Common", fallbackKind: "common" });
  else for (const item of array(common.sections)) result.push({ ...object(item), fallbackKind: "common" });
  const versions = parsed.versions;
  if (Array.isArray(versions)) for (const version of versions) {
    const item = object(version), productVersion = text(item.productVersion ?? item.version);
    if (Array.isArray(item.sections)) for (const section of item.sections) result.push({ ...object(section), fallbackKind: "version", fallbackVersion: productVersion });
    else result.push({ ...item, fallbackKind: "version", fallbackVersion: productVersion });
  }
  else for (const [productVersion, value] of Object.entries(object(versions))) {
    const item = object(value);
    if (Array.isArray(item.sections)) for (const section of item.sections) result.push({ ...object(section), fallbackKind: "version", fallbackVersion: productVersion });
    else result.push({ ...item, fallbackKind: "version", fallbackVersion: productVersion });
  }
  for (const item of array(parsed.differences)) result.push({ ...object(item), fallbackKind: "difference" });
  return result;
}

export class WikiGenerationService {
  constructor(private readonly store: KnowledgeStore, private readonly clock: () => Date = () => new Date(), private readonly providerOverride?: ManagedProviderHandle) {}

  private provider(): ManagedProviderHandle {
    if (this.providerOverride) return this.providerOverride;
    const registry = createManagedProviderRegistry(this.store);
    const configured = registry.list().find(row => row.kind === "wiki_llm" && row.status !== "disabled");
    if (!configured) throw new Error("Wiki generation provider is not configured");
    return registry.resolveCandidateProvider(configured.id);
  }

  private markState(topicGroupId: string, projectId: string | undefined, environment: string | undefined, status: "queued" | "running" | "succeeded" | "failed", fingerprint?: string, error?: string, pageId?: string): void {
    const now = this.clock().toISOString();
    this.store.db.prepare(`INSERT INTO knowledge_wiki_generation_state(project_id,environment,topic_group_id,status,source_fingerprint,last_error,attempt_count,generated_page_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,1,?,?,?)
      ON CONFLICT(project_id,environment,topic_group_id) DO UPDATE SET status=excluded.status,source_fingerprint=COALESCE(excluded.source_fingerprint,source_fingerprint),last_error=excluded.last_error,attempt_count=attempt_count+1,generated_page_id=COALESCE(excluded.generated_page_id,generated_page_id),updated_at=excluded.updated_at`)
      .run(projectId ?? "", environment ?? "", topicGroupId, status, fingerprint ?? null, error?.slice(0, 500) ?? null, pageId ?? null, now, now);
  }

  async generate(input: { topicGroupId: string; projectId?: string; environment?: string }): Promise<WikiGenerationResult> {
    const sources = loadSources(this.store, input);
    if (!sources.length) throw new Error("Wiki topic has no approved Product Document sources");
    const fingerprint = hash(sources.map(source => ({ id: source.id, version: source.version, sha256: source.sourceSha256, body: source.body, chunks: source.chunks.map(chunk => [chunk.id, chunk.content]) })));
    this.markState(input.topicGroupId, input.projectId, input.environment, "running", fingerprint);
    try {
      const provider = this.provider();
      const response = await provider.chat([
        { role: "system", content: "You are a factual documentation generator. Cite every section with exact source and chunk IDs." },
        { role: "user", content: promptFor(input.topicGroupId, sources) },
      ], 12_000, { type: "json_object" });
      const parsed = object(parseJson(response.text));
      const allowedDocuments = new Map(sources.map(source => [source.id, source]));
      const allowedChunks = new Map(sources.flatMap(source => source.chunks.map(chunk => [chunk.id, source] as const)));
      const versions = [...new Set(sources.map(source => source.version))];
      const candidates = sectionCandidates(parsed);
      if (!candidates.length) throw new Error("Wiki provider returned no sections");
      const sections: WikiGenerationInput["sections"] = [];
      for (const [index, candidate] of candidates.entries()) {
        const kind = (text(candidate.kind) ?? candidate.fallbackKind) as WikiSectionKind;
        const productVersion = text(candidate.productVersion) ?? candidate.fallbackVersion;
        if (!kind || !["common", "version", "difference"].includes(kind)) throw new Error("Wiki provider returned an invalid section kind");
        const body = String(candidate.body ?? candidate.markdown ?? candidate.content ?? "").trim();
        if (!body) throw new Error("Wiki provider returned an empty section");
        const chunkRefs = strings(candidate.chunkRefs ?? candidate.chunks);
        const explicitSourceRefs = strings(candidate.sourceRefs ?? candidate.documents);
        const sourceRefs = [...new Set([...explicitSourceRefs, ...chunkRefs.map(chunk => allowedChunks.get(chunk)?.id).filter((id): id is string => Boolean(id))])];
        if (!sourceRefs.length || sourceRefs.some(id => !allowedDocuments.has(id))) throw new Error(`Wiki section ${index + 1} has an invalid source citation`);
        if (kind === "version") {
          if (!productVersion || !versions.includes(productVersion)) throw new Error("Wiki version section requires a represented product version");
          if (sourceRefs.some(id => allowedDocuments.get(id)!.version !== productVersion)) throw new Error(`Wiki version section ${productVersion} cites another version`);
        }
        if (kind === "difference" && versions.length > 1) {
          const citedVersions = new Set(sourceRefs.map(id => allowedDocuments.get(id)!.version));
          if (citedVersions.size < 2) throw new Error("Wiki difference section must cite at least two product versions");
        }
        if (kind === "common" && versions.length > 1 && !versions.every(version => sourceRefs.some(id => allowedDocuments.get(id)!.version === version))) throw new Error("Common Wiki content is not supported by every product version");
        const citedChunks = chunkRefs.length ? chunkRefs : sourceRefs.flatMap(id => allowedDocuments.get(id)!.chunks.map(chunk => chunk.id));
        if (citedChunks.some(id => !allowedChunks.has(id) || !sourceRefs.includes(allowedChunks.get(id)!.id))) throw new Error(`Wiki section ${index + 1} has an invalid chunk citation`);
        const citations: WikiCitation[] = sourceRefs.map(documentId => {
          const source = allowedDocuments.get(documentId)!;
          return { documentId, title: source.title, productVersion: source.version, sourceLocator: source.sourcePath, sourceSha256: source.sourceSha256, chunkIds: citedChunks.filter(chunkId => allowedChunks.get(chunkId)?.id === documentId) };
        });
        sections.push({ key: text(candidate.key) ?? `${kind}-${productVersion ?? index + 1}`, kind, productVersion: kind === "version" ? productVersion : undefined, title: text(candidate.title) ?? (kind === "common" ? "Common" : kind === "difference" ? "Differences" : productVersion ?? "Version"), body, sortOrder: index, citations });
      }
      const title = text(parsed.title) ?? sources[0].title;
      const render = sections.map(section => `## ${section.title}\n\n${section.body}`).join("\n\n");
      const pageBody = `# ${title}\n\n${render}`.trim();
      const sourceRefs = [...new Set(sections.flatMap(section => section.citations.map(citation => citation.documentId)))];
      const page = new WikiService(this.store, this.clock).upsertGenerated({
        topicGroupId: input.topicGroupId, pageKey: `topic/${slug(title)}-${hash(input.topicGroupId).slice(0, 8)}`, title, body: pageBody,
        projectId: input.projectId, environment: input.environment, solution: sources.find(source => source.solution)?.solution, module: sources.find(source => source.module)?.module,
        supportedVersions: versions, sourceRefs, sections, fingerprint,
        directoryPath: [sources.find(source => source.solution)?.solution, sources.find(source => source.module)?.module, title].filter(Boolean).join("/") || title,
      });
      this.markState(input.topicGroupId, input.projectId, input.environment, "succeeded", fingerprint, undefined, page.id);
      return { topicGroupId: input.topicGroupId, pageId: page.id, title, supportedVersions: versions, sectionCount: sections.length, sourceCount: sourceRefs.length, fingerprint };
    } catch (error) {
      this.markState(input.topicGroupId, input.projectId, input.environment, "failed", fingerprint, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}

export function listWikiTopicGroups(store: KnowledgeStore, input: { projectId?: string; environment?: string } = {}): Array<{ topicGroupId: string; title: string; solution?: string; module?: string; supportedVersions: string[]; sourceCount: number }> {
  const conditions = ["d.kind='product_document'", "d.lifecycle IN ('approved','verified')"];
  const params: unknown[] = [];
  if (input.projectId) { conditions.push("((d.project_id IS NULL AND d.environment IS NULL) OR (d.project_id=? AND d.environment IS ?))"); params.push(input.projectId, input.environment ?? null); }
  else conditions.push("d.project_id IS NULL AND d.environment IS NULL");
  const rows = store.db.prepare(`SELECT COALESCE(NULLIF(p.topic_group_id,''),b.topic_id,'family:' || p.document_family_id) AS topic_group_id,
    MIN(d.title) AS title,MIN(d.solution) AS solution,MIN(d.module) AS module,COUNT(DISTINCT d.id) AS source_count,GROUP_CONCAT(DISTINCT p.version) AS versions
    FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id LEFT JOIN knowledge_product_document_bindings b ON b.document_id=d.id
    WHERE ${conditions.join(" AND ")} GROUP BY topic_group_id ORDER BY solution,module,title`).all(...params) as Row[];
  return rows.map(row => ({ topicGroupId: String(row.topic_group_id), title: String(row.title ?? row.topic_group_id), solution: text(row.solution), module: text(row.module), supportedVersions: String(row.versions ?? "").split(",").map(value => value.trim()).filter(Boolean).sort(), sourceCount: Number(row.source_count ?? 0) }));
}
