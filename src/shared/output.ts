import type { ExecResult } from "./remote-runner.js";

const DEFAULT_LIMIT = Number(process.env.MCP_OUTPUT_LIMIT ?? 12000);

export interface CompactTextResult {
  text: string;
  originalLength: number;
  truncated: boolean;
}

export function compactTextWithMetadata(value: string, limit = DEFAULT_LIMIT): CompactTextResult {
  if (value.length <= limit) {
    return { text: value, originalLength: value.length, truncated: false };
  }
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return {
    text: [
      value.slice(0, head),
      `\n... truncated ${value.length - limit} character(s) ...\n`,
      value.slice(value.length - tail),
    ].join(""),
    originalLength: value.length,
    truncated: true,
  };
}

export function compactText(value: string, limit = DEFAULT_LIMIT): string {
  return compactTextWithMetadata(value, limit).text;
}

export function summarizeExec(command: string, result: ExecResult, limit = DEFAULT_LIMIT): string {
  const stdout = compactText(result.stdout || "", Math.floor(limit * 0.55));
  const stderr = compactText(result.stderr || "", Math.floor(limit * 0.35));
  return [
    `$ ${command}`,
    `exit=${result.code}`,
    "--- stdout ---",
    stdout || "(empty)",
    "--- stderr ---",
    stderr || "(empty)",
  ].join("\n");
}

export function summarizeJson(value: unknown, limit = DEFAULT_LIMIT): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized.length <= limit) return serialized;
  const previewLimit = Math.max(200, limit - 180);
  return JSON.stringify({
    truncated: true,
    originalLength: serialized.length,
    preview: compactText(serialized, previewLimit),
  }, null, 2);
}

export interface StructuredOutputLimits {
  maxDepth?: number;
  maxArrayItems?: number;
  maxStringLength?: number;
}

export function sanitizeStructuredOutput(
  value: unknown,
  limits: StructuredOutputLimits = {}
): { value: unknown; truncatedPaths: string[]; largestFields: Array<{ path: string; characters: number }> } {
  const maxDepth = Math.max(1, Math.min(limits.maxDepth ?? 6, 20));
  const maxArrayItems = Math.max(1, Math.min(limits.maxArrayItems ?? 200, 5000));
  const maxStringLength = Math.max(100, Math.min(limits.maxStringLength ?? 8000, 100000));
  const truncatedPaths: string[] = [];
  const sizes: Array<{ path: string; characters: number }> = [];

  const visit = (item: unknown, path: string, depth: number): unknown => {
    let characters = 0;
    try { characters = JSON.stringify(item)?.length ?? 0; } catch {}
    sizes.push({ path: path || "$", characters });
    if (depth >= maxDepth && item !== null && typeof item === "object") {
      truncatedPaths.push(path || "$");
      return `[truncated at depth ${maxDepth}]`;
    }
    if (typeof item === "string" && item.length > maxStringLength) {
      truncatedPaths.push(path || "$");
      return `${item.slice(0, maxStringLength)}... [truncated ${item.length - maxStringLength} chars]`;
    }
    if (Array.isArray(item)) {
      if (item.length > maxArrayItems) truncatedPaths.push(path || "$");
      return item.slice(0, maxArrayItems).map((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      let entries = Object.entries(record);
      const commandFields = ["Name", "CommandType", "Version", "Source", "ModuleName", "Definition"];
      const serviceFields = ["Name", "DisplayName", "Status", "StartType", "ServiceName"];
      let whitelist: string[] | undefined;
      if ("CommandType" in record && "Name" in record) whitelist = commandFields;
      else if ("Status" in record && ("ServiceName" in record || "DisplayName" in record)) whitelist = serviceFields;
      if (whitelist) {
        const omitted = entries.filter(([key]) => !whitelist!.includes(key)).length;
        if (omitted > 0) truncatedPaths.push(`${path || "$"}.[${omitted} non-whitelisted properties]`);
        entries = entries.filter(([key]) => whitelist!.includes(key));
      }
      return Object.fromEntries(entries.map(([key, entry]) => [
        key,
        visit(entry, path ? `${path}.${key}` : key, depth + 1),
      ]));
    }
    return item;
  };

  return {
    value: visit(value, "", 0),
    truncatedPaths: Array.from(new Set(truncatedPaths)).slice(0, 100),
    largestFields: sizes
      .filter((entry) => entry.path !== "$")
      .sort((a, b) => b.characters - a.characters)
      .slice(0, 10),
  };
}
