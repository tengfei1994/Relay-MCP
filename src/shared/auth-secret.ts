const DEVELOPMENT_DEFAULT_SECRET = "dev-secret-change-in-production";

/** Return the configured JWT secret, refusing the public fallback outside local/test runs. */
export function requireJwtSecret(service: string): string {
  const configured = process.env.JWT_SECRET?.trim();
  const nodeEnv = process.env.NODE_ENV ?? "";
  const local = nodeEnv === "development" || nodeEnv === "test";
  const placeholder = !configured || configured === DEVELOPMENT_DEFAULT_SECRET || /(?:change-this|example|placeholder|your[-_ ]|at[-_ ]least[-_ ]\d+[-_ ]chars)/i.test(configured) || configured.length < 32;
  if (placeholder) {
    if (local) {
      console.warn(`[${service}] JWT_SECRET is not set or uses the development default; do not use this configuration in production.`);
      return DEVELOPMENT_DEFAULT_SECRET;
    }
    throw new Error("JWT_SECRET must be configured and must not use the public development default");
  }
  return configured;
}
