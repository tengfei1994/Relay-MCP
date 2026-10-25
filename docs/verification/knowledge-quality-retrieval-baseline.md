# Full-corpus retrieval baseline and gated evaluator

This extends [the offline fixture/Wiki audit](knowledge-quality-offline-acceptance.md). It uses the same frozen 5,372-page manifest and 55-case private fixture. No online search or model call was executed. Running services, provider settings and business data were unchanged.

The coordinating task subsequently received approval for a temporary 12,000/day migration allowance, concurrency 1 and one retry. These tools do not alter provider policy. Online quality evaluation remains deferred until full publication and a separate execution-budget confirmation.

## Actual FTS comparison

The first read-only run reproduced the existing Product SQL defect: SQLite rejects BM25 used in the same query as GROUP BY. The old implementation caught that error and used LIKE fallback. The failed report remains at runtime/full-213/quality-fts-baseline-20261025a.json, SHA-256 fcf9eec5e04bfa2c178cd1d90d56be3253a75f8a695193881e2cdfd4689252ee. It contains one failed case and 54 unrun cases.

The successful comparison ranks FTS rows, then keeps each document at its first rank. It applies the frozen-corpus predicate before ranking, uses the Product OR-token construction and never hides errors with LIKE. This is a native FTS comparison, not proof of the old HTTP endpoint's behavior. The Product implementation fix is owned by the integration review task.

Successful report: runtime/full-213/quality-fts-baseline-20261025b.json
SHA-256: a366fa7414eade4836be2bc9d1a5404a3d3ffa3f3ab186f2b96ffe8a8ef16342

| Category | Cases | Mean source Recall@10 | Source MRR | Source nDCG@10 |
|---|---:|---:|---:|---:|
| English title | 8 | 0.986111 | 1.000000 | 0.975378 |
| Object identifier | 8 | 0.958333 | 0.937500 | 0.912789 |
| Original source path | 8 | 0.000000 | 0.000000 | 0.000000 |
| Explicit version filter | 8 | 0.806250 | 0.875000 | 0.820950 |
| Chinese wording around English object | 8 | 1.000000 | 1.000000 | 0.994479 |
| VGL context | 5 | 0.546032 | 0.833333 | 0.506616 |
| XML context | 8 | 0.614583 | 0.483333 | 0.476950 |
| Configuration key | 2 | 0.833333 | 1.000000 | 0.888374 |
| **All cases** | **55** | **0.714892** | **0.736970** | **0.686440** |

All 55 cases completed; 11 had zero recall, including every source-path case. The body/title FTS index does not establish original full-path retrieval. No recall release threshold or pass was invented.

The 313 unjudged returned sources are not automatically irrelevant or integrity failures. This offline comparison does not exercise authenticated ACL denial, engine publication or engine chunk citations. Semantic precision and factual accuracy remain not_evaluated.

Latency was P50 172.51 ms, P95 1,034.54 ms and maximum 1,341.07 ms. This was one pass over the real bulk index, with frozen-corpus filtering and document deduplication. Cache state was uncalibrated and concurrent work may affect timing. It is not an equivalent workload to the separate hot-cache 100k synthetic benchmark.

## Native long-page budget

The single frozen page above the HTTP preview's 65,536-character cap used the actual pinned native Go packages:

NormalizeLineEndings → NormalizeHTMLTables → NormalizeSplitterConfig({}) → SplitWithDiagnostics.

Body and normalized payload hashes matched the frozen manifest. Source text traveled through stdin only. Go used cached modules with GOPROXY=off and GOSUMDB=off. No active engine/service was touched.

Report: runtime/full-213/long-page-budget.json, mode 0600
SHA-256: 9c7ec262b659052265fab9115c5f01adae5f15350e1977c18dfb51923ca334b0

| Measurement | Value |
|---|---:|
| Normalized characters | 81,850 |
| Native chunks | 202 |
| Logical embedding batches at size 5 | 41 |
| Approximate embedding tokens | 20,386 |
| Actual model calls | 0 |

Adding the other 5,371 previewed pages gives 10,114 logical no-retry embedding batches. This excludes retries, Wiki generation, queries and exact billing tokenization. The frozen manifest was not changed. The report contains source-file/helper hashes, configuration, selected tier and chunk hashes.

The reproducible probe is scripts/knowledge-quality-long-page.ts. It intentionally pins the approved nonproduction manifest hash.

## Evaluator modes and readiness

scripts/knowledge-quality-retrieval.ts supports:

- --mode fts: read-only native FTS comparison. Target IDs map to original bulk IDs for SQL, then back before scoring.
- --mode plan: read-only validation of all targets and published mappings; no token reads or HTTP.
- --mode http: explicitly gated, sequential, bounded actual Relay requests. Not executed in this task.

The actual plan verified all seeded targets and marked 55 queries not_ready while full publication was pending. Report: runtime/full-213/quality-http-plan-20261025a.json, SHA-256 acbb0d02789dc427309cd78123362abaa7b277401f5a455c0ea276d3fddf8691. Attempted retrievals/model calls were zero.

Seeding adds exactly one controlled metadata field, engineAcceptance. Validation checks its corpus, manifest/body/normalized hashes and original source ID; verifies untouched bulk metadata/sections hashes against the manifest; removes only that field in memory; then compares remaining target metadata/sections as canonical JSON. Whitespace/key ordering may differ, semantic changes may not. Target body/hash/path/version/scope are also checked. Stored metadata is never rewritten.

Online mode requires every manifest target to have formally published migration mappings in the chosen KB, verified upstream state, nonempty chunk proof and consistent model provenance. It checks returned source/citation hashes, chunk membership, current binding identity, exact version/path boundaries, global-or-exact scope and engine provider identity. Legitimate sources outside the expected relevance set remain unjudged.

A request or integrity failure stops execution and preserves the partial report. --resume reuses only completed cases when fixture, manifest, mode, endpoint and binding fingerprint match. Output overwrites are refused.

## Commands

Focused self-tests and strict checking passed:

    npx tsx scripts/knowledge-quality-manifest.ts --self-test
    npx tsx scripts/knowledge-quality-wiki.ts --self-test
    npx tsx scripts/knowledge-quality-retrieval.ts --self-test
    npx tsc --noEmit --strict --skipLibCheck --esModuleInterop --target ES2022 --module ESNext --moduleResolution bundler --noUnusedLocals --noUnusedParameters scripts/knowledge-quality-common.ts scripts/knowledge-quality-manifest.ts scripts/knowledge-quality-wiki.ts scripts/knowledge-quality-long-page.ts scripts/knowledge-quality-retrieval.ts

Use these common arguments with the actual frozen inputs:

    --frozen-jsonl /home/ftd/relay-knowledge-engine-nonprod/runtime/full-213/manifest.jsonl
    --fixture /home/ftd/relay-knowledge-engine-nonprod/runtime/full-213/quality-fixture-private-20261025a.json
    --manifest-sha256 712d0e78e9928123c402b748a3e966ef99eaf30121a7ff4ac76be3fe0ab30009
    --fixture-sha256 eee3f08d797d810ac4cc7c2c00527e95f4fca07481ccd1197499beccaf7c4ac2

From the nonproduction Relay checkout, set RELAY_QUALITY_ISOLATED=1 and run node --import tsx scripts/knowledge-quality-retrieval.ts with those common arguments.

For a plan, add --mode plan, --db pointing to relay/data/knowledge.db, --source-db pointing to bulk/knowledge.db, --knowledge-base-id CURRENT_KB_ID and --report pointing to a new private runtime JSON path. All paths must be absolute and inside the named nonproduction root.

Only after full readiness and explicit coordinator budget confirmation, use --mode http --endpoint product, additionally set RELAY_QUALITY_ALLOW_MODEL_CALLS=1, and supply:

    --base-url http://127.0.0.1:18300
    --token-file /home/ftd/relay-knowledge-engine-nonprod/relay/data/e2e-admin.jwt
    --max-requests 55

This bounds HTTP requests, not downstream billing calls. The evaluator neither overrides quota nor resets counters. --mode fts instead uses the bulk DB and requires no token or KB selector.

Verified HTTP routes are /api/knowledge/product-documents/search and, with --endpoint knowledge, /api/knowledge/search. The latter is not a direct MCP transport test. ContextPack and foreign-actor denial are not executed by this evaluator.

## Scoring, latency and privacy limits

Ranks deduplicate source IDs at first occurrence. Invalid and unjudged results keep their positions so later expected hits are not artificially promoted into the top ten. Only valid expected IDs earn recall/MRR/nDCG credit. Failed attempts score zero in attempted-case means; not-ready/unrun cases remain visible and cannot be presented as completed.

HTTP timing measures Relay round trip, including engine work, provider queue and transport. engineInternalLatencyMs remains null because these routes lack a trustworthy separately measured engine duration. HTTP request count is not asserted to equal billed model calls.

Reports contain IDs/hashes/counts/status/latencies, never raw queries, source bodies, snippets, prompts, credentials or responses. Fixtures and detailed reports remain private. The current Knowledge search implementation separately persists original query/results in knowledge_retrieval_runs and query tokens in audit details. The evaluator does not claim service-side absence of those fields; the coordinator was informed. The default Product endpoint avoids that Knowledge-search persistence path, but this is not a whole-service privacy attestation.

Self-tests cover scoring/ranks/duplicates/unjudged results; actual SQLite grouped-BM25 rejection and row-first deduplication; scope/version/provider/citation/path failures; valid global unjudged sources; and controlled seed metadata projection versus semantic changes.
