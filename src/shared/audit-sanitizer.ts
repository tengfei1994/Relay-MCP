function keyMetadata(value: unknown): { keys: string[]; count: number; valuesRedacted: true } {
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
  return { keys, count: keys.length, valuesRedacted: true };
}

// Credential fields are matched by case-insensitive containment so variant
// names (apiToken, accessToken, clientSecret, privateKey, authorization, ...)
// are redacted by key even when the value carries no recognizable marker.
const SENSITIVE_KEY = /(token|secret|password|passwd|credential|authorization|api[-_]?key|private[-_]?key|ssh[-_]?key|connection[-_]?string|cookie|bearer)/i;
const SENSITIVE_VALUE = /(?:bearer\s+|--?(?:password|token|secret|api[-_]?key)\s*=|(?:password|token|secret|api[-_]?key|connectionstring)\s*=)/i;
const EXACT_SENSITIVE_KEY = /^(script|content|base64|token|password|sql|parameters)$/i;
const BUILD_SETTINGS_KEY = /^(environmentVariables|msbuildProperties)$/i;

function redactionLength(item: unknown): number {
  try {
    return typeof item === "string" ? item.length : JSON.stringify(item)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function sanitizeAuditArguments(value: unknown, seen: Set<object> = new Set()): unknown {
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (typeof value === "string") {
    if (SENSITIVE_VALUE.test(value)) return { redacted: true, length: value.length };
    return value;
  }
  if (!value || typeof value !== "object") return value;
  // Circular structures are summarized instead of recursed so audit and
  // Knowledge serialization can never overflow the stack.
  if (seen.has(value as object)) return { circular: true };
  seen.add(value as object);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizeAuditArguments(item, seen));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (BUILD_SETTINGS_KEY.test(key)) return [key, keyMetadata(item)];
      if (EXACT_SENSITIVE_KEY.test(key) || SENSITIVE_KEY.test(key)) {
        return [key, { redacted: true, length: redactionLength(item) }];
      }
      return [key, sanitizeAuditArguments(item, seen)];
    }));
  } finally {
    seen.delete(value as object);
  }
}
