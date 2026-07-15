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
  return compactText(JSON.stringify(value, null, 2), limit);
}
