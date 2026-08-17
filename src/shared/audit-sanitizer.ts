function keyMetadata(value: unknown): { keys: string[]; count: number; valuesRedacted: true } {
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
  return { keys, count: keys.length, valuesRedacted: true };
}

export function sanitizeAuditArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAuditArguments);
  if (!value || typeof value !== "object") return value;
  const sensitive = /^(script|content|base64|token|password|sql|parameters)$/i;
  const buildSettings = /^(environmentVariables|msbuildProperties)$/i;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (buildSettings.test(key)) return [key, keyMetadata(item)];
    if (sensitive.test(key)) {
      const text = typeof item === "string" ? item : JSON.stringify(item);
      return [key, { redacted: true, length: text?.length ?? 0 }];
    }
    return [key, sanitizeAuditArguments(item)];
  }));
}
