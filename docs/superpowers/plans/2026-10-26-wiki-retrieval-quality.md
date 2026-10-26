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

## Follow-up: failed Wiki pages and retrieval gaps

Owner request: continue nonproduction, prioritize failed Wiki source support, three zero-recall cases and weak XML. Preserve all frozen evaluation inputs/occurrence references and closure gates. Update existing draft PR #62 and evidence comments after actual revalidation.

- [x] Attribute all Wiki failures and frozen three-zero/all-XML candidates before code changes; distinguish automated-review inconsistency from demonstrated generation/provenance defects without changing old labels.
- [x] Reproduce the summary page's missing chunk references in a real-service regression; carry only current raw evidence actually used, replace stale refs when replacing the summary.
- [x] Strengthen general source-grounding boundaries against inferring operational semantics/status from identifiers or reference-list membership; test real rendered requests. Prompt changes alone are not entailment proof.
- [x] Fix any proven general retrieval token/candidate defect with synthetic real SQLite/pipeline RED-to-GREEN, without query exceptions, fixture-dependent weights, corpus edits or label changes.
- [x] Pin new upstream patches/tests and build fresh source, run complete affected suites, full application tests/build, source/hash/ACL/privacy guards and independent review.
- [x] Deploy reversibly under the approved nonproduction root, preserving all101 existing Wiki pages and existing mappings/model identities; retain every failure and backup.
- [x] Run one bounded separate native Wiki QA trial against the identical839-character source, at most20 new logical generation admissions with watchdog/drain/restore; audit all resulting bounded pages once using unchanged validator. No original-page edits or automatic publication.
- [x] Replay the same55 HTTP cases against the exact original global index snapshot and restore the complete QA database afterward. Report regressions and unresolved cases, not just improvements.
- [x] Update draft PR #62, immutable evidence and related comments; keep #55/#56 and aggregates open absent their original gates. No production deployment/merge or ledger reset.

Starting proof: wiki-retrieval-followup-20261026/start.json SHA2e6ad69ef3677bedeafac5e0e9c0407fb4e925481d5ee1a6f50a664d99b829ae; embedding15406/Wiki68; bothready200/hour, concurrency1/retry1; no pending work. Existing QA/restored corpus:101Wiki pages,7174mappings,7180native documents/58853chunks. Root coordinates model calls/deployment; independent domain analysts use gpt-6.1-sol/medium.

- Follow-up code: 18c1b8f /64be666 /635797d. Summary raw-evidence references, XML structure/encoded angles, literal identifiers, optional chat controls and parameterized slow/error SQL are repaired with real RED/GREEN regressions. Complete 861-test application/build and 22 Python/19 installer checks pass; fresh full Go packages, 29 Git-index pins and 151 bundle artifacts pass.
- Explicit owner-approved batch cap is now117 embedding /70 Wiki, measured from15406/68; absolute15523/138, provider200/hour/concurrency1/retry1 unchanged. Latest pre-final55 ledger15468/125. Final same-source Wiki trial11pages/32paragraphs has0/11 automatic source-support passes. All old drafts retained and human labelsnull; quality gates remain open.
- Final0012 deployment preserves126pages/mappings/model state. First attempt rolled back on state assertion; backup comparison passed and unchanged diagnostic retry passed. Evaluation lifecycle P2s found by review were repaired: stop all runner children before restore; engine starts in an independent scope. Both normal and SIGKILL zero-model fault tests pass; final lifecycle review has no P1/P2.
- Final55 completed55/55 against exact original globalindex cce225; QA7182documents/58859chunks/126Wiki exactly restored. Recall .908413/MRR .794394/nDCG .794067, XMLrecall .781250, zero1; two small ranking regressions and worse P95 7115.67ms retained. Final guards passed11pages/32paragraphs/22chunkchecks/165spans/114oldpages,1840916newlogbytes/121metadata rows, no matches within the stated privacy scope or managed-model calls. Final ledger15523/125 means approved batch117/57; exact admission trigger removed with unchanged rows; providers200/hour restored, no pending/watch work. Humanpacket550pairs/483sources/550chunks/32Wiki all labelsnull. Final evidence was published in6150e6e and draft PR #62 was updated; comments #55/#56/#43/#49/#50 were added and all five issue states were rechecked open.

- Final publication receipts: [#55 comment](https://github.com/tengfei1994/Relay-MCP/issues/55#issuecomment-6408498780), [#56 comment](https://github.com/tengfei1994/Relay-MCP/issues/56#issuecomment-6408499489), [#43 comment](https://github.com/tengfei1994/Relay-MCP/issues/43#issuecomment-6408500105), [#49 comment](https://github.com/tengfei1994/Relay-MCP/issues/49#issuecomment-6408500804), [#50 comment](https://github.com/tengfei1994/Relay-MCP/issues/50#issuecomment-6408501355). No issue was closed because the original quality gates remain unsatisfied. PR #62 is still draft and unmerged.

## Continuation ledger

- Manually repaired all11 failed QA pages into revision-two drafts using only their existing cited source. The eight linked sources are in another KB/scope and were not cited or reindexed without authorization. Preserved all revision-one bodies; deterministic exact-span review covers11pages/26paragraphs/23claims, not human gold. Repair SHA e5bf76d8604595b4208c0e5a0e49e79029671464567e77c0e11054920cc396c1; review SHA 416b70fcff976afeade5a041fd71e4baba043f1d4a991500f7d4faef827d693c.
- Added0013 heading retrieval after RED; focused and complete affected Go suites pass. Cached original-index/vector replay moves008db title source to sourceRank1 and resolves only the cached zero condition. Added offline7zip archive input with unchanged pinned hashes after a network-only build failure; both failed build attempts are retained. Full application861/861, standard build, tsc, quality self-tests and13patch/19test asset verification pass.
- Before the new HTTP run, owner selected strict gates: Recall .908413/MRR .794394/nDCG .794067/XMLrecall .781250 minimum, zero integrity/zero-recall failures, HTTP P95<=7500ms, all550 human-reviewed pairs with semantic precision>=.90, and every factual Wiki paragraph human-supported. Context Pack remains a separate unmeasured/unagreed release gate. Authorized only55 new embedding admissions for exact frozen queries; Wiki generation/audit calls0.
- Final55 actual HTTP passed every automatic gate: Recall .912958/MRR .812900/nDCG .801334/XMLrecall .781250, zero integrity/zero-recall, P95 7127.75ms. One VGL nDCG regression .006287 remains;377 outside-reference pairs and all550 human labels remain unjudged. First401 attempt used0 calls and was retained; formal scope-compatible QA tokens were renewed. The24h admission cleanup reduced cumulative rows while the actual batch window proves55/0. Final HTTP SHA93d6f082ed523d4c3b21cea8041b0654ef764874c32121dff0517ddf48ea2e80; automatic gate SHA367f00577e4ee2c88667ee025b8d90df09d9a845cd936ad5ff82519619880017.
- Fresh engine binary2d619f6b5f6846cc7d1803d674f72110b5b43c73f0b89af7812e4d88820c2826 and155 bundle files passed. Final MCP and guard checks pass11pages/26paragraphs/22chunks/165spans/115unchangedpages,5372publishedmigrations,1793358newlogbytes/56metadata rows,55/0 actual batch and zero verification calls. Final guard SHA c96a60d5562b049e54a8b3cd599c153fe79a1e0f6e31c14c65771c37042cd48e. Human semantic/Wiki review and Context Pack remain open; no issue is closed, no Wiki is published, no PR is merged and production is unchanged.
