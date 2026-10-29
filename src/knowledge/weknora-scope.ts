export interface RetrievalProjectInput {
  projectId?: string;
  sessionProjectId?: string;
}

/** An omitted scope selects only global Product Knowledge; private scopes stay explicit. */
export function resolveRetrievalProjectId(input: RetrievalProjectInput): string | undefined {
  const explicit = input.projectId?.trim();
  const session = input.sessionProjectId?.trim();
  if (explicit && session && explicit !== session) throw new Error("projectId does not match Work Session");
  return explicit || session || undefined;
}
