# Wiki grounding and retrieval-source repair — 2026-10-26

[Draft PR #62](https://github.com/tengfei1994/Relay-MCP/pull/62) stacks on #61. Evidence comments: [#55](https://github.com/tengfei1994/Relay-MCP/issues/55#issuecomment-6406693763), [#56](https://github.com/tengfei1994/Relay-MCP/issues/56#issuecomment-6406694405), [#43](https://github.com/tengfei1994/Relay-MCP/issues/43#issuecomment-6406699930), [#49](https://github.com/tengfei1994/Relay-MCP/issues/49#issuecomment-6406700710), [#50](https://github.com/tengfei1994/Relay-MCP/issues/50#issuecomment-6406701546).

This is a nonproduction repair and evidence packet, not release approval. The owner confirmed that real semantic-precision and end-to-end latency thresholds have not yet been agreed; #55/#56 retain their closure gates. Production was not changed.

## Code and regression evidence

Implementation: d57cfe2 (Wiki/Product) and 28ba3ce (Memory SQL), based on b00f4a0.

- Wiki reduction uses resolved original source chunks, without generated Description/Details as substitute evidence. Missing/partial evidence fails before model/storage. Legacy extraction still receives citations.
- The summary prompt no longer forces short sources into a minimum word count or invented hierarchy. Extraction guidance reaches citation. Touched malformed-output warnings omit raw model output and unknown handle values.
- Product search counts distinct documents within a bounded 200-candidate response. Cross-document duplicate/overlap removal preserves separate source identities; same-source deduplication remains. Keyword cutoff and fusion ties are deterministic. Exact vector TopK tie membership is unchanged.
- Wiki DTOs expose actual page chunk references. Complete review coverage is distinct from automated source-support success; neither constitutes expert factual approval.
- Memory FTS materializes BM25 cursor scores before selecting the best matching chunk per document. The former aggregate raised the real SQLite error `unable to use function bm25 in the requested context` and silently fell back to LIKE/updatedAt ordering. ACL, lifecycle, version, candidate guards and genuinely unavailable-FTS fallback remain intact; document-ID ties are stable.

Validation: **857/857** application tests, zero skips; standard build; **22/22** independent Python guards; complete Go service/chat_pipeline/SQLite suites with sqlite_fts5; model protocol/privacy, document parser, task retry and RRF gates. All **7** patches / **9** regression assets match Git-staged hashes. Independent review found no demonstrated P1/P2. Memory regressions first demonstrated three expected failures, then passed 14 focused/related tests; the independent reviewer reran all four new real SQLite regressions. The final deployed Linux SQLite smoke also verified relevance ordering and substring exclusion without model calls.

The original Go service suite and patched suite initially had identical 40 DNS-dependent failures. Test-only positive fixtures were made hermetic using existing guard-supported patterns. The same complete service command then passed; runtime SSRF policy, negative assertions and skips were unchanged. A Windows-to-Bash launcher encountered a trailing CR after build completion; the stored build's success and all 138 artifact hashes were independently verified.

## Reversible deployment

The first preservation check triggered rollback because it treated control updatedAt as business state. Exact comparison established that this was the only changed control field; mappings, Wiki content, engine record counts and model ledgers matched. That failed attempt and backups remain retained.

The corrected check hashes every control field except that timestamp, tests six meaningful configuration mutations, and records timestamp changes separately. The subsequent deployment passed, preserving 7,174 mappings, 7,179 native documents, 58,850 chunks, 88 existing Wiki pages and model identity. Backups and failed evidence remain private.

| Artifact | SHA-256 |
| --- | --- |
| Application archive | fbd7008bba452275f44bed667ea63f45794866937a1c3d6502fcc5e3f8bbbb47 |
| Engine manifest | a9066c6db0417e7a7db163785a15629ac6b2dc40413cb73169d09a176d7c1814 |
| Engine binary | e101e58bbf8f91114039f429a3a57a39d2156073a0e6782cd7c166a4654eb48f |
| Complete affected Go-suite log | 9d190b71130c83f26330eed60230fd2d836fb1f765491ea1612cbe91f6804782 |
| Deployment proof | b87a184d0f79a7bc944bdc45746180feb617d1312767a0bea667cf046c00cb2e |
| First-attempt diagnostic | 78b90042586686efdcbdb8b02b2a7caecfe8b7313f4fd979531ce43fe054db08 |

## Independent native Wiki trial

The unchanged frozen 839-character source, SHA d3bd45f37d263df2a2cf2576730ae4a0b2163a75764e76d2375bec7a6ee88f8c, was submitted to a separate QA base using the existing Flash index-2 embedding and qwen-plus Wiki model. Relevant generation configuration matched the original base. No original draft was edited or published.

Generation used **17** logical Wiki calls and **2** embedding calls. A twenty-call generation allowance and independent watchdog bounded the trial. Generation settled, pending work reached zero, and the provider was disabled/drained for at least its 120-second timeout plus five seconds before restoring the original **200/hour**, concurrency-one/retry-one policy. No ledger was reset.

All **12** content pages / **49** paragraphs were frozen before review. One page failed the explicit chunk-reference preflight and remained unassessed. The other eleven pages received exactly one source-audit call each, with no additional retry outside provider policy.

| Automated finding | Paragraphs |
| --- | ---: |
| Supported | 18 |
| Insufficient | 8 |
| Contradicted | 1 |
| Nonfactual | 12 |
| Invalid classification/claim/span | 4 |
| Unassessed preflight-failed page | 6 |

Seven page reviews had complete valid coverage; only **3/12** content pages passed the automated source-support check. These are automated consistency labels, not expert factual gold. The new population differs from the prior four-page/39-paragraph sample; their raw counts are not a controlled accuracy improvement.

No Wiki content was automatically approved, rewritten into a claimed pass or published in Relay. Generated pages, failed classifications, source snapshots and private audit artifacts remain intact.

| Wiki artifact | SHA-256 |
| --- | --- |
| Frozen review plan | ecc0d3045f3c244a566419370943024fd78618b73d035032b2ce7481a7919169 |
| Audit report | 100dd83cd7b679d122b1cabaea6a70469db024bec220eb1b34082951173c2087 |

## Frozen retrieval evaluation

The 55 queries, labels, source manifest, ACL/version filters and metrics implementation are unchanged. Because QA imports change global BM25 statistics even outside the selected scope, the run uses the exact original native index snapshot. The complete QA database is preserved separately and must be restored afterward. This is an isolated evaluation fixture, not terminal migration-status rollback.

All **55/55** actual HTTP cases completed, using exactly **55** embedding admissions and no integrity flags for source, version, scope, publication, citation or chunk proof. The fixture SHA is 63f1adda80e849a8d92727d512de507019000ab9bfdb6476458250532bc4c271. All query inputs, occurrence references, metric definitions and provider settings remained frozen. Occurrence references are not expert relevance gold.

| Same-fixture run | Recall@10 | MRR | nDCG@10 |
| --- | ---: | ---: | ---: |
| Local FTS control | 0.752727 | 0.738636 | 0.725033 |
| Earlier hybrid | 0.619502 | 0.663961 | 0.575430 |
| Prior keyword-first | 0.831681 | 0.724848 | 0.708052 |
| This repair | **0.864726** | **0.723304** | **0.728150** |

Recall and nDCG improve against the prior run; MRR is slightly worse and remains below FTS. Three zero-recall cases persist. XML is still weak: Recall@10 0.557292 / MRR 0.361111 / nDCG@10 0.376390. There are **387 returned query-source pairs outside the frozen occurrence references**, not 387 unique documents and not a semantic false-positive count. No scoring weights, query-specific exceptions or labels were changed after observing results.

Observed HTTP latency was p50 **6,519.66 ms**, p95 **6,950.42 ms**, maximum **7,031.17 ms**. This is the recorded retrieval HTTP boundary, not an engine-internal or full Context Pack latency claim. The separate local hot-cache 100k-chunk FTS microbenchmark p95 was 0.0686 ms over 100 samples; it cannot substitute for an agreed end-to-end performance target.

The exact original global index/embedding-row fingerprint was cce2255abace0ed4e63903b5871229f6a7816b0180b5a04a257aa5716675fe0d. After evaluation, the complete QA database was restored and its business state matched the preserved snapshot exactly. Evaluation-complete and QA-preserved databases remain private. The isolation state is **restored**; no rollback action is pending. The later Memory-only query fix does not change the Product evaluation path or frozen index, so the 55 paid calls were not repeated.

| Retrieval artifact | SHA-256 |
| --- | --- |
| Complete HTTP report | 4654c2e407e376c3f927985812a48e01e294949b214d0e1f324c8c40c0a2c823 |
| Restored isolation state | 933247b1069695fa6c961a40919025599ac88e5ddb565ba8013d56f2c5375e4c |

## Final deployed checks and budget

The Memory-only application update backed up code and both Relay databases, then verified seven core business tables, mappings, native counts, Wiki bodies, model ledger, engine binary and configuration unchanged. It did not rebuild or replace the engine. Final live MCP passed **5/5** checks: 121-tool catalog, Session idempotence/reconnect/foreign ACL, Memory/Evidence sentinel reuse, five genuine Product reads plus Context Pack/foreign denial, and idempotent close. Earlier browser/import/outage/Candidate acceptance remains separately recorded in the existing checkpoint; this smoke does not claim to repeat every workflow.

Independent final guards verified **12** frozen content-page row/citation hashes, **49** paragraph hashes, **24** repeated source-chunk checks and **180** exact source-span checks. The original **88** Wiki pages and all **5,372** published migration records remain intact. The separate QA base has generated drafts only; no automatic Relay publication occurred.

New log bytes since the frozen retrieval start: **28,451,263**, across Web/MCP/engine. Selected operational metadata: **153** rows across audit, retrieval, Work Session, provider admissions and native processing spans, including the retained evaluation database. Exact checks covered **10** actual credential values resolved in memory, the QA source fragments, **55** JSON raw-query values and hidden-reasoning markers, with zero new matches. Retrieval query columns held SHA-256 digests. A supplementary scan covered 1,331 selected prefixes/long lines from all 482 canonical retrieval sources and cited chunks, plus framed raw-query formats, over 28,451,640 new log bytes: zero matches (report SHA 3d85b6ecdc4c2c96b7c1ec17a8a3c44e7c4a2a3a9d9e9784cc35cb854830da0f). This is the stated marker/metadata scope, not a universal privacy proof. A historical engine-log source-fragment match is retained and reported separately; its preceding log timestamps are 2026-10-25 08:55:25, before this QA trial. Old failures are not relabelled clean.

Final logical admissions: **15,406 embedding** (below the existing 16,000 allowance) and **68 Wiki**. This run added 59 embedding calls (two QA source, 55 evaluation, two MCP) and 28 Wiki calls (17 generation, 11 audit). Logical admissions are not exact billable request or cost counts. Both providers are back at **ready, 200/hour, concurrency 1, retry 1**; native/Relay pending queues are zero, the temporary watchdog is inactive, and no additional model calls are scheduled. The final guard itself made zero model calls.

| Final artifact | SHA-256 |
| --- | --- |
| Memory application archive | e19a428bce783f932a156fc379fd02785b19fbe23bc8f994ab6b27006ec29fb3 |
| Application-only deployment proof | c4f2aafbf6dff144bec14212b85e900a06414dfb5543308886b9f19a57a9978e |
| Final MCP report | 538776d2522d475cd3227e5b163d994587ac379d1104eaf0b1137334ca9e4c54 |
| Source/privacy/budget guards | 25e24ab67c209cd181c3541df29e059ac160ef7dbbfeba3400a8ae0c15b16268 |

## Prepared human review and disposition

Private review material is under the approved nonproduction runtime's wiki-retrieval-repair-20261026/human-review-v2-corrected directory (0700, files 0600). It contains **55 cases / 550 query-source pairs**, **482** unique canonical sources verified through manifest targetLocalId to bulkSourceId with exact body/source hashes and path/version, all **550** actual cited chunks verified against document binding and ready/enabled status, and all **49** Wiki paragraphs with source spans and automated findings. **Every human label and reviewer remains null.** No occurrence match or model label was promoted into human gold.

The first packet failed to resolve canonical IDs; the second omitted cited chunks because it assumed a string status instead of the native numeric encoding. Both are retained as diagnostics. The corrected packet is the review input.

| Private review artifact | SHA-256 |
| --- | --- |
| Retrieval query-source packet | 4583ac7647e4021e1ef09b09960e9f0dc65c43b5fe82c74aed284a43e3dd6455 |
| Wiki paragraph packet | 293f3e5d6ec3689ced8889d5ba92b8ac730280811532f6624bd7698adc38c5db |
| Packet manifest | 25b1ca563a02a7e5bd1549c9ae3500a9a2b64e5f5c7de2b81a871f4db9561786 |

**#55 and #56 remain open**, with aggregate #43/#49/#50 also open. The owner confirmed that semantic Precision@10 and end-to-end P95 targets are not yet agreed and instructed us to preserve the closure gates. Expert semantic/factual adjudication, persistent Wiki support failures, the three zero-recall cases and weak XML retrieval remain acceptance work. Memory's existing negative-BM25 score normalization/clamping still flattens relevance magnitude for fusion; this narrow SQL fix preserves the correct lexical order but does not claim to solve score calibration. Source-candidate collection is bounded at 200, and equal-distance vector TopK membership is unchanged. No production deployment or merge is authorized by this packet.
