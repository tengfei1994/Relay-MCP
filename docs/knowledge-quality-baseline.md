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

## Release evidence

Attach the JSON benchmark report and golden-set evaluation output to the release/PR. Compare the golden-set version, metrics and forbidden-return count with the previous accepted baseline. A quality reduction, a nonzero forbidden return, or P95 threshold breach blocks release until explicitly investigated and documented.
