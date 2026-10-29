export type WeknoraSearchQuery = {
  q: string;
  productVersion: string;
  solution: string;
  module: string;
  limit: string;
};

export function buildWeknoraSearchBody(query: WeknoraSearchQuery, projectId?: string | number, environment?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: query.q.trim(),
    limit: Math.max(1, Math.min(100, Number(query.limit) || 10)),
  };
  Object.assign(body, buildKnowledgeScope({ projectId, environment }));
  for (const key of ["productVersion", "solution", "module"] as const) {
    if (query[key].trim()) body[key] = query[key].trim();
  }
  return body;
}


export type KnowledgeScope = { projectId?: string | number; environment?: string };

export function buildKnowledgeScope(scope: KnowledgeScope = {}): Record<string, string> {
  const result: Record<string, string> = {};
  if (scope.projectId !== undefined && String(scope.projectId).trim()) result.projectId = String(scope.projectId).trim();
  if (scope.environment?.trim()) result.environment = scope.environment.trim();
  return result;
}

export function withKnowledgeScope(path: string, scope: KnowledgeScope = {}): string {
  const [route, hash] = path.split("#", 2);
  const [pathname, search] = route.split("?", 2);
  const params = new URLSearchParams(search);
  Object.entries(buildKnowledgeScope(scope)).forEach(([key, value]) => params.set(key, value));
  const query = params.toString();
  return pathname + (query ? `?${query}` : "") + (hash === undefined ? "" : `#${hash}`);
}

export function knowledgeItemScope(item: unknown, fallback: KnowledgeScope = {}): KnowledgeScope {
  const source = typeof item === "object" && item !== null ? item as Record<string, unknown> : undefined;
  const projectId = source?.projectId ?? source?.project_id;
  const environment = source?.environment;
  return {
    projectId: typeof projectId === "string" || typeof projectId === "number" ? projectId : fallback.projectId,
    environment: typeof environment === "string" ? environment : fallback.environment,
  };
}

export function knowledgeItemMatchesScope(item: unknown, scope: KnowledgeScope): boolean {
  const source = buildKnowledgeScope(knowledgeItemScope(item));
  const selected = buildKnowledgeScope(scope);
  return source.projectId === selected.projectId && source.environment === selected.environment;
}

export function productEngineDocumentState(document: unknown) {
  const source = typeof document === "object" && document !== null ? document as Record<string, unknown> : {};
  const parseJson = (value: unknown): unknown => { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown; } catch { return undefined; } };
  const chunkIds = parseJson(source.externalChunkIds ?? source.external_chunk_ids_json);
  const chunks = Array.isArray(chunkIds) ? chunkIds.filter((id) => typeof id === "string" && id.trim()) : [];
  const parseStatus = source.upstreamParseStatus ?? source.upstream_parse_status;
  const verifiedAt = source.upstreamVerifiedAt ?? source.upstream_verified_at;
  const verified = parseStatus === "completed" && typeof verifiedAt === "string" && Boolean(verifiedAt) && Number.isFinite(Date.parse(verifiedAt)) && chunks.length > 0;
  const model = parseJson(source.modelProvenance ?? source.model_provenance_json);
  const modelRecord = typeof model === "object" && model !== null ? model as Record<string, unknown> : undefined;
  const modelProvenance = modelRecord?.modelId && modelRecord.providerId ? modelRecord : undefined;
  return { parseStatus, verifiedAt, chunkCount: chunks.length, verified, canPublish: source.status === "staged" && verified, modelProvenance };
}
