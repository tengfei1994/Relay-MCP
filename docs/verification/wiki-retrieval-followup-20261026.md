# Wiki source and XML retrieval follow-up — 2026-10-26

This continues [draft PR #62](https://github.com/tengfei1994/Relay-MCP/pull/62) on #61 in nonproduction. Fixed55 queries, occurrence references, corpus/version/ACL filters, metrics and closure gates remain unchanged. The owner has not agreed semantic Precision@10/end-to-end P95 thresholds; #55/#56 and aggregates remain open.

## Proven causes and repairs

Implementation18c1b8f follows the [previous evidence](wiki-retrieval-quality-20261026.md).

- **Wiki summary provenance:** the map stage omitted summary chunk IDs and the reducer explicitly cleared them. Summaries now use only bounded current raw text input (32768runes, final chunk may contribute a prefix), record exactly supplied chunk IDs and replace stale source/chunk references. Missing evidence preserves the old draft. Exact document/tenant/enabled/text ownership and ambiguous-ID guards prevent foreign evidence from satisfying another source.
- **Wiki authority:** additions no longer send generated DocSummary framing to the editor. Generic policy prohibits inferring semantics/status/relationships from identifiers or reference-list membership/absence and removes the remaining SUMMARY minimum length. Raw input and entity matching remain distinct. Prompt instructions are not an entailment guarantee.
- **XML:** explicit element syntax survived canonical/index storage but was flattened into ordinary prose terms. Structural preference now precedes the bounded SQLite candidate cutoff and survives keyword rank derivation through fusion. Tag names, case, namespace and boundaries are preserved; multiple tags are conjunctive, values are bound SQL parameters, ordinary lexical fallback remains. Raw BM25, RRF weights, vector ranks and final fusion formula are unchanged. The internal preference flag is omitted from JSON. Preference beyond the inspected order-preserving Product/no-rerank path is not claimed.
- **SQL privacy:** managed INFO suppression did not stop GORM slow/error traces from expanding parameters. Parameterized runtime logging and GORM's supported once-installed Scan recorder filter retain placeholders and duration/row/error diagnostics. Bound values are protected; directly constructed SQL literals and database-origin error text are outside this filter. Old logs remain private and retained.

Eight actual-service Wiki regressions showed RED then GREEN. Real SQLite-to-fusion tests prove SQL-only ordering fails both hybrid and keyword-only paths; the full repair passes. Actual GORM SQLite tests independently reproduced and fixed Info, Scan, slow Warn, error and record-not-found value exposure. One prior injected regression deliberately changes from requiring generated summary context to forbidding it; every other raw-source/table/ref assertion remains.

All857 application tests pass (zero skips), standard build passes, Python22/22 and final installer/hash/privacy19/19 pass. A first sandbox run853/857 had exactly four Python child-spawn EPERM failures; retained logs and unchanged normal-permission rerun are recorded. Independent reviews found no demonstrated P1/P2 within the stated scopes. Fresh source build passed complete model/privacy/parser/retry/RRF/service/chat_pipeline/SQLite/types/container suites. All23 Git-index pinned assets (10patches/13testfiles) and145 bundle artifacts match SHA-256.

## Deployment and bounded trial

Reversible deployment preserved all101 prior Wiki pages,7174mappings, native counts, model identity/configuration and current provider ledger before newQA. No production change or merge occurred.

| Artifact | SHA-256 |
| --- | --- |
| Application archive | 8dda96f624b7a41ff32b474b8ab0ea125d4ac907f2114afebd34c842a6be6e8a |
| Engine manifest | 15ca3b5c1f474535a905c3013323ac8c5cd62fa7ed5fd43c953fd6fbc7afed3b |
| Engine binary | 5a9d4f3d7a852e2fed39091fce8be12139a1197c49ad48f3ce9bd26a1512fc58 |
| Complete affected Go suites | ee485859ca3be70bcba5d3d040fd6063e915b3780ce3cdf47fd34a0d356588c8 |
| Deployment proof | ef317844aec067f9253b4c27523cd063cbe5b9e509dc3743c0a8e3ee827767f8 |
| Final MCP5/5 report | 4706c790ce165838bf2312b5183383b26e59d0d27baef60587bbba00c076de45 |

Auto-review initially rejected two diagnostic embedding calls twice without executing them, requesting explicit external-send authorization. The owner then explicitly approved the existing fixed55 query texts, identical839-character Wiki source and new draft/audit context to the existing maas.qianwenaiapi.com Flash/qwen-plus models, maximum60embedding/40Wiki logical admissions, existing200/hour ceiling, concurrency1/retry1 and cumulative16000embedding gate. Two missing diagnostic vectors were then captured privately. No new model/destination or ledger reset was introduced.

The identical source and upload filename were submitted to a separate nativeQA base. Generation used17logical Wiki calls and2embedding calls, yielding12content pages/38paragraphs plus navigation. All12 passed explicit chunk-reference preflight. A20-generation allowance and independent watchdog bound work; the provider is stopped and draining before restoring the original200/hour policy. No prior page was edited or published. Frozen plan SHA8c2aeae5ac94085a126441ab32389f04a0dca34ca3774d692e13f58d63e64a19.

The unchanged audit completed12calls:10completepage reviews, only **2/12** automatedsource-support passes, supported10/insufficient10/nonfactual16/invalid2. No contradicted or unassessed paragraphs were returned. This does not demonstrate factual improvement: the page/paragraph population differs from the earlier49paragraphtrial, and read-only expert-preparation inspection found both genuine generated extrapolations and inconsistent automated judgments. A supported-labelled paragraph also misplaces obsolete items into a reference grouping. All automatedlabels are retained, and every humanlabel staysnull.

All55HTTP cases completed with55embeddingadmissions andzero source/version/ACL/publication/citation integrity flags. Identical originalglobalindex cce2255abace0ed4e63903b5871229f6a7816b0180b5a04a257aa5716675fe0d was used and completeQA state was restored afterward (7181documents/58856chunks/6bases/114Wiki pages).

| First deployed follow-up vs previous | Previous | This run |
| --- | ---: | ---: |
| Recall@10 | 0.864726 | 0.876089 |
| MRR | 0.723304 | 0.756407 |
| nDCG@10 | 0.728150 | 0.747777 |
| XML Recall@10 | 0.557292 | 0.760417 |
| XML MRR | 0.361111 | 0.601190 |
| XML nDCG@10 | 0.376390 | 0.547459 |
| Zero-recallcases | 3 | 2 |

Both former XMLzero cases recovered;008db remainszero. A VGLsource that previously ranked10 disappeared from the top10, so VGLrecall fell0.815873→0.615873. All fiveVGL queries have no XMLsyntax, old/new corpus and keywordSQL digests match, and the top9sources of the affected query remain identical. The actual newqueryvector was not retained; attributing this boundary swap to XMLcode or model drift is unproven. The loss is preserved as a regression, not omitted from the report.383returned query-sourcepairs remain outside occurrence references; semanticprecision isunjudged. HTTPp50=6459.75ms,p95=6944.61ms,max=7157.11ms, not fullContextPack performance.

| First live follow-up artifact | SHA-256 |
| --- | --- |
| Wiki audit report | f5d353223278188321badd04cd34d36135972589cbe275e7888b63d7884db577 |
| HTTP report | 9bcb4207c9fd4a19259aaa7877e5cbde47806c814a7ae067526e730a22f59811 |
| Restored index state | 38c208556c42723d1679d53b7329b2d36c962c59d368580e4bdcccd0d9c30487 |
| Final source/privacy/budgetguards | 85b9d9e910afe25ecb80ceeb47b9a0fd6d42aba8438e90bb2e06eb34ba212f0c |
| Private550-pair retrievalcontext | d16eb4dd5eee36188e2a9b4558717d193e9ea1645ac9e7ff119e65fc12d85c90 |
| Private38paragraphWiki context | 463b358c713848c3af8ceaffda7edb33e0353757ff8187d12524d568fadfb705 |

All101oldpages,12new frozen pages/38paragraphs,24sourcechunkchecks and180exactspans matched finalguards.1,677,568newlogbytes/136selectedmetadata rows passed actualcredential/source/JSON/encodedquery checks; slowSQLMATCH values were placeholders. The temporary60/40admissiontrigger was removed withunchangedledger. Currentcounts15466embedding/97Wiki mean this batch used **60/29**, with0embedding and11Wiki admissions left. No extra embedding isauthorized until the owner increases the explicitbatchcap.

## Further concrete repairs after that live evidence

Code64be666 preserves nativechat samplingcontrols. The nativeWiki requests temperature0.3, but Relay previously dropped it beforeproviderHTTP. Optional validatedtemperature and recognizedexplicitthinkingcontrols now pass gateway→handle→serializer, withrealHTTP RED→GREEN and backwardcompatibility. An independentP2(array-valuedthinking.type coercedthenreversed) was reproduced and fixed withstrictstringenumregressions. Nativegeneric adapter may omit Thinking:false beforeRelay receivesit; this repair doesnot invent a default or claim actualthinkingdisabled.

0011preserves query-declared wholeunderscore identifiers. OrdinaryFTS splits these into prose tokens; in the VGLcase exactlyone indexedchunkcontains the whole identifier anditis an expectedsource. General, bounded, parameterized wholeidentifier preference now survives cutoff andfusion without case IDs, app-specific strings, weightchanges orlabel edits. Paths/filenames/numericversions are excluded; XMLmatching isunchanged. Nativecachedvector replay moves thatsource10→3, but this isCPU evidence, not a secondactual55run.

These two repairs passed861/861application tests, normalbuild, related44tests, full affectedGo suites and independentreviews. A first861run retained one unchanged5secondMCPstartupguard timeout; focused1/1passed2.269s and the unfiltered861rerun passedzero skips. Newassets comprise11patches/15regressionfiles,26pins. The fresh combined build passed all complete gates and148 artifact hashes. The second reversible deployment preserved all114 priorWiki pages, mappings, configuration and15466/97providerledger. Enginebinary SHA daaf4febed839e3f6968d843267f7dfe7061a095fc0cfba3863932ffa9fe201b; manifest c5911fc3a94cfe26dfe84aa6959cbf732ae6fd513e430bbe914630992c9335da; Go suites e5c72d2d5407f4363485670c2a7ace58b4dbf276fda5d8e5fd1a07dfd5ce3955; deployment proof d17298834753492ecd84fc1174c2a4da460f405220c909807317b76e08eb7643.

One real gateway contract probe sent the same approved source with temperature0.3 and explicitenable_thinking:false to the existingqwen-plus endpoint and was accepted; its only assertedoutput was syntheticJSON, not factualcontent. This madecurrentbatch use **60embedding/30Wiki**, ledgers **15466/98**. ProbeSHA f7abf3b09133465f4cbdf3afbecba49e511dac3beb18e3b745adadb42d4db2c7. Actualnative thinkingfalse propagation remainsunproven when the nativegenericadapter omitsit.

Another full55 evaluation and a new independentWiki generation/audit require an explicitbudget increase. Current60/40authorization is not silently exceeded. No new factual or retrieval pass is claimed from CPUreplay or controlacceptance.

## Remaining boundaries

The cached-model CPU diagnostic suggests two zero-recall recoveries. The remaining008db case has only one reference source containing its literal tag; the others match only part of the query. That is unresolved evidence, not permission to change labels or add a case exception. Actual55results will be reported with all regressions.

All human semantic/factual labels remain unjudged. Existing entity image enrichment is retained; raw-text-only summaries fail closed for OCR/caption-only input, and this text-only trial does not validate image-grounded factual claims. Retraction requests may still contain generated summaries. Map-to-reduce source snapshot verification and Memory negative-BM25 score calibration are unchanged. No broader completeness claim follows from these repairs.
