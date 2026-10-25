# Full 21.3 corpus acceptance: corrected source and Flash migration

This is a progress and failure report, not a full-corpus acceptance pass. All actions described here used the isolated `ftd1994-codex` nonproduction environment. Production was not changed.

## Frozen source and budget

The original 21.3 archive SHA-256 is `256b2a52562f321f2788205605436e5e00272060ad76c20263c637672c4b7342`. The corpus contains 5,372 HTML documents after excluding two empty MadCap shells. Identical bodies at different source paths remain distinct sources.

Candidate v3-b uses the structure-preserving `html-3` parser. All 5,372 normalized bodies passed the independent heading, table, code, image-reference, link and anchor comparison. This proves preservation of references, not delivery of image assets to a browser. The report SHA-256 is `b6f53231679653f17489729452d9702a1c2245cc84366207199686280e893c76`.

| Frozen artifact | SHA-256 |
| --- | --- |
| v3-b manifest | `6e151fcae5636df1e6a682294e4985b53d6a0e59054193112321142566188b95` |
| Source/runtime freeze | `c9814a45b8c442258099eee8977351f9e42cbff5250139cfbe04ee5c9733a4fd` |
| Native preview budget | `0381e5e42b133852515bd0d4a1f25a26c636f0229943e2d93e4d4cf6194308af` |
| Thirteen actual HTTP-preview calibrations | `c04bd5d1047cc25cab94ecd2a84ed5d68cbc090a0f2460107d9abbe2ff1ef9fd` |

The frozen preview predicts 44,833 indexable chunks and 11,248 logical embedding batches. Its approximate input count is 4,603,362 tokens; this is an upstream approximation, not a billing tokenizer. The user approved an amended ceiling of **15,000 logical embedding calls per 24 hours**, with concurrency 1 and at most one retry. Prior usage remains in the ledger. The lease retains its original expiry, 2026-10-26 13:10:29 UTC, and restores 200 calls/hour. Wiki and Candidate quotas remain unchanged.

## Topic projection repair

The acceptance corpus has 4,970 source topic bindings and 402 intentionally unbound documents. Its separate topic projection retains the original source topic IDs and canonical keys as provenance.

An independent validator found that opening `KnowledgeStore` repeatedly backfilled the unbound rows and modified 400 existing topic timestamps, including four titles. Existing bindings were unchanged. The conflict handler now preserves an existing canonical topic instead of overwriting its title and timestamp. A regression reproduced the mutation before the fix and passed afterward.

After deploying the fix, a full-field compare-and-set repair restored only the 400 proven backfill changes from the pre-seed snapshot. The original failed report and repair audit remain available. Independent revalidation passed all 5,372 documents and 4,970 projected bindings, with **zero changed legacy topic rows, zero changed legacy binding rows, and zero foreign-key violations**.

| Evidence | SHA-256 |
| --- | --- |
| Original failed topic comparison | `2d7e52b5d6168ae159dd11fc6820b9af3bc7e84e56f9946da7684fe50ed73fa3` |
| Reviewed repair plan | `83d931552c6ae23d822d7478fa67d4b30695110d2eeda96de8e46d0538dd6e35` |
| Applied repair audit | `e53b7b0e82bad4f345d560844ed178ee757f30f004a0664a8012cc92dd3c550b` |
| Independent post-repair pass | `b034926915d45d2c8b4148a0965cf8859e7ec3c5c79ab9f54324e7478bbe5e20` |

The application deployment containing this repair passed **686/686 tests, zero skipped**, and the standard `npm run build`. A preceding sandbox run failed four Python-subprocess checks with `EPERM`; the complete normal-environment rerun passed. The build retains a nonblocking Vite main-chunk size warning. These results precede the subsequent provider and engine fixes; they must not be presented as final validation of those changes.

## Actual indexing exposed additional blockers

Migration `migration-d15fd3b1-c964-4483-90b7-c89502629b31` was suspended with 357 accepted mappings and 339 upstream-verified mappings. No full-corpus publication occurred. The checkpoint retained external IDs, chunk IDs and hashes; the engine had zero active ingestion tasks before the migration child was stopped. Checkpoint SHA-256: `6e4a3c4a24a4d51b129458e06184c4c3d5b3a035f06ead39271890d003e4ec59`.

Independent verification found that 250 of the 339 verified mappings exactly matched the frozen native chunk hashes. The other 89 did not: 72 had different chunk bytes and 17 had different chunk counts. All 89 stored uploaded files still matched their normalized source hashes. CPU reproduction identified the cause: the upstream upload pipeline removed outer hyperlinks around Markdown images, while preview did not. Applying that transformation reproduced every mismatching chunk exactly. It removed 117 distinct outer image links in these 89 documents; the full frozen corpus contains 2,225 such links across 1,611 documents, all targeting a different image from the inline source. The validation expectation was not weakened to accept this loss. Diagnostic SHA-256: `609f634b67e6f4dc1dac79a3c4a731c149073c832a1d74adadf3154f0af345d4`.

Separately, the embedding gateway recorded 32 `unauthorized` failures followed by 546 circuit-open rejections. Legacy audit stored only the category and cannot distinguish historical HTTP 401 from 403. One subsequent fixed-text embedding probe on 2026-10-25 14:58:35 UTC returned **HTTP 403**, increasing the ledger from 3,959 to 3,960. A single read-only model-discovery request returned HTTP 200, and Wiki generation with the same token succeeded. These facts do not establish whether the embedding refusal is caused by model entitlement, billing, quota or another service-side policy. No corpus retry was made to diagnose it.

A subsequent CPU-only budget reconciliation found 356 durable migration rows (339 staged, 17 failed) and one additional accepted mapping whose migration row had not yet been checkpointed. The remaining forecast is 10,564 batches for not-yet-mapped sources, 39 for failed rows, 241 to repair the 89 damaged indexes, and 55 online queries. Added to the retained ledger of 3,960, the forecast is **14,859 logical invocations**, leaving **141** below the authorized ceiling. This is not a guarantee: additional faults or explicit reprocessing would consume headroom, and the durable 15,000 ceiling remains enforced. No historical admissions are refunded.

The old admission ordering also counted circuit-open rejections before any HTTP attempt. Historical ledger entries remain intact; the repair must stop counting new transport-free circuit rejections and retain one admission for a logical invocation with retries. A migration must preserve the failing document checkpoint and stop before submitting another source when the bound provider fails.

## Verified nonproduction upgrade

The subsequent application revision passed **703/703 tests, zero skipped**, the standard `npm run build`, explicit strict type checks for the changed frontend components, and **16/16** independent Python validator tests. It includes provider circuit/queue/admission corrections and the migration stop-after-durable-failure-checkpoint guard. An independent three-document review exercised success, accepted-ID failure, restart, and continuation: the completed source was not retransmitted, the failed accepted ID was retained, and only the remaining source was uploaded.

The managed engine was stopped, backed up, installed and started using Relay's existing lifecycle commands. The new bundle keeps upstream v0.8.3 and adds separately locked patches for linked-image preservation and disabling automatic **document-processing task** retries in the managed runtime. The existing gateway provider `maxRetries: 1` remains unchanged. This distinction prevents an upstream default of three task retries from repeating an entire paid document independently of the gateway policy. Nonmanaged upstream task defaults and other task kinds remain unchanged.

All **127** bundle files and three binary-bound regression proofs passed verification. CPU execution of the patched upload pipeline matched the frozen hashes for all **5,372 documents / 44,833 indexable chunks**. The actual Lite queue consumed the service's options and executed one failing document attempt; there was no automatic second attempt. During installation, the existing pinned 7-Zip tool was reused and reverified after its download endpoint temporarily failed; no source or lock was relaxed.

| Upgrade evidence | SHA-256 |
| --- | --- |
| Final bundle manifest | `e07cb7135368d52c9fa0c92f7576f4f88533e87288f533340b4d5ea9e5266a4d` |
| Running engine binary | `3b853e4eb4424e521ce5c5602c41e19ee500eea799e6cc625759dcdf1a0ba426` |
| Pinned source/patch lock | `6285dcc056b3ed3fe8c0b5e9575430c117e3171b0fea3f6db748d3fd54da348a` |
| Full corpus patched CPU pipeline | `f2c5668f3a4faf70316ae8a242822c29cf5a5166e9eee6b6fffb6fb0d01d902f` |
| Actual Lite single-attempt proof | `7e0dfe24e3d24f04f13616006d8629b9b62549312dd4c1f01a733e0c0e76f27b` |
| Independent bundle verification | `6301f65df8301c13c312e7e642aee068a5859a8cbd84b9a38070a71739494b26` |
| Actual upgrade and state-preservation proof | `126f8911abd3d248e07c49a0a870a7e7db34a87ad29737c8239de7a97285d423` |

The restarted engine is ready. All application mappings/chunk-ID lists, engine document/chunk/model/KB counts, control configuration, runtime credentials and endpoint identities were preserved. The live process has the managed no-document-retry flag enabled. Embedding ledger remains **3,960**; no repair, reparse or new model invocation occurred during upgrade. The old affected indexes are still not accepted as corrected merely because the binary changed.

## Quality evidence and remaining gates

The same frozen 55-query fixture was remapped to v3-b without changing queries or relevance labels. Local FTS completed 55/55 cases with Recall@10 0.75272727, MRR 0.73863636 and nDCG 0.72503323. This is a local control result, not remote retrieval acceptance or human semantic judgment. Baseline report SHA-256: `de6fdfb80ac491ca181efefabd58c2229cd4560798d219b03ab6981b9ba0a683`.

The separate [Wiki source-consistency review](wiki-source-consistency-review.md) made 17 logical calls and found 37 source-supported paragraphs, 29 with insufficient support, 38 nonfactual paragraphs, and 12 paragraphs without completed validation. Its 14 complete page assessments do not mean 14 factually correct pages. No Wiki was edited or published by that review.

The [real HTTP/MCP privacy acceptance](knowledge-mcp-real-acceptance.md) and [isolated fault matrix](knowledge-mcp-fault-acceptance.md) are independently recorded. The fault matrix used real handlers and sockets with injected faults and made no model calls.

At that checkpoint, the old model's HTTP 403 still prevented reprocessing. The subsequent model switch below supersedes that execution plan. Issues #52, #55 and the aggregate #56 remain open; no partial result authorizes closing them.

## Authorized Flash restart — 2026-10-25 16:00 UTC

The user's saved production configuration was read without modifying production: its actual model ID is `qwen3.7-text-embedding-flash`, not the initially stated `qwen3.8-text-embedding-flash`. Nonproduction was configured through Relay's Provider Setup with that exact saved model. The formal probe returned HTTP 200, 1024 dimensions and 94 ms. The embedding admission ledger increased from 3,960 to 3,961. This does not establish why the former model returned HTTP 403. Model-switch report SHA-256: `e72e439f263c4e91857239e9ddc448c3eb29b2278d17f9a7cd885c7277738e68`.

The user explicitly approved **16,000 logical embedding calls per 24 hours**. The previous ledger remains intact, concurrency remains 1, provider retries remain at most 1, and automatic whole-document retries remain disabled. The existing lease expiry and restoration to 200 calls/hour are unchanged. The forecast is 3,961 retained admissions + 11,248 full-corpus embedding batches + 55 retrieval calls = **15,264**; the difference is contingency, not authorization to reset or discard prior usage.

The new model has its own KB and index generation. The corrected source manifest is unchanged; neither the old damaged indexes nor their failure evidence were deleted or adopted as Flash results.

| Frozen migration identity | Value |
| --- | --- |
| Migration | `migration-d09f8da0-9f7c-4501-b3d4-1ff8ada653f5` |
| Operation key | `full-213-v4-flash-6e151fcae563` |
| Source environment | `nonprod-full-213-v3` |
| Parser operation | `html-3-engine-full213-v4-flash` |
| Engine KB | `c5c3bc14-c3e6-4b93-8147-87a3bfa0e29a` |
| Engine model | `019fe3eb-5e8d-4996-918a-5cdfd88f00a7` |
| Relay provider/index | `qwen`, index version 2, 1024 dimensions |
| Launch manifest SHA-256 | `b3d2657b61a43e3523294fe452a6ae8d816130372b4d6a1a8bd82743d51b6538` |

At 16:00:09 UTC the durable job reported **1,105 mapped, 0 failed, 4,267 pending**, with 6,231 retained embedding admissions. An earlier independent read-only content pass checked **744 stored files and 6,275 actual text chunks** against the immutable source and native-preview hashes, including embedding/vector-row presence: **0 mismatches**. This is partial validation, not a recomputation of the model's vectors. Report SHA-256: `314e8d97df91fc89e717b4ff0c1803f0c8f53d810805e112e9ef9ff305b7fe8e`.

The independent validator now requires explicit migration/operation/provider/model/index/KB/alias/parser/dimension and expected provider status. It excludes old mappings sharing the source environment. Its 12 regression cases pass. `pending_reindex` is explicitly expected during construction; full completion must run with `--require-complete`, and a later formal status transition must use the corresponding explicit expected status.

The subsequent application checkpoint passed **734/734 tests with zero skips** and the standard build. A further review then found three bugs requiring new verification: a queued/retried provider request could cross model generations; existing Session operations did not consistently recheck current token scope; and a parser upgrade could leave a topic binding on its old document. These fixes are in progress and are not retroactively covered by the 734-test checkpoint.

Remaining gates: independently validate all 5,372 new mappings; complete model reindex and publish only verified results; run the frozen 55 online retrieval cases and scope checks; demonstrate no-growth replay, checkpoint recovery and rollback; resolve the documented Wiki support gaps; and complete current-build browser/operational/privacy and release verification. The Wiki supplemental review is separately recorded in [its evidence report](wiki-source-consistency-review.md); generation/reference integrity alone does not establish factual quality.

## Actual application restart during Flash migration

The provider binding/credential race, disabled-provider configuration recovery, current Session authorization, paginated Session summary and parser/topic-binding corrections passed **779/779 tests, zero skips**, and the standard build. Application archive `d13e00182ca549f5d2dc186328e490cb8581700fa049620c0ced212ae18a0b22` was deployed with the engine unchanged. The worker was stopped only after the engine became idle and a private checkpoint was saved; the original migration/job/key was resumed through the formal API.

The checkpoint contained **3,891 verified mappings**, plus one local pending-upload placeholder whose external document had already completed indexing. After restart, all verified mapping identities/hashes/chunk lists were unchanged. All **3,892 prior engine documents and 32,076 chunks** remained, with zero added or missing chunks for those documents. The pending placeholder adopted its already-existing external ID; it did not upload again. New documents continued normally.

| Restart proof | SHA-256 |
| --- | --- |
| Pre-restart checkpoint | `cbe207ff1c22f878c4dd9c0271b515192be739aee777d61971072d335a63fb9a` |
| Formal resume response | `1a572d6494d624aaf29a0e2d8a97286a87f1f74b168b84a398064578738d3db8` |
| Corrected independent continuity report | `0984ed48aa66906b1bd325f57a05170af384094a2c57ba4edef0d55ebbe84482` |

The first continuity report treated the unverified pending placeholder as an immutable accepted external ID and failed. That report is retained. The corrected check permits only a pending placeholder resolving to an engine ID already present in the checkpoint; verified rows remain immutable.

The following local checkpoint, including the separately discovered Job environment propagation correction and isolated Solution contract regression, passed **783/783 tests**, zero skips, and `npm run build`. This is a named source checkpoint; it is not retroactively a claim that the running application already includes that later Job fix.

## Full Flash corpus completed and published

At 16:52 UTC, the required-complete independent validator passed **5,372/5,372 stored files and 44,833 text chunks**, with zero pending, failed or invalid documents. Model/KB/dimension/embedding-row/vector-row checks passed. Report SHA-256: `ca3b32cdbc79f807adacba8e5319f4a409aae41347ae566832b5e9f3bf798f5b`. No model calls or database writes were made by validation.

The formal repeated migration returned the same successful job. Mapping identities, external document IDs, chunk IDs, Wiki count and logical admission count were unchanged. Proof SHA-256: `3b83b59b235b7d2ac8ecec78746f1c80e56862fef02ec4f7e66d563df5eaaea1`.

The administrator then explicitly published all 5,372 sources in nonproduction. Before publication, reading a staged legacy ID was denied. The publication transaction retained a 5,372-document rollback manifest and made no model calls or index changes. Proof SHA-256: `69ff6b6192fc1e9d4e8eb58d1839cfd956967c9a0ef3d64e5f4198fe2d693dd0`.

Seven older 21.1/21.3/CHM samples were rebuilt in their three original exact scopes, verified against frozen stored-file and ordered native-chunk hashes, and published in the Flash generation. They used exactly **13 logical embedding admissions**, bringing the retained total to 15,223. The full-corpus routing was restored afterward. Proof SHA-256: `49f0fe1b0bd0351d9d2283e8df5fcba3096a8f3e5bd718212ba0762a7f875e6a`. This preserves old canonical content; it does not establish the original CHM table/layout fidelity. Two genuine CHM pages therefore have a separate html-3 reconstruction and browser gate.

Formal reindex completion exposed `SQLITE_BUSY_SNAPSHOT`: a background writer could invalidate the deferred transaction between corpus validation and its completion audit. The new two-connection regression reproduced the failure. Reserving an immediate transaction before validation fixed it while retaining atomic completion/rollback; the focused reindex/binding group passed 27 tests and independent review passed. Deployment of that fix precedes the next formal completion attempt.

## Frozen 55-query online result: quality gate still open

All 55 HTTP cases completed against the published Flash corpus, with **zero integrity flags**. The fixed query text, source-occurrence labels and scoring were unchanged. The report is `runtime/full-213-v4-flash/retrieval-http-20261025T170625465101049Z.json`, SHA-256 `e3d3baeb7c0b241ec4fabf2414a101c6885dca0e88d2aae2100579a4d42566ab`.

| Metric | Frozen local FTS control | Flash engine HTTP |
| --- | ---: | ---: |
| Source Recall@10 | 0.752727 | 0.619502 |
| Source MRR | 0.738636 | 0.663961 |
| Source nDCG@10 | 0.725033 | 0.575430 |

The engine returned ten distinct sources for every case; fewer unique results after chunk deduplication does not explain this measured regression. Twelve cases had zero expected-source recall. The weakest categories were VGL (0.250794), XML (0.463542) and version-filtered queries (0.452778); source-path recall was 1.0. Round-trip latency including engine/provider work was P50 6,449 ms, P95 6,831 ms, maximum 7,040 ms. The local FTS timing is a different workload and is not directly comparable.

These labels measure exact source occurrence, not semantic Precision@10 or Wiki factual accuracy. Query execution/integrity passed; retrieval quality did **not** pass the regression gate. #55 and aggregate release issues remain open while ranking/keyword behavior is investigated. Production and old indexes remain unchanged.
# Subsequent nonproduction verification — 2026-10-26

Application bundle `95b5dfed00abdb3ad6bdd8c627c93e965cad1b3dd73d69703fab6bdcc49721e2` passed **822/822** tests and the standard `npm run build`, then deployed to the existing nonproduction Web/MCP services. Production was not changed. Later source-read and Wiki-navigation fixes require their own final build/tests and deployment.

The formal managed-provider reindex completion succeeded for job `a1e55f85-5c07-4f9f-bc1d-83a2f8e6bf79`, after verification of the 5,372 full-corpus and seven retained legacy publications. The provider is ready on Flash index 2. Report `reindex-completion-20261025T173533.json` SHA: `f2dbb2f7cbfe76c1245cf3592671940b49ea9ee4837d6bb547f9094468226c19`. The preceding `database is locked` failures were a deferred SQLite read-snapshot/write race; an immediate transaction now reserves the verified snapshot before the audit write, with a two-connection regression.

Formal routing was switched to `relay_local` and back to `weknora` against the same published migration. All 5,379 mappings, 44,884 chunks, model bindings and 15,278 embedding admissions remained unchanged, and the cleanup dry run proposed no deletion. Report `routing-cycle-20261025T173546041039Z.json` SHA: `882be7e3ea2682ac8c2761bfa01b69cd13b5e4184fb7fdbf07039d1bf6bf1874`. This is a routing rollback/restoration proof, not a full migration-status rollback; the published migration and its retained rollback manifest were preserved.

Two additional genuine 21.1 CHM pages were re-extracted from the approved original archive into a separate `nonprod-chm-html3-acceptance` scope. Their new html-3 bodies preserve source tables, code, headings, links and anchors. Exact stored-byte/chunk-hash/vector proof covers 30 text chunks and **seven** new embedding admissions. Replaying each verified operation key changed neither documents, chunks nor admissions. The actual proof SHA is `c76a18c84502ff6f4e635e9b6ccda78687cb6a5fe6b7e2ed70c9da9189b754bd`. The initial driver's incorrect HTTP response nesting stopped after the first accepted upload; its failed report is retained, and the accepted ID was reconciled read-only before continuing, without uploading or billing that document again. Both were published through the real Relay browser UI.

That browser check exposed a separate full-document read defect: concatenating overlapping retrieval chunks duplicated four anchors and parts of headings/tables although original stored bytes were correct. It is tracked with the hash-verified original-file download repair in [Product source-read fidelity](product-source-read-fidelity.md), and is not relabelled as a successful content-rendering gate.

Five bounded diagnostic queries then established modality-ranking evidence for the keyword-first correction; they used exactly five embedding admissions, with a preliminary internal-gateway credential rejection consuming zero admissions. The final pinned engine bundle was independently reviewed, backed up and deployed. Binary SHA: `c3d7212c9e823b845269018127fb57834a112b95dfa02d06e6caedef65aa1d98`; manifest SHA: `67237d0f6a6bc1f13c99a0f0d10e27d46ea1b3868287e8aa022465b5a86884ce`. Mapping, chunk, Wiki, control and provider-ledger snapshots remained equal across the actual restart. Upgrade report SHA: `9e6eb46ec96ca35db2cfd5a973ec70bcbad787c8c291011e0f897a2f0b43a5f8`. Only wholly unconfigured RRF defaults change to keyword 0.7/vector 0.3; complete and partial explicit configurations retain their previous effective weights. The unchanged 55-case HTTP regression is a separate gate, not established by five diagnostic cases.

Fresh bounded Wiki generation and its **failed source-support quality gate** are recorded in [Wiki source-consistency review](wiki-source-consistency-review.md). The four content drafts remain unpublished. Successful generation/reference integrity does not close semantic-quality requirements.
