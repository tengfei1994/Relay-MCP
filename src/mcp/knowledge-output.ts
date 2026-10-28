/** Preserve Knowledge DTOs and citations; generic text previews destroy their contract. */
export function serializeKnowledgeResult(value: unknown, maxBytes = 16 * 1024 * 1024): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error("Knowledge response exceeds the size limit; narrow the query or use a smaller page");
  }
  return serialized;
}
