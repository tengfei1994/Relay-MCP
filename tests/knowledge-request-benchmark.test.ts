import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { configFromEnv, percentile } from "../scripts/knowledge-request-benchmark.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

interface Measurement {
  samples: number;
  statusErrors: Record<string, number>;
  integrityErrors: Record<string, number>;
  latencyMs: { p50: number; p95: number; max: number };
  phaseLatencyMs: Record<"cold" | "hot", { samples: number; p50: number; p95: number; max: number } | null>;
}

interface EndpointReport extends Measurement {
  boundaries: Record<string, Measurement & { limit: number; offset?: number; expectation: string }>;
}

interface SmokeReport {
  format: string;
  provider: { kind: string; actualModel: boolean; paidCalls: number; externalNetwork: boolean; replayCalls: number };
  data: { productDocuments: number; candidateInsights: number; evidence: number; confirmedKnowledge: number; candidates: number; currentFacts: number };
  endpoints: Record<"weknoraSearch" | "candidateInsights" | "evidence", EndpointReport>;
}

test("knowledge request benchmark uses nearest-rank percentiles without mutating samples", () => {
  const samples = [40, 10, 30, 20];
  assert.equal(percentile(samples, 0.5), 20);
  assert.equal(percentile(samples, 0.95), 40);
  assert.equal(percentile(samples, 0), 10);
  assert.equal(percentile(samples, 1), 40);
  assert.deepEqual(samples, [40, 10, 30, 20]);
  assert.throws(() => percentile([], 0.5), /at least one/);
  assert.throws(() => percentile([1], 1.1), /between 0 and 1/);
});

test("knowledge request benchmark environment controls are bounded and require a measured phase", () => {
  const config = configFromEnv({
    KNOWLEDGE_REQUEST_BENCHMARK_SAMPLES: "2",
    KNOWLEDGE_REQUEST_BENCHMARK_CONCURRENCY: "3",
    KNOWLEDGE_REQUEST_BENCHMARK_PRODUCT_DOCUMENTS: "4",
    KNOWLEDGE_REQUEST_BENCHMARK_CANDIDATE_INSIGHTS: "5",
    KNOWLEDGE_REQUEST_BENCHMARK_EVIDENCE: "6",
    KNOWLEDGE_REQUEST_BENCHMARK_COLD_REPETITIONS: "1",
    KNOWLEDGE_REQUEST_BENCHMARK_HOT_REPETITIONS: "2",
  });
  assert.deepEqual(config, { samples: 2, concurrency: 3, productDocuments: 4, candidateInsights: 5, evidence: 6, coldRepetitions: 1, hotRepetitions: 2 });
  assert.throws(() => configFromEnv({ KNOWLEDGE_REQUEST_BENCHMARK_COLD_REPETITIONS: "0", KNOWLEDGE_REQUEST_BENCHMARK_HOT_REPETITIONS: "0" }), /At least one/);
});

test("knowledge request benchmark smoke covers real HTTP routes, Context Pack, replay, and boundaries", { timeout: 120_000 }, async () => {
  const script = join(repositoryRoot, "scripts", "knowledge-request-benchmark.ts");
  const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx/esm", script], {
    cwd: repositoryRoot,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      KNOWLEDGE_REQUEST_BENCHMARK_SAMPLES: "1",
      KNOWLEDGE_REQUEST_BENCHMARK_CONCURRENCY: "2",
      KNOWLEDGE_REQUEST_BENCHMARK_PRODUCT_DOCUMENTS: "4",
      KNOWLEDGE_REQUEST_BENCHMARK_CANDIDATE_INSIGHTS: "5",
      KNOWLEDGE_REQUEST_BENCHMARK_EVIDENCE: "6",
      KNOWLEDGE_REQUEST_BENCHMARK_COLD_REPETITIONS: "1",
      KNOWLEDGE_REQUEST_BENCHMARK_HOT_REPETITIONS: "1",
    },
  });
  assert.equal(stderr, "");
  const report = JSON.parse(stdout) as SmokeReport;
  assert.equal(report.format, "knowledge-request-benchmark/v1");
  assert.deepEqual(report.data, { productDocuments: 4, candidateInsights: 5, evidence: 6, confirmedKnowledge: 1, candidates: 1, currentFacts: 1 });
  assert.deepEqual(report.provider, { kind: "deterministic-weknora-http-replay", actualModel: false, paidCalls: 0, externalNetwork: false, replayCalls: 9 });

  for (const endpoint of Object.values(report.endpoints)) {
    assert.equal(endpoint.samples, 2);
    assert.deepEqual(endpoint.statusErrors, {});
    assert.deepEqual(endpoint.integrityErrors, {});
    assert.ok(Number.isFinite(endpoint.latencyMs.p50));
    assert.ok(Number.isFinite(endpoint.latencyMs.p95));
    assert.ok(Number.isFinite(endpoint.latencyMs.max));
    for (const boundary of Object.values(endpoint.boundaries)) {
      assert.equal(boundary.samples, 2);
      assert.deepEqual(boundary.statusErrors, {});
      assert.deepEqual(boundary.integrityErrors, {});
    }
    assert.equal(endpoint.phaseLatencyMs.cold?.samples, 1);
    assert.equal(endpoint.phaseLatencyMs.hot?.samples, 1);
    for (const boundary of Object.values(endpoint.boundaries)) {
      assert.equal(boundary.phaseLatencyMs.cold?.samples, 1);
      assert.equal(boundary.phaseLatencyMs.hot?.samples, 1);
    }
  }
  assert.equal(report.endpoints.weknoraSearch.boundaries.maximumLimit.limit, 100);
  assert.equal(report.endpoints.weknoraSearch.boundaries.noResults.expectation, "noResults");

  assert.equal(report.endpoints.candidateInsights.boundaries.maximumLimit.limit, 200);
  assert.equal(report.endpoints.candidateInsights.boundaries.deepOffset.offset, 4);
  assert.equal(report.endpoints.candidateInsights.boundaries.noResults.offset, 1_005);
  assert.equal(report.endpoints.evidence.boundaries.maximumLimit.limit, 500);
  assert.equal(report.endpoints.evidence.boundaries.deepOffset.offset, 5);
  assert.equal(report.endpoints.evidence.boundaries.noResults.offset, 1_006);
});
test("knowledge request benchmark preserves chunk identity beyond the 200-result engine window", { timeout: 120_000 }, async () => {
  const script = join(repositoryRoot, "scripts", "knowledge-request-benchmark.ts");
  const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx/esm", script], {
    cwd: repositoryRoot, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, KNOWLEDGE_REQUEST_BENCHMARK_SAMPLES: "1", KNOWLEDGE_REQUEST_BENCHMARK_CONCURRENCY: "1", KNOWLEDGE_REQUEST_BENCHMARK_PRODUCT_DOCUMENTS: "250", KNOWLEDGE_REQUEST_BENCHMARK_CANDIDATE_INSIGHTS: "1", KNOWLEDGE_REQUEST_BENCHMARK_EVIDENCE: "1", KNOWLEDGE_REQUEST_BENCHMARK_COLD_REPETITIONS: "1", KNOWLEDGE_REQUEST_BENCHMARK_HOT_REPETITIONS: "0" },
  });
  assert.equal(stderr, "");
  const report = JSON.parse(stdout) as SmokeReport;
  for (const endpoint of [report.endpoints.weknoraSearch, report.endpoints.weknoraSearch.boundaries.maximumLimit]) {
    assert.deepEqual(endpoint.statusErrors, {});
    assert.deepEqual(endpoint.integrityErrors, {});
  }
});
