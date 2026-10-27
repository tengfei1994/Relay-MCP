/**
 * Source-occurrence evaluation. fts = CPU/read-only; plan = no HTTP/bearer-token reads.
 * http requires a separate explicit model-call gate and bounded request budget.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { GoldenCase } from "./knowledge-quality-manifest.js";
import { QualityError, type Row, type Source, argumentsFor, countBy, isolatedPath, loadSources, nullable, openReadOnly,
  projectFrozenJsonl, readJson, record, requireQuality, safeFailure, savePrivate, sha,
  sameOrGlobal, sourceFingerprint, text, NONPROD_ROOT } from "./knowledge-quality-common.js";
import {selectRetrievalBindings,retrievalReadiness,type Binding,type RetrievalScope} from './knowledge-quality-retrieval-scope.js';

type Mode = "fts" | "plan" | "http";
interface Hit { id: string; valid: boolean; flags: string[]; product: boolean; evidence?: Row; }
interface CaseResult {
  caseId: string; category: string; querySha256: string; status: string;
  latencyMs: number | null; metrics: { sourceRecallAt10: number; sourceMrr: number; sourceNdcgAt10: number };
  returnedCount: number; unjudgedCount: number; integrityFlags: string[]; hits: Hit[];
  retrievalRunId?: string; httpStatus?: number; errorCode?: string;
}
export function scoreSources(expected: string[], hits: Hit[]) {
  const unique = [...new Map(hits.map(hit => [hit.id, hit])).keys()];
  const first = unique.slice(0, 10).map(id => hits.find(hit => hit.id === id)!);
  const truth = new Set(expected), gains = first.map(hit => hit.valid && truth.has(hit.id) ? 1 : 0);
  const found = new Set(first.filter(hit => hit.valid && truth.has(hit.id)).map(hit => hit.id)).size;
  const reciprocalRank = gains.findIndex(value => value === 1);
  const dcg = gains.reduce<number>((sum, gain, index) => sum + gain / Math.log2(index + 2), 0);
  const ideal = Array.from({ length: Math.min(10, truth.size) }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0);
  return { sourceRecallAt10: truth.size ? found / truth.size : 0, sourceMrr: reciprocalRank < 0 ? 0 : 1 / (reciprocalRank + 1),
    sourceNdcgAt10: ideal ? dcg / ideal : 0 };
}
const zero = () => ({ sourceRecallAt10: 0, sourceMrr: 0, sourceNdcgAt10: 0 });
function summarize(cases: CaseResult[]) {
  const attempted = cases.filter(item => !["not_run", "not_ready"].includes(item.status));
  const metrics = (rows: CaseResult[]) => ({ cases: rows.length,
    sourceRecallAt10: rows.length ? rows.reduce((sum, row) => sum + row.metrics.sourceRecallAt10, 0) / rows.length : null,
    sourceMrr: rows.length ? rows.reduce((sum, row) => sum + row.metrics.sourceMrr, 0) / rows.length : null,
    sourceNdcgAt10: rows.length ? rows.reduce((sum, row) => sum + row.metrics.sourceNdcgAt10, 0) / rows.length : null });
  const times = attempted.map(item => item.latencyMs).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const completed = cases.filter(item => item.status === "completed"), flags = cases.flatMap(item => item.integrityFlags);
  return { plannedCases: cases.length, statuses: countBy(cases.map(item => item.status)), attempted: attempted.length,
    attemptedMeansIncludingFailedZero: metrics(attempted),
    byCategory: Object.fromEntries([...new Set(cases.map(item => item.category))].sort().map(category => [category, {
      statuses: countBy(cases.filter(item => item.category === category).map(item => item.status)),
      ...metrics(attempted.filter(item => item.category === category)),
    }])),
    latencyMs: { samples: times.length, p50: times.length ? times[Math.ceil(times.length * 0.5) - 1] : null,
      p95: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null, max: times.at(-1) ?? null },
    integrityFlags: countBy(flags), unjudgedReturnedSources: cases.reduce((sum, item) => sum + item.unjudgedCount, 0),
    zeroRecallCompletedCases: completed.filter(item => item.metrics.sourceRecallAt10 === 0).length,
    semanticPrecisionAt10: "not_evaluated", factualAccuracy: "not_evaluated" };
}
function validateFixture(value: unknown, sources: Source[]): { cases: GoldenCase[]; sourceFingerprint: string } {
  const fixture = record(value), fingerprint = sourceFingerprint(sources);
  requireQuality(fixture.kind === "source_occurrence_not_semantic_gold" && fixture.sourceFingerprint === fingerprint, "fixture_source_fingerprint_mismatch");
  requireQuality(Array.isArray(fixture.cases) && fixture.cases.length > 0 && fixture.cases.length <= 270, "invalid_case_count");
  const byId = new Map(sources.map(source => [source.id, source])), seen = new Set<string>();
  const cases = fixture.cases as GoldenCase[];
  for (const item of cases) {
    requireQuality(item.id && !seen.has(item.id) && typeof item.query === "string" && item.query.length <= 280 &&
      !/[\r\n\0]/.test(item.query) && sha(item.query) === item.querySha256 && item.expected.length > 0, "invalid_case");
    seen.add(item.id);
    for (const expected of item.expected) {
      const source = byId.get(expected.localDocumentId);
      requireQuality(source && source.bodySha256 === expected.bodySha256 && source.sourceSha256 === expected.sourceSha256 &&
        source.citationSha256 === expected.citationSha256 && sameOrGlobal(source, item.filters) &&
        (!item.filters.productVersion || source.version === item.filters.productVersion), "case_source_evidence_mismatch");
    }
  }
  return { cases, sourceFingerprint: fingerprint };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
export function validateProjectionMetadata(targetMetadata: unknown, originalMetadata: unknown, manifest: Row, manifestSha256: string): void {
  const metadata = { ...record(targetMetadata) }, acceptance = record(metadata.engineAcceptance);
  const expectedCorpus = manifest.environment === "nonprod-full-213" ? "full-213" : manifest.environment === "nonprod-full-213-v3" ? "full-213-v3" : undefined;
  requireQuality(expectedCorpus !== undefined && acceptance.corpus === expectedCorpus && acceptance.manifestSha256 === manifestSha256 &&
    acceptance.bulkSourceId === manifest.bulkSourceId && acceptance.bodySha256 === manifest.bodySha256 &&
    acceptance.normalizedSha256 === manifest.normalizedSha256 && Number.isInteger(acceptance.embeddingRequests) &&
    Number(acceptance.embeddingRequests) > 0, "seed_projection_provenance_mismatch");
  delete metadata.engineAcceptance;
  requireQuality(canonical(metadata) === canonical(originalMetadata), "seed_original_metadata_semantic_mismatch");
}
function seededSources(db: Database.Database, bulkPath: string, rows: Row[], manifestSha256: string): Source[] {
  const bulk = openReadOnly(bulkPath);
  try {
    const original = loadSources(bulk, rows.map(row => text(row.bulkSourceId)));
    // Checks the untouched original metadata/sections byte hashes against the frozen manifest.
    const projected = projectFrozenJsonl(original, rows);
    const byProjected = new Map(projected.map(source => [source.id, source]));
    const target = new Map(loadSources(db, rows.map(row => text(row.targetLocalId))).map(source => [source.id, source]));
    const originalMeta = bulk.prepare("SELECT metadata_json,sections_json FROM knowledge_product_documents WHERE id=?");
    const targetMeta = db.prepare("SELECT metadata_json,sections_json FROM knowledge_product_documents WHERE id=?");
    for (const row of rows) {
      const found = target.get(text(row.targetLocalId)), source = byProjected.get(text(row.targetLocalId));
      requireQuality(found && source, "full_corpus_targets_not_seeded");
      for (const key of ["bodySha256", "sourceSha256", "sourcePath", "version", "projectId", "environment", "solution", "module", "language", "parserVersion", "sourceFormat"] as const)
        requireQuality(found[key] === source[key], "seed_source_body_or_metadata_mismatch");
      const a = record(originalMeta.get(row.bulkSourceId)), b = record(targetMeta.get(row.targetLocalId));
      validateProjectionMetadata(JSON.parse(text(b.metadata_json)), JSON.parse(text(a.metadata_json)), row, manifestSha256);
      requireQuality(canonical(JSON.parse(text(a.sections_json))) === canonical(JSON.parse(text(b.sections_json))), "seed_sections_semantic_mismatch");
    }
    return projected;
  } finally { bulk.close(); }
}

function locatedAt(locator: unknown, sourcePath: string): boolean { const base = sourcePath.split("#")[0]; return text(locator) === base || text(locator).startsWith(base + "#"); }
export function inspectHttpHit(value: unknown, item: GoldenCase, sourceById: Map<string, Source>, proof: Map<string, Binding>): Hit {
  const row = record(value), id = text(row.id), product = row.kind === "product_document", flags: string[] = [];
  if (!product) return { id: id || "nonproduct:" + sha(JSON.stringify(row)), valid: false, flags: [], product: false };
  const source = sourceById.get(id), binding = proof.get(id);
  if (!source || !binding) return { id: id || "unknown", valid: false, flags: ["unknown_or_unverified_source"], product: true };
  if (row.provider !== "weknora") flags.push("silent_provider_fallback");
  if (row.status !== "published") flags.push("source_not_published");
  if (!sameOrGlobal(source, item.filters) || nullable(row.projectId) !== source.projectId || nullable(row.environment) !== source.environment) flags.push("scope_integrity_failure");
  if (nullable(row.version ?? row.sampleManagerVersion) !== source.version ||
      (item.filters.productVersion && source.version !== item.filters.productVersion)) flags.push("version_integrity_failure");
  if (row.sourceSha256 !== source.sourceSha256) flags.push("source_hash_mismatch");
  if (row.sourcePath !== source.sourcePath || (row.sourceLocator && !locatedAt(row.sourceLocator, source.sourcePath))) flags.push("source_path_mismatch");
  if (row.externalDocumentId !== binding.row.external_document_id) flags.push("external_identity_mismatch");
  const citations = Array.isArray(row.citations) ? row.citations : [];
  if (!citations.length) flags.push("citations_missing");
  const safeCitations = citations.map(value => {
    const citation = record(value), chunkId = text(citation.chunkId);
    if (citation.documentId !== id || citation.sourceSha256 !== source.sourceSha256 || citation.provider !== "weknora" ||
      !binding.chunks.has(chunkId)) flags.push("citation_identity_hash_or_chunk_invalid");
    if (citation.version !== source.version || !locatedAt(citation.sourceLocator, source.sourcePath)) flags.push("citation_version_or_path_invalid");
    return { documentId: text(citation.documentId), chunkId, sourceSha256: text(citation.sourceSha256),
      sourceLocatorSha256: sha(text(citation.sourceLocator)) };
  });
  return { id, valid: flags.length === 0, flags: [...new Set(flags)], product: true,
    evidence: { sourceSha256: source.sourceSha256, sourcePathSha256: sha(source.sourcePath), version: source.version,
      projectId: source.projectId, environment: source.environment, externalDocumentId: text(row.externalDocumentId),
      retrievalRunId: text(row.retrievalRunId), citations: safeCitations } };
}
function mainFts(db: Database.Database, item: GoldenCase, sources: Source[]): Hit[] {
  const eligible = sources.filter(source => sameOrGlobal(source, item.filters) && (!item.filters.productVersion || source.version === item.filters.productVersion));
  if (!eligible.length) return [];
  const sourceByOriginal = new Map(eligible.map(source => [source.sourceDbId ?? source.id, source]));
  const params: Record<string, string> = { match: item.query.trim().split(/\s+/).filter(Boolean).slice(0, 24)
    .map(value => '"' + value.replaceAll('"', '""') + '"').join(" OR ") };
  const ids = eligible.map((source, index) => { params["source" + index] = source.sourceDbId ?? source.id; return "@source" + index; });
  // OR-token FTS5 contrast baseline constrained to the frozen corpus. Rank
  // FTS rows first, then retain each document at its first rank. SQLite rejects
  // bm25 with GROUP BY; the legacy Product query silently used LIKE fallback.
  const matches = db.prepare("SELECT d.id,bm25(knowledge_fts) AS rank FROM knowledge_fts JOIN knowledge_documents d ON d.id=knowledge_fts.document_id JOIN knowledge_product_documents p ON p.id=d.id WHERE knowledge_fts MATCH @match AND d.kind='product_document' AND d.lifecycle<>'deprecated' AND d.id IN (" + ids.join(",") + ") ORDER BY rank,d.id,knowledge_fts.rowid").iterate(params) as IterableIterator<Row>;
  const rows: Row[] = [], seen = new Set<string>();
  for (const row of matches) { if (seen.has(text(row.id))) continue; seen.add(text(row.id)); rows.push(row); if (rows.length === 10) break; }
  return rows.map(row => { const source = sourceByOriginal.get(text(row.id))!; return { id: source.id, valid: true, flags: [], product: true,
    evidence: { sourceSha256: source.sourceSha256, citationSha256: source.citationSha256, version: source.version, sourcePathSha256: sha(source.sourcePath),
      citationGranularity: "local_document_no_engine_chunk_claim" } }; });
}
export function selfTest(): void {
  const hit = (id: string, valid = true): Hit => ({ id, valid, flags: [], product: true });
  assert.deepEqual(scoreSources(["a"], [hit("unjudged"), hit("a"), hit("a")]), {
    sourceRecallAt10: 1, sourceMrr: 0.5, sourceNdcgAt10: 1 / Math.log2(3) });
  assert.equal(scoreSources(["a", "b"], [hit("a"), hit("a"), hit("x")]).sourceRecallAt10, 0.5);
  assert.equal(scoreSources(["a"], [hit("a", false)]).sourceRecallAt10, 0);
  assert.equal(scoreSources(["a"], Array.from({ length: 10 }, (_, i) => hit("x" + i)).concat(hit("a"))).sourceRecallAt10, 0);
  const source = { id: "a", version: "21.3", projectId: "1", environment: "nonprod", sourceSha256: sha("raw"), sourcePath: "/source/a" } as Source;
  const proof = new Map([["a", { row: { external_document_id: "up-a" }, chunks: new Set(["c"]), localId: "a" }]]);
  const item = { filters: { projectId: "1", environment: "nonprod", productVersion: "21.3" } } as GoldenCase;
  const row = { id: "a", kind: "product_document", provider: "weknora", status: "published", projectId: "1", environment: "nonprod", version: "21.3",
    sourcePath: "/source/a", sourceLocator: "/source/a#char=0-2", sourceSha256: source.sourceSha256, externalDocumentId: "up-a",
    citations: [{ documentId: "a", chunkId: "c", provider: "weknora", version: "21.3", sourceLocator: "/source/a", sourceSha256: source.sourceSha256 }] };
  const inspect = (extra: Row) => inspectHttpHit({ ...row, ...extra }, item, new Map([["a", source]]), proof);
  assert(inspect({}).valid);
  assert(inspect({ environment: "production" }).flags.includes("scope_integrity_failure"));
  assert(inspect({ version: "21.1" }).flags.includes("version_integrity_failure"));
  assert(inspect({ provider: "relay_local" }).flags.includes("silent_provider_fallback"));
  assert(inspect({ citations: [{ ...row.citations[0], chunkId: "unverified" }] }).flags.includes("citation_identity_hash_or_chunk_invalid"));
  assert(inspect({ sourcePath: "/wrong" }).flags.includes("source_path_mismatch"));
  assert(inspect({ sourceLocator: "/source/a-foreign" }).flags.includes("source_path_mismatch"));
  const unjudgedSource = { ...source, id: "b", projectId: null, environment: null };
  const unjudgedProof = new Map([["b", { row: { external_document_id: "up-b" }, chunks: new Set(["cb"]), localId: "b" }]]);
  assert(inspectHttpHit({ ...row, id: "b", projectId: null, environment: null, externalDocumentId: "up-b", citations: [{ ...row.citations[0], documentId: "b", chunkId: "cb" }] }, item, new Map([["b", unjudgedSource]]), unjudgedProof).valid, "legitimate globally scoped source absent from expected labels is unjudged, not an integrity error");
  const projection = { environment: "nonprod-full-213", bulkSourceId: "original", bodySha256: sha("body"), normalizedSha256: sha("normalized") };
  const acceptance = { corpus: "full-213", manifestSha256: sha("manifest"), ...projection, embeddingRequests: 1 };
  validateProjectionMetadata({ b: 2, a: 1, engineAcceptance: acceptance }, { a: 1, b: 2 }, projection, sha("manifest"));
  const v3Projection = { ...projection, environment: "nonprod-full-213-v3" };
  const v3Acceptance = { ...acceptance, corpus: "full-213-v3" };
  validateProjectionMetadata({ a: 1, b: 2, engineAcceptance: v3Acceptance }, { a: 1, b: 2 }, v3Projection, sha("manifest"));
  assert.throws(() => validateProjectionMetadata({ a: 1, b: 2, engineAcceptance: acceptance }, { a: 1, b: 2 }, v3Projection, sha("manifest")), /seed_projection_provenance_mismatch/);
  assert.throws(() => validateProjectionMetadata({ a: 1, b: 2, engineAcceptance: v3Acceptance }, { a: 1, b: 2 }, projection, sha("manifest")), /seed_projection_provenance_mismatch/);
  for (const environment of [undefined, "production", "nonprod-arbitrary", "nonprod-full-213-v30"]) {
    assert.throws(() => validateProjectionMetadata({ a: 1, b: 2, engineAcceptance: v3Acceptance }, { a: 1, b: 2 }, { ...v3Projection, environment }, sha("manifest")), /seed_projection_provenance_mismatch/);
  }
  assert.throws(() => validateProjectionMetadata({ a: 999, b: 2, engineAcceptance: acceptance }, { a: 1, b: 2 }, projection, sha("manifest")), /seed_original_metadata_semantic_mismatch/);
  const testDb = new Database(":memory:");
  try {
    testDb.exec("CREATE TABLE knowledge_documents(id TEXT,kind TEXT,lifecycle TEXT); CREATE TABLE knowledge_product_documents(id TEXT); CREATE VIRTUAL TABLE knowledge_fts USING fts5(document_id UNINDEXED,title,body); INSERT INTO knowledge_documents VALUES ('a','product_document','approved'),('b','product_document','approved'); INSERT INTO knowledge_product_documents VALUES ('a'),('b'); INSERT INTO knowledge_fts VALUES('a','t','SHARED_WORD'),('a','t','SHARED_WORD'),('b','t','SHARED_WORD');");
    assert.throws(() => testDb.prepare("SELECT d.id,bm25(knowledge_fts) rank FROM knowledge_fts JOIN knowledge_documents d ON d.id=knowledge_fts.document_id WHERE knowledge_fts MATCH 'SHARED_WORD' GROUP BY d.id ORDER BY rank").all(), /unable to use function bm25/);
    assert.deepEqual(new Set(mainFts(testDb, { ...item, query: "SHARED_WORD" }, [source, { ...source, id: "b" }]).map(hit => hit.id)), new Set(["a", "b"]));
  } finally { testDb.close(); }
  process.stdout.write(JSON.stringify({ status: "passed", selfTest: "knowledge-quality-retrieval", modelCalls: 0 }) + "\n");
}
async function main(): Promise<void> {
  if (process.argv.slice(2).join(" ") === "--self-test") { selfTest(); return; }
  const args = argumentsFor(["--mode", "--db", "--frozen-jsonl", "--fixture", "--fixture-sha256", "--manifest-sha256", "--report",
    "--knowledge-base-id", "--source-db", "--endpoint", "--base-url", "--token-file", "--max-requests", "--resume",
    "--migration-id", "--operation-key", "--expected-provider-id", "--expected-provider-status", "--expected-model-id", "--expected-index-version", "--expected-dimensions", "--expected-engine-model-id", "--expected-model-alias", "--expected-parser-version", "--expected-case-count"]);
  const mode = args.get("--mode") as Mode;
  requireQuality(["fts", "plan", "http"].includes(mode), "mode_required");
  const dbPath = isolatedPath(args.get("--db")), manifestPath = isolatedPath(args.get("--frozen-jsonl")), fixturePath = isolatedPath(args.get("--fixture"));
  const output = isolatedPath(args.get("--report"), true), startedAt = new Date().toISOString();
  const manifestData = fs.readFileSync(manifestPath, "utf8"), fixtureData = fs.readFileSync(fixturePath, "utf8");
  requireQuality(sha(manifestData) === args.get("--manifest-sha256") && sha(fixtureData) === args.get("--fixture-sha256"), "pinned_input_hash_mismatch");
  const rows = manifestData.trim().split(/\r?\n/).map(line => record(JSON.parse(line)));
  const db = openReadOnly(dbPath);
  try {
    let sources: Source[];
    if (mode === "fts") sources = projectFrozenJsonl(loadSources(db, rows.map(row => text(row.bulkSourceId))), rows);
    else sources = seededSources(db, isolatedPath(args.get("--source-db") ?? NONPROD_ROOT + "/bulk/knowledge.db"), rows, sha(manifestData));
    const fixture = validateFixture(JSON.parse(fixtureData), sources);
    const expectedCases=Number(args.get('--expected-case-count')??fixture.cases.length);
    requireQuality(Number.isInteger(expectedCases)&&fixture.cases.length===expectedCases,'frozen_case_count_mismatch');
    const endpoint = args.get("--endpoint") ?? "product";
    requireQuality(["product", "knowledge"].includes(endpoint), "unsupported_endpoint");
    const normalized=new Map(rows.map(row=>[text(row.targetLocalId),text(row.normalizedSha256)]));
    let scope:RetrievalScope|undefined;
    if(mode!=='fts'){
      const required=(name:string)=>{const value=args.get(name);requireQuality(value&&value.trim()===value,'explicit_migration_and_model_scope_required');return value;};
      scope={migrationId:required('--migration-id'),operationKey:required('--operation-key'),knowledgeBaseId:required('--knowledge-base-id'),providerId:required('--expected-provider-id'),providerStatus:required('--expected-provider-status') as RetrievalScope['providerStatus'],modelId:required('--expected-model-id'),indexVersion:Number(required('--expected-index-version')),dimensions:Number(required('--expected-dimensions')),engineModelId:required('--expected-engine-model-id'),modelAlias:required('--expected-model-alias'),parserVersion:required('--expected-parser-version')};
      requireQuality(Number.isSafeInteger(scope.indexVersion)&&scope.indexVersion>0&&Number.isSafeInteger(scope.dimensions)&&scope.dimensions>0&&['ready','pending_reindex'].includes(scope.providerStatus),'invalid_expected_model_scope');
    }
    const currentReadiness=()=>retrievalReadiness(db,sources,scope!,normalized,record(readJson(isolatedPath(NONPROD_ROOT+'/runtime/knowledge-engine/control.json'))));
    const proof = mode === "fts" ? undefined : currentReadiness();
    const previous = args.get("--resume") ? record(readJson(isolatedPath(args.get("--resume")))) : undefined;
    if (previous) requireQuality(previous.fixtureSha256 === sha(fixtureData) && previous.manifestSha256 === sha(manifestData) &&
      previous.mode === mode && previous.endpoint === endpoint && previous.bindingFingerprint === proof?.fingerprint && canonical(previous.expectedScope??null)===canonical(scope??null), "resume_identity_mismatch");
    const oldCases = new Map((Array.isArray(previous?.cases) ? previous.cases as CaseResult[] : []).filter(item => item.status === "completed").map(item => [item.caseId, item]));
    const results: CaseResult[] = fixture.cases.map(item => oldCases.get(item.id) ?? ({
      caseId: item.id, category: item.category, querySha256: item.querySha256, status: "not_run", latencyMs: null,
      metrics: zero(), returnedCount: 0, unjudgedCount: 0, integrityFlags: [], hits: [],
    }));
    let requests = 0, stopped = false, token = "";
    const maxRequests = Number(args.get("--max-requests") ?? 0);
    if (mode === "http") {
      requireQuality(process.env.RELAY_QUALITY_ALLOW_MODEL_CALLS === "1", "explicit_model_execution_authorization_required");
      requireQuality(Number.isInteger(maxRequests) && maxRequests > 0 && maxRequests <= fixture.cases.length, "bounded_request_budget_required");
      requireQuality((args.get("--base-url") ?? "http://127.0.0.1:18300") === "http://127.0.0.1:18300", "only_isolated_loopback_relay_allowed");
      requireQuality(proof?.ready, "full_corpus_not_published_verified_consistently");
      token = fs.readFileSync(isolatedPath(args.get("--token-file")), "utf8").trim();
      requireQuality(token.length > 20 && !/\s/.test(token), "invalid_private_token_file");
    }
    const inspectionSources = mode === "fts" ? sources : loadSources(db);
    const sourceById = new Map(inspectionSources.map(source => [source.id, source]));
    for (let index = 0; index < fixture.cases.length; index++) {
      const item = fixture.cases[index], result = results[index];
      if (result.status === "completed") continue;
      if (mode === "plan") { result.status = proof!.ready ? "not_run" : "not_ready"; continue; }
      if (stopped || (mode === "http" && requests >= maxRequests)) continue;
      const begin = performance.now();
      try {
        if (mode === "fts") result.hits = mainFts(db, item, sources);
        else {
          const before=currentReadiness();requireQuality(before.ready&&before.fingerprint===proof!.fingerprint,'binding_changed_before_retrieval');
          const url = new URL(endpoint === "product" ? "/api/knowledge/product-documents/search" : "/api/knowledge/search", "http://127.0.0.1:18300");
          url.searchParams.set("q", item.query); url.searchParams.set("limit", "10");
          if (item.filters.projectId) url.searchParams.set("projectId", item.filters.projectId);
          if (item.filters.environment) url.searchParams.set("environment", item.filters.environment);
          if (item.filters.productVersion) url.searchParams.set("sampleManagerVersion", item.filters.productVersion);
          requests++;
          const response = await fetch(url, { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(180000), redirect: "error" });
          result.httpStatus = response.status;
          requireQuality(response.ok, "http_status_" + response.status);
          const body = record(await response.json());
          requireQuality(!record(body.degradedReasons ?? {}).productKnowledge && Array.isArray(body.results), "product_degraded_or_invalid_response");
          const refreshed = currentReadiness();
          requireQuality(refreshed.ready&&refreshed.fingerprint === proof!.fingerprint, "binding_changed_during_retrieval");
          const allCurrentProof = selectRetrievalBindings(db, inspectionSources, scope!, normalized,true);
          result.hits = (body.results as unknown[]).slice(0, 10).map(hit => inspectHttpHit(hit, item, sourceById, allCurrentProof.found));
          result.retrievalRunId = text(body.retrievalRunId) || text(result.hits[0]?.evidence?.retrievalRunId);
        }
        result.latencyMs = performance.now() - begin;
        result.returnedCount = result.hits.length;
        result.integrityFlags = [...new Set(result.hits.flatMap(hit => hit.flags))];
        const expected = item.expected.map(source => source.localDocumentId);
        result.metrics = scoreSources(expected, result.hits);
        result.unjudgedCount = new Set(result.hits.filter(hit => hit.product && !expected.includes(hit.id)).map(hit => hit.id)).size;
        result.status = result.integrityFlags.length ? "integrity_failure" : "completed";
        if (result.integrityFlags.length) stopped = true;
      } catch (error) {
        result.latencyMs = performance.now() - begin; result.status = "failed";
        result.errorCode = error instanceof QualityError ? error.code : "retrieval_failed_no_content_logged";
        result.metrics = zero(); stopped = true;
      }
      if ((index + 1) % 5 === 0 || index === fixture.cases.length - 1 || stopped) process.stdout.write(JSON.stringify({ stage: "quality_case", mode, completed: results.filter(row => row.status === "completed").length,
        attempted: results.filter(row => !["not_run", "not_ready"].includes(row.status)).length, planned: results.length, requests }) + "\n");
    }
    const report = { schemaVersion: 1, mode, endpoint, startedAt, completedAt: new Date().toISOString(),
      fixtureSha256: sha(fixtureData), manifestSha256: sha(manifestData), sourceFingerprint: fixture.sourceFingerprint,
      expectedScope:scope??null,bindingFingerprint: proof?.fingerprint, readiness: proof ? { ready:proof.ready,flags:proof.flags,corpusSources: sources.length, verifiedPublishedSources: proof.found.size,
        missingSources: proof.missing.length, modelIdentityVariants: proof.modelHashes.length, modelProvenanceHashes: proof.modelHashes } : null,
      latencyBoundary: mode === "fts" ? "native_fts_contrast_row_rank_then_document_dedup_not_legacy_like_fallback_cache_uncalibrated" : "relay_http_round_trip_including_engine_provider_queue",
      engineInternalLatencyMs: null, upstreamBillableCallCount: null,
      httpRequestsThisRun: requests, modelCallsThisRun: mode === "http" ? "not_attributable_from_http_counter" : 0,
      queryPersistenceBoundary: endpoint === "knowledge" ? "live_service_telemetry_requires_separate_privacy_acceptance" : "no_raw_query_in_this_report",
      aclCoverage: mode === "fts" ? "not_exercised_bulk_scope_projected" : "returned_scope_integrity_only_not_foreign_actor_denial_test",
      publishedMappingCoverageComplete: mode === "fts" ? false : proof?.ready===true,
      semanticPrecisionAt10: "not_evaluated", factualAccuracy: "not_evaluated", summary: summarize(results), cases: results };
    const saved = savePrivate(output, report);
    process.stdout.write(JSON.stringify({ status: "quality_report_written", report: saved, mode, summary: report.summary, httpRequestsThisRun: requests }) + "\n");
    if (results.some(result => ["failed", "integrity_failure"].includes(result.status))) process.exitCode = 1;
  } finally { db.close(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch(safeFailure);
}
