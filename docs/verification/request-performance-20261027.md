# Request performance checkpoint — 2026-10-27

This is a resumable measurement checkpoint, not a performance-gate pass. All requests used new temporary SQLite databases, Fastify `inject`, and deterministic WeKnora HTTP replay. No real model, external network, socket transport or paid call was used. No threshold is inferred.

## Large replay run before repair

Raw report: [`artifacts/knowledge-request-benchmark-20261027.json`](../../artifacts/knowledge-request-benchmark-20261027.json).

Workload: 50,000 Product mappings, 100,000 Candidate Insights and 100,000 Evidence records; 10 cold + 10 hot timed samples per scenario; concurrency four. Cold/hot describes scenario warm-up only, not purged process/OS/SQLite caches.

The initial report is retained with failures rather than replaced:

- Context Pack default and max-limit scenarios each had 20 timed HTTP 502 responses plus one warm-up failure. Their measured P50 values were about 21–22 seconds under concurrency four.
- Investigation found two separate issues. Relay `publishedRows` performed two legacy-metadata queries per Product row, twice per search (about 200,000 SQLite queries at 50k). Independently, the new replay fixture assigned chunk IDs by response position, which became invalid when lexical document ordering differed beyond the 200-result engine window. The existing production chunk-integrity guard correctly rejected those replay rows. Thus the 502 report is not evidence of a production chunk defect.
- Candidate Insight and Evidence responses had no HTTP/integrity errors. Their overall default P50/P95/max were 966.643/1714.018/1714.084 ms and 946.190/1909.111/1909.203 ms. Deep-offset Candidate P50/P95/max was 2616.936/2855.583/2855.739 ms; deep-offset Evidence was 1582.177/1617.317/1617.319 ms. These measurements include the failed run's machine load and are retained as observations, not targets.

The Relay metadata lookup is now a bulk JOIN preserving the previous latest-publication precedence and DTO filters. The replay now derives chunk identity from the external document ID. A permanent regression exercises more than 200 Product documents through the real route and chunk-integrity guard.

## Post-repair 50k smoke

Raw report: [`artifacts/knowledge-request-benchmark-after-20261027.json`](../../artifacts/knowledge-request-benchmark-after-20261027.json).

One cold sample, concurrency one, 50,000 Product mappings; all three search scenarios returned HTTP 200 with no status or integrity errors:

| Scenario | P50/P95/max (one sample, ms) |
| --- | ---: |
| Context Pack default | 2739.425 |
| Context Pack max limit 100 | 2783.217 |
| Empty result | 2555.745 |

This proves the repaired path completes at 50k; one sample does not establish a distribution or threshold pass. A post-repair concurrency-four cold/hot run, nonproduction deployment and real-provider measurement remain pending. Candidate/Evidence thresholds and Context Pack real-model thresholds still require project agreement.

## Reproduction

```bash
node --import tsx/esm --test tests/knowledge-request-benchmark.test.ts
```

The focused post-repair run covered Product backend, benchmark, source comparison/API/MCP and Topic review: **42/42 passed**. `npx tsc --noEmit` and `git diff --check` passed. The preceding complete application run was **883/883**; rerun the complete suite after this checkpoint's Product backend change before final delivery.
