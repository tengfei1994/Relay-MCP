# Real-source Knowledge Quality Implementation Plan

> For agentic workers: use superpowers:executing-plans to implement and verify these bounded tasks.

**Goal:** Produce a reproducible source-grounded retrieval fixture and objective Wiki checks for the authorized nonproduction corpus, without model calls or pretending to perform human factual review.

**Architecture:** Read the frozen source manifest and SQLite snapshots. Generate deterministic exact-occurrence query candidates and expected local source IDs/hashes. Separately join upstream Wiki references to Relay publication, source, scope and revision metadata. Emit a private query fixture and metadata-only reports.

**Tech stack:** TypeScript/tsx, better-sqlite3, Node crypto/filesystem. No new package or HTTP client.

**Spec:** Parent's explicit nonproduction-first 5,372-page migration/quality request and the current acceptance criteria of issues [49](https://github.com/tengfei1994/Relay-MCP/issues/49), [52](https://github.com/tengfei1994/Relay-MCP/issues/52), [53](https://github.com/tengfei1994/Relay-MCP/issues/53), [55](https://github.com/tengfei1994/Relay-MCP/issues/55), [56](https://github.com/tengfei1994/Relay-MCP/issues/56).

## Design decisions and alternatives

- Chosen: deterministic source-occurrence fixtures plus reference-integrity checks. This proves narrower, reproducible properties and requires no model calls.
- Model-generated questions/judgments were considered but are excluded from this task: they add model cost and can invent relevance labels or accept unsupported prose.
- A wholly human-curated semantic relevance set remains desirable, but is a separate review artifact. The generated fixture is labeled unreviewed and must not be reported as complete semantic ground truth.

## Constraints

- Only scripts/knowledge-quality-*.ts and docs/verification/knowledge-quality-*.md change.
- SQLite is opened read-only and query-only. No model calls, service/configuration changes, deployment, issue closure or quota increases.
- Real executions require RELAY_QUALITY_ISOLATED=1 and paths inside the named nonproduction root.
- A frozen manifest selects the corpus; never silently substitute all 89,927 parsed documents for the requested 5,372-page corpus.
- Source IDs, source/body hashes and scope are verified against the manifest. Private fixtures may contain bounded queries; reports contain hashes/IDs/counts/categories, never source bodies or credentials.
- Generation never calls search to choose easy passing queries. Sampling is deterministic, stratified and recorded before retrieval.
- Native Chinese-source coverage and Chinese query wording over English objects are different dimensions. Missing coverage is reported as a gap.
- Current process-local provider quota remains unchanged. Evaluation admission and call count are explicit; a fixture is not permission to execute it.

## Tasks and verification

- [x] Common read-only input/path/output helpers, exact source-manifest validation, stable source fingerprint.
- [x] Fixture generator: English/title, native Chinese, Chinese cross-language object queries, object, path, version, VGL, XML and configuration candidates; deterministic sample and exact source-occurrence evidence.
- [x] Wiki checker: valid source publication/current KB, source hash, project/environment, bound version, chunk membership, reviewed revision; separate code-excerpt and identifier-review signals from factual judgment.
- [x] Self-tests inside the allowed scripts for stale source hashes, deterministic generation, ambiguous targets, Chinese coverage, foreign/unpublished/unknown sources, invalid chunks and code mismatch.
- [x] Strict TypeScript checks and --self-test, followed by authorized read-only nonproduction inventory/Wiki snapshot. No retrieval/model evaluation.
- [x] Record actual objective Wiki failure counts and limits in the report document.

## Retrieval report contract

Keep the private fixture immutable and identify it by SHA-256. Compare the same fixture before and after cutover.

For each executed case, capture query hash, category, expected local IDs, returned local IDs/ranks, verified citation document/chunk IDs and source hashes, returned version/scope/publication, retrieval run ID, provider, latency and error category. Never log the raw query or returned snippet/body.

Measure source Recall@10, source MRR and source nDCG@10 using exact-occurrence labels. Report unjudged returned IDs separately. Semantic Precision@10 and factual correctness remain not_evaluated until humans supply exhaustive relevance judgments. A non-expected result is not automatically irrelevant.

Hard failures: unknown/unverified/deprecated/unpublished source, incorrect hash, wrong requested version, foreign project/environment, invalid chunk or silent provider fallback. Retrieval thresholds beyond these integrity gates must be agreed after the first baseline; do not invent a release pass threshold.

Report coverage by source version, Solution, Module, source language, query category and original container type. Missing positive dimensions stay explicit gaps. Native-language and cross-language results are separate. Do not equate an English object token in a Chinese template with successful retrieval of Chinese documentation.

## Wiki report contract

Source-reference coverage measures resolved, published, verified references in the current KB. It does not prove that every statement follows from those sources.

Objective checks cover missing/unmapped/retired references, source hash mismatch, cross-project/environment mixing, bound version mismatch, invalid chunk membership and a published control revision differing from the current engine revision.

Code blocks not appearing exactly in cited source bodies, identifiers absent from cited sources, and mixed/unbacked version mentions are review candidates. They can be legitimate transformations or comparisons. They must never be labeled automatically as hallucinations, unsupported-fact counts or factual accuracy scores.

Human reviewers still decide whether claims follow from the cited source, whether omitted qualifications change meaning, whether steps are complete and safe, whether a cross-version comparison is justified, and whether generated code is valid for the stated SampleManager version. Store reviewer identity, decision, reason and source locations separately; do not auto-approve Wiki pages.

## Current acceptance interpretation

The small synthetic v1 golden set and hot-cache 100k FTS benchmark remain regression/performance evidence. They do not prove real full-corpus engine recall or Wiki factual quality. The latest issue comments continue to require real golden-set coverage, DOM/table/link/anchor quality, missing Solution/language positives, full migration and recovery proof, and complete operational/E2E metrics. This work addresses quality fixture generation and objective source checks only.

Executed against the frozen 5,372-page manifest and current Wiki SQLite inventory. See [the metadata-only acceptance report](knowledge-quality-offline-acceptance.md) for exact hashes, current versus historical populations, coverage gaps and the subsequent retrieval contract. No retrieval or model evaluation was executed.
