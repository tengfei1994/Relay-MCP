import { createHash } from "crypto";
import { ensureRemoteSuccess, type RemoteExecutionOptions, type RemoteRunner } from "./remote-runner.js";

export interface SampleManagerVglSourceOptions {
  sourcePath: string;
  maxBytes?: number;
  execution?: RemoteExecutionOptions;
}

export interface SampleManagerVglAnalysisOptions {
  sourcePath: string;
  entrypoint: string;
  maxCallDepth?: number;
  queryId?: string;
  startedAt?: string;
  finishedAt?: string;
}

function psQuote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

export async function readSampleManagerVglSource(runner: RemoteRunner, options: SampleManagerVglSourceOptions): Promise<string> {
  const sourcePath = options.sourcePath.trim();
  if (!sourcePath || sourcePath.length > 4096 || /[\r\n\0]/.test(sourcePath)) throw new Error("Invalid VGL source path");
  const maxBytes = Math.max(1024, Math.min(Math.trunc(options.maxBytes ?? 1024 * 1024), 2 * 1024 * 1024));
  const script = `
$ErrorActionPreference = "Stop"
$path = ${psQuote(sourcePath)}
$maxBytes = ${maxBytes}
if(-not (Test-Path -LiteralPath $path -PathType Leaf)){ throw "VGL source file not found: $path" }
$item=Get-Item -LiteralPath $path
if($item.Length -gt $maxBytes){ throw "VGL source exceeds the $maxBytes byte inspection limit" }
$bytes=[IO.File]::ReadAllBytes($path)
[pscustomobject]@{
  path=$item.FullName; bytes=$item.Length; sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  modifiedAt=$item.LastWriteTimeUtc.ToString('o'); contentBase64=[Convert]::ToBase64String($bytes)
} | ConvertTo-Json -Depth 4 -Compress
`;
  const result = await runner.execPowerShell(script, 120000, options.execution);
  ensureRemoteSuccess(result);
  const output = (result.stdout || result.stderr).trim();
  if (!output) throw new Error("VGL source inspection returned no JSON evidence");
  return output;
}

function stripComments(source: string): string {
  let output = "";
  let inComment = false;
  let inString = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inComment) {
      if (char === "}") inComment = false;
      output += char === "\n" ? "\n" : " ";
      continue;
    }
    if (char === '"') {
      inString = !inString;
      output += char;
      continue;
    }
    if (!inString && char === "{") {
      inComment = true;
      output += " ";
      continue;
    }
    output += char;
  }
  return output;
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function splitArguments(text: string): string[] {
  const values: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;
  for (const char of text) {
    if (char === '"') inString = !inString;
    if (!inString && char === "(") depth++;
    if (!inString && char === ")") depth--;
    if (!inString && depth === 0 && char === ",") {
      values.push(current.trim()); current = ""; continue;
    }
    current += char;
  }
  if (current.trim()) values.push(current.trim());
  return values;
}

export function analyzeSampleManagerVglSource(raw: Record<string, unknown>, options: SampleManagerVglAnalysisOptions) {
  const encoded = String(raw.contentBase64 ?? "");
  if (!encoded) throw new Error("VGL source response did not contain contentBase64");
  const bytes = Buffer.from(encoded, "base64");
  const source = bytes.toString("utf8").replace(/^\uFEFF/, "");
  const cleaned = stripComments(source);
  const declarationPattern = /^\s*(GLOBAL\s+)?ROUTINE\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)/gim;
  const declarations: Array<{ name: string; global: boolean; parameters: Array<Record<string, unknown>>; start: number; bodyStart: number; end: number; line: number; endLine: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = declarationPattern.exec(cleaned))) {
    declarations.push({
      name: match[2],
      global: Boolean(match[1]),
      parameters: splitArguments(match[3]).map((parameter, index) => {
        const valueMatch = parameter.match(/^VALUE\s+(.+)$/i);
        return { ordinal: index + 1, name: (valueMatch?.[1] ?? parameter).trim(), passing: valueMatch ? "value" : "reference" };
      }),
      start: match.index,
      bodyStart: declarationPattern.lastIndex,
      end: cleaned.length,
      line: lineAt(cleaned, match.index),
      endLine: cleaned.split("\n").length,
    });
  }
  for (let index = 0; index < declarations.length; index++) {
    const declaration = declarations[index];
    const next = declarations[index + 1]?.start ?? cleaned.length;
    const segment = cleaned.slice(declaration.bodyStart, next);
    const endMatch = /\bENDROUTINE\b/i.exec(segment);
    declaration.end = endMatch ? declaration.bodyStart + endMatch.index + endMatch[0].length : next;
    declaration.endLine = lineAt(cleaned, declaration.end);
  }
  const constants = [...cleaned.matchAll(/^\s*CONSTANT\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(.+?)\s*$/gim)].map((item) => ({ name: item[1], value: item[2], line: lineAt(cleaned, item.index ?? 0) }));
  const joins = [...cleaned.matchAll(/^\s*JOIN\s+(STANDARD_LIBRARY|LIBRARY)\s+([^\s]+).*$/gim)].map((item) => ({ kind: item[1].toUpperCase(), name: item[2], line: lineAt(cleaned, item.index ?? 0) }));
  const declarationByName = new Map(declarations.map((item) => [item.name.toUpperCase(), item]));
  const callsByRoutine = new Map<string, Array<Record<string, unknown>>>();
  for (const declaration of declarations) {
    const body = cleaned.slice(declaration.bodyStart, declaration.end);
    const calls = [...body.matchAll(/CALL_ROUTINE\s*\(([^)]*)\)/gim)].map((item) => {
      const args = splitArguments(item[1]);
      const literal = args[0]?.match(/^"([^"]+)"$/);
      return {
        callee: literal?.[1] ?? null,
        dynamicExpression: literal ? null : args[0] ?? null,
        library: args[1] ?? null,
        arguments: args.slice(2),
        line: lineAt(cleaned, declaration.bodyStart + (item.index ?? 0)),
      };
    });
    callsByRoutine.set(declaration.name.toUpperCase(), calls);
  }
  const entrypoint = options.entrypoint.trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entrypoint)) throw new Error("Invalid VGL entrypoint name");
  const entry = declarationByName.get(entrypoint.toUpperCase());
  const maxDepth = Math.max(1, Math.min(Math.trunc(options.maxCallDepth ?? 6), 10));
  const callChain: Array<Record<string, unknown>> = [];
  const visited = new Set<string>();
  const walk = (name: string, depth: number) => {
    if (depth > maxDepth || visited.has(`${name}:${depth}`)) return;
    visited.add(`${name}:${depth}`);
    for (const call of callsByRoutine.get(name) ?? []) {
      const callee = typeof call.callee === "string" ? call.callee : undefined;
      callChain.push({ caller: declarationByName.get(name)?.name ?? name, depth, ...call, resolvedInFile: callee ? declarationByName.has(callee.toUpperCase()) : false });
      if (callee && declarationByName.has(callee.toUpperCase())) walk(callee.toUpperCase(), depth + 1);
    }
  };
  if (entry) walk(entry.name.toUpperCase(), 1);
  const unknowns: string[] = [];
  if (!entry) unknowns.push(`Entrypoint '${entrypoint}' was not declared in the inspected source file.`);
  if (callChain.some((call) => call.dynamicExpression)) unknowns.push("One or more CALL_ROUTINE targets are dynamic and cannot be resolved statically.");
  if (callChain.some((call) => call.callee && call.resolvedInFile === false)) unknowns.push("One or more literal CALL_ROUTINE targets are external to this file; inspect the joined library source to continue the call graph.");
  const excerpt = entry ? source.split(/\r?\n/).slice(Math.max(0, entry.line - 1), Math.min(entry.endLine, entry.line + 20)).join("\n") : null;
  return {
    target: { sourcePath: options.sourcePath, entrypoint },
    entrypoint: entry ? { name: entry.name, global: entry.global, parameters: entry.parameters, source: { startLine: entry.line, endLine: entry.endLine, excerpt } } : null,
    routines: declarations.map((item) => ({ name: item.name, global: item.global, parameters: item.parameters, source: { startLine: item.line, endLine: item.endLine } })),
    constants,
    joins,
    callChain,
    facts: entry ? [{ statement: "VGL entrypoint declaration was found", routine: entry.name, parameterCount: entry.parameters.length }] : [],
    inferences: [{ statement: "Call edges include only statically identifiable CALL_ROUTINE expressions", basis: { maxDepth, callCount: callChain.length } }],
    unknowns,
    evidence: [{ path: raw.path ?? options.sourcePath, bytes: raw.bytes ?? bytes.length, sha256: raw.sha256 ?? createHash("sha256").update(bytes).digest("hex"), modifiedAt: raw.modifiedAt ?? null }],
    errors: [],
    queryMetadata: { queryId: options.queryId, startedAt: options.startedAt, finishedAt: options.finishedAt, readOnly: true, mutationAttempted: false, source: "bounded static VGL source inspection" },
    partial: unknowns.length > 0,
  };
}
