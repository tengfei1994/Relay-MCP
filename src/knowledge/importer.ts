import { createHash, randomUUID } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { extname, join, relative, resolve } from "path";
import YAML from "yaml";
import type { Case, KnowledgeDocument, KnowledgeKind, KnowledgeLifecycle, Pattern, Playbook } from "./domain.js";
import type { KnowledgeStore } from "./store.js";
import { EvidenceStore } from "./evidence-store.js";
import { KnowledgeRepository } from "./repository.js";

export interface ImportCasebookOptions {
  root: string; projectId?: string; projectNameSnapshot?: string;
  sampleManagerVersion?: string; solution?: string; module?: string;
  environment?: string; sourceCommit?: string; evidenceRoot?: string; now?: () => Date;
}
export interface ImportContextFactsOptions {
  files: string[]; userId: number; projectId?: string; projectNameSnapshot?: string;
  projectResolver?: (userId: number, projectName: string) => string | number | undefined;
  projectMap?: Record<string, string | number>; preserveSource?: boolean; now?: () => Date;
}
export interface ImportReport {
  runId: string; imported: number; skipped: number; unresolved: number;
  errors: Array<{ path: string; error: string }>;
}
type ParsedCasebook = { document: KnowledgeDocument; metadata: Record<string, unknown> };

function walkFiles(root: string): string[] {
  const base = resolve(root); if (!existsSync(base)) return [];
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(md|markdown|ya?ml)$/i.test(entry.name)) out.push(path);
    }
  };
  if (statSync(base).isDirectory()) visit(base); return out.sort();
}
function asString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function asText(value: unknown): string | undefined {
  if (Array.isArray(value)) { const values = value.map(asText).filter((v): v is string => Boolean(v)); return values.length ? values.join("\n") : undefined; }
  return asString(value) ?? (typeof value === "number" || typeof value === "boolean" ? String(value) : undefined);
}
function asKind(value: unknown): Exclude<KnowledgeKind, "candidate" | "fact" | "evidence" | "relation"> {
  if (value === "case" || value === "pattern" || value === "playbook") return value;
  throw new Error("kind must be one of case, pattern, playbook");
}
function asLifecycle(value: unknown): KnowledgeLifecycle {
  if (value === undefined || value === null || value === "") return "draft";
  if (value === "draft" || value === "reproduced" || value === "verified" || value === "approved" || value === "deprecated") return value;
  throw new Error("status/lifecycle is invalid");
}
function asObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be a mapping`);
  return value as Record<string, unknown>;
}
function parseCasebook(path: string, options: ImportCasebookOptions): ParsedCasebook {
  const raw = readFileSync(path, "utf8");
  const relativePath = relative(resolve(options.root), path).replaceAll("\\", "/");
  let metadata: Record<string, unknown>; let body = raw;
  if (raw.startsWith("---")) {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) throw new Error("front matter is not terminated");
    metadata = asObject(YAML.parse(match[1]), "front matter"); body = raw.slice(match[0].length);
  } else if (/\.(ya?ml)$/i.test(path)) {
    metadata = asObject(YAML.parse(raw), "YAML document");
    body = [metadata.symptoms, metadata.root_cause, metadata.fix, metadata.verification, metadata.applicability]
      .map(asText).filter((v): v is string => Boolean(v)).join("\n");
  } else throw new Error("Markdown casebook entries require YAML front matter");
  const scope = asObject(metadata.scope, "scope");
  const title = asString(metadata.title); if (!title) throw new Error("title is required");
  const id = asString(metadata.id) ?? `casebook-${createHash("sha256").update(relativePath).digest("hex").slice(0, 24)}`;
  const createdAt = asString(metadata.createdAt) ?? options.now?.().toISOString() ?? new Date().toISOString();
  const updatedAt = asString(metadata.updatedAt) ?? createdAt;
  const document: KnowledgeDocument = {
    id, kind: asKind(metadata.kind), title, body: body.trim(), lifecycle: asLifecycle(metadata.status ?? metadata.lifecycle),
    projectId: asString(metadata.projectId) ?? options.projectId,
    projectNameSnapshot: asString(metadata.projectNameSnapshot) ?? options.projectNameSnapshot,
    sampleManagerVersion: asString(scope.samplemanager ?? scope.sampleManagerVersion) ?? options.sampleManagerVersion,
    solution: asString(scope.solution) ?? options.solution, module: asString(scope.module) ?? options.module,
    environment: asString(scope.environment) ?? options.environment,
    locator: asString(metadata.sourceLocator) ?? `casebook:${relativePath}`,
    commit: asString(metadata.sourceCommit ?? metadata.commit) ?? options.sourceCommit,
    sha256: createHash("sha256").update(raw).digest("hex"), createdAt, updatedAt,
  };
  return { document, metadata };
}
function startRun(store: KnowledgeStore, sourceLocator: string, now: () => Date): string {
  const id = `ingest-${randomUUID()}`;
  store.db.prepare("INSERT INTO knowledge_ingest_runs(id,source_locator,status,started_at) VALUES (?,?,?,?)").run(id, sourceLocator, "running", now().toISOString()); return id;
}
function finishRun(store: KnowledgeStore, report: ImportReport, now: () => Date): void {
  store.db.prepare("UPDATE knowledge_ingest_runs SET status=?,imported=?,skipped=?,failed=?,finished_at=?,error=? WHERE id=?")
    .run(report.errors.length ? "failed" : "completed", report.imported, report.skipped, report.errors.length, now().toISOString(), report.errors.length ? JSON.stringify(report.errors) : null, report.runId);
}
function saveProjection(repository: KnowledgeRepository, parsed: ParsedCasebook): void {
  const { document, metadata } = parsed;
  const base = { ...document, evidenceRefs: Array.isArray(metadata.evidenceRefs) ? metadata.evidenceRefs.filter((v): v is string => typeof v === "string") : undefined };
  if (document.kind === "case") repository.saveCase({ ...base, kind: "case", symptoms: asText(metadata.symptoms), rootCause: asText(metadata.root_cause ?? metadata.rootCause), fix: asText(metadata.fix), verification: asText(metadata.verification), applicability: asText(metadata.applicability) } as Case);
  else if (document.kind === "pattern") repository.savePattern({ ...base, kind: "pattern", applicability: asText(metadata.applicability), caseRefs: Array.isArray(metadata.caseRefs) ? metadata.caseRefs.filter((v): v is string => typeof v === "string") : undefined } as Pattern);
  else repository.savePlaybook({ ...base, kind: "playbook", steps: Array.isArray(metadata.steps) ? metadata.steps.map(asText).filter((v): v is string => Boolean(v)) : undefined, rollback: asText(metadata.rollback), skillDiff: asText(metadata.skillDiff ?? metadata.skill_diff) } as Playbook);
}
function evidenceEntries(metadata: Record<string, unknown>): Array<{ path: string; locator?: string; kind?: string }> {
  if (!Array.isArray(metadata.evidence)) return [];
  return metadata.evidence.flatMap((entry) => {
    if (typeof entry === "string") return [{ path: entry }];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    const explicitPath = asString(value.path ?? value.file ?? value.source);
    const fallback = explicitPath ? undefined : Object.entries(value).find(([key, item]) => key !== "locator" && key !== "kind" && typeof item === "string");
    const path = explicitPath ?? asString(fallback?.[1]);
    return path ? [{ path, locator: asString(value.locator) ?? (fallback ? `casebook-evidence:${fallback[0]}` : undefined), kind: asString(value.kind) }] : [];
  });
}
function evidenceMime(path: string): string {
  const ext = extname(path).toLowerCase();
  if ([".txt", ".log", ".md", ".markdown", ".json", ".xml", ".sql", ".cs", ".yaml", ".yml"].includes(ext)) return "text/plain";
  return "application/octet-stream";
}
function evidenceKind(path: string, requested?: string): "log" | "xml" | "sql" | "artifact" | "test" | "manifest" | "other" {
  if (requested === "log" || requested === "xml" || requested === "sql" || requested === "artifact" || requested === "test" || requested === "manifest" || requested === "other") return requested;
  const ext = extname(path).toLowerCase();
  if (ext === ".log") return "log"; if (ext === ".xml") return "xml"; if (ext === ".sql") return "sql"; if ([".json", ".yaml", ".yml"].includes(ext)) return "manifest";
  return "artifact";
}

export function importCasebook(store: KnowledgeStore, options: ImportCasebookOptions): ImportReport {
  const now = options.now ?? (() => new Date()); const runId = startRun(store, `casebook:${resolve(options.root)}`, now);
  const report: ImportReport = { runId, imported: 0, skipped: 0, unresolved: 0, errors: [] }; const repository = new KnowledgeRepository(store); const evidence = options.evidenceRoot ? new EvidenceStore(store, options.evidenceRoot) : undefined;
  for (const path of walkFiles(options.root)) try {
    const parsed = parseCasebook(path, options); const existing = store.db.prepare("SELECT source_sha256 FROM knowledge_documents WHERE id=?").get(parsed.document.id) as { source_sha256?: string } | undefined;
    const expectedEvidence = evidenceEntries(parsed.metadata);
    const linkedRow = expectedEvidence.length ? store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_entity_evidence WHERE entity_type=? AND entity_id=?").get(parsed.document.kind, parsed.document.id) as { count?: number } : undefined;
    const linkedEvidence = Number(linkedRow?.count ?? 0);
    if (existing?.source_sha256 === parsed.document.sha256 && linkedEvidence >= expectedEvidence.length) { report.skipped++; continue; }
    saveProjection(repository, parsed); report.imported++;
    if (evidence) for (const entry of evidenceEntries(parsed.metadata)) {
      const evidencePath = resolve(options.root, entry.path); if (!existsSync(evidencePath) || !statSync(evidencePath).isFile()) throw new Error(`evidence file not found: ${entry.path}`);
      const row = evidence.put({ content: readFileSync(evidencePath), mimeType: evidenceMime(evidencePath), sourceKind: evidenceKind(evidencePath, entry.kind), projectId: parsed.document.projectId, locator: entry.locator ?? `casebook:${relative(resolve(options.root), evidencePath).replaceAll("\\", "/")}`, commit: parsed.document.commit });
      repository.attachEvidence(parsed.document.kind, parsed.document.id, String((row as { id: string }).id));
    }
  } catch (error) { report.errors.push({ path, error: error instanceof Error ? error.message : String(error) }); }
  finishRun(store, report, now); return report;
}

export function importContextFacts(store: KnowledgeStore, options: ImportContextFactsOptions): ImportReport {
  const now = options.now ?? (() => new Date()); const runId = startRun(store, `context-jsonl:${options.files.map((file) => resolve(file)).join(",")}`, now); const report: ImportReport = { runId, imported: 0, skipped: 0, unresolved: 0, errors: [] };
  for (const path of options.files) try {
    const source = resolve(path); if (!existsSync(source) || !statSync(source).isFile()) throw new Error("source JSONL file does not exist");
    const lines = readFileSync(source, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) { if (!lines[index].trim()) continue; try {
      const parsed = JSON.parse(lines[index]) as Record<string, unknown>; const text = asString(parsed.text ?? parsed.fact ?? parsed.content); if (!text) throw new Error("fact text is required");
      const projectName = asString(parsed.projectName ?? parsed.project_name) ?? options.projectNameSnapshot; let projectId = asString(parsed.projectId ?? parsed.project_id) ?? options.projectId;
      if (!projectId && projectName && options.projectMap?.[projectName] !== undefined) projectId = String(options.projectMap[projectName]);
      if (!projectId && projectName && options.projectResolver) { const resolved = options.projectResolver(options.userId, projectName); if (resolved !== undefined) projectId = String(resolved); }
      const status = projectId ? "resolved" : "unresolved"; if (!projectId) report.unresolved++; const locator = `context-jsonl:${source}:${index + 1}`; const id = `fact-${createHash("sha256").update(`${locator}\n${text}`).digest("hex")}`; const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === "string") : [];
      const result = store.db.prepare("INSERT OR IGNORE INTO knowledge_facts(id,user_id,project_id,project_name_snapshot,text,tags_json,source_locator,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, options.userId, projectId ?? null, projectName ?? null, text, JSON.stringify(tags), locator, status, now().toISOString()); if (result.changes === 1) report.imported++; else report.skipped++;
    } catch (error) { report.errors.push({ path: `${source}:${index + 1}`, error: error instanceof Error ? error.message : String(error) }); } }
    void options.preserveSource;
  } catch (error) { report.errors.push({ path, error: error instanceof Error ? error.message : String(error) }); }
  finishRun(store, report, now); return report;
}

export function ingestSourceFiles(store: KnowledgeStore, options: ImportCasebookOptions & { contextFiles?: string[]; userId?: number; projectResolver?: ImportContextFactsOptions["projectResolver"]; projectMap?: ImportContextFactsOptions["projectMap"] }): ImportReport {
  const casebook = importCasebook(store, options); if (!options.contextFiles?.length || options.userId === undefined) return casebook;
  const facts = importContextFacts(store, { files: options.contextFiles, userId: options.userId, projectId: options.projectId, projectNameSnapshot: options.projectNameSnapshot, projectResolver: options.projectResolver, projectMap: options.projectMap, now: options.now });
  return { runId: casebook.runId, imported: casebook.imported + facts.imported, skipped: casebook.skipped + facts.skipped, unresolved: casebook.unresolved + facts.unresolved, errors: [...casebook.errors, ...facts.errors] };
}
