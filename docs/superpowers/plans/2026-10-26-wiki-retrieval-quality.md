# Wiki grounding and retrieval quality repair plan

> **For agentic workers:** Use systematic-debugging and test-driven-development for each narrow repair. The coordinator integrates, performs live nonproduction validation and requests one independent final review.

**Goal:** Repair the evidenced Wiki provenance/generation defects and retrieval candidate/order defects, preserving the frozen acceptance inputs and recording actual quality outcomes.

**Architecture:** Keep Relay ACL, review and publication controls and the pinned private engine. Fix authority confusion at Wiki generation boundaries; fix retrieval behavior at the candidate/ranking boundary demonstrated by a reproduction. Existing automated source classification remains separate from expert factual acceptance.

**Tech Stack:** TypeScript, Node test runner, Go, SQLite FTS5/sqlite-vec, pinned WeKnora v0.8.3.

**Spec:** Existing issue #55/#56 requirements and docs/verification/knowledge-acceptance-20261026.md.

## Global constraints

- All environment changes are limited to /home/ftd/relay-knowledge-engine-nonprod.
- Preserve all old drafts, failures, frozen 55 queries, source manifest and relevance labels.
- Do not automatically publish Wiki or declare semantic precision/expert factual quality passed.
- Existing 200/hour provider limits, concurrency one, retry one; do not reset ledgers or increase quotas.
- No raw prompts, document bodies, credentials, private reports or vectors in Git.
- No production change or merge.

## Review focus

- An unknown/empty chunk handle must not become source evidence through generated Details.
- Generated descriptions/summaries must not be represented as verbatim source facts.
- Duplicate source chunks must not exclude other sources before the source-result limit.
- Equal scores must produce stable ordering, without query-specific special cases.
- Missing/invalid/insufficient review classifications must stay distinguishable from complete valid coverage.

### Task 1: Wiki generation evidence boundary

Files: pinned upstream service/wiki_ingest_cite.go, service/wiki_ingest_batch.go, source-grounding Go regressions; scripts/knowledge-engine/patches and upstream-lock.json; EngineWiki citation DTO/tests if warranted.

- [x] Write real-service tests for raw evidence versus generated paraphrases, empty/unknown chunk citations, and extraction instruction propagation.
- [x] Execute against unchanged pinned source and record expected RED.
- [x] Apply minimal source-boundary correction, checksum-pin patch/tests; preserve ordinary upstream behavior where needed through an explicit managed-runtime scope.
- [x] Run focused Go regressions and source-review validator tests; record GREEN.
- [x] Validate a bounded new draft generation against the preserved source; keep original failed drafts intact.

### Task 2: Retrieval candidates and repeatable ordering

Files: src/knowledge/weknora.ts, src/knowledge/product-backend.ts, related tests; pinned upstream fusion/retriever only where exact reproductions justify a change.

- [x] Trace unchanged failed query cases/candidate boundaries with safe metadata, no paid calls initially.
- [x] Write failing source-diversity and deterministic-order tests.
- [x] Implement narrow general fixes; keep source/chunk/snippet/score/citation coherent and authorization fail closed.
- [x] Verify RED to GREEN and replay identical frozen 55 cases with existing labels, reporting all metrics and unresolved labels.
- [x] Do not change weights or invent a release threshold after seeing results.

### Task 3: Unified verification and issue evidence

Files: docs/verification/wiki-retrieval-quality-20261026.md; bounded private remote scripts/artifacts.

- [x] Run full npm test, normal build, pinned asset/Python validation and whitespace checks.
- [x] Run bounded real HTTP/MCP/source/privacy validation on current nonproduction build; verify provider budgets and historical state.
- [x] Independently review final diff; repair material findings and rerun affected checks.
- [x] Commit/push a reviewable repair PR or update the existing authorized PR; attach it.
- [x] Update relevant issue comments with immutable evidence and close only issues whose original acceptance conditions are fully met.

## Execution ledger

- Baseline b00f4a0: initial full test 848/849; startup DB-alias rejection timed out at its unchanged 5-second guard under parallel load. Exact focused rerun 1/1 passed in 2.09 seconds. This failure remains recorded; final full suite must be green.
- Worktree: native managed wiki-retrieval-quality, created from codex/managed-knowledge-engine. Read-only analyst agents use gpt-6.1-sol/medium.
- Ruling: proceed without another plan-approval pause because user explicitly authorized automated nonproduction fixes and asked for intervention only when necessary.

- Final code d57cfe2 plus Memory SQL repair 28ba3ce: complete 857/857 application tests and build passed; Python 22/22, all 16 pinned assets and complete affected Go packages passed. Independent reviews found no P1/P2; deployed Linux BM25 smoke passed.
- Bounded native QA: 17 Wiki generation +2 embedding calls, then 11 audit calls; 12 pages /49 paragraphs; only3/12 automatic source-support pass. All original drafts retained, no publication. This trial is not expert factual gold or a controlled comparison with the earlier four-page population.
- Frozen55 actual HTTP: Recall .864726 /MRR .723304 /nDCG .728150, three zero-recall cases, 387 outside-reference query-source pairs, p95 6950.42ms. QA index exactly restored after evaluation. No weights/labels/thresholds changed.
- Final MCP5/5, immutable source/page/span guards and scoped privacy/budget guards passed. Embedding15406/Wiki68; ready200/hour restored; no pending model work. Earlier failed deployments/packets/log matches are preserved in the report.
- Owner response: no agreed semantic precision/P95 targets; keep closure gates. #55/#56 and aggregates stay open, with expert review packets prepared and every human label null. Memory fusion score calibration, weak XML, zero recalls and Wiki support remain open; no production merge.

- Published [stacked draft PR #62](https://github.com/tengfei1994/Relay-MCP/pull/62) against codex/managed-knowledge-engine; attached it to this task. Added immutable evidence comments to #55/#56 and aggregate #43/#49/#50. All five stay open; both #61/#62 remain draft, with no merge.
