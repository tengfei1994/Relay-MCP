import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import type { KnowledgeStore } from "../src/knowledge/store.js";
import type { KnowledgeRepository } from "../src/knowledge/repository.js";

const PROJECT_ID = "1";
const ACTOR_ID = 7;
const PROVIDER_ORIGIN = "https://weknora.benchmark.invalid";
const MATCH_QUERY = "benchmark cache";
const NO_MATCH_QUERY = "syntheticunmatchedtoken";

export interface BenchmarkConfig {
  samples: number;
  concurrency: number;
  productDocuments: number;
  candidateInsights: number;
  evidence: number;
  coldRepetitions: number;
  hotRepetitions: number;
}

interface RequestSpec {
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, unknown>;
}

interface Scenario {
  name: string;
  endpoint: "weknoraSearch" | "candidateInsights" | "evidence";
  request: RequestSpec;
  limit: number;
  offset?: number;
  expectation: "results" | "noResults";
  validate: (body: unknown, config: BenchmarkConfig, scenario: Scenario) => string[];
}

interface Measurement {
  samples: number;
  concurrency: number;
  cache: Record<string, unknown>;
  provider: Record<string, unknown>;
  latencyMs: { p50: number; p95: number; max: number };
  phaseLatencyMs: Record<"cold" | "hot", { samples: number; p50: number; p95: number; max: number } | null>;
  integrityErrors: Record<string, number>;
}

const cacheDescription = "cold means before this scenario's warm-up; hot means after warm-up. Process, OS, and SQLite caches are not purged.";

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BenchmarkConfig {
  const config = {
    samples: boundedEnv(env, "KNOWLEDGE_REQUEST_BENCHMARK_SAMPLES", 20, 1, 1_000),
    concurrency: boundedEnv(env, "KNOWLEDGE_REQUEST_BENCHMARK_CONCURRENCY", 4, 1, 64),
    productDocuments: boundedEnv(env, "KNOWLEDGE_REQUEST_BENCHMARK_PRODUCT_DOCUMENTS", 250, 1, 50_000),
    candidateInsights: boundedEnv(env, "KNOWLEDGE_REQUEST_BENCHMARK_CANDIDATE_INSIGHTS", 500, 1, 100_000),
    evidence: boundedEnv(env, "KNOWLEDGE_REQUEST_BENCHMARK_EVIDENCE", 1_000, 1, 100_000),
    coldRepetitions: boundedEnv(env, "KNOWLEDGE_REQUEST_BENCHMARK_COLD_REPETITIONS", 1, 0, 100),
    hotRepetitions: boundedEnv(env, "KNOWLEDGE_REQUEST_BENCHMARK_HOT_REPETITIONS", 2, 0, 100),
  };
  if (config.coldRepetitions + config.hotRepetitions === 0) throw new Error("At least one cold or hot repetition is required");
  return config;
}

function boundedEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

/** Nearest-rank percentile; the caller's samples are not mutated. */
export function percentile(values: readonly number[], quantile: number): number {
  if (!values.length) throw new Error("Percentile requires at least one sample");
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) throw new Error("Percentile quantile must be between 0 and 1");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

export async function runKnowledgeRequestBenchmark(config: BenchmarkConfig = configFromEnv()): Promise<Record<string, unknown>> {
  if (config.coldRepetitions + config.hotRepetitions === 0) throw new Error("At least one cold or hot repetition is required");
  const root = mkdtempSync(join(tmpdir(), "knowledge-request-benchmark-"));
  const previousFetch = globalThis.fetch;
  const environmentKeys = ["DB_PATH", "KNOWLEDGE_DB_PATH", "RELAY_STATE_ROOT", "KNOWLEDGE_EVIDENCE_ROOT", "WEKNORA_BASE_URL", "WEKNORA_KNOWLEDGE_BASE_ID", "WEKNORA_API_TOKEN"] as const;
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  let replayCalls = 0;
  let app: FastifyInstance | undefined;
  let store: KnowledgeStore | undefined;
  let appDb: Database.Database | undefined;

  // Every provider request is intercepted. The invalid DNS name is never resolved,
  // no model is invoked, and no paid provider call can occur in this benchmark.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== `${PROVIDER_ORIGIN}/api/v1/knowledge-search` || init?.method !== "POST") throw new Error("Unexpected network request blocked by benchmark replay");
    const request = JSON.parse(String(init.body ?? "{}")) as { query?: string; knowledge_ids?: string[]; match_count?: number };
    replayCalls += 1;
    const ids = Array.isArray(request.knowledge_ids) ? request.knowledge_ids : [];
    const count = Math.max(0, Math.min(Number(request.match_count ?? 10), ids.length));
    const rows = request.query === NO_MATCH_QUERY ? [] : ids.slice(0, count).map((id, index) => ({
      id: id.replace("benchmark-external-", "benchmark-chunk-"),
      knowledge_id: id,
      knowledge_title: `Synthetic product document ${index}`,
      content: `Synthetic benchmark retrieval excerpt ${index}`,
      score: 1 - index / Math.max(1, ids.length + 1),
      metadata: { sourcePath: `synthetic/document-${index}.md`, productVersion: "benchmark", language: "en" },
    }));
    return new Response(JSON.stringify({ success: true, data: rows }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "deterministic-http-replay" },
    });
  }) as typeof fetch;

  try {
    process.env.DB_PATH = join(root, "app.db");
    process.env.KNOWLEDGE_DB_PATH = join(root, "knowledge.db");
    process.env.RELAY_STATE_ROOT = root;
    process.env.KNOWLEDGE_EVIDENCE_ROOT = join(root, "evidence");
    process.env.WEKNORA_BASE_URL = PROVIDER_ORIGIN;
    process.env.WEKNORA_KNOWLEDGE_BASE_ID = "benchmark-knowledge-base";
    process.env.WEKNORA_API_TOKEN = "";

    // Intentional dynamic imports: DB modules capture paths at module initialization,
    // so static imports would open the caller's database before temporary isolation.
    const { default: Fastify } = await import("fastify");
    const { db, runMigrations } = await import("../src/server/db/index.js");
    const { knowledgeRoutes } = await import("../src/server/routes/knowledge.js");
    const { getKnowledgeStore } = await import("../src/server/knowledge-context.js");
    const { KnowledgeRepository } = await import("../src/knowledge/repository.js");

    runMigrations();
    appDb = db.session.client;
    appDb.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES (?,?,?,0)").run(ACTOR_ID, "benchmark-user", "unused");
    appDb.prepare("INSERT INTO projects(id,user_id,name,description,workspace_path) VALUES (?,?,?,?,?)").run(Number(PROJECT_ID), ACTOR_ID, "Benchmark", "Synthetic isolated benchmark", root);
    store = getKnowledgeStore();
    store.grantAcl(PROJECT_ID, ACTOR_ID);
    seedData(store, new KnowledgeRepository(store), config);

    app = Fastify({ logger: false });
    app.decorate("authenticate", async (request: FastifyRequest) => { Object.assign(request, { user: { id: ACTOR_ID, isAdmin: false } }); });
    await app.register(knowledgeRoutes);
    await app.ready();

    const scenarios = createScenarios().map((scenario) => materializeScenarioOffsets(scenario, config));
    const results = new Map<string, Measurement>();
    for (const scenario of scenarios) {
      results.set(`${scenario.endpoint}.${scenario.name}`, await measureScenario(app, scenario, config, () => replayCalls));
    }

    const endpoint = (name: Scenario["endpoint"], method: string, path: string) => {
      const selected = scenarios.filter((scenario) => scenario.endpoint === name);
      const main = selected[0];
      const boundaryNames = selected.slice(1);
      return {
        method,
        path,
        ...results.get(`${main.endpoint}.${main.name}`)!,
        defaultLimit: main.limit,
        boundaries: Object.fromEntries(boundaryNames.map((scenario) => [scenario.name, {
          limit: scenario.limit,
          ...(scenario.offset === undefined ? {} : { offset: scenario.offset }),
          expectation: scenario.expectation,
          ...results.get(`${scenario.endpoint}.${scenario.name}`)!,
        }])),
      };
    };

    return {
      format: "knowledge-request-benchmark/v1",
      recordedAt: new Date().toISOString(),
      isolation: { database: "new temporary SQLite app and knowledge databases", transport: "Fastify inject through registered production routes", productionData: false },
      provider: { kind: "deterministic-weknora-http-replay", actualModel: false, paidCalls: 0, externalNetwork: false, replayCalls },
      measurementSemantics: { timing: "wall time around each Fastify inject request; response validation excluded", cache: cacheDescription },
      data: {
        productDocuments: config.productDocuments,
        candidateInsights: config.candidateInsights,
        evidence: config.evidence,
        confirmedKnowledge: 1,
        candidates: 1,
        currentFacts: 1,
      },
      endpoints: {
        weknoraSearch: endpoint("weknoraSearch", "POST", "/api/knowledge/weknora/search"),
        candidateInsights: endpoint("candidateInsights", "GET", "/api/knowledge/candidate-insights"),
        evidence: endpoint("evidence", "GET", "/api/knowledge/evidence"),
      },
    };
  } finally {
    if (app) await app.close();
    if (store) store.close();
    if (appDb) appDb.close();
    globalThis.fetch = previousFetch;
    for (const key of environmentKeys) {
      const value = previousEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

function seedData(store: KnowledgeStore, repository: KnowledgeRepository, config: BenchmarkConfig): void {
  const now = "2026-01-01T00:00:00.000Z";
  store.upsertDocument({ id: "benchmark-case", kind: "case", title: "Synthetic confirmed benchmark cache", body: `${MATCH_QUERY} confirmed synthetic memory`, lifecycle: "approved", projectId: PROJECT_ID, locator: "synthetic:case", createdAt: now, updatedAt: now });
  store.upsertDocument({ id: "benchmark-candidate", kind: "candidate", title: "Synthetic candidate benchmark cache", body: `${MATCH_QUERY} candidate synthetic memory`, lifecycle: "draft", projectId: PROJECT_ID, locator: "synthetic:candidate", createdAt: now, updatedAt: now });
  repository.saveFact({ id: "benchmark-fact", userId: ACTOR_ID, projectId: PROJECT_ID, projectNameSnapshot: "Benchmark", text: `${MATCH_QUERY} current synthetic fact`, tags: ["benchmark"], locator: "synthetic:fact", status: "resolved", createdAt: now });

  const insertProduct = store.db.prepare(`INSERT INTO knowledge_weknora_documents
    (id,external_document_id,external_knowledge_base_id,external_chunk_ids_json,title,normalized_content_sha256,parser_version,project_id,status,upstream_parse_status,upstream_verified_at,idempotency_key,created_at,updated_at,published_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertInsight = store.db.prepare(`INSERT INTO knowledge_candidate_insights
    (id,work_session_id,project_id,kind,statement,why_proposed,evidence_refs_json,generated_by,input_hash,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertEvidence = store.db.prepare(`INSERT INTO knowledge_evidence
    (id,sha256,storage_path,mime_type,size_bytes,source_kind,project_id,source_locator,retention,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insertEvidenceAcl = store.db.prepare("INSERT INTO knowledge_evidence_acl(evidence_id,project_id,created_at) VALUES (?,?,?)");
  const insertMemory = store.db.prepare(`INSERT INTO knowledge_confirmed_memories
    (id,memory_type,title,statement,details_json,project_id,environment,scope_json,evidence_refs_json,source_json,confirmed_by,confirmed_at,audit_json,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertEntityEvidence = store.db.prepare("INSERT INTO knowledge_entity_evidence(entity_type,entity_id,evidence_id,created_at) VALUES ('confirmed_memory',?,?,?)");
  store.db.prepare(`INSERT INTO knowledge_work_sessions
    (id,actor_id,project_id,status,intent_json,idempotency_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run("benchmark-session", ACTOR_ID, PROJECT_ID, "open", JSON.stringify({ objective: "Synthetic benchmark", projectId: PROJECT_ID }), "benchmark-session", now, now);

  store.db.transaction(() => {
    for (let index = 0; index < config.productDocuments; index++) {
      const suffix = index.toString(16).padStart(64, "0");
      insertProduct.run(`benchmark-product-${index}`, `benchmark-external-${index}`, "benchmark-knowledge-base", JSON.stringify([`benchmark-chunk-${index}`]), `Synthetic product ${index}`, suffix, "benchmark-fixture", PROJECT_ID, "published", "completed", now, `benchmark-product-${index}`, now, now, now);
    }
    for (let index = 0; index < config.candidateInsights; index++) {
      const timestamp = new Date(Date.parse(now) + index * 1_000).toISOString();
      const statuses = ["draft", "accepted", "edited", "rejected"];
      insertInsight.run(`benchmark-insight-${index}`, "benchmark-session", PROJECT_ID, "fact", `Synthetic insight ${index}`, "Deterministic benchmark fixture", "[]", "benchmark-fixture", `benchmark-hash-${index}`, statuses[index % statuses.length], timestamp, timestamp);
    }
    for (let index = 0; index < config.evidence; index++) {
      const timestamp = new Date(Date.parse(now) + index * 1_000).toISOString();
      insertEvidence.run(`benchmark-evidence-${index}`, index.toString(16).padStart(64, "0"), `synthetic-storage-${index}`, "text/plain", 32, "log", PROJECT_ID, `synthetic:evidence:${index}`, "standard", timestamp);
      insertEvidenceAcl.run(`benchmark-evidence-${index}`, PROJECT_ID, timestamp);
    }
    insertMemory.run("benchmark-case", "Case", "Synthetic confirmed benchmark cache", `${MATCH_QUERY} confirmed synthetic memory`, JSON.stringify({ symptoms: MATCH_QUERY, rootCause: "benchmark fixture", resolution: "reviewed", verification: "confirmed" }), PROJECT_ID, "nonprod", JSON.stringify({ projectId: PROJECT_ID, environment: "nonprod", scopeType: "environment", scopeKey: "nonprod", visibility: "project" }), JSON.stringify(["benchmark-evidence-0"]), JSON.stringify({ kind: "manual", locator: "synthetic:case" }), ACTOR_ID, now, JSON.stringify({ action: "manual", reason: "benchmark fixture" }), "confirmed", now, now);
    insertEntityEvidence.run("benchmark-case", "benchmark-evidence-0", now);
  })();
  store.db.pragma("optimize");
}

function createScenarios(): Scenario[] {
  const search = (name: string, limit: number, query: string, expectation: Scenario["expectation"] = "results"): Scenario => ({
    name, endpoint: "weknoraSearch", limit, expectation,
    request: { method: "POST", url: "/api/knowledge/weknora/search", payload: { query, projectId: PROJECT_ID, limit } },
    validate: validateSearch,
  });
  const insights = (name: string, limit: number, offset?: number, expectation: Scenario["expectation"] = "results"): Scenario => ({
    name, endpoint: "candidateInsights", limit, offset, expectation,
    request: { method: "GET", url: `/api/knowledge/candidate-insights?projectId=${PROJECT_ID}&limit=${limit}${offset === undefined ? "" : `&offset=${offset}`}` },
    validate: validateInsights,
  });
  const evidence = (name: string, limit: number, offset?: number, expectation: Scenario["expectation"] = "results"): Scenario => ({
    name, endpoint: "evidence", limit, offset, expectation,
    request: { method: "GET", url: `/api/knowledge/evidence?projectId=${PROJECT_ID}&limit=${limit}${offset === undefined ? "" : `&offset=${offset}`}` },
    validate: validateEvidence,
  });
  return [
    search("default", 10, MATCH_QUERY),
    search("maximumLimit", 100, MATCH_QUERY),
    search("noResults", 10, NO_MATCH_QUERY, "noResults"),
    insights("default", 50),
    insights("maximumLimit", 200),
    insights("deepOffset", 50, -1),
    insights("noResults", 50, -2, "noResults"),
    evidence("default", 100),
    evidence("maximumLimit", 500),
    evidence("deepOffset", 100, -1),
    evidence("noResults", 100, -2, "noResults"),
  ];
}

function materializeScenarioOffsets(scenario: Scenario, config: BenchmarkConfig): Scenario {
  if (scenario.offset === -1) {
    const count = scenario.endpoint === "candidateInsights" ? config.candidateInsights : config.evidence;
    return { ...scenario, offset: Math.max(0, count - 1), request: { ...scenario.request, url: scenario.request.url.replace("offset=-1", `offset=${Math.max(0, count - 1)}`) } };
  }
  if (scenario.offset === -2) {
    const count = scenario.endpoint === "candidateInsights" ? config.candidateInsights : config.evidence;
    return { ...scenario, offset: count + 1_000, request: { ...scenario.request, url: scenario.request.url.replace("offset=-2", `offset=${count + 1_000}`) } };
  }
  return scenario;
}

function validateSearch(body: unknown, config: BenchmarkConfig, scenario: Scenario): string[] {
  const root = asRecord(body);
  const pack = asRecord(root?.contextPack);
  if (!pack) return ["missing_context_pack"];
  const errors: string[] = [];
  const counts = asRecord(pack.counts);
  const sectionNames = ["authoritativeDocs", "confirmedKnowledge", "candidates", "currentFacts"] as const;
  for (const section of sectionNames) {
    const value = pack[section];
    if (!Array.isArray(value)) errors.push(`missing_${section}`);
    else if (counts?.[section] !== value.length) errors.push(`count_mismatch_${section}`);
  }
  if (pack.provider !== "weknora") errors.push("wrong_context_pack_provider");
  if (!asRecord(pack.degraded) || !asRecord(pack.conflicts)) errors.push("incomplete_context_pack_metadata");
  if (!Array.isArray(root?.references) || typeof root?.retrievalRunId !== "string") errors.push("incomplete_search_response");
  const expectedDocuments = scenario.expectation === "noResults" ? 0 : Math.min(scenario.limit, config.productDocuments);
  if (!Array.isArray(pack.authoritativeDocs) || pack.authoritativeDocs.length !== expectedDocuments) errors.push("unexpected_authoritative_count");
  if (scenario.expectation === "noResults") {
    for (const section of sectionNames) if (!Array.isArray(pack[section]) || pack[section].length !== 0) errors.push(`unexpected_no_results_${section}`);
  } else {
    for (const section of ["confirmedKnowledge", "candidates", "currentFacts"]) if (!Array.isArray(pack[section]) || pack[section].length === 0) errors.push(`empty_${section}`);
  }
  return [...new Set(errors)];
}

function validateInsights(body: unknown, config: BenchmarkConfig, scenario: Scenario): string[] {
  const insights = asRecord(body)?.insights;
  if (!Array.isArray(insights)) return ["missing_insights"];
  const expected = scenario.expectation === "noResults" ? 0 : Math.max(0, Math.min(scenario.limit, config.candidateInsights - (scenario.offset ?? 0)));
  const errors = insights.length === expected ? [] : ["unexpected_insight_count"];
  if (insights.some((item) => {
    const insight = asRecord(item);
    return !insight || typeof insight.id !== "string" || insight.projectId !== PROJECT_ID || typeof insight.workSessionId !== "string" || typeof insight.statement !== "string";
  })) errors.push("incomplete_insight");
  return errors;
}

function validateEvidence(body: unknown, config: BenchmarkConfig, scenario: Scenario): string[] {
  const root = asRecord(body);
  const evidence = root?.evidence;
  const page = asRecord(root?.page);
  if (!Array.isArray(evidence) || !page) return ["missing_evidence_page"];
  const offset = scenario.offset ?? 0;
  const expected = scenario.expectation === "noResults" ? 0 : Math.max(0, Math.min(scenario.limit, config.evidence - offset));
  const errors: string[] = [];
  if (evidence.length !== expected) errors.push("unexpected_evidence_count");
  if (page.limit !== scenario.limit || page.offset !== offset || page.total !== config.evidence) errors.push("incorrect_evidence_page");
  if (evidence.some((item) => {
    const row = asRecord(item);
    return !row || typeof row.id !== "string" || row.projectId !== PROJECT_ID || "storagePath" in row;
  })) errors.push("incomplete_or_unsafe_evidence");
  return errors;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function measureScenario(app: FastifyInstance, rawScenario: Scenario, config: BenchmarkConfig, replayCalls: () => number): Promise<Measurement> {
  const scenario = materializeScenarioOffsets(rawScenario, config);
  const startedProviderCalls = replayCalls();
  const durations: number[] = [];
  const phaseDurations = { cold: [] as number[], hot: [] as number[] };
  const statusErrors: Record<string, number> = {};
  const integrityErrors: Record<string, number> = {};
  const execute = async (timed: boolean, phase?: keyof typeof phaseDurations) => {
    const started = performance.now();
    try {
      const response = await app.inject({ method: scenario.request.method, url: scenario.request.url, payload: scenario.request.payload });
      const elapsed = performance.now() - started;
      if (timed && phase) { durations.push(elapsed); phaseDurations[phase].push(elapsed); }
      if (response.statusCode !== 200) increment(statusErrors, String(response.statusCode));
      try {
        const body = response.json();
        if (process.env.KNOWLEDGE_REQUEST_BENCHMARK_DEBUG_ERRORS === "1" && response.statusCode !== 200) console.error(JSON.stringify(body));
        if (response.statusCode !== 200) {
          const code = asRecord(body)?.code;
          if (typeof code === "string" && /^[a-z_]+$/.test(code)) increment(statusErrors, `${response.statusCode}:${code}`);
          const message = asRecord(body)?.error;
          const classified = typeof message === "string" ? message.match(/\((timeout|invalid_response|unavailable|rate_limited|unauthorized|conflict|parse_failed)\)/) : null;
          if (classified) increment(statusErrors, `${response.statusCode}:${classified[1]}`);
        }
        for (const error of scenario.validate(body, config, scenario)) increment(integrityErrors, error);
      } catch {
        increment(integrityErrors, "invalid_json_or_validation_failure");
      }
    } catch {
      const elapsed = performance.now() - started;
      if (timed && phase) { durations.push(elapsed); phaseDurations[phase].push(elapsed); }
      increment(statusErrors, "inject_exception");
    }
  };
  const repetition = async (phase: keyof typeof phaseDurations) => {
    let next = 0;
    const workers = Array.from({ length: Math.min(config.concurrency, config.samples) }, async () => {
      while (next < config.samples) {
        next += 1;
        await execute(true, phase);
      }
    });
    await Promise.all(workers);
  };

  for (let round = 0; round < config.coldRepetitions; round++) await repetition("cold");
  let warmupRequests = 0;
  if (config.hotRepetitions > 0) {
    await execute(false);
    warmupRequests = 1;
    for (let round = 0; round < config.hotRepetitions; round++) await repetition("hot");
  }
  const calls = replayCalls() - startedProviderCalls;
  const distribution = (values: number[]) => values.length ? { samples: values.length, p50: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)), max: round(Math.max(...values)) } : null;
  return {
    samples: durations.length,
    concurrency: config.concurrency,
    cache: { coldRepetitions: config.coldRepetitions, hotRepetitions: config.hotRepetitions, samplesPerRepetition: config.samples, warmupRequests, description: cacheDescription },
    provider: scenario.endpoint === "weknoraSearch"
      ? { kind: "deterministic-weknora-http-replay", actualModel: false, paidCalls: 0, replayCalls: calls }
      : { kind: "none-sqlite-route-only", actualModel: false, paidCalls: 0, replayCalls: 0 },
    latencyMs: {
      p50: round(percentile(durations, 0.5)),
      p95: round(percentile(durations, 0.95)),
      max: round(Math.max(...durations)),
    },
    phaseLatencyMs: { cold: distribution(phaseDurations.cold), hot: distribution(phaseDurations.hot) },
    statusErrors,
    integrityErrors,
  };
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  runKnowledgeRequestBenchmark().then((report) => {
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (process.env.KNOWLEDGE_REQUEST_BENCHMARK_OUTPUT) writeFileSync(resolve(process.env.KNOWLEDGE_REQUEST_BENCHMARK_OUTPUT), json, { flag: "wx" });
    process.stdout.write(json);
  }).catch((error: unknown) => {
    process.stderr.write(`Knowledge request benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
