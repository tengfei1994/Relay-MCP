# Knowledge retrieval quality and performance baseline

The versioned golden set is [`tests/fixtures/knowledge-golden-set.v1.json`](../tests/fixtures/knowledge-golden-set.v1.json). It is source-controlled and every entry identifies its Project scope, user, optional SampleManager scope, relevant document identities, and identities that must never appear.

The seed is intentionally small. Before a production release, add reviewed, evidence-backed SampleManager incidents for each target solution and version. Do not replace entries merely to make a failing score pass: add a new version, record the reason in the pull request, and retain the old file for comparison.

The CI regression test exercises English, Chinese, object/path and version queries. It fails if a version-mismatched, cross-Project/ACL, or deprecated document enters results. It also applies Recall@10, MRR, nDCG@10 and forbidden-result gates. The metric implementation is provider-independent: reranking or embedding changes can be measured against exactly the same identities.

## Reproducible FTS5 benchmark

Run the full hot-cache 100,000-chunk baseline locally or in CI:

```powershell
npm run benchmark:knowledge-fts
```

It reports JSON with CPU/OS/Node memory data, chunk count, FTS5 index, cache state, query types, samples, P50/P95/max and the threshold. It covers English, Chinese, SampleManager object name, Windows path and version terms. It first warms each query and then measures FTS-only lookup; embedding and reranking latency are deliberately excluded and should be captured independently by provider tracing.

The default release gate is hot-cache P95 `< 200ms`; a violation exits non-zero. CI can tune only the explicit environment variables below, so an altered workload remains visible in workflow history:

```text
KNOWLEDGE_BENCHMARK_DOCUMENTS=100000
KNOWLEDGE_BENCHMARK_REPETITIONS=20
KNOWLEDGE_BENCHMARK_MAX_P95_MS=200
KNOWLEDGE_BENCHMARK_REPORT=path/to/report.json
```

The benchmark creates a temporary isolated Knowledge DB and deletes it after the report; it never accesses production Relay or SampleManager data.

## Context Pack, Candidate and Evidence request benchmark

Run `node --import tsx/esm scripts/knowledge-request-benchmark.ts` for the isolated full-route benchmark. It measures `POST /api/knowledge/weknora/search` including Context Pack assembly, `GET /api/knowledge/candidate-insights`, and `GET /api/knowledge/evidence`, with default/max limits, deep offsets and empty results. The report contains data sizes, concurrency, separate cold/hot samples and P50/P95/max. Cold means before scenario warm-up; process, OS and SQLite caches are not purged.

The Product provider is deterministic WeKnora HTTP replay. Fastify `inject` excludes real socket transport, and replay excludes actual model latency. Candidate and Evidence routes use only new temporary SQLite databases. The benchmark blocks unexpected network requests and makes no paid calls. It is not a substitute for a separately required real-provider measurement.

Use `KNOWLEDGE_REQUEST_BENCHMARK_SAMPLES`, `CONCURRENCY`, `PRODUCT_DOCUMENTS`, `CANDIDATE_INSIGHTS`, `EVIDENCE`, `COLD_REPETITIONS`, `HOT_REPETITIONS`, and optionally `KNOWLEDGE_REQUEST_BENCHMARK_OUTPUT` (full variable names carry the `KNOWLEDGE_REQUEST_BENCHMARK_` prefix). No pass/fail threshold is inferred. Project-specific targets must be agreed independently; the FTS and frozen-search thresholds do not apply to these endpoints.

## Release evidence

Attach the JSON benchmark report and golden-set evaluation output to the release/PR. Compare the golden-set version, metrics and forbidden-return count with the previous accepted baseline. A quality reduction, a nonzero forbidden return, or P95 threshold breach blocks release until explicitly investigated and documented.


## Source boundaries repaired on 2026-10-26

Product search now counts distinct documents within the engine's bounded 200-candidate response. Ordinary Knowledge retrieval keeps chunk-level limits. This avoids using a source-result slot repeatedly for one document; it does not promise exhaustive recall beyond the candidate pool.

The pinned engine keeps identical or overlapping passages from different source documents separately citable. Same-source deduplication remains enabled. Keyword cutoff ties and fusion ties use stable chunk identity; vector-neighbor membership at an exact TopK distance tie is unchanged.

Keep occurrence-based source metrics separate from semantic relevance. The frozen 55-case fixture and its labels remain unchanged. Before the follow-up HTTP run, the owner confirmed automatic gates of zero integrity failures and zero zero-recall cases, Recall@10 ≥ 0.908413, MRR ≥ 0.794394, nDCG@10 ≥ 0.794067, XML Recall@10 ≥ 0.781250, and search HTTP P95 ≤ 7,500 ms. Semantic Precision@10 requires actual human review of all 550 returned pairs and ≥ 0.90; every factual Wiki paragraph requires human `supported` adjudication. Context Pack latency and its threshold remain a separate release gate, so these search gates do not close the aggregate release issue. The existing hot-cache FTS P95 gate above is unchanged.

An automated Wiki review can have complete paragraph coverage and still find insufficient or contradicted claims. Source-support success is reported separately, requires at least one supported factual paragraph and no invalid/unresolved classification, and never constitutes expert factual approval or automatic publication. Deterministic exact-span revalidation is likewise distinct from independent model audit and human factual review.
