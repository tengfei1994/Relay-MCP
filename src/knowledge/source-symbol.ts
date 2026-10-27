import { createHash } from "node:crypto";
import { compareSourceBaselines, type SourceChangeStatus, type SourceManifestFile, type ThreeWayChange } from "./source-baseline.js";
import type { KnowledgeStore } from "./store.js";

export interface SourceSymbolSpan {
  sha256: string;
  lineStart: number;
  lineEnd: number;
}

export interface SourceSymbolChange {
  path: string;
  symbol: string;
  name: string;
  kind: string;
  status: SourceChangeStatus;
  potentialConflict?: boolean;
  old?: SourceSymbolSpan;
  project?: SourceSymbolSpan;
  next?: SourceSymbolSpan;
  evidenceRefs?: { old: string[]; project: string[]; next: string[] };
}

interface SymbolDefinition extends SourceSymbolSpan {
  key: string;
  name: string;
  kind: string;
  content: string;
}

interface SymbolInput {
  path: string;
  language: string;
  old?: string;
  project?: string;
  next?: string;
}

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

function definition(text: string, start: number, end: number, key: string, name: string, kind: string): SymbolDefinition {
  const content = text.slice(start, end).trim();
  const before = text.slice(0, start);
  const lineStart = before.split("\n").length;
  return { key, name, kind, content, sha256: sha256(content), lineStart, lineEnd: lineStart + content.split("\n").length - 1 };
}

function braceEnd(text: string, from: number, fallback: number): number {
  const start = text.indexOf("{", from);
  if (start < 0) return fallback;
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === "{") depth++;
    else if (text[index] === "}" && --depth === 0) return index + 1;
  }
  return text.length;
}

function csharpSymbols(text: string): SymbolDefinition[] {
  const definitions: SymbolDefinition[] = [];
  for (const [pattern, kind] of [[/\b(class|interface|struct|namespace|enum|record)\s+([A-Za-z_][\w.]*)/g, "type"], [/^\s*(?:public|private|protected|internal)\s+(?:(?:static|virtual|override|async|sealed|extern|partial|new|abstract|readonly|unsafe)\s+)*[A-Za-z_][\w<>,.?\[\]]*\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm, "method"]] as const) {
    for (const match of text.matchAll(pattern)) {
      const isMethod = kind === "method";
      const name = isMethod ? match[1] : match[2];
      const signature = isMethod ? `(${match[2].replace(/\s+/g, "")})` : "";
      const end = braceEnd(text, (match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length);
      definitions.push(definition(text, match.index ?? 0, end, `${kind}:${name}${signature}`, name, kind));
    }
  }
  return definitions;
}

function sqlSymbols(text: string): SymbolDefinition[] {
  const matches = [...text.matchAll(/\bCREATE\s+(?:OR\s+ALTER\s+)?(PROCEDURE|PROC|TABLE|VIEW|FUNCTION)\s+([A-Za-z_][A-Za-z0-9_.$#[\]]*)/gi)];
  return matches.map((match, index) => {
    const kind = match[1].toLowerCase() === "proc" ? "procedure" : match[1].toLowerCase();
    const name = match[2];
    const start = match.index ?? 0;
    return definition(text, start, matches[index + 1]?.index ?? text.length, `${kind}:${name.toLowerCase()}`, name, kind);
  });
}

function vglSymbols(text: string): SymbolDefinition[] {
  const matches = [...text.matchAll(/\b(SUB|FUNCTION|PROCEDURE)\s+([A-Za-z_][\w.]*)/gi)];
  return matches.map((match, index) => {
    const name = match[2];
    const start = match.index ?? 0;
    const remaining = text.slice(start + match[0].length);
    const closing = new RegExp(`\\bEND\\s+${match[1]}\\b`, "i").exec(remaining);
    const fallback = matches[index + 1]?.index ?? text.length;
    const end = closing ? start + match[0].length + closing.index + closing[0].length : fallback;
    return definition(text, start, end, `routine:${name.toLowerCase()}`, name, "routine");
  });
}

function xmlSymbols(text: string): SymbolDefinition[] {
  const definitions: SymbolDefinition[] = [];
  for (const match of text.matchAll(/<([A-Za-z_][\w:.-]*)([^>]*)>/g)) {
    const attributes = match[2];
    const identity = /(?:^|\s)(?:name|key|id)\s*=\s*["']([^"']+)["']/i.exec(attributes);
    if (!identity) continue;
    const tag = match[1];
    const name = identity[1];
    const start = match.index ?? 0;
    const selfClosing = /\/\s*$/.test(attributes);
    const closing = selfClosing ? undefined : new RegExp(`</${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*>`, "i").exec(text.slice(start + match[0].length));
    const end = selfClosing ? start + match[0].length : closing ? start + match[0].length + closing.index + closing[0].length : start + match[0].length;
    definitions.push(definition(text, start, end, `element:${tag}[${name}]`, name, "element"));
  }
  return definitions;
}

function uniqueDefinitions(definitions: SymbolDefinition[]): SymbolDefinition[] {
  const occurrences = new Map<string, number>();
  return definitions.map((item) => {
    const occurrence = (occurrences.get(item.key) ?? 0) + 1;
    occurrences.set(item.key, occurrence);
    return occurrence === 1 ? item : { ...item, key: `${item.key}#${occurrence}` };
  });
}

function symbolsFor(text: string | undefined, language: string): SymbolDefinition[] {
  if (text === undefined) return [];
  const normalized = language.toLowerCase();
  const definitions = normalized === "csharp" || normalized === "cs" ? csharpSymbols(text)
    : normalized === "sql" ? sqlSymbols(text)
      : normalized === "vgl" ? vglSymbols(text)
        : normalized === "xml" ? xmlSymbols(text) : [];
  return uniqueDefinitions(definitions);
}

function manifest(definitions: SymbolDefinition[]): SourceManifestFile[] {
  return definitions.map((item) => ({ path: item.key, sha256: item.sha256, size: item.content.length }));
}

export function compareSourceSymbolText(input: SymbolInput): SourceSymbolChange[] {
  const definitions = new Map<string, SymbolDefinition>();
  const sides = [["old", symbolsFor(input.old, input.language)], ["project", symbolsFor(input.project, input.language)], ["next", symbolsFor(input.next, input.language)]] as const;
  for (const [side, symbols] of sides) for (const item of symbols) definitions.set(`${side}:${item.key}`, item);
  const root = input.path;
  const changes = compareSourceBaselines(
    { root, files: manifest(sides[0][1]), sha256: "old" },
    { root, files: manifest(sides[1][1]), sha256: "project" },
    { root, files: manifest(sides[2][1]), sha256: "next" },
  );
  return changes.map((change) => {
    const old = definitions.get(`old:${change.path}`);
    const project = definitions.get(`project:${change.path}`);
    const next = definitions.get(`next:${change.path}`);
    const symbol = old ?? project ?? next!;
    const span = (item: SymbolDefinition | undefined): SourceSymbolSpan | undefined => item ? { sha256: item.sha256, lineStart: item.lineStart, lineEnd: item.lineEnd } : undefined;
    return { path: input.path, symbol: change.path, name: symbol.name, kind: symbol.kind, status: change.status, ...(change.potentialConflict ? { potentialConflict: true } : {}), ...(old ? { old: span(old) } : {}), ...(project ? { project: span(project) } : {}), ...(next ? { next: span(next) } : {}) };
  });
}


interface SourceChunkRow {
  id: string;
  relative_path: string;
  line_start: number;
  line_end: number;
  content: string;
}

export interface SourceUpgradeChange extends ThreeWayChange {
  symbols: SourceSymbolChange[];
}

function sourceText(chunks: SourceChunkRow[]): string {
  const lines: string[] = [];
  for (const chunk of [...chunks].sort((left, right) => left.line_start - right.line_start || left.id.localeCompare(right.id))) {
    const content = chunk.content.split("\n");
    for (let index = 0; index < content.length; index++) lines[chunk.line_start - 1 + index] = content[index];
  }
  return lines.map(line => line ?? "").join("\n");
}

function loadSourceChunks(store: KnowledgeStore, snapshot: boolean, id: string): Map<string, SourceChunkRow[]> {
  const table = snapshot ? "knowledge_project_snapshot_files" : "knowledge_source_files";
  const key = snapshot ? "snapshot_id" : "baseline_id";
  const rows = store.db.prepare(`SELECT c.id,c.relative_path,c.line_start,c.line_end,c.content FROM knowledge_source_chunks c JOIN ${table} f ON f.id=c.source_file_id WHERE c.${key}=? ORDER BY c.relative_path,c.line_start,c.id`).all(id) as SourceChunkRow[];
  const result = new Map<string, SourceChunkRow[]>();
  for (const row of rows) {
    const chunks = result.get(row.relative_path) ?? [];
    chunks.push(row); result.set(row.relative_path, chunks);
  }
  return result;
}

function symbolEvidence(changes: SourceSymbolChange[], oldChunks: SourceChunkRow[], projectChunks: SourceChunkRow[], nextChunks: SourceChunkRow[]): SourceSymbolChange[] {
  return changes.map((change) => {
    const references = (span: SourceSymbolSpan | undefined, chunks: SourceChunkRow[]) => span ? chunks.filter(chunk => chunk.line_start <= span.lineEnd && chunk.line_end >= span.lineStart).map(chunk => chunk.id) : [];
    return { ...change, evidenceRefs: { old: references(change.old, oldChunks), project: references(change.project, projectChunks), next: references(change.next, nextChunks) } };
  });
}

export function compareSourceUpgradeWithSymbols(store: KnowledgeStore, changes: ThreeWayChange[], oldBaselineId: string, projectSnapshotId: string, newBaselineId: string): SourceUpgradeChange[] {
  const oldChunks = loadSourceChunks(store, false, oldBaselineId);
  const projectChunks = loadSourceChunks(store, true, projectSnapshotId);
  const nextChunks = loadSourceChunks(store, false, newBaselineId);
  return changes.map((change) => {
    if (change.status === "UNCHANGED") return { ...change, symbols: [] };
    const language = change.old?.language ?? change.project?.language ?? change.next?.language ?? "";
    const oldForPath = oldChunks.get(change.path) ?? [], projectForPath = projectChunks.get(change.path) ?? [], nextForPath = nextChunks.get(change.path) ?? [];
    const symbols = compareSourceSymbolText({
      path: change.path, language,
      old: change.old ? sourceText(oldForPath) : undefined,
      project: change.project ? sourceText(projectForPath) : undefined,
      next: change.next ? sourceText(nextForPath) : undefined,
    });
    return { ...change, symbols: symbolEvidence(symbols, oldForPath, projectForPath, nextForPath) };
  });
}