# Integrated Knowledge acceptance checkpoint — 2026-10-26

This supersedes the open-work assessments in the October 25 snapshot. It records nonproduction acceptance, not a production release. Production remained read-only. The managed engine, credentials, model gateway and deployment are owned by Relay; no separate WeKnora administration is required.

## Verified release

- `npm test`: **849/849 passed**, zero skipped, 88.048 seconds. The first run had four Windows sandbox Python-spawn failures and one outdated synthetic download fixture. The fixture was corrected to serve the official authenticated source download and matching hash; its focused regression and the complete normal-environment rerun passed. No test was skipped or expectation weakened.
- Standard `npm run build`: passed, 121 MCP tools / 318-line registration boundary, 1,827 Vite modules. The 501.26 kB main bundle retains the nonblocking chunk-size warning.
- Independent Python regressions: **22/22** (12 index-content, 7 topic-projection, 3 operational-fixture checks).
- Final staging verification: all **9** locked patch/Go-test assets match their exact SHA-256 from Git's index, and `git diff --cached --check` passes. Checksum-pinned Go fixtures preserve their original bytes instead of being rewritten by Windows Git line-ending conversion. Three related focused regressions also pass.
- Independent reviews accepted source-read boundaries, keyword-default compatibility, Wiki resolver ACL and async navigation guards with no outstanding P1/P2 in those changes.
- Nonproduction application archive: `6fe51ed5a6d5e08aaf0f913918d29156c2b5138f8f2034c4a00f60aec2a47b0e`. Deployment checked the hash, backed up both databases/configuration and updated Web/MCP while preserving the engine and indexes.
- Full test log SHA: `30dc1accce0d84a2b51037e6b2248cb30a5885c29caff43dbf0c405d2bd9313e`; build log SHA: `6864851647014a31a3df6244cb5d9eaf8c0c039da6daeca89f556eff6f69044a`.

## Final live/browser packet

Two genuine html-3 CHM sources and the fresh Wiki source were read through the deployed Relay API. All three body byte hashes equal their stored normalized source hashes, and all 32 cited text chunks belong to the correct sources. Report SHA: `c4b6aa3de6cf9ba6d1bc11aac8c54d6890a4e4dbfe9e1d8c80e0d80a7a3e2ce9`. Product reads no longer join overlapping retrieval chunks.

The actual browser displayed GET_TABLE_DETAILS with three tables, two code blocks, four normalized Markdown headings and 15 unique anchors, with no duplicate IDs or unresolved internal-anchor links. TABLE_NAME displayed two tables, three normalized headings and 14 unique anchors. Its five rendered pre elements include Markdown-indented code in addition to the normalized explicit code blocks; pre-element counts are not relabelled as original HTML block counts. Both exact body hashes were verified separately. Source-relative links remain visible references; this is not an image-asset delivery claim.

The browser opened a generated Wiki draft, followed its `[[entity/samplemanager-pims|...]]` link within Relay, returned with Back, refreshed the selected deep link, and opened its original Product source. A foreign user opening the same Wiki key saw “Wiki page not found in the selected scope”, zero pages and no source content. The four quality-reviewed drafts remained unmodified/unpublished. Navigation resolves only existing authorized Relay bindings; it does not discover arbitrary upstream slugs.

The browser explicitly deprecated only the dedicated `TABLE_NAME` sample `weknora-aa36b31a-fb28-441f-881c-4924d265a494` in `nonprod-chm-html3-acceptance`. Reopening it under the **correct same scope** was denied. The full 5,372-page migration and seven retained legacy sources were unchanged. Earlier real HTML/Markdown/normalized-CHM uploads, failed-file retry, 20+20 nonoverlapping paging, Wiki edit/diff/publish/deprecate/rollback and stopped-engine recovery packets remain valid and are linked below.

The final actual HTTP/MCP privacy/source packet passed **11 checks**, including seven formally migrated sources, five legacy-ID MCP reads, current Memory reuse, foreign/environment rejection, publication denial and metadata-only telemetry. It scanned 10,429 new Web log bytes and 5,337 actual MCP audit bytes / 13 tool calls; model admissions stayed 15,387 total (15,347 embedding + 40 Wiki). Report SHA: `b28d4a15ccd52eca99ca02c65cec5800c902991ca9970e042525eed2da60a886`. The first attempt correctly stopped because the original hidden-source fixture had become fully published; a second preflight incorrectly counted direct CHM imports as migration-linked sources. Both failed reports are retained. The final run freezes seven formal migration sources and separately tests the dedicated deprecated CHM. Its same-scope browser denial supplies the direct publication-boundary evidence.

A separate rejected Candidate compile request used the real MCP entry point and synthetic private-context markers. It produced one digest-only tool audit, zero marker matches across 81 tables / 225,189,563 text bytes, and no provider admission. Report SHA: `40a63dc8e7a501d83c969221d9e44892a90cde7486d1e63202f6b0ca80967771`. Earlier real-model Candidate generation and the isolated success/fault/Capture/outbox packet remain separate evidence; this rejected request is not presented as a model-success test. Historical failure records were neither deleted nor declared clean.

## Issue dispositions

| Issue | Acceptance decision | Evidence / remaining work |
| --- | --- | --- |
| #42 | Keep open | Real bulk parsing, source/revision repair and engine integration are proven. The broader source-baseline/project-snapshot three-way upgrade, cross-version topic review and 42k Developer engine-scale workflow still need their own complete acceptance. |
| #43 | Keep open | Aggregate depends on remaining quality and release gates. |
| #44 | Close | Actual open-to-close Work Session, real Jobs/Deployments, restart, scoped summary, concurrent close and privacy; [operational report](work-session-operational-acceptance.md). |
| #45 | Close | Actual sync/async execution, deployment failure/rollback, receipts, Capture replay and legacy no-Session compatibility; same operational report and [summary contract](work-session-summary-contract.md). |
| #46 | Close | Internal Product plus Relay Memory/current facts, positive scope/ref contracts, real source/ACL/privacy and deterministic degradation; [scope contract](knowledge-scope-contract-acceptance.md), [fault packet](knowledge-mcp-fault-acceptance.md). |
| #47 | Close | Real managed qwen-plus generation/review/reuse plus fault/retry/Evidence/Capture/outbox/DLQ coexistence and final deployed privacy; [Candidate packet](candidate-coexistence-acceptance.md). |
| #48 | Remain closed | Its prior Candidate review acceptance remains valid; current native Wiki navigation also passes. |
| #49 | Keep open | Its body explicitly includes #50–#56. Remaining integrated quality, semantic precision and agreed performance gates are not satisfied by the operational component packet. |
| #50 | Keep open | Aggregate integration retains the open retrieval/Wiki quality and release gates. |
| #51 | Close | Real managed Embedding/Wiki/Candidate success, UI provenance, formal index-2 completion, injected real transport rotation/clear/concurrency/fault/ACL/privacy tests; [provider packet](knowledge-provider-transport-acceptance.md). No claim of a real external Rerank account test. |
| #52 | Close | Actual 21.1/21.3/Developer samples, original archive/CHM/PDF parsing reports, 5,372 exact source/chunk/vector proofs, real html-3 CHM/replay/publication and final faithful source reads; [migration report](full-corpus-v3-progress.md), [source fidelity](product-source-read-fidelity.md). This does not claim all 42k Developer pages were embedded. |
| #53 | Close | Current public MCP compatibility, keyword-first policy, 55 completed bilingual/object/path/version/VGL/XML cases with zero integrity flags, positive scope and fault matrix, live privacy/source reads. Semantic quality acceptance remains in #55/#56. |
| #54 | Close | Actual native UI uploads/retry/progress, paging, Product structure, Wiki lifecycle/links/source jumps, ACL and outage recovery; [browser imports](browser-real-format-import.md), [earlier lifecycle/outage packet](managed-engine-progress.md), final packet above. |
| #55 | Keep open | Full migration/replay/restart/publication/reindex/routing rollback are complete. Recall improves, but MRR/nDCG remain below FTS and an agreed gold-set threshold is still absent; [55-case report](flash-retrieval-final.md). Routing rollback is not relabelled as terminal migration-status rollback. |
| #56 | Keep open | Wiki source support failed (19 insufficient paragraphs, one invalid classification in the fresh four-draft packet); semantic precision is unjudged. Complete the final integrated quality/performance/operational release packet before production release. |

## Budget and remaining quality boundary

The 5,372-page source/chunk/vector migration is complete, not still running. Retained embedding usage is **15,347 logical calls**, below 16,000; Wiki usage is **40**. No additional paid call is scheduled by the acceptance scripts. The embedding lease was explicitly restored at `2026-10-25T18:14:02Z` to **200 calls/hour**, concurrency one, provider retry one. Wiki/Candidate are also 200/hour. Lease receipt SHA: `0a530f5cc4b27ca25e6f2bdd142a7d23c83120e0fe8707d1fb3059ddecf9debe`. Counts are logical admissions, not exact billable requests or costs, and were never reset.

The [retrieval report](flash-retrieval-final.md) records Recall@10 0.831681 / MRR 0.724848 / nDCG 0.708052. The [Wiki report](wiki-source-consistency-review.md) records 8 supported, 19 insufficient, 11 nonfactual and one unvalidated paragraph. Automatic grounding improvements and controlled evaluations can continue; the user is not being asked to manually rerun functionality already proven. Expert relevance/factual adjudication and agreement on release-quality thresholds are the remaining decisions that automation cannot honestly invent.

## Later nonproduction repair checkpoint

The [Wiki/retrieval repair packet](wiki-retrieval-quality-20261026.md) records subsequent code d57cfe2 /28ba3ce, **857/857** tests, fresh pinned engine/full Go validation, reversible deployments and final MCP/source/privacy checks. Frozen55 recall/nDCG improved to **0.864726 /0.728150**; MRR **0.723304** slightly regressed and three zero-recall cases persist. The new independent 12-page/49-paragraph Wiki trial has only **3/12** automated source-support passes; it is a different population from the earlier four-page trial and remains unapproved/unpublished.

Current retained logical counts are **15,406 embedding /68 Wiki**, with original200/hour, concurrency-one/retry-one policies restored, no pending model work and no ledger reset. Complete QA state was restored after isolated evaluation. Private human packets are ready, with all semantic/factual human labels null. The owner confirmed no agreed semantic Precision@10/end-to-end P95 thresholds yet and instructed that closure gates remain. **#55/#56 and #43/#49/#50 stay open.** This later evidence preserves the historical failures and earlier component decisions above; production remains unchanged.

## Subsequent fixed-set follow-up — 2026-10-26 04:42 UTC

The [follow-up report](wiki-retrieval-followup-20261026.md) records code `18c1b8f` / `64be666` / `635797d`: current raw-evidence summary references, XML structure and encoded-angle comparisons, literal identifiers, native chat controls and parameterized SQL diagnostics. Verification passed **861/861** application tests, standard build, **22/22** Python regressions, **19/19** installer/hash checks, complete affected Go suites, 29 Git-index pins and 151 fresh bundle hashes. Earlier failed tests and deployment attempts remain retained; no acceptance assertion was weakened.

The final unchanged **55/55** HTTP evaluation used the exact original global index and restored the complete QA database afterward. Recall@10 is **0.908413**, MRR **0.794394**, nDCG@10 **0.794067**; XML Recall@10 is **0.781250**. Zero-recall cases fell from three to **one**, the version-filtered `008db7099c19a1bf17585ee0`. Integrity flags remain zero. Two small case-level ranking regressions against the first follow-up are retained, including slightly lower aggregate XML MRR; HTTP P95 rose to **7115.67 ms** and is not an end-to-end Context Pack measurement. All **378** outside-reference returned pairs remain semantically unjudged. Final HTTP report SHA: `a69c4a20ff8735c44ab0a7a0c4f8409a38453e68e40407dfe30bc09fe64043d4`.

The final separate Wiki trial used the same 839-character source and produced **11 content pages /32 paragraphs**. All pages passed explicit citation preflight, but only ten automated reviews are complete and **0/11** pages pass automated source support: 9 supported, 10 insufficient, 12 nonfactual and 1 invalid paragraph classification. Earlier 49/38-paragraph populations differ; no accuracy trend or expert pass is claimed. All prior drafts are preserved; no draft was automatically published. Eight explicitly linked canonical sources were verified and privately prepared, without sending their additional bodies to the configured model. All human labels remain null.

Reversible deployment and final restoration preserve **126 Wiki pages**, all mappings and all **5372** published migration records. Post-deployment MCP/source/Memory/Evidence/ACL checks and final source/span/scoped privacy/runtime guards pass with zero model admissions. The scan covers 1,840,916 new log bytes and 121 selected operational metadata rows; historical logs and failures remain retained. Final guard SHA: `1bbba0d08269f93e5e1411c66d1604932532c77fdb97f47c40fc38f6c027f82f`. Independent lifecycle review found and repaired runner/engine cgroup races before this actual evaluation; real normal/SIGKILL fault tests and actual post-job engine readiness pass.

The owner explicitly approved total batch maxima **117 embedding /70 Wiki**. Actual batch use is **117 /57**, producing retained totals **15,523 /125**, below the cumulative 16,000 embedding gate. The exact temporary admission guard was removed after completion with no ledger changes. Providers remain ready at **200/hour**, concurrency one, retry one; no model job or evaluation watchdog is pending. **#55/#56 and #43/#49/#50 remain open** for the original quality/release gates. No production change or merge occurred.

## Source-grounded and heading-retrieval continuation

The [continuation outcome](wiki-retrieval-followup-20261026.md#final-continuation-outcome) repairs the eleven failed QA Wiki pages into revision-two drafts using only currently cited original evidence. All 26 paragraphs/23 factual claims have exact source-span coverage in deterministic revalidation; revision-one bodies remain available, no Wiki was published, and no Wiki generation/audit calls were made. Human factual labels remain null.

Patch `0013-xml-heading-retrieval` resolves the remaining cached zero-recall defect without changing frozen inputs, RRF weights or source bytes. The actual 55-case HTTP result is Recall@10 **0.912958**, MRR **0.812900**, nDCG@10 **0.801334**, XML Recall@10 **0.781250**, zero zero-recall and zero integrity failures, with HTTP P95 **7127.75 ms**. Every automatic gate preregistered by the owner passes. One VGL nDCG regression of 0.006287 is retained, and all 550 returned pairs still require actual human semantic review.

Application verification passed **861/861**, standard build and strict TypeScript; the fresh engine produced 155 verified bundle files. Final source/span/privacy/runtime guards pass, and the complete QA state was restored. The 24-hour admission retention cleanup reduced cumulative rows, while the independent batch window proves exactly **55 embedding /0 Wiki** admissions. Production remains unchanged.

The aggregate release disposition is unchanged: human semantic/factual review and Context Pack performance/threshold acceptance remain open. **#55/#56 and #43/#49/#50 are not closed.**

## Source-control and Developer-scale continuation — 2026-10-27

The [source-control and Developer-scale packet](source-control-developer-scale-20261027.md) repairs the three-way single-side classification and MCP snapshot ACL, adds real API/MCP/UI coverage and audited low-confidence Topic review, and records a real changed-body/stable-ID two-version check. The full 42,724-HTML manifest matches raw hashes, but only two complete Developer documents exist in the managed engine. The no-call native forecast is 63,781 logical embedding admissions without retry; no full import was started and #42 remains open. Aggregate #43/#49/#50/#56 remain open.

The [request performance checkpoint](request-performance-20261027.md) retains the failed 50k/100k/100k replay report, separates a Relay N+1 lookup repair from a replay chunk-fixture defect, and records successful post-repair 50k smoke and full concurrency-four cold/hot distributions. Live read-only Candidate/Evidence measurements and the reversible nonproduction deployment are complete with zero model calls. Performance thresholds and real Context Pack provider measurements remain open; no performance issue is closed.

## Automated closeout repairs — 2026-10-27

Three deterministic defects found during the closeout audit were repaired without provider calls or deployment changes:

- Context Pack now counts version conflicts across the complete ACL/version/scope-eligible set even when the response limit truncates returned documents, and equal-score authoritative documents use a stable document-ID tie-break.
- Explicit `localDocumentIds` migration batches now use the exact de-duplicated ID count instead of the generic scan limit, so a bounded checkpoint cannot silently under-report its manifest or coverage.
- Source baseline comparison retains the two-anchor single-side rule for `old=A / project=B / next=A`; the regression remains `PROJECT_ONLY` with no conflict flag.

Fresh verification after these repairs passed **893/893** application tests, standard build, strict TypeScript and `git diff --check`. Existing Python-backed engine tests required the local Windows subprocess permission and passed **19/19** when rerun. No embedding/Wiki provider call, production change, publication or merge occurred. The remaining closure gates are still the explicit 42k external-engine coverage/resume decision, real Context Pack provider measurement with an agreed threshold, and human semantic/Wiki factual labels.
