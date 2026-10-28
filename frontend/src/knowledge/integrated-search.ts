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

export function knowledgeItemScope(item: any, fallback: KnowledgeScope = {}): KnowledgeScope {
  return { projectId: item?.projectId ?? item?.project_id ?? fallback.projectId, environment: item?.environment ?? fallback.environment };
}

export function knowledgeItemMatchesScope(item: any, scope: KnowledgeScope): boolean {
  const source = buildKnowledgeScope(knowledgeItemScope(item));
  const selected = buildKnowledgeScope(scope);
  return source.projectId === selected.projectId && source.environment === selected.environment;
}

export function productEngineDocumentState(document: any) {
  const parseJson = (value: unknown) => { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return undefined; } };
  const chunkIds = parseJson(document.externalChunkIds ?? document.external_chunk_ids_json);
  const chunks = Array.isArray(chunkIds) ? chunkIds.filter((id) => typeof id === "string" && id.trim()) : [];
  const parseStatus = document.upstreamParseStatus ?? document.upstream_parse_status;
  const verifiedAt = document.upstreamVerifiedAt ?? document.upstream_verified_at;
  const verified = parseStatus === "completed" && Boolean(verifiedAt) && Number.isFinite(Date.parse(verifiedAt)) && chunks.length > 0;
  const model = parseJson(document.modelProvenance ?? document.model_provenance_json);
  const modelProvenance = model && typeof model === "object" && model.modelId && model.providerId ? model : undefined;
  return { parseStatus, verifiedAt, chunkCount: chunks.length, verified, canPublish: document.status === "staged" && verified, modelProvenance };
}
