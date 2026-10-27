# Wiki sources and retrieval follow-up — 2026-10-26

This records the additional nonproduction work in [draft PR #62](https://github.com/tengfei1994/Relay-MCP/pull/62), stacked on #61. Production is unchanged. Neither PR is merged. The fixed 55 queries, occurrence references, source manifest, scope filters and closure gates remain unchanged. The owner confirmed that semantic Precision@10 and end-to-end P95 targets have not been agreed; #55/#56 and aggregate #43/#49/#50 remain open.

## Repairs and their evidence

The first follow-up, `18c1b8f`, fixes the following demonstrated defects:

- **Wiki provenance:** summary generation omitted chunk IDs and the reducer cleared them. Summaries now use bounded current raw input (32,768 runes), record exactly supplied chunk IDs and replace stale references. If evidence is missing, the prior draft is preserved. Tenant, document, enabled/text ownership and ambiguous-ID checks remain enforced.
- **Wiki authority:** the additions editor no longer receives generated DocSummary framing. General instructions prohibit inferring operational semantics, status or relationships from identifiers or reference-list membership/absence. The remaining SUMMARY minimum length was removed. These instructions do not prove entailment.
- **XML retrieval:** query-declared XML elements now receive structural preference before the bounded SQLite candidate cutoff, and this preference survives keyword rank derivation through both hybrid and keyword-only fusion. Element case, namespace, boundaries, attributes and conjunctions are tested. Broad lexical fallback, raw BM25, vector ranks, RRF weights and the final fusion formula remain unchanged. The internal preference flag is omitted from JSON.
- **SQL logging:** slow/error GORM traces expanded bound parameters despite managed INFO suppression. Parameterized logging and the supported Scan-recorder filter now retain placeholders. Actual SQLite Info/Scan/slow/error/not-found regressions reproduced RED and pass GREEN. Direct SQL literals and database-origin error text remain outside this filter; historical private logs are retained.

Eight actual-service Wiki regressions reproduced the provenance failure before repair. Real SQLite-to-fusion regressions prove that SQL-only ordering is insufficient. One earlier injected test deliberately changed from requiring generated summary context to forbidding it; its raw-source, table and reference assertions remain.

`64be666` adds two further general repairs:

- Native Wiki requests temperature 0.3, but Relay dropped it before provider HTTP. Validated optional temperature and recognized explicit thinking controls now survive gateway, provider handle and serialization. Real HTTP-capture tests cover explicit zero/false and absent-field compatibility. An independently found array-valued thinking-type coercion defect was reproduced and fixed using strict string-enum validation. The native generic adapter may omit Thinking:false before Relay; no default is invented and actual thinking-disabled behavior is not claimed.
- Whole underscore identifiers now retain their literal meaning instead of becoming unrelated FTS prose tokens. The preference is bounded and parameterized, survives cutoff/fusion and excludes paths, dotted filenames and numeric versions. No benchmark IDs, application-specific query strings, label changes or weight tuning were introduced. Cached-vector replay moved one expected VGL source from rank 10 to 3; this is diagnostic evidence, separate from the final HTTP run.

`635797d` adds `0012-xml-named-angle-comparison`. Three reference sources in the remaining version-filtered zero case contain encoded XML tags, contrary to the earlier diagnostic that they contained only partial query terms. All four reference sources have genuine raw or named-entity tag evidence. The patch creates an XML-comparison-only view for `&lt;`, `&gt;`, `&LT;` and `&GT;`; source/index bytes, identifier comparisons and BM25 are preserved. Real SQLite and fusion tests cover encoded tags, attributes, namespaces, conjunctions, ACL and enabled-document boundaries, and reject double/numeric/different mixed-case encodings. Cached replay still placed the four sources below the final top ten, so this correction alone is not a zero-recall success claim.

## Verification and deployment

Application verification passed **861/861 tests**, zero skips, and the standard build. Python regressions passed **22/22**; installer, hash and privacy checks passed **19/19**. The initial sandbox run had four Python-spawn EPERM failures and the first 861-test run retained one unchanged five-second MCP-startup timeout. Normal-permission full reruns passed; the focused startup case also passed in 2.269 seconds. No timeout, skip or quality expectation was relaxed.

A fresh checksum-verified upstream build passed complete model protocol/privacy, parser, retry, RRF, service, chat-pipeline, SQLite, types and container suites. All **29 Git-index pins** (12 patches and 17 Go regression assets) and **151 bundle artifacts** match SHA-256. Independent reviews found no remaining P1/P2 in the reviewed code and evaluation lifecycle changes.

The final reversible deployment preserved all **126** existing Wiki pages, all mappings, engine counts, model identities/configuration and the **15,468 /125** provider ledger. Its first attempt failed the business-state assertion and rolled back. A read-only comparison confirmed all recorded business state matched the backup after rollback. The cause of that first transient assertion is unresolved. The unchanged assertion passed on the diagnostic retry; both failure and backup evidence remain retained.

| Final deployment artifact | SHA-256 |
| --- | --- |
| Application archive | b031dbba47eb43b5178a865506ed759252e68e438cb6047f75f8c2365378b773 |
| Engine binary | eeff7b61f8300290638dc6fab881b71fa37827bfc33a9e64787a914a826dce2f |
| Engine manifest | a6d885f57f32e408191c140e03c23c9874e9ab5b22e1a4adf435ca758a5d64ba |
| Complete affected Go suites | 8becb1fa4745f1f5fa3465a3139319b8a6897d93e672324b736940ec660cbc24 |
| Deployment proof | 8935af5d71baa514d84799b52829f000d102045928787ff25416ec45af5a5c3e |
| Post-deployment MCP source/Memory/Evidence/ACL check | d8232c70d0396b313c019f8ce86626f97ee443f4051784010d49fd9f14b991eb |

The final MCP check found 121 tools and verified five actual Product body hashes, existing Memory/Evidence and foreign-user denial, with zero model admissions. The preceding full five-check MCP packet remains separate evidence: `4706c790ce165838bf2312b5183383b26e59d0d27baef60587bbba00c076de45`.

## Authorized calls and evaluation controls

After explicit approval of the same destination and data, the owner approved another **57 embedding /30 Wiki** logical admissions. This brings the batch limit to **117 /70**, measured from **15,406 /68**, with absolute maxima **15,523 /138**. Inputs remain the existing fixed 55 query texts, the same 839-character Wiki source and resulting draft/audit context at the already configured maas.qianwenaiapi.com Flash/qwen-plus models. Provider policies remain 200/hour, concurrency one and at most one retry; the cumulative embedding gate remains 16,000. Logical admissions do not establish exact billable HTTP requests or costs.

Temporary database admission guards enforce the absolute caps and are removed only after the bounded work completes, without changing the ledger. Earlier external-send auto-review rejections executed zero calls; the owner's explicit approval then permitted the diagnostic calls. Later deployment-package auto-review rejections were resolved by verifying package contents and the repository's public visibility, without sending private sources or credentials.

The unchanged HTTP runner uses the exact original global index, because merely filtering out added QA bases would still alter global BM25 statistics. The complete QA database is preserved before isolation and restored afterward. Evaluation controls also received real zero-model fault testing: the original watcher restored the database while an orphan query runner remained alive after parent SIGKILL. The corrected watcher stops the complete runner service before restoration. Restored engines run in independent scopes, and tests verify survival after both normal and SIGKILL exits of the temporary service. Review found and repaired both lifecycle defects before the actual final 55 run.

| Frozen input / lifecycle proof | SHA-256 |
| --- | --- |
| Fixed 55 fixture | 63f1adda80e849a8d92727d512de507019000ab9bfdb6476458250532bc4c271 |
| Source manifest | 6e151fcae5636df1e6a682294e4985b53d6a0e59054193112321142566188b95 |
| Original global embedding rows | cce2255abace0ed4e63903b5871229f6a7816b0180b5a04a257aa5716675fe0d |
| Same Wiki source | d3bd45f37d263df2a2cf2576730ae4a0b2163a75764e76d2375bec7a6ee88f8c |
| Runner parent-SIGKILL RED/GREEN | b9a58dc894e3433170b192c2b0627a566006982388b7994fcc9ee5cdc6441d81 |
| Actual CLI normal/SIGKILL engine-scope survival | 457403d5572f297eb92b926a11671dad96d140e3c1021d7f85d84907bfac21ba |

## Actual retrieval results

The first follow-up completed all 55 HTTP cases with 55 embedding admissions and zero source/version/ACL/publication/citation integrity flags. It recovered two former XML zero cases but introduced a VGL rank-ten boundary loss. The affected VGL query has no XML syntax; old/new corpus and keyword-SQL digests match and its first nine sources are identical. Its actual new query vector was not retained, so attributing that loss to XML code or model drift is unproven. That regression remains in the results.

| Metric | Previous repair | First follow-up | Final HTTP run |
| --- | ---: | ---: | ---: |
| Recall@10 | 0.864726 | 0.876089 | 0.908413 |
| MRR | 0.723304 | 0.756407 | 0.794394 |
| nDCG@10 | 0.728150 | 0.747777 | 0.794067 |
| XML Recall@10 | 0.557292 | 0.760417 | 0.781250 |
| XML MRR | 0.361111 | 0.601190 | 0.598958 |
| XML nDCG@10 | 0.376390 | 0.547459 | 0.585222 |
| VGL Recall@10 | 0.815873 | 0.615873 | 0.838095 |
| VGL MRR | 0.653333 | 0.633333 | 0.700000 |
| VGL nDCG@10 | 0.606576 | 0.548763 | 0.675506 |
| Zero-recall cases | 3 | 2 | 1 |
| Outside-reference returned pairs | 387 | 383 | 378 |
| HTTP P95 (ms) | 6950.42 | 6944.61 | 7115.67 |

The final run completed **55/55** HTTP requests and consumed exactly **55 logical embedding admissions** in the isolated ledger window. Integrity flags remain zero. The former XML zeros and the first follow-up VGL zero recovered; `source-occurrence-008db7099c19a1bf17585ee0` (version-filtered) remains zero. All 378 outside-reference query-source pairs remain semantically unjudged.

Two case-level regressions against the first follow-up are retained: version-filtered `00dd4d977f5255747d1365e4` nDCG 0.722295→0.718363 with unchanged recall/MRR; XML `05fdb189053ce31a6d91909d` MRR 1/7→1/8 and nDCG 0.156426→0.148041 with unchanged recall. Aggregate XML MRR slightly regressed (0.601190→0.598958), while XML recall/nDCG improved. HTTP P50 is 6531.51 ms, P95 7115.67 ms and max 9170.86 ms; P95 is worse than the first follow-up. These differences are reported without inventing a causal attribution or a pass threshold.

| Retrieval artifact | SHA-256 |
| --- | --- |
| First follow-up HTTP report | 9bcb4207c9fd4a19259aaa7877e5cbde47806c814a7ae067526e730a22f59811 |
| Final HTTP report | a69c4a20ff8735c44ab0a7a0c4f8409a38453e68e40407dfe30bc09fe64043d4 |
| Final restored index state | ad78da6cbf2809dd78d7e237dd85b2235642c14578be35ea0a3ff1ad399d3834 |


These are occurrence-reference metrics. Semantic Precision@10 remains unjudged, and HTTP search latency is not end-to-end Context Pack latency. No release threshold was inferred after observing results.

## Wiki source support remains failed

All trials retain the same 839-character source and upload filename, with separate QA bases and no automatic publication. Summary/citation preflight improved, but complete source support did not pass.

| Independent trial | Content pages / paragraphs | Citation preflight | Complete automated reviews | Automated page source-support passes | Supported / insufficient / nonfactual / invalid / unassessed paragraphs |
| --- | --- | --- | --- | --- | --- |
| Previous repair | 12 /49 | Summary chunk references missing | Incomplete population | 3/12 | 18 /8 /12 /4 /6, plus 1 contradicted |
| First follow-up | 12 /38 | 12/12 eligible | 10/12 | 2/12 | 10 /10 /16 /2 /0 |
| Final approved trial | 11 /32 | 11/11 eligible | 10/11 | **0/11** | 9 /10 /12 /1 /0 |

The first follow-up used 17 generation plus 12 audit Wiki admissions. The final trial used 16 generation plus 11 audit admissions and two source embeddings. One additional real gateway contract probe accepted temperature 0.3 and explicit enable_thinking:false using the same approved source; its asserted output was synthetic JSON, not factual acceptance. Its SHA is `f7abf3b09133465f4cbdf3afbecba49e511dac3beb18e3b745adadb42d4db2c7`.

The populations changed from 49 to 38 to 32 paragraphs, so these trials do not establish an accuracy trend. Read-only inspection found genuine extrapolations and inconsistent automatic classifications. Automated labels are preserved and every human factual/relevance label remains null.

| Wiki artifact | SHA-256 |
| --- | --- |
| First follow-up plan | 8c2aeae5ac94085a126441ab32389f04a0dca34ca3774d692e13f58d63e64a19 |
| First follow-up audit | f5d353223278188321badd04cd34d36135972589cbe275e7888b63d7884db577 |
| Final frozen plan | b47fe1065eaed85ed0c50e73478b3de225842abadec68aaa5d2094b2f5a0ecdc |
| Final audit | f3de223cc91adc7016176143d6dcefa3df1e0ed458d9061b1a4975ac36f03cd1 |

The source's eight explicit Markdown links all resolve to exact canonical sources; their hashes, versions, paths and published Relay mappings were verified. A private review-input packet contains 15,278 characters across the eight linked bodies (largest 5,190), with all human labels null. These additional bodies were **not sent to the configured maas generation/audit providers** and were not added to the frozen evaluation or native QA input. Packet SHA: `3b903649a7c4373cd916afb48a85bcad629db456a5b062f806c370756cdc0de5`. Earlier incorrect publication/composite lookup reports remain retained beside the corrected exact Relay-schema verification (`61d308c8011151230848746e59c7bf2e8af28aace53a53ea031bc4fd3c68d190`).

## Final state and remaining gates

Final source/citation/span and scoped privacy guards passed with **zero model admissions**. They verified the frozen 11 pages /32 paragraphs, 22 source-chunk checks, 165 exact spans and all 114 earlier pages. The complete QA database returned exactly to **7182 documents /58859 chunks /3 models /7 bases /126 Wiki pages**. The actual engine remains ready in its independent scope after both evaluation units ended. All 5372 migrated documents remain published.

The scan covered 1,840,916 new log bytes and 121 selected operational metadata rows since the final-stage preflight, checking 10 actual credential values, six selected source fragments, JSON raw-query values and URL-encoded query forms and hidden-reasoning markers. SQL MATCH parameters remained placeholders. This is a scoped check, not a universal privacy claim; old logs and failed reports remain retained.

Private human-review materials contain **550 query-source pairs /483 verified canonical sources /550 cited chunks /32 Wiki paragraphs**, with all human labels null. Supplemental read-only mapping of the 11 insufficient/invalid paragraphs against the eight linked canonical bodies found 2 full, 8 partial and 1 absent direct matches; 9 still have assertion/scope gaps. This model-agent diagnostic is not expert gold, changes no original labels and adds no managed-model calls. It identifies missing linked context, abbreviation guesses, historical qualifiers, grouping generalizations and unsupported module purpose as remaining problems.

| Final evidence | SHA-256 |
| --- | --- |
| Source/privacy/budget/runtime guards | 1bbba0d08269f93e5e1411c66d1604932532c77fdb97f47c40fc38f6c027f82f |
| Exact admission-guard removal | 6458a849380785d942d893df8a0789f9e5cdc8c6188306648d68cf52ec5fc2cb |
| Private retrieval review inputs | 8722c0221e9cfe7494af04b85c9fec743b313a61d985155f899de002b39d0488 |
| Private Wiki review inputs | 1f85e73ec98ea5cc11225ef925eaf64b2259d2dcc44e80a5a33c435ee90dcb5c |
| Private review manifest | befa5585bf72a9befba474f8d23086e21dfe5f0ee06d9200db204a4722a92ad8 |
| Supplemental linked-source paragraph mapping | 091067bc87c3601c251722581d18069801721bc5c27f01eb83d32ebc27e3df52 |

Final retained ledgers are **15,523 embedding /125 Wiki**: this batch used **117 /57**, within the owner's **117 /70** cap and below the 16,000 cumulative embedding gate. The temporary guard was removed only after completion and exact SQL-hash verification, with no admission rows changed. Providers are ready at 200/hour, concurrency one, retry one. No model work or evaluation watchdog is pending. No further embedding is authorized by this batch; 13 same-scope Wiki admissions remain unused and none are scheduled.

Existing entity image enrichment is retained; raw-text-only summaries fail closed for OCR/caption-only input, and this text-only trial does not validate image-grounded factual claims. Retraction requests may still contain generated summaries. Map-to-reduce snapshot verification, Memory negative-BM25 score calibration, and bounded-candidate/vector-tie membership remain separate limitations. The broader #42 and real Windows #11/#19/#32 acceptance work is not claimed complete by this packet.

Wiki factual support, human semantic/factual adjudication and agreed release/performance thresholds remain open. No failure record was removed or relabelled, no Wiki draft was automatically published, and no production deployment or merge occurred.

## Continuation: source-grounded drafts and heading retrieval

The eleven failed QA pages were reviewed against their current cited source and the eight linked canonical bodies. The linked bodies belong to the full-corpus KB and a different project/environment scope, so they cannot be added as citations to the isolated QA pages without a new authorized indexing operation. No cross-KB citation or new embedding was used to bypass that boundary. Unsupported acronym expansions, module purposes, functional hierarchies and unqualified historical behavior were removed instead.

Each page was edited through the actual `EngineWikiService` adopt/edit/revision path with a privately resumed and hash-verified existing source. All eleven are revision-two **drafts**, all revision-one bodies remain readable, and no page was published. A separate deterministic exact-span revalidation covers **11 pages /26 paragraphs /23 factual claims** with complete structure and exact cited spans. It is not a model audit, independent expert review or human factual approval; every human label remains null. Repair report SHA: `e5bf76d8604595b4208c0e5a0e49e79029671464567e77c0e11054920cc396c1`; exact-span report SHA: `416b70fcff976afeade5a041fd71e4baba043f1d4a991500f7d4faef827d693c`; private human packet SHA: `6d01ef713586949353f62ff93c9dc8a9e1430f795de85e8d83e19ff60c002e2b`.

Patch `0013-xml-heading-retrieval` adds Markdown-heading element recognition and preserves structural flags when vector metadata is merged. It changes keyword ordering only; raw BM25, RRF weights/formula, corpus, labels and returned source bytes are unchanged. The focused tests failed before the patch and pass afterward, as do the complete affected Go packages. Cached-vector replay against the exact original global index moves the title source in `008db` from source rank 51 to 1; one of its four reference sources is now in the Top10. This resolves the cached zero-recall condition but does not claim full recall or substitute for the frozen HTTP run. Patch SHA: `0f5c03fa2f7daec721fdb4ac1d92baca703aaf9a348ebba3664e5699a29ed978`.

Before the new HTTP run, the owner confirmed these automatic gates: 55 completed cases, zero integrity failures and zero zero-recall cases; Recall@10 ≥ **0.908413**, MRR ≥ **0.794394**, nDCG ≥ **0.794067**, XML Recall@10 ≥ **0.781250**; search HTTP P95 ≤ **7,500 ms**. Semantic Precision@10 requires all **550** returned pairs to receive actual human review and reach **0.90**. Every factual Wiki paragraph requires human `supported` adjudication. Context Pack latency and its threshold remain a separate unmet release gate. The owner authorized exactly **55 new logical embedding admissions** for the frozen query texts to the existing Flash provider, with no Wiki generation or audit calls and no ledger reset. Final measured outcomes and human review remain pending at this point in the report.

Application verification passed **861/861** tests with zero skips, the standard build, strict TypeScript and quality self-tests. The fresh standard engine build passed all affected suites and produced **155** bundle files with **13** patches / **19** pinned regression assets. Binary SHA: `2d619f6b5f6846cc7d1803d674f72110b5b43c73f0b89af7812e4d88820c2826`; manifest SHA: `066669831f2f7b77f3ac42bde041c7f1b295719a5381e4720495f90e85d05e92`; deployment proof SHA: `5d5d87a09f33c9f5e9fbd6bb26182328d94c9bba712bab5f870ab41499ebbcac`. A first build stopped at the official 7-Zip download; the standard installer then used its existing verified-archive option with the same pinned SHA. The optional `RELAY_7ZIP_ARCHIVE` build input does not bypass archive or binary verification. The earlier network-only failure is retained.

The first HTTP attempt received **401** on case one because the isolated admin JWT had expired. It made **zero** embedding and Wiki admissions, and the complete QA state was restored. A formal nonproduction login renewed both admin and foreign tokens before a separate isolation cycle; the failed report and lifecycle artifacts are retained rather than counted as quality results.

## Final continuation outcome

The second isolation cycle completed **55/55** real HTTP queries against the exact original global index. It used exactly **55** new embedding admissions and zero Wiki admissions, then restored the complete QA state including all eleven revision-two drafts. The automatic retrieval gate **passes every owner-confirmed check**:

| Metric | Previous final | Continuation |
| --- | ---: | ---: |
| Recall@10 | 0.908413 | **0.912958** |
| MRR | 0.794394 | **0.812900** |
| nDCG@10 | 0.794067 | **0.801334** |
| XML Recall@10 | 0.781250 | **0.781250** |
| XML MRR | 0.598958 | **0.601190** |
| Zero-recall cases | 1 | **0** |
| Integrity flags | 0 | **0** |
| Outside-reference returned pairs | 378 | **377** |
| HTTP P50 (ms) | 6531.51 | **6650.16** |
| HTTP P95 (ms) | 7115.67 | **7127.75** |
| HTTP max (ms) | 9170.86 | **8723.37** |

The title source in `008db` is now retrieved and no case has zero occurrence recall. One VGL case, `source-occurrence-f593187e924ec57c43b55653`, retains a small nDCG regression of **0.006287** with unchanged recall/MRR. Four cases improved and 50 were unchanged. Semantic Precision@10 remains unevaluated: all **550** new query-source pairs, **484** canonical sources and **550** cited chunks were verified into a fresh private human packet, but all human labels remain null. Final HTTP SHA: `93d6f082ed523d4c3b21cea8041b0654ef764874c32121dff0517ddf48ea2e80`; automatic gate SHA: `367f00577e4ee2c88667ee025b8d90df09d9a845cd936ad5ff82519619880017`; case comparison SHA: `2da23d8552d5f6868ab690f7874a597edb90d3e98b49619c311cb7e9facd00a5`; private retrieval packet SHA: `3eea7dde9a3026fdadcbcf9914f0575c2434128d170b658a43307e774326d19a`.

The runner initially reported a failed final assertion because cumulative admission rows fell from 15,523/125 to 7,167/98. Read-only reconciliation proves the 24-hour retention cleanup removed old rows while exactly **55 embedding /0 Wiki** rows were added in this batch; there was no ledger reset or negative invocation. The failed assertion is retained and the final guard checks the actual time-window population instead. Reconciliation SHA: `6249a343ca44fe940af81eb1fc185826c3c2a5f15296680394956b1edc9ac2a8`.

Final MCP verification passed 121 tools, five actual Product body hashes, Memory/Evidence preservation and foreign-user denial with zero model admissions. Initial MCP attempts lacked the seed-compatible default project/environment claims and were corrected by reissuing short-lived nonproduction tokens with the established seed scope contract; no ACL or mapping was relaxed. MCP SHA: `32595b8ac1805a8178f72afe7e17f2ab82bdb1217d815eb69017414d37e3c7a7`.

Final guards passed **11 pages /26 paragraphs /22 chunk checks /165 exact spans**, with **115** unrelated existing Wiki pages unchanged, all **5372** migration records published, providers ready at 200/hour, concurrency one and retry one, and no pending work/watchdog. The scoped privacy check covered **1,793,358** new log bytes and **56** selected operational metadata rows with zero new matches in the stated credential/source/query/hidden-reasoning scope. Final guard SHA: `c96a60d5562b049e54a8b3cd599c153fe79a1e0f6e31c14c65771c37042cd48e`. The separate 100,000-chunk hot-cache FTS baseline passed at P95 **0.312 ms**, which does not replace HTTP or Context Pack latency.

**Disposition:** the automatic frozen retrieval gate is green. Human semantic relevance, human Wiki factual adjudication and the separate Context Pack performance gate are still open, so #55/#56 and aggregate #43/#49/#50 remain open. No Wiki draft was published, no PR was merged, and production was not changed.
