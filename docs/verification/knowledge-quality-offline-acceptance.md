# Real-source quality fixture and Wiki reference audit

This is offline quality preparation and a read-only reference audit, completed on 2026-10-25 at 12:55 UTC. It performed **zero retrieval requests, model calls, credential reads, service/configuration changes or publication changes**. It is not retrieval-quality or Wiki factual-accuracy acceptance. The existing 200 calls/hour provider policy was not changed.

## Reproducible artifacts

| Artifact | Scope | SHA-256 |
|---|---|---|
| Frozen full-corpus manifest | 5,372 genuine 21.3 source pages | `712d0e78e9928123c402b748a3e966ef99eaf30121a7ff4ac76be3fe0ab30009` |
| Private full-corpus query fixture | 55 deterministic cases | `eee3f08d797d810ac4cc7c2c00527e95f4fca07481ccd1197499beccaf7c4ac2` |
| Full-corpus metadata report | Generation and coverage only | `20bd6d99c583dc34ffb10571578c4f2c106e12a69a7975745e8b1aaeeb383989` |
| Private five-source query fixture | 29 complementary 21.1/21.3 cases | `0b4712398ef5ca440686edbb8a23afbf51af0e649caacca2af772f6283849265` |
| Five-source metadata report | Existing local source IDs | `313847be84ff759a0ae29e83cdc8ff84fc125b0be902fabe9eca4feee41e7519` |
| Wiki reference audit | Current default KB; populations separated below | `ba77fa88503facf68c3effec855def557cff8e9155fcd5036d3876cc03342c9e` |

The files are outside the repository under the isolated runtime root. Query fixtures have mode `0600`. They contain bounded queries and source IDs/hashes, never full source bodies or credentials. This document intentionally publishes only aggregate evidence. The per-case metadata reports are also private.

Paths relative to `/home/ftd/relay-knowledge-engine-nonprod/runtime/`:

- `full-213/manifest.jsonl`
- `full-213/quality-fixture-private-20261025a.json` and `full-213/quality-fixture-report-20261025a.json`
- `quality-seed-fixture-20261025a.json` and `quality-seed-report-20261025a.json`
- `quality-wiki-report-20261025c.json`

The earlier `quality-wiki-report-20261025a.json` was a schema-compatibility diagnostic that incorrectly treated SQLite JSON BLOBs as malformed. It is **invalid for acceptance**. BLOB decoding now has a regression assertion; the final `c` report is the evidence above. The earlier source lifecycle preflight exited without creating a fixture; source lifecycle `approved` is now recognized explicitly.

## What the fixture proves

The generator verifies each selected source's canonical body hash, raw-source provenance hash, original source path and version. Frozen JSONL mode additionally verifies section/metadata hashes, current normalized payload hash, source parser/format and title against the bulk SQLite source.

The raw-source hash comparison validates stored provenance against the frozen manifest; this command does not reopen every original HTML file or revalidate the archive. Canonical and normalized body hashes are recomputed from the actual stored source bytes.

The full-corpus fixture projects `bulkSourceId` to the manifest's intended `targetLocalId` and nonproduction project/environment. Its report explicitly labels these **planned target identities, not proof that the targets are imported, published or indexed**. The frozen manifest remains the authoritative projection. Its source fingerprint is `a023a5572ed74a100b1c65fad6daaa7f596844ec5af54dcc35951200609ec55d`.

Queries derive from literal titles, identifiers, paths, fenced code and configuration context. Expected IDs are all eligible exact occurrences within the frozen corpus and case scope/version, with field offsets and source/body/citation hashes. Sampling is sorted by SHA-256 before retrieval; there is no selection based on successful search results. Cases with more than ten exact-occurrence sources are excluded and counted, rather than given an arbitrary one-source answer.

These are **unreviewed source-occurrence labels**. A term appearing in a source does not establish semantic relevance to every interpretation of a query. A Chinese wording template around an English object is not evidence of native Chinese documentation.

## Actual coverage

| Query category | Full 5,372-source fixture | Existing five-source fixture |
|---|---:|---:|
| English title | 8 | 5 |
| Object identifier | 8 | 7 |
| Original source path | 8 | 5 |
| Explicit version filter | 8 | 5 |
| Chinese wording around an English object | 8 | 7 |
| VGL code/context | 5 | 0 |
| XML code/context | 8 | 0 |
| Configuration key/context | 2 | 0 |
| Native Chinese-source phrase | 0 | 0 |
| **Total cases** | **55** | **29** |
| Unique expected source IDs | 188 | 5 |

The full fixture uses all 5,372 manifest entries when determining expected occurrences, but its selected cases cover 188 distinct expected sources. This is stratified scenario sampling, not exhaustive per-page recall. Twelve candidate cases were excluded for more than ten eligible occurrences.

All full-corpus sources are declared English, 21.3, module `samplemanager` and format `madcap-html`. There are 963 sources with fenced code, zero sources containing CJK characters and zero positive Solution assignments. The five-source fixture contains two 21.1 and three 21.3 pages, but no selected version-filtered case has an actual other-version occurrence within its scope.

Required gaps remain explicit: native Chinese sources, positive Solution filtering, meaningful module diversity, same-scope cross-version/conflict negatives, human semantic relevance labels, source table/image/link/anchor correctness, and retrieval results. Do not populate these dimensions with fabricated examples or relabel English source material as Chinese.

## Wiki findings: current review pages versus historical inventory

The audit uses SQLite read transactions, not Wiki list/get APIs that might adopt or mutate pages. Relay and engine are separate databases, so cross-database atomicity is not claimed. The report is a bounded inventory snapshot; it does not impersonate an authenticated user or prove an HTTP ACL response.

| Population | Pages | All reference-integrity checks pass | Interpretation |
|---|---:|---:|---|
| Current adopted pages | 17 | 17 | All are drafts available for authorized review; no publication claim |
| Published control rows | 0 | 0 | No current published Wiki factual-accuracy acceptance |
| Unadopted or deprecated inventory | 66 | 12 | 65 unadopted pages and one deprecated page; separate from current user-facing publication |

The 17 adopted drafts have no findings under the current code-excerpt/version-literal review rules. Passing those rules does not mean their prose has been fact-checked.

All 54 pages with reference-integrity flags are in the historical/unadopted population. Counts overlap:

| Objective flag | Historical/unadopted pages |
|---|---:|
| Source has no Relay mapping | 42 |
| Referenced chunk absent from resolved source mapping's allowlist | 37 |
| Source mapping is not published, including retired sources | 13 |
| Sources mix non-global project/environment scopes | 2 |
| No source references | 1 |

The existing source checks should keep these pages from automatic acceptance. They may need explicit source remapping, regeneration or a documented retirement decision; this audit neither rewrites nor deletes them.

Chunk diagnostics distinguish missing physical data from retained history:

| Referenced-chunk category | Current adopted pages | Historical/unadopted inventory |
|---|---:|---:|
| Current mapping's verified chunk | 16 | 104 |
| Explicitly retired source's retained chunk | 0 | 61 |
| Physically present chunk whose upstream source has no Relay mapping | 0 | 60 |
| Physically missing chunk | 0 | 0 |

These are chunk-reference counts, not unique corpus chunk counts. The 61 retained retired-source references are consistent with preserving old indexes; they are excluded from current publication and are not described as dangling physical chunks. The 60 unmapped-source references have physical chunks but lack Relay provenance. Without a matching migration record, their age or legitimacy is not assumed. A new chunk belonging to a current source but absent from its proof would be reported separately; that category was zero here.

Across the entire historical/current inventory, 63 of 123 distinct-per-page source references resolve to published verified mappings. That ratio is **not the quality score of the current 17 adopted drafts**, not claim-level citation coverage, and not factual accuracy.

Only the historical/unadopted population produced these content-review signals:

- 11 pages contain a fenced code block that is not an exact excerpt of any available cited source body.
- Three pages cite multiple source versions.
- Ten pages contain a version-like literal absent from the cited source version metadata.

Generated code, comparisons and numeric literals can be legitimate. These are review candidates, not automatic hallucination counts. `unsupportedFactualClaimCount` is `null` and `factualAccuracy` is `not_evaluated` in every page result.

## Running the offline tools again

Use new output filenames: the scripts refuse overwrites. They accept only real paths inside the named isolated root and require `RELAY_QUALITY_ISOLATED=1`. SQLite opens read-only with `query_only` enabled. No script imports a model or HTTP client.

From the nonproduction Relay checkout:

```sh
RELAY_QUALITY_ISOLATED=1 node --import tsx scripts/knowledge-quality-manifest.ts \
  --db /home/ftd/relay-knowledge-engine-nonprod/bulk/knowledge.db \
  --frozen-jsonl /home/ftd/relay-knowledge-engine-nonprod/runtime/full-213/manifest.jsonl \
  --out /home/ftd/relay-knowledge-engine-nonprod/runtime/full-213/quality-private-NEW.json \
  --report /home/ftd/relay-knowledge-engine-nonprod/runtime/full-213/quality-report-NEW.json \
  --max-per-category 8
```

For an existing local source manifest use `--source-manifest` instead of `--frozen-jsonl` and point `--db` at its actual local database. The manifest must contain source IDs, raw/body hashes, path, version and exact scope. It must not silently substitute a different corpus.

```sh
RELAY_QUALITY_ISOLATED=1 node --import tsx scripts/knowledge-quality-wiki.ts \
  --db /home/ftd/relay-knowledge-engine-nonprod/relay/data/knowledge.db \
  --engine-db /home/ftd/relay-knowledge-engine-nonprod/runtime/knowledge-engine/data/weknora.db \
  --knowledge-base-id CURRENT_KB_ID \
  --report /home/ftd/relay-knowledge-engine-nonprod/runtime/quality-wiki-NEW.json
```

The KB ID is supplied explicitly; the checker does not read engine credentials. Use the current managed KB ID, not a historical or identity-test KB.

Local validation completed:

```sh
npx tsx scripts/knowledge-quality-manifest.ts --self-test
npx tsx scripts/knowledge-quality-wiki.ts --self-test
npx tsc --noEmit --strict --skipLibCheck --esModuleInterop --target ES2022 \
  --module ESNext --moduleResolution bundler --noUnusedLocals --noUnusedParameters \
  scripts/knowledge-quality-common.ts scripts/knowledge-quality-manifest.ts \
  scripts/knowledge-quality-wiki.ts
```

Regression assertions cover input-order determinism, source hash/scope mismatch, actual approved lifecycle, frozen target projection, broad ambiguous terms, native versus templated Chinese, fence delimiters, SQLite JSON BLOBs, unknown/unpublished/unverified/foreign sources, invalid chunk ownership/readiness, retired versus missing chunks, published revision drift and the distinction between generated code and factual failure.

## Contract for the subsequent live retrieval run

This task did not execute retrieval. The coordinating driver must keep the exact private fixture hash and record provider/model/index/KB identity before a run. It must first confirm every planned target needed by the fixture has been imported, published, verified and bound to the expected source and scope. Missing targets are `not_ready`, not silently skipped or relabeled as successful.

An authorized run should cover Product Search, `knowledge_search` and ContextPack with the same cases, preserving the same context and filters. Resolve external document IDs through the verified Relay mapping; do not compare raw engine IDs directly to planned local IDs.

For each case, retain only private bounded query text plus metadata evidence: fixture/case/query hash, requested filters, returned unique source IDs/ranks, citation document/chunk IDs and hashes, mapping publication/readiness, product version/scope, provider/run ID, latency, safe error category and actual admitted provider-call deltas. Public reports aggregate those fields. Do not store prompts, response snippets, bodies, credentials or raw model responses in evaluation logs.

Deduplicate multiple hits from the same document at its first rank before document-level scoring. Count only results whose citation, source hash, publication, version and ACL scope checks pass:

- **Source Recall@10:** expected source IDs found among the first ten unique valid source results divided by all expected IDs.
- **Source MRR:** reciprocal rank of the first expected source, or zero.
- **Source nDCG@10:** binary exact-occurrence gain for expected source IDs, normalized against that case's expected set. This is an occurrence benchmark, not semantic nDCG.
- **Citation completeness/integrity:** the fraction of returned Product hits with a valid expected-shape source identity/hash and valid mapped chunk. Report invalid citations and version/scope failures separately even when the source is outside the expected occurrence set.
- **Unjudged returns:** report their count; do not automatically call them irrelevant. Semantic Precision@10 remains `not_evaluated` until humans provide relevance judgments.

Report cases attempted, completed, not ready and failed alongside aggregates, including per-category/version results. Do not improve averages by dropping timeouts or zero-recall cases. Keep successful-request latency and failure rate separate. Unknown/unverified/deprecated/unpublished sources, incorrect hashes, foreign scope, invalid chunks, wrong explicit version and silent fallback are hard integrity failures. This document does not invent a recall release threshold before the first real baseline.

Existing 200/hour admission is unchanged and shared with other model work as implemented by the runtime. Fifty-five cases do not imply fifty-five billable calls: embeddings, reranking and retries can add calls. The coordinating run needs an explicit bounded budget and actual counter evidence; it must pause/resume by case ID rather than bypass the policy or restart services to reset it.

## Human review and remaining acceptance gates

Human reviewers must inspect the actual cited passages and decide whether each material Wiki claim follows from them, whether omitted conditions change its meaning, whether procedures are complete and safe, whether generated VGL/XML is valid for the stated version, and whether cross-version claims are justified. Record page revision/content hash, cited source location/hash, reviewer identity, decision and reason. A page revision change invalidates that review.

A useful review ledger has one row per material claim: claim-location hash, supporting source ID/location/hash, decision `supported / contradicted / insufficient / needs domain validation` and reviewer. Only reviewed claims belong in a factual-accuracy denominator. Source-reference counts, lexical overlap and a model's self-assessment cannot substitute for that ledger.

This work supplies fixture generation and reference-integrity evidence for [#49](https://github.com/tengfei1994/Relay-MCP/issues/49), [#52](https://github.com/tengfei1994/Relay-MCP/issues/52), [#53](https://github.com/tengfei1994/Relay-MCP/issues/53), [#55](https://github.com/tengfei1994/Relay-MCP/issues/55) and [#56](https://github.com/tengfei1994/Relay-MCP/issues/56). It does not close their remaining real retrieval, full-corpus indexing, source structure, recovery/fault, end-to-end performance or human Wiki-fact-review requirements.

Subsequent CPU-only FTS results, native long-page budgeting and the gated online evaluator are recorded in [the retrieval baseline report](knowledge-quality-retrieval-baseline.md). The no-retrieval statement above describes the 12:55 UTC fixture/Wiki snapshot.
