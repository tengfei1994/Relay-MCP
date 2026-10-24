export type WeknoraSearchQuery = {
  q: string;
  productVersion: string;
  solution: string;
  module: string;
  limit: string;
};

export function buildWeknoraSearchBody(query: WeknoraSearchQuery, projectId?: string | number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: query.q.trim(),
    limit: Math.max(1, Math.min(100, Number(query.limit) || 10)),
  };
  if (projectId !== undefined) body.projectId = String(projectId);
  for (const key of ["productVersion", "solution", "module"] as const) {
    if (query[key].trim()) body[key] = query[key].trim();
  }
  return body;
}
