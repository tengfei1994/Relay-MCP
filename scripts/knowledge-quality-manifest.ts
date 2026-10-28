/**
 * Offline source-occurrence golden fixture; it does not call retrieval or a model.
 * Bounded raw queries are written ONLY to the private fixture. Stdout/report use hashes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type Source, argumentsFor, codeBlocks, countBy, isolatedPath, loadSources, openReadOnly,
  readJson, requireQuality, safeFailure, savePrivate, selectFrozenSources, sha, sourceFingerprint,
  sameOrGlobal, projectFrozenJsonl, record, text,
} from "./knowledge-quality-common.js";
import { normalizeProductMarkup } from "../src/knowledge/weknora-markdown.js";

export const CATEGORIES = [
  "english_title", "native_chinese_source", "chinese_query_english_object", "object_identifier",
  "source_path", "version_filtered", "vgl", "xml", "configuration_key",
] as const;
type Category = typeof CATEGORIES[number];
interface Candidate {
  category: Category; query: string; needle: string; originId: string;
  projectId: string | null; environment: string | null; version: string | null;
  matchFields: Array<"title" | "body" | "sourcePath">; queryConstruction: string;
}
export interface GoldenCase {
  id: string; category: Category; query: string; querySha256: string; queryConstruction: string;
  filters: { projectId: string | null; environment: string | null; productVersion?: string };
  relevance: "exact_source_occurrence_unreviewed"; originId: string;
  expected: Array<{ localDocumentId: string; sourceSha256: string; bodySha256: string; citationSha256: string;
    occurrence: { field: string; start: number; end: number; needleSha256: string } }>;
  scopeBoundary: "global_and_exact_only"; forbiddenOtherVersionIds: string[];
}
function uniqueMatches(value: string, expression: RegExp, limit: number): string[] {
  return [...new Set([...value.matchAll(expression)].map(match => match[1] ?? match[0]))].slice(0, limit);
}
export function candidatesFor(source: Source): Candidate[] {
  const output: Candidate[] = [];
  const add = (category: Category, query: string, needle: string, queryConstruction: string,
    fields: Candidate["matchFields"] = ["title", "body", "sourcePath"], version: string | null = null) => {
    if (needle.length < 4 || query.length > 280 || /[\r\n\0]/.test(query)) return;
    output.push({ category, query, needle, originId: source.id, projectId: source.projectId,
      environment: source.environment, version, matchFields: fields, queryConstruction });
  };
  const title = source.title.trim().replace(/\s+/g, " ").slice(0, 150);
  if (/[A-Za-z]{4}/.test(title)) add("english_title", title, title, "literal_source_title", ["title", "body"]);
  for (const phrase of uniqueMatches(source.title + "\n" + source.body, /([\u3400-\u9fff]{4,18})/gu, 3))
    add("native_chinese_source", phrase, phrase, "literal_cjk_occurrence");
  const objects = uniqueMatches(source.title + "\n" + source.body, /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g, 5);
  for (const object of objects) {
    add("object_identifier", object, object, "literal_identifier");
    add("chinese_query_english_object", "SampleManager " + object + " 用法", object, "chinese_wrapper_over_literal_object_not_native_chinese_evidence");
  }
  if (source.sourcePath) add("source_path", source.sourcePath, source.sourcePath, "literal_source_path", ["sourcePath"]);
  if (source.version && title) add("version_filtered", "SampleManager " + source.version + " " + title,
    title, "source_title_with_explicit_version_filter", ["title", "body"], source.version);
  for (const block of codeBlocks(source.body)) {
    const identifiers = uniqueMatches(block.content, /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g, 3);
    if (/^vgl$/i.test(block.language) || /\bVGL\b/i.test(source.title + " " + source.sourcePath)) {
      for (const id of identifiers) add("vgl", "VGL " + id, id, "literal_code_identifier_with_vgl_source_context", ["body"]);
    }
    for (const tag of uniqueMatches(block.content, /<([A-Za-z_][A-Za-z0-9_.:-]{3,})\b[^>]*>/g, 3)) {
      if ((block.language === "xml" || /\bXML\b/i.test(source.title + " " + source.sourcePath + " " + source.body)) && (block.content.includes("</" + tag + ">") || new RegExp("<" + tag.replace(/[.*+?^$()|[\]\\]/g, "\\$&") + "\\b[^>]*\\/\\s*>").test(block.content)))
        add("xml", "<" + tag + ">", "<" + tag, "literal_markup_tag_in_source_code_not_xml_validity_proof", ["body"]);
    }
    if (/config|configuration|setting|配置|设置/i.test(source.title + " " + source.sourcePath + " " + block.language)) {
      for (const key of uniqueMatches(block.content, /^\s*([A-Za-z_][A-Za-z0-9_.-]{3,})\s*[:=]/gm, 3))
        add("configuration_key", key, key, "literal_assignment_key_with_configuration_context", ["body"]);
    }
  }
  return output;
}
function occurrence(source: Source, candidate: Candidate): GoldenCase["expected"][number]["occurrence"] | undefined {
  for (const field of candidate.matchFields) {
    const start = source[field].toLowerCase().indexOf(candidate.needle.toLowerCase());
    if (start >= 0) return { field, start, end: start + candidate.needle.length, needleSha256: sha(candidate.needle) };
  }
  return undefined;
}
export function generateFixture(sources: Source[], maxPerCategory: number) {
  requireQuality(Number.isInteger(maxPerCategory) && maxPerCategory >= 1 && maxPerCategory <= 30, "max_per_category_out_of_range");
  sources = [...sources].sort((a, b) => a.id.localeCompare(b.id));
  const all = new Map<string, Candidate>();
  for (const source of [...sources].sort((a, b) => a.id.localeCompare(b.id))) for (const candidate of candidatesFor(source)) {
    const key = sha(JSON.stringify([candidate.category, candidate.query, candidate.projectId, candidate.environment, candidate.version]));
    if (!all.has(key)) all.set(key, candidate);
  }
  const cases: GoldenCase[] = [], excluded = { ambiguousMoreThanTenSources: 0, noExactOccurrence: 0 };
  const candidateCounts = countBy([...all.values()].map(candidate => candidate.category));
  for (const category of CATEGORIES) {
    let accepted = 0;
    // Deterministic ordering BEFORE any retrieval result is available.
    const pool = [...all].filter(([, candidate]) => candidate.category === category).sort(([a], [b]) => a.localeCompare(b));
    for (const [key, candidate] of pool) {
      if (accepted >= maxPerCategory) break;
      const matches = sources.filter(source => sameOrGlobal(source, candidate) && (!candidate.version || source.version === candidate.version))
        .map(source => ({ source, found: occurrence(source, candidate) })).filter(item => item.found);
      if (matches.length === 0) { excluded.noExactOccurrence++; continue; }
      if (matches.length > 10) { excluded.ambiguousMoreThanTenSources++; continue; }
      const expected = matches.map(({ source, found }) => ({ localDocumentId: source.id, sourceSha256: source.sourceSha256,
        bodySha256: source.bodySha256, citationSha256: source.citationSha256, occurrence: found! }));
      cases.push({ id: "source-occurrence-" + key.slice(0, 24), category, query: candidate.query, querySha256: sha(candidate.query),
        queryConstruction: candidate.queryConstruction, filters: { projectId: candidate.projectId, environment: candidate.environment,
          ...(candidate.version ? { productVersion: candidate.version } : {}) },
        relevance: "exact_source_occurrence_unreviewed", originId: candidate.originId, expected,
        scopeBoundary: "global_and_exact_only",
        forbiddenOtherVersionIds: candidate.version ? sources.filter(source => source.version !== candidate.version &&
          sameOrGlobal(source, candidate) && occurrence(source, candidate)).map(source => source.id) : [] });
      accepted++;
    }
  }
  const coverage = {
    sources: sources.length, uniqueExpectedSources: new Set(cases.flatMap(item => item.expected.map(source => source.localDocumentId))).size,
    cases: cases.length, byCategory: countBy(cases.map(item => item.category)),
    byVersion: countBy(sources.map(source => source.version)), bySolution: countBy(sources.map(source => source.solution)),
    byModule: countBy(sources.map(source => source.module)), byDeclaredLanguage: countBy(sources.map(source => source.language)),
    bySourceFormat: countBy(sources.map(source => source.sourceFormat)),
    sourcesContainingCjk: sources.filter(source => /[\u3400-\u9fff]/u.test(source.body + source.title)).length,
    sourcesWithCode: sources.filter(source => codeBlocks(source.body).length > 0).length,
    missingCategories: CATEGORIES.filter(category => !cases.some(item => item.category === category)),
    missingPositiveSolution: !sources.some(source => source.solution),
    versionFilteredCasesWithActualOtherVersionNegatives: cases.filter(item => item.forbiddenOtherVersionIds.length > 0).length,
  };
  return { schemaVersion: 1, kind: "source_occurrence_not_semantic_gold", sourceFingerprint: sourceFingerprint(sources),
    sampling: { method: "sha256_sorted_stratified_before_retrieval", maxPerCategory, maximumExpectedSourcesPerCase: 10,
      candidateCounts, excluded, selectedFromFrozenManifestOnly: true },
    coverage, cases, humanReview: { relevance: "not_evaluated", factualAccuracy: "not_evaluated", reviewer: null },
    modelCalls: 0, retrievalCalls: 0 };
}
function example(id: string, title: string, body: string, extra: Partial<Source> = {}): Source {
  return { id, title, body, bodySha256: sha(body), sourceSha256: sha("raw-" + id), sourcePath: "21.1/" + id + ".html",
    version: "21.1", solution: null, module: "Developer", language: "en", projectId: "p1", environment: "nonprod",
    lifecycle: "published", parserVersion: "html-2", sourceFormat: "html", citationSha256: sha(id), ...extra };
}
export function selfTest(): void {
  const ticks = String.fromCharCode(96).repeat(3);
  const a = example("a", "VGL TABLE_NAME configuration", ticks + "xml\n<Settings><MaxRetries>3</MaxRetries></Settings>\n" + ticks +
    "\n" + ticks + "ini\nMaxRetries=3\n" + ticks + "\n" + ticks + "vgl\nTABLE_NAME(1)\n" + ticks + "\nTABLE_NAME 仪器保存配置");
  const b = example("b", a.title, a.body, { version: "21.3" });
  const foreign = example("foreign", a.title, a.body, { projectId: "p2" });
  const global = example("global", a.title, a.body, { projectId: null, environment: null });
  const fixture = generateFixture([a, b, foreign, global], 5);
  assert.deepEqual(fixture, generateFixture([global, foreign, b, a], 5), "sampling independent of input order");
  for (const category of CATEGORIES) assert(fixture.cases.some(item => item.category === category), category);
  const version = fixture.cases.find(item => item.category === "version_filtered" && item.originId === "a")!;
  assert(version.expected.some(item => item.localDocumentId === "a"));
  assert(version.expected.some(item => item.localDocumentId === "global"));
  assert(!version.expected.some(item => ["b", "foreign"].includes(item.localDocumentId)));
  assert(version.forbiddenOtherVersionIds.includes("b"));
  const noChinese = generateFixture([example("x", "TABLE_NAME", "TABLE_NAME")], 2);
  assert(noChinese.coverage.missingCategories.includes("native_chinese_source"));
  assert(noChinese.cases.some(item => item.category === "chinese_query_english_object"));
  assert.equal(noChinese.humanReview.factualAccuracy, "not_evaluated");
  const manifest = { documents: [{ id: a.id, sourcePath: a.sourcePath, sourceSha256: a.sourceSha256,
    normalizedBodySha256: a.bodySha256, version: a.version, projectId: a.projectId, environment: a.environment }] };
  assert.equal(selectFrozenSources([a], manifest)[0].id, a.id);
  assert.equal(selectFrozenSources([{ ...a, lifecycle: "approved" }], manifest)[0].id, a.id);
  assert.throws(() => selectFrozenSources([{ ...a, bodySha256: sha("changed") }], manifest), /manifest_body_hash_mismatch/);
  assert.throws(() => selectFrozenSources([{ ...a, projectId: "other" }], manifest), /manifest_scope_mismatch/);
  assert.throws(() => selectFrozenSources([{ ...a, sourceSha256: sha("different") }], manifest), /manifest_raw_hash_mismatch/);
  const ambiguous = Array.from({ length: 11 }, (_, i) => example("many-" + i, "SHARED_OBJECT", "SHARED_OBJECT"));
  assert(generateFixture(ambiguous, 2).sampling.excluded.ambiguousMoreThanTenSources > 0);
  assert.equal(codeBlocks("~~~~xml\n<a/>\n~~~\n~~~~")[0].content, "<a/>\n~~~");
  const projectedSource = { ...a, sourceMetadataSha256: sha("{}"), sectionsSha256: sha("[]") };
  const projection = { bulkSourceId: a.id, targetLocalId: "target-a", projectId: "p1", environment: "nonprod-full", bodySha256: a.bodySha256, rawSha256: a.sourceSha256, sourcePath: a.sourcePath, version: a.version, sourceMetadataSha256: sha("{}"), sectionsSha256: sha("[]"), language: a.language, module: a.module, solution: a.solution };
  assert.equal(projectFrozenJsonl([projectedSource], [projection])[0].id, "target-a");
  assert.throws(() => projectFrozenJsonl([projectedSource], [{ ...projection, bodySha256: sha("changed") }]), /projection_body_hash_mismatch/);
  assert.throws(() => projectFrozenJsonl([projectedSource], [{ ...projection, environment: "production" }]), /projection_nonproduction_scope_required/);
  process.stdout.write(JSON.stringify({ status: "passed", selfTest: "knowledge-quality-manifest", modelCalls: 0 }) + "\n");
}
function main(): void {
  if (process.argv.slice(2).join(" ") === "--self-test") { selfTest(); return; }
  const args = argumentsFor(["--db", "--source-manifest", "--frozen-jsonl", "--out", "--report", "--max-per-category"]);
  requireQuality(Boolean(args.get("--source-manifest")) !== Boolean(args.get("--frozen-jsonl")), "exactly_one_manifest_format_required");
  const dbPath = isolatedPath(args.get("--db")), manifestPath = isolatedPath(args.get("--source-manifest") ?? args.get("--frozen-jsonl"));
  const output = isolatedPath(args.get("--out"), true), reportPath = isolatedPath(args.get("--report"), true);
  requireQuality(output !== reportPath, "distinct_output_paths_required");
  const db = openReadOnly(dbPath), startedAt = new Date().toISOString();
  let fixture: ReturnType<typeof generateFixture>;
  try {
    db.exec("BEGIN");
    let selected: Source[];
    if (args.has("--frozen-jsonl")) {
      requireQuality(fs.statSync(manifestPath).size <= 128 * 1024 * 1024, "input_too_large");
      const rows = fs.readFileSync(manifestPath, "utf8").trim().split(/\r?\n/).map(line => record(JSON.parse(line)));
      const originals = loadSources(db, rows.map(row => text(row.bulkSourceId)));
      selected = projectFrozenJsonl(originals, rows);
      const byOriginal = new Map(originals.map(source => [source.id, source]));
      for (const row of rows) {
        const source = byOriginal.get(text(row.bulkSourceId))!;
        requireQuality(sha(normalizeProductMarkup(source.body)) === row.normalizedSha256, "projection_normalized_hash_mismatch");
        requireQuality(source.title === row.title && source.parserVersion === row.sourceParserVersion && source.sourceFormat === row.sourceFormat, "projection_source_parser_or_title_mismatch");
      }
    } else selected = selectFrozenSources(loadSources(db), readJson(manifestPath));
    fixture = generateFixture(selected, Number(args.get("--max-per-category") ?? 8));
    db.exec("COMMIT");
  } finally { db.close(); }
  const privateFixture = savePrivate(output, fixture);
  const report = { schemaVersion: 1, status: "fixture_generated_retrieval_not_run", startedAt, completedAt: new Date().toISOString(),
    inputManifestSha256: sha(fs.readFileSync(manifestPath, "utf8")), privateFixture,
    identityMode: args.has("--frozen-jsonl") ? "planned_target_ids_projected_from_verified_bulk_sources_not_indexing_evidence" : "existing_local_source_ids", sourceFingerprint: fixture.sourceFingerprint,
    sampling: fixture.sampling, coverage: fixture.coverage,
    cases: fixture.cases.map(({ query: _query, ...item }) => item), humanReview: fixture.humanReview,
    modelCalls: 0, retrievalCalls: 0, credentialReads: 0 };
  const saved = savePrivate(reportPath, report);
  process.stdout.write(JSON.stringify({ status: report.status, report: saved, coverage: fixture.coverage, modelCalls: 0 }) + "\n");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try { main(); } catch (error) { safeFailure(error); }
}
