/**
 * Token extraction for the MCP endpoint. The Authorization header is always
 * accepted; the `?token=` query form is a legacy transport for MCP clients
 * that cannot set headers (e.g. some stdio bridges) and must be enabled
 * explicitly because query strings leak into proxy logs, browser history,
 * and monitoring systems.
 */
export function extractMcpToken(
  headers: { authorization?: string },
  query: Record<string, unknown>,
  options: { allowQueryToken: boolean }
): string | undefined {
  const headerToken = typeof headers.authorization === "string" && headers.authorization.startsWith("Bearer ")
    ? headers.authorization.slice(7)
    : undefined;
  if (headerToken) return headerToken;
  if (options.allowQueryToken && typeof query.token === "string" && query.token.length > 0) return query.token;
  return undefined;
}

export function queryTokenAuthEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.RELAY_MCP_ALLOW_QUERY_TOKEN ?? "");
}
