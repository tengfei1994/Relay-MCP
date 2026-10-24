export interface RetrievalProjectInput {
  projectId?: string;
  sessionProjectId?: string;
  fallbackProjectId?: string;
  fallbackProjectName?: string;
}

/** Fail closed when a Product Knowledge request has no project boundary. */
export function resolveRetrievalProjectId(input: RetrievalProjectInput): string {
  const projectId = [input.projectId, input.sessionProjectId, input.fallbackProjectId, input.fallbackProjectName]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
  if (!projectId) throw new Error("projectId or workSessionId is required for Product Knowledge retrieval");
  return projectId;
}
