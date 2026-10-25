# Managed Knowledge engine acceptance — 2026-10-25

Branch: `codex/managed-knowledge-engine`; base: `b25ee02`.

## Authorization and boundaries

Relay owns Web/MCP/API, encrypted model configuration, deployment, ACL, publication, Memory and Evidence. WeKnora Lite is a private Product/Wiki process managed by Relay. This phase accesses production read-only over SSH and does not use Relay MCP tools.

The user approved copying encrypted Bailian configuration and its key, five genuine samples, and the two original documentation archives to `ftd1994-codex:/home/ftd/relay-knowledge-engine-nonprod`. The archives are mode0600; production/nonproduction hashes and sizes match:

| Archive | Bytes | SHA-256 |
|---|---:|---|
|21.1 Docs.zip|268002743|1cff794c938afe3544d426f0fae9f4ec056caebae5513372c1c31a3ac6832908|
|21.3 Docs.zip|397941192|256b2a52562f321f2788205605436e5e00272060ad76c20263c637672c4b7342|

Private source bodies, credentials and detailed artifacts remain in authorized private storage. Repository reports contain IDs, counts, hashes and verification limits.

## Raw corpus parsing

Both archives completed first import and a repeat import with a distinct operation key. Each repeat added zero documents, with unchanged corpus/chunk/revision counts and corpus hashes. There were zero parser warnings/failures; SQLite integrity_check returned ok. The separate bulk database contains no provider configurations and made no model calls.

|Package|Documents|Original formats|
|---|---:|---|
|21.1|41,826|4 PDFs;3 CHMs producing36,757 HTML pages;2 ZIP layers|
|21.3|48,101|3 PDFs;3 ZIP layers;no CHM in this original archive|
|Combined|89,927|581,543 chunks;89,743 revisions|

Report: `bulk/raw-formats-acceptance.json`, SHA-256 `d50d87704e9615584bcedbe340fd64c163d32a442ca78fcc16ae6a60fd94998a`. A driver initially required CHM in both versions; the corrected assertion uses the verified actual archive inventories and records the amendment. Parsing does not prove full engine migration, layout fidelity or retrieval quality.

## Real engine and model checkpoints

- Managed Lite v0.8.3, upstream commit `3e22822c1d2397be730c458c7539d0eb8c113a24`; private engine18190, Relay18300, MCP18301. SQLite migration36 clean. Restart, stopped backup and isolated restore verified.
- Current patched bundle manifest SHA `c6d845af20787a4796d29ba88adcf98d52d35cbad52269295cd45c544bbdcbf8`; actual executable SHA `83abda70c42774784bf2f05c17e8428356f83cf3aa6dd0778b43647e4f5a3c75`. Managed7zz version26.05, mode0700, SHA `d32657a7a0e4cdc0a8aa57cafe474746944d76e861e753e9c902b9c9356fa886`; actual CHM support verified.
- Real embedding: qwen3.7-text-embedding,1024 dimensions. Real Wiki/Candidate: qwen-plus. All requests use Relay's private gateway/encrypted registry. Configured admission remains200 logical calls/hour/provider and concurrency1; the limit is process-local, not an account-wide billing cap. See operations documentation for cancellation, retries and crash limitations.
- Five genuine samples: two21.1 Product,two21.3 Product,one21.3 Developer,11,597 original body bytes. Source/body hashes, model/index provenance, completed parse and original chunk IDs verified.
- HTTP report `runtime/live-acceptance-e-resume.json`: all9 milestones passed, including durable202 migration/idempotency, explicit publication, three search aliases,fifteen stable/legacy reads, source-linked generated Wiki, edit/publish/history/diff/rollback, ACL and original Memory/Evidence preservation.
- MCP report `runtime/mcp-product-live2.json`: catalog120 at that checkpoint, Session open/replay/reconnect/close, foreign actor denial, five complete Product DTOs and unified ContextPack passed. Final report `runtime/mcp-healthy-final.json` passed with the additive job-status tool (121 total).
- MCP report `runtime/mcp-reviewed-memory-pass.json`: a real browser-reviewed/verified Case entered confirmedKnowledge; other-environment Session use was explicitly denied. Initial probe incorrectly expected an empty result instead of the existing environment denial; its failed reports are preserved, the assertion now checks the exact denial contract.
- Real source identity probe: five same-body synthetic scope/path/version variants created five documents/30 chunks; repeating an identity returned409 and reused it. This is not proof of real cross-version topic equivalence.

## Memory and browser evidence

`runtime/memory-live-20261025c.json` passed all6 milestones: actual managed qwen-plus typed output, replay idempotence, Evidence/foreign-actor checks, explicit confirmation/promotion, Session close, and unchanged source sentinel hashes.

- Session: `session-2c2fd31c384ff08805c9ca8674509621`.
- Candidate: `insight-d8a535ad5485b0ee04598b40718de661`.
- Case: `case-insight-d8a535ad5485b0ee04598b40718de661`, draft, project1/environment nonprod.
- Evidence: `evidence-38570323-ddd2-4c84-a456-88fe773a269a`,90bytes,SHA `98da0611278f4e1e4b3cccb0241beeb257280303649847af80adffa89a55292f`.

Actual browser actions include Candidate edit/confirm/promotion, Evidence jump, explicit legacy scope review, Case draft→reproduced→verified, rejected fallback remaining terminal, migration refresh recovery and publication, Wiki edit/publish/diff/revert and source-document jump with project/environment/hash/chunks. Foreign-user Product deep link was denied. During a real stopped-engine interval, Wiki displayed unavailable while Evidence retained its90bytes/hash; the engine restarted ready.

Browser migration `migration-b9ed4dba-53b3-4826-b2fd-bda10542f9c2` processed5/5. Durable job `migration-job-995c7fa65661d7141347130c32b119daf510c41f50ae748e1d93349dd3417f2d` survived refresh. Browser legacy Case `case-insight-78e35171480d35c98533d8d4f4479c6a` was explicitly scope-reviewed and subsequently verified only for the nonproduction sentinel.

Screenshots are private under `output/playwright/`; they are not release-quality evidence of Wiki factual correctness. Real generated Wiki text includes claims that still need source-quality review.

## Failures exposed and fixed

- Upstream owner password length; real API envelopes and snapshot-only Wiki history; long finalization requiring bounded readiness; durable migration202/checkpoint/retry instead of a blocking HTTP request.
- Summary hits resolved to verified original chunks; Product catalogs and old IDs constrained by current KB/publication/ACL/scope; Knowledge MCP structured DTOs no longer truncated into previews.
- Candidate typed JSON contract; trusted scope snapshot migration041; legacy Case quarantine and audited scope restoration; Session drift and concurrent review/reject/promote races; historical global bindings cannot expand Candidate scope.
- Case detail crashed on an undefined render identifier. Regression failed before the fix; actual browser Case deep-link and lifecycle transitions now work.
- A stopped engine incorrectly failed the entire combined ContextPack. Product availability errors now degrade only that section while retaining Relay confirmed memory; ACL/reference failures remain fail-closed. Final deployed `runtime/mcp-outage-final.json` passed all5 checks; HTTP `runtime/http-outage-final.json` returned200, zero Product references, productKnowledge=unavailable and2 confirmed memory records. The engine restarted healthy; final healthy MCP passed all6 checks.
- Async Candidate queue lacked a deployed consumer and atomic claim. Dispatcher/leases/recovery/status APIs and shared cancellable model adapter are implemented and deployed. `runtime/candidate-async-live-20261025.json` passed while the Product engine was stopped: job `insight-job-4ee46f41054aeb548deaf617c145ecb9` completed in1 attempt, with real managed-qwen-plus Candidate `insight-64ab3d358baa52a07ce872a5e11ed6e6`; repeat enqueue returned the same job/attempt. This proves queue consumption and independent engine availability, not the full Capture/outbox/dead-letter coexistence matrix.
- Raw compressed PDF parsing and nested archive routing; explicit repair of unchanged-hash legacy PDF placeholders preserves manual edits and source IDs.

## CHM content integrity gate

Two real21.1 CHM-derived pages completed formal migration/publication/search/read and repeated migration. Foreign actor/environment and original five-sample preservation checks passed. However stronger content verification found TABLE_NAME's1927 code bytes reduced to39 by a second HTML cleanup. The actual upstream stored payload also had the loss. Report `runtime/chm-live-20261025.json` is explicitly `retrieval_passed_content_integrity_failed`, SHA `a8913980801ad99eec618286b15bd25b46de8192f1bf3cdbb6d1c4a04f1aaaf3`.

The correction now passed the actual engine gate in `runtime/chm-live-20261025b.json`: all5 milestones passed, with both full-text SHA values and all4 fenced-code SHA values equal across canonical→normalized→actual upstream stored source. HTTP chunks covered every non-whitespace code character; search/read, repeated migration, ACL/environment and preservation of the original five samples passed. The two pages contain305 and1927 code bytes. A new parser identity produced two new external IDs; the prior mappings are deprecated and their migration rows withdrawn, preserving the earlier failed evidence. Processing took501.914 seconds with unchanged model limits; active ingest jobs returned to0. Report SHA `804dddba00e614a2880047dada40ce537008218703a7cfea912d68afa1cad17f`.

This proves the selected genuine CHM pages and their code fidelity. Engine text locators are not original HTML DOM anchors; full-corpus table/image/link/layout and retrieval-quality acceptance remain separate.

## Log safety

The initial scan found no approved credentials in the scanned files/databases, but found142 upstream INFO model request records containing actual prompt text. The original private logs are preserved; this was a failed gate.

The reviewed source patch,16 real Go package tests and rebuilt executable passed; a real saved Wiki model call through Relay→Bailian passed the incremental token/canary/structure scan. Candidate-specific scan covered3 candidates,6 reviews,15 audits,230 fields and42,472 new log bytes, with zero exact credential or prohibited-shape matches. The final asynchronous task scan additionally covered1 task/1 Candidate,140 related/new audit rows,1,136 fields and274,167 new log bytes, with zero credential/prohibited-shape or long input/output marker matches. Its boundary ends at11:06:56.671Z. A subsequent post-CHM scan through11:17:29.708Z checked139,946 additional log bytes,333 audit/span fields and213 real-source markers, all with zero matches. WARN-level live logs alone do not prove INFO behavior; the real Go regression covers INFO. Details: [model-log-safety-acceptance.md](model-log-safety-acceptance.md).

## Final scope and browser checks

`runtime/context-scope-final.json` passed10/10 real HTTP checks: combined Product+verified Case,21.1/21.3 positive version filters,positive module,negative version/module/Solution/language/environment,foreign actor. References had actual provider/document/chunk/hash/locator metadata. The approved five-sample set has no positive Solution-specific source, so that positive case remains unproven.

After the final deployment, a real browser reload displayed generated Wiki revisions; the existing Case deep link retained project1/environment nonprod and displayed verified without the prior render crash. Product outage browser checks, source jumps and earlier lifecycle mutations used asset `index-YCzkLRNg.js`. The final deprecated-page controls use asset `index-DhtXf__r.js`: actual browser publish→deprecate of revision6 passed, all4 write controls disappeared, and source/history remained visible. `runtime/wiki-final-lifecycle.json` confirms repeated deprecate200 with no extra status audit and republish403 with the exact deprecated-page rejection. The probe initially expected400, then corrected the expectation after checking the existing Wiki route contract. Final deployed `runtime/mcp-post-wiki-fix.json` passed all6 MCP checks.

## Test checkpoints and remaining gates

Final `npm test`: **587/587 passed**,0 skipped,57.244 seconds, including24 added Wiki concurrency/no-op regressions. Final standard `npm run build`: passed, MCP boundary318 lines/121 tools, Vite1523 modules; JS497.06kB (gzip127.88kB). Logs are private `runtime/final-full-test.log` and `runtime/final-build.log`. `git diff --check` passed. Remote main remained the branch base b25ee02 at verification.

Earlier failures are retained as evidence: a501/502 checkpoint had one MCP startup timeout during a concurrent build (isolated rerun and subsequent full suites passed); final first run562/563 exposed a stale explicit migration-list expectation (missing043), corrected before the full563/563 rerun. The first post-Wiki full run586/587 again hit the same15-second MCP cold-start contention; the isolated5/5 rerun passed (first scenario2.54s). The runner now caps file concurrency at4 instead of the20-core machine's default, without skipping tests or changing timeouts; the complete587 rerun passed.

Remaining: full5,372-page engine migration, positive Solution scope, gold-set recall/precision/factual Wiki quality, agreed performance thresholds, remote Job/Deployment correlation, Capture/outbox/dead-letter coexistence and full model rotation/reindex/fault coverage remain separate gates. The bulk parser counts and local fault tests cannot substitute for those deployment-scale scenarios.

All #42–#56 were reopened/audited. #48 has completed its scoped Candidate review and actual Wiki/Product navigation acceptance; the final issue comment records closure after the commit/PR is available. The other issues remain open with their individual gaps. This is bounded nonproduction acceptance, not a production release approval.

## Additional review and performance evidence

The repository CI FTS benchmark was also executed with100,000 chunks,20 repetitions per each of5 query types and the existing200ms P95 threshold. It passed with P50=0.0926ms,P95=0.145ms,max=0.1992ms. This is a synthetic hot-cache FTS-only baseline; it is not the full real-corpus or HTTP/model performance gate.

The final independent review found a Wiki publication race: another process could deprecate a page after the publisher hydrated it, and the publisher then ignored the transaction's fresh state. Sixteen dual-store race regressions failed on the old implementation and passed on the fixed one; eight no-op scope/ACL checks were also added. Wiki tests passed46/46. An immediate transaction reloads current authorization/status/revision/source snapshots, revalidates active citations and uses conditional updates. A conflict cannot revive a deprecated page or overwrite a newer local review. Remote calls remain outside SQLite transactions; an upstream edit already completed before a local conflict remains a new unreviewed revision. The full587-test suite and standard build passed after this fix; the deployed browser/API Wiki status checks also passed.

## Final report fingerprints

Private report files live under the authorized nonproduction runtime directory. These hashes let reviewers locate the exact evidence without committing private detailed artifacts.

|Report|SHA-256|
|---|---|
|chm-live-20261025b.json|804dddba00e614a2880047dada40ce537008218703a7cfea912d68afa1cad17f|
|wiki-final-lifecycle.json|1a443823722f78c0956775e384511c091e9d9097fe795c55424f77ace03c39d8|
|mcp-healthy-final.json|14924223f0323a4f5db0937047b2b3ca94e327853c9431a3e14ed438dc741ff8|
|mcp-outage-final.json|33e583cd69298180b3dcbe15983fa609c81f2f197e3f6fb19b4b14ca1d707d7d|
|http-outage-final.json|70226d9dcd50f5305b3dae4788b3a8b6ecc961d971f5ad015df59055353ba0d9|
|context-scope-final.json|e75df8f8c3ffce6c0d6d0e3b6cb7b16b30dd635fb57c44443e6a24fd5d99f7bd|
|candidate-async-live-20261025.json|c6c7b2c212ee91e554ae0bc15ce53f66fe0e983a5023e4112359553585a9a1dd|
|candidate-async-sensitive-scan-3cab605e-672c-4114-9530-7c387abc0e8e.json|f5ff0c9417259ffd52a4d835572811960f6ac507ba7521285606124caba49c7e|
