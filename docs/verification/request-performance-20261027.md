# Request performance evidence — 2026-10-27

This is a resumable measurement checkpoint, not a performance-gate pass. All requests used new temporary SQLite databases, Fastify `inject`, and deterministic WeKnora HTTP replay. No real model, external network, socket transport or paid call was used. No threshold is inferred.

## Large replay run before repair

Raw report: [`artifacts/knowledge-request-benchmark-20261027.json`](../../artifacts/knowledge-request-benchmark-20261027.json), SHA-256 `719f065ddd9a510cae658403c5d4b933e25a88cf8890e99e8ea1a7dec5197949`.

Workload: 50,000 Product mappings, 100,000 Candidate Insights and 100,000 Evidence records; 10 cold + 10 hot timed samples per scenario; concurrency four. Cold/hot describes scenario warm-up only, not purged process/OS/SQLite caches.

The initial report is retained with failures rather than replaced:

- Context Pack default and max-limit scenarios each had 20 timed HTTP 502 responses plus one warm-up failure. Their measured P50 values were about 21–22 seconds under concurrency four.
- Investigation found two separate issues. Relay `publishedRows` performed two legacy-metadata queries per Product row, twice per search (about 200,000 SQLite queries at 50k). Independently, the new replay fixture assigned chunk IDs by response position, which became invalid when lexical document ordering differed beyond the 200-result engine window. The existing production chunk-integrity guard correctly rejected those replay rows. Thus the 502 report is not evidence of a production chunk defect.
- Candidate Insight and Evidence responses had no HTTP/integrity errors. Their overall default P50/P95/max were 966.643/1714.018/1714.084 ms and 946.190/1909.111/1909.203 ms. Deep-offset Candidate P50/P95/max was 2616.936/2855.583/2855.739 ms; deep-offset Evidence was 1582.177/1617.317/1617.319 ms. These measurements include the failed run's machine load and are retained as observations, not targets.

The Relay metadata lookup is now a bulk JOIN preserving the previous latest-publication precedence and DTO filters. The replay now derives chunk identity from the external document ID. A permanent regression exercises more than 200 Product documents through the real route and chunk-integrity guard.

## Post-repair 50k smoke

Raw report: [`artifacts/knowledge-request-benchmark-after-20261027.json`](../../artifacts/knowledge-request-benchmark-after-20261027.json), SHA-256 `ad48d81725464e974695c8dfef2164420ee28b8328266c80454a703e02ed4d33`.

One cold sample, concurrency one, 50,000 Product mappings; all three search scenarios returned HTTP 200 with no status or integrity errors:

| Scenario | P50/P95/max (one sample, ms) |
| --- | ---: |
| Context Pack default | 2739.425 |
| Context Pack max limit 100 | 2783.217 |
| Empty result | 2555.745 |

This proves the repaired path completes at 50k; one sample does not establish a distribution or threshold pass. Nonproduction deployment and real-provider measurement remain separate from the replay evidence. Candidate/Evidence thresholds and Context Pack real-model thresholds still require project agreement.

## Final post-repair cold/hot distributions

Raw report: [`artifacts/knowledge-request-benchmark-final-20261027.json`](../../artifacts/knowledge-request-benchmark-final-20261027.json), SHA-256 `82ba2ff8d996ef06acaf0c139ed8848bd8b380d9863f9193bb6000f6ad51bc22`. Workload: 50,000 Product mappings, 100,000 Candidate Insights and 100,000 Evidence records; concurrency four; 10 cold + 10 hot timed samples per scenario. **Every default/boundary scenario returned HTTP 200 with zero status or integrity errors.** The raw JSON retains separate cold and hot P50/P95/max for every row.

| Endpoint/scenario | Overall P50 (ms) | Overall P95 (ms) | Max (ms) |
| --- | ---: | ---: | ---: |
| Context Pack default | 9598.393 | 9927.957 | 10092.545 |
| Context Pack max limit 100 | 9472.525 | 9981.025 | 10077.014 |
| Context Pack empty result | 11533.551 | 14307.984 | 14892.347 |
| Candidate Insights default | 1051.371 | 1078.022 | 1078.118 |
| Candidate Insights limit 200 | 1086.866 | 1113.546 | 1113.863 |
| Candidate Insights offset 99,999 | 3368.264 | 3514.514 | 3514.520 |
| Candidate Insights empty offset 101,000 | 3503.561 | 3605.254 | 3605.255 |
| Evidence default | 1218.434 | 1270.892 | 1271.020 |
| Evidence limit 500 | 1281.192 | 1379.437 | 1388.084 |
| Evidence offset 99,999 | 2160.624 | 2288.904 | 2288.907 |
| Evidence empty offset 101,000 | 2160.733 | 2181.944 | 2181.945 |

These are deterministic replay observations, not real-provider or socket measurements. They do not reuse the 7,500 ms frozen-search threshold or the 200 ms FTS threshold, and no new target is invented after seeing the results. Human/project agreement on performance targets remains open.

## Live nonproduction Candidate/Evidence read-only check

Real loopback HTTP against the existing nonproduction Relay measured 20 requests per endpoint (10 cold + 10 hot, concurrency four), with zero errors and **admissionDelta=0**. Candidate Insights had six visible records: overall P50/P95/max **12.496/14.414/14.711 ms**. Evidence had one visible record: **7.962/10.296/10.902 ms**. Report SHA-256: `07a52c10b5f84c71e0540434910f51be929649810edae21b97f8bb1ee264d365`.

These small live datasets are not comparable to the 100k synthetic workload and do not supply a Context Pack real-provider measurement. No Context Pack request or model call was made.

## Reproduction

```bash
node --import tsx/esm --test tests/knowledge-request-benchmark.test.ts
```

The focused post-repair run covered Product backend, benchmark, source comparison/API/MCP and Topic review: **42/42 passed**. `npx tsc --noEmit` and `git diff --check` passed. The preceding complete application run was **883/883**; rerun the complete suite after this checkpoint's Product backend change before final delivery.
