import { cpus, freemem, platform, release, totalmem } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { createKnowledgeStore } from "../src/knowledge/store.ts";

const documentCount = boundedEnv("KNOWLEDGE_BENCHMARK_DOCUMENTS", 100_000, 1_000, 250_000);
const repetitions = boundedEnv("KNOWLEDGE_BENCHMARK_REPETITIONS", 20, 3, 200);
const maxP95Ms = boundedEnv("KNOWLEDGE_BENCHMARK_MAX_P95_MS", 200, 1, 60_000);
const root = mkdtempSync(join(tmpdir(), "relay-knowledge-fts-benchmark-"));
const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
const now = new Date().toISOString();

type BenchmarkQuery = { type: "english" | "chinese" | "object-name" | "path" | "version"; match: string };
const queries: BenchmarkQuery[] = [
  { type: "english", match: '"stale" OR "cache"' },
  { type: "chinese", match: '"仪器" OR "保存"' },
  { type: "object-name", match: '"SamplingHygieneStatus"' },
  { type: "path", match: '"FormsBin"' },
  { type: "version", match: '"21.1"' },
];

try {
  store.grantAcl("benchmark", 1);
  const insert = store.db.prepare(`INSERT INTO knowledge_documents
    (id,kind,title,body,lifecycle,project_id,source_locator,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const insertChunk = store.db.prepare(`INSERT INTO knowledge_chunks(id,document_id,ordinal,content,content_sha256) VALUES (?,?,?,?,?)`);
  const populate = store.db.transaction(() => {
    for (let index = 0; index < documentCount; index++) {
      const token = index % 5;
      const body = token === 0 ? `FormsBin stale cache incident ${index} version 21.1` : token === 1 ? `仪器 保存 静态必填 incident ${index} 版本 21.1` : token === 2 ? `SamplingHygieneStatus object validation incident ${index}` : token === 3 ? `C:\\ProgramData\\Thermo\\SampleManager\\FormsBin ${index}` : `SampleManager 21.1 deployment evidence ${index}`;
      const documentId = `chunk-${index}`;
      insert.run(documentId, "case", `Benchmark chunk ${index}`, body, "verified", "benchmark", `benchmark:${index}`, now, now);
      insertChunk.run(`${documentId}:chunk:0`, documentId, 0, body, createHash("sha256").update(body, "utf8").digest("hex"));
    }
  });
  populate();
  // The document insert trigger creates one compatibility row per document;
  // benchmark the chunk projection used by production reindex/search.
  store.db.prepare("DELETE FROM knowledge_fts").run();
  store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) SELECT c.document_id, d.title, c.content FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id").run();
  store.db.pragma("optimize");
  // Fill SQLite's page cache before measuring. The report makes this explicit:
  // it is a hot-cache FTS-only baseline, not an end-to-end provider benchmark.
  const find = store.db.prepare(`SELECT d.id FROM knowledge_fts JOIN knowledge_documents d ON d.id = knowledge_fts.document_id WHERE knowledge_fts MATCH @match AND d.project_id = 'benchmark' AND d.lifecycle <> 'deprecated' LIMIT 20`);
  for (const query of queries) find.all({ match: query.match });
  const measurements: Array<{ type: BenchmarkQuery["type"]; ms: number }> = [];
  for (const query of queries) for (let round = 0; round < repetitions; round++) {
    const started = performance.now();
    const rows = find.all({ match: query.match });
    const elapsed = performance.now() - started;
    if (!rows.length) throw new Error(`Benchmark query returned no rows: ${query.type}`);
    measurements.push({ type: query.type, ms: elapsed });
  }
  const latencyMs = measurements.map((measurement) => measurement.ms).sort((a, b) => a - b);
  const p95 = latencyMs[Math.min(latencyMs.length - 1, Math.ceil(latencyMs.length * 0.95) - 1)];
  const report = {
    format: "relay-knowledge-fts-benchmark/v1",
    recordedAt: new Date().toISOString(),
    hardware: { platform: platform(), release: release(), arch: process.arch, cpus: cpus().map((cpu) => cpu.model), cpuCount: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), node: process.version },
    data: { chunkCount: documentCount, index: "SQLite FTS5 knowledge_fts", cacheState: "hot: each query was executed once before timing", repetitionsPerQuery: repetitions },
    queryTypes: queries.map((query) => query.type),
    latencyMs: { p50: percentile(latencyMs, 0.5), p95, max: latencyMs.at(-1), samples: latencyMs.length },
    threshold: { maxP95Ms, passed: p95 < maxP95Ms },
  };
  const reportPath = process.env.KNOWLEDGE_BENCHMARK_REPORT;
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (p95 >= maxP95Ms) throw new Error(`Knowledge FTS hot-cache P95 ${p95.toFixed(2)}ms exceeds ${maxP95Ms}ms`);
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const candidate = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(candidate) ? Math.max(min, Math.min(max, candidate)) : fallback;
}

function percentile(values: number[], quantile: number): number {
  return values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)];
}
