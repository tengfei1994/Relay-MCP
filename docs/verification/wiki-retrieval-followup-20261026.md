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
