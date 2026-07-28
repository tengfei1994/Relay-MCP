export interface ProjectTargetLink {
  id: number;
  environment: string;
  server: {
    id: number;
    name: string;
  };
}

export interface ProjectTargetSelection {
  environment?: string;
  defaultEnvironment?: string;
  serverId?: number;
  serverName?: string;
  projectServerId?: number;
  defaultServerId?: number;
  allowedServerIds: number[];
}

function normalized(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

export function describeProjectTargets(links: ProjectTargetLink[]): string {
  if (links.length === 0) return "none";
  return links
    .map((link) => `${link.environment} -> ${link.server.name} (serverId=${link.server.id}, linkId=${link.id})`)
    .join(", ");
}

export function selectProjectTarget<T extends ProjectTargetLink>(
  projectName: string,
  links: T[],
  options: ProjectTargetSelection
): T {
  const allowed = links.filter((link) => options.allowedServerIds.includes(link.server.id));
  const available = describeProjectTargets(allowed);
  const requestedName = normalized(options.serverName);
  const requestedEnvironment = normalized(options.environment);
  const hasExplicitServer = options.serverId !== undefined || requestedName !== undefined;

  if (hasExplicitServer) {
    const linkedMatches = links.filter((link) =>
      (options.serverId === undefined || link.server.id === options.serverId) &&
      (requestedName === undefined || normalized(link.server.name) === requestedName)
    );
    if (linkedMatches.length === 0) {
      throw new Error(`Server selection is not linked to project '${projectName}'. Available links: ${available}`);
    }
    const scopedMatches = linkedMatches.filter((link) => options.allowedServerIds.includes(link.server.id));
    if (scopedMatches.length === 0) {
      throw new Error(
        `Selected server link exists for project '${projectName}', but it is not allowed for this MCP token. Available links: ${available}`
      );
    }
    const environmentMatches = requestedEnvironment
      ? scopedMatches.filter((link) => normalized(link.environment) === requestedEnvironment)
      : scopedMatches;
    if (environmentMatches.length === 0) {
      throw new Error(
        `Selected server is not linked to project '${projectName}' for environment '${options.environment}'. Available links: ${available}`
      );
    }
    if (environmentMatches.length === 1) return environmentMatches[0];
    const preferredEnvironment = normalized(options.defaultEnvironment);
    const preferred = preferredEnvironment
      ? environmentMatches.find((link) => normalized(link.environment) === preferredEnvironment)
      : undefined;
    if (preferred) return preferred;
    throw new Error(
      `Server selection is ambiguous for project '${projectName}'. Pass environment or serverId. Matching links: ${describeProjectTargets(environmentMatches)}`
    );
  }

  const resolvedEnvironment = requestedEnvironment || normalized(options.defaultEnvironment) || "production";
  const environmentLinks = allowed.filter((link) => normalized(link.environment) === resolvedEnvironment);
  if (environmentLinks.length === 0) {
    const allEnvironmentLinks = links.filter((link) => normalized(link.environment) === resolvedEnvironment);
    if (allEnvironmentLinks.length > 0) {
      throw new Error(
        `Server link exists for project '${projectName}' env '${options.environment || options.defaultEnvironment || "production"}', but it is not allowed for this MCP token. Available links: ${available}`
      );
    }
    throw new Error(
      `No server link for project '${projectName}' env '${options.environment || options.defaultEnvironment || "production"}'. Available links: ${available}`
    );
  }

  const scopedLink = options.projectServerId
    ? environmentLinks.find((link) => link.id === options.projectServerId)
    : undefined;
  if (scopedLink) return scopedLink;
  const defaultServer = options.defaultServerId
    ? environmentLinks.find((link) => link.server.id === options.defaultServerId)
    : undefined;
  return defaultServer ?? environmentLinks[0];
}
