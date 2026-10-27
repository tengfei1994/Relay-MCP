# Frozen Wiki source-consistency review

This is an **automated comparison against supplied sources**, not a human factual gold standard. It does not establish that every Wiki statement is correct, does not cover the new full-corpus migration, and does not authorize publication.

## Scope and frozen plan

The current nonproduction population was frozen before model calls: **17 adopted draft Wiki pages**, all at revision 1, containing **116 paragraph blocks**. These pages cite **four distinct published, verified source mappings and 15 allowed text chunks** in the current knowledge base. The plan records page body/revision/citation hashes, source raw and normalized hashes, exact chunk contents and hashes, paragraph offsets/hashes, and the complete prompts.

All 17 pages fit the configured review budgets without truncation. Prompt size totaled 85,572 UTF-8 bytes; the largest prompt was 10,569 bytes. Per-page output caps ranged from 2,048 to 5,572 tokens, with a combined maximum of 45,172 output tokens. No paragraph or source chunk was removed to make a page fit. Oversized or invalid-source pages would remain uncovered rather than receive a whole-page pass.

The private artifact directory is `/home/ftd/relay-knowledge-engine-nonprod/runtime/wiki-quality-review-01`. Source text, prompts, quotations and raw responses remain there; JSON files were verified to have mode **0600**, inside a private directory. Public evidence contains counts, hashes and validation flags only.

| Private artifact | SHA-256 |
| --- | --- |
| `plan.json` | `6d17fef0e0bc317c62d1b37ee5358abaad2c32489d4071101f6095f7a12d655e` |
| Original `report.json` | `b25bae710dc9c7fb90691981414858178d897ef06bd7742466e301600a97fbf1` |
| Independent `validation-summary.json` | `19bdfc8cd8ba1a8ccd07b19da6f85dd691334cd580a292896181253255d82bca` |
| Final offline `report-validated-v2.json` | `0adf733c69162f6ca37f89c5f7fab34294dc936bf1a9d25d5593eae29836b7ad` |

## Execution boundary

Each page received one sequential `ProviderRegistry` handle `complete` call through the existing `qwen-wiki-nonprod` configuration (Bailian, `qwen-plus`). The durable admission ledger increased by exactly **17 logical calls**. Concurrency remained **1**, quota remained **200 calls per hour**, and no provider/profile configuration changed. Existing `maxRetries: 1` was retained: the planned upper bound was 34 HTTP attempts, not a claim that only 17 HTTP attempts occurred. No additional model call was made for output repair or revalidation.

Reported usage was **20,171 prompt tokens + 8,745 completion tokens = 28,916 total tokens**. All responses reported `finishReason: stop`; that alone did not make malformed JSON or invalid evidence acceptable.

The runner did not instantiate `KnowledgeStore` or invoke migration/backfill initialization. Wiki/source databases were inspected through read-only connections. The managed provider used a minimal database/audit interface for its existing admission and error-audit records. It did not edit, regenerate, roll back, adopt or publish a Wiki page, and made **zero embedding calls**. Page/source snapshots were checked before and after each call. A durable per-page attempt marker prevents automatic replay after failure or interruption.

## Validation and result

The model had to classify every paragraph as `supported`, `contradicted`, `insufficient` or `nonfactual`. A `supported` or `contradicted` classification requires an allowed chunk ID and at least one verbatim quote of 16 or more non-framing characters. Every supplied quote must occur exactly in that frozen chunk. Unknown or duplicate paragraph IDs, missing coverage, invalid JSON, truncated completion and invalid quotes cannot count as a completed page. Exact quotation is a provenance check; it does not independently prove that a model's semantic inference is correct.

The initial strict validator marked omitted empty `evidence` fields on 20 `nonfactual` paragraphs invalid. A failing regression established that this was an unnecessarily strict schema requirement: those classifications make no source-support assertion. The validator now allows an omitted empty evidence list only for `nonfactual` and `insufficient`; `supported` and `contradicted` still require valid exact quotations. All raw responses and earlier reports were retained. The final report was produced by **offline revalidation with zero new model calls**.

| Final result | Count |
| --- | ---: |
| Pages with complete paragraph coverage and valid required evidence | 14 / 17 |
| Validated paragraph classifications | 104 / 116 |
| Automatically classified supported, with allowed exact quotes | 37 |
| Automatically classified insufficient | 29 |
| Automatically classified nonfactual | 38 |
| Validated contradicted classifications | 0 |
| Paragraphs still unvalidated | 12 |

Three pages remain incomplete: **two pages contain 16 non-exact quote occurrences affecting nine paragraphs**, and **one three-paragraph page has malformed JSON**. No quote was silently rewritten or approximately matched; no malformed response was reconstructed. The 29 `insufficient` classifications also remain review findings even on pages with complete response coverage. “14 complete pages” is therefore **not “14 factually correct pages.”** Zero validated contradictions is not proof that none exist.

The implementation is `scripts/knowledge-quality-wiki-review.ts`; four focused regressions cover paragraph/code boundaries, exact allowed quotations, duplicate/missing coverage, truncation, oversized plans, invalid sources, and evidence omission rules. All four passed, and strict TypeScript checking with unused-code checks passed. Source text is treated as untrusted data and is never executed.

## Remaining acceptance

Review the 29 insufficient classifications and the 12 unvalidated paragraphs against their frozen original sources. Any further model evaluation requires a separately bounded run; the current attempt records deliberately prevent automatic repeat billing. Human factual assessment, cross-version consistency, source adequacy, new-corpus Wiki generation and publication approval remain separate work. No page was automatically published by this assessment.

## CPU triage and bounded follow-up

Read-only CPU triage found that the 15 supplied ready text chunks covered every non-whitespace character of all four actual uploaded Markdown files; each file hash matched its frozen normalized source hash. There was no omitted same-source chunk or prompt truncation. Longer current local bodies with the same raw hash were not substituted for the frozen upload. Literal text absence cannot establish that a semantic claim is unsupported.

The 29 insufficient blocks comprised 18 prose and 11 list blocks. Twenty-four had no evidence and five included evidence. The first-round schema did not request a brief reason or atomic claims, so CPU comparison could not reliably distinguish absent source assertions from an auditor's missed inference. The 16 invalid quotes showed formatting differences: five whitespace-only, ten matching only after heading/table-marker and whitespace projection, and one with the same 24 consecutive words but an added table separator and changed newlines. These diagnostic projections were **not** accepted as exact evidence. A unique extra-brace deletion would parse the JSON-error page, but its candidate still contained two insufficient classifications; neither the candidate nor a reconstructed response replaced the original.

The private metadata report is `wiki-quality-review-01/cpu-triage-final.json`, SHA-256 `43a2601957d0e3ed0b0be6f3db869faa389cdd555d6e38e75d5b1ca94f853939`. It used zero model calls.

A separately authorized follow-up selects the union of incomplete pages and pages containing insufficient classifications: **10 pages, 99 complete paragraph blocks, 193 source spans**. Every original paragraph and complete source chunk is retained. The new prompts total 120,144 UTF-8 bytes (maximum 19,708 per page); combined output caps are 52,874 tokens. The private `wiki-quality-review-02/plan.json` hash is `e673e770fe8f5742e3c5d6631dbed94a3d07e7f32c5d80a175d978f4f72a9541`. Limits are ten new logical calls, at most twenty HTTP attempts under the unchanged provider retry policy, and no more than 27 cumulative logical review calls. The existing 200/hour quota remains unchanged.

The follow-up uses `ProviderRegistry.chat` JSON mode. Each factual paragraph must enumerate atomic claims; mixed supported/insufficient claims cannot receive an overall supported label. Evidence selects a frozen span ID and SHA-256; the validator extracts the original text, chunk ID and offsets. Unknown IDs, changed hashes, model-rewritten quotes, missing coverage and incomplete responses fail validation. A span match establishes provenance, not independent semantic truth. `nonfactual` remains distinct, with no invented factual claims. Reasons are short evidence explanations, not requests for reasoning traces.

The initial follow-up validator's 500-character reason limit was a display restriction, not a source-consistency requirement. A RED-to-GREEN regression permits complete reasons up to a hard limit of 4,096 characters and creates a separately marked 500-character display preview. It preserves all claims and evidence and still rejects wrong hashes and reasons exceeding the hard limit. The original running validator and raw results remain intact; the correction is applied only in a separate CPU revalidation report, without additional model calls.

## Follow-up execution and unresolved findings

All ten authorized logical invocations finished; the durable admission ledger increased by exactly **10**, giving **27 cumulative logical calls** across both reviews. Eight responses were saved with `finishReason: stop`; two calls failed without a saved response (both audited as `provider_timeout`) and were not retried beyond the existing provider policy. The initial report counted two complete pages. Offline revalidation of bounded reason text counted **six complete pages**, with **53 validated paragraph classifications out of the 99 planned follow-up paragraphs**: nine supported, 24 insufficient and 20 nonfactual. No contradicted classification was validated. There were **zero extra model calls** for revalidation.

The remaining five returned paragraphs were correctly rejected: one used a free-text value instead of a claim-classification enum, and four claimed an overall `supported` paragraph while listing one or more `insufficient` claims. Those four paragraphs were not promoted to supported. The two calls without responses account for a further 41 uncovered paragraphs. Failure does not erase the preserved first-round evidence, but it cannot count as successful follow-up coverage.

| Original target set | Supported | Insufficient | Nonfactual | Invalid claim/schema | No follow-up response |
| --- | ---: | ---: | ---: | ---: | ---: |
| 29 insufficient paragraphs | 1 | 20 | 0 | 2 | 6 |
| 12 unvalidated paragraphs | 1 | 2 | 1 | 0 | 8 |

Across all 24 validated follow-up insufficient paragraphs, the model selected `source_context_insufficient` 15 times and `source_does_not_assert` nine times. These are automatic evidence diagnoses, not human factual findings. Since the complete frozen source text was supplied, the first label does **not** mean the runner omitted same-source chunks. No `nonfactual` label was converted to supported by a heuristic or validator repair.

Independent CPU validation confirmed that all original selected paragraph bodies and sources were unchanged, every source character was retained in the span plan, and all **88 extracted evidence occurrences** exactly matched the frozen chunk offsets and hashes. The untouched seven first-round pages retain their 17 validated classifications (ten supported, seven nonfactual). The latest selected-page results plus those untouched pages therefore contain 70 validated classifications: 19 supported, 24 insufficient and 27 nonfactual; all older reports remain available separately. These counts describe review coverage and source consistency, not a factual pass rate.

The eight successful responses reported **29,772 prompt tokens + 18,667 completion tokens = 48,439 tokens**. Usage for timed-out attempts is unknown and is not treated as zero. The unchanged provider retry policy means logical admissions are not the same as HTTP requests or billable attempts. No Wiki page was edited or published; no embedding invocation or provider configuration change was performed by this audit.

| Follow-up private artifact | SHA-256 |
| --- | --- |
| `wiki-quality-review-02/report.json` (original validation) | `a094903b4fdcf6639a69603f0dad26a537b0dfcb1a386ab95966475d31c60cf6` |
| `wiki-quality-review-02/report-validated-v2.json` (CPU only) | `b7ee08870be24ca642c087218da1fd548a4f3143fc4cb0c0b993709e86c4d00b` |
| `wiki-quality-review-02/independent-validation-summary.json` | `307d0936dfecfd45402c32a900862fe3c5a143875a6dd23c400be5462aeefb8a` |

All private JSON artifacts were verified mode 0600. The standalone follow-up script is `scripts/knowledge-quality-wiki-followup.ts`; the original runner only adds an export of its existing read-only snapshot function. Nine related regressions and strict TypeScript checking passed. The bounded review is finished, not a claim that the outstanding source-adequacy, semantic-quality and coverage findings are resolved. No further model call is scheduled by either runner.
# Fresh Flash generation and source review — 2026-10-26

After the complete 5,372-page publication and seven retained legacy-source replacements, a separate standard-profile ingestion used the frozen real 839-character PIMS configuration page in `nonprod-wiki-flash-acceptance`. It reused Relay's existing `qwen` / Flash index 2 and `qwen-wiki-nonprod` / qwen-plus configuration. The other 5,379 publications, routing and model identities were retained; the corpus was not reparsed.

The private submission report SHA is `33f648b159fcdcd26ae697de1b5633e7c858e849cfe47bf6a75682ca126cb276`. The accepted source is `weknora-b12c7a11-74e8-4229-89ea-9d9dbf1d9037`; its stored Markdown SHA is `d3bd45f37d263df2a2cf2576730ae4a0b2163a75764e76d2375bec7a6ee88f8c`. Both text chunks match the corresponding frozen full-corpus source exactly and have actual 1024-dimensional vector rows. Standard processing additionally produced one summary vector. The source publication proof SHA is `457a58fff93a94eb25614a4c18fb2813ba3c52e8cebbb88d863ddd218a02afb3`. A preliminary verifier incorrectly counted the summary vector as an extra text vector and stopped before publication; the corrected proof separates chunk types rather than dropping the extra artifact.

Generation used **9 new Wiki logical calls and 2 embedding logical calls**. An independent user-systemd guard temporarily restricted the existing Wiki budget to at most 20 new admissions in ten minutes. It was explicitly stopped after success, persisting disabled status before attempting cancellation of the exact completed source; native cancellation returned 400 because the source was already terminal. Two quiet queue observations, no active parsing, a wait exceeding the provider's 120-second timeout plus five seconds, and eleven gateway requests with eleven terminal responses established the bounded drain. The watchdog was inactive before the formal managed-provider PUT restored **200 calls/hour**. No ledger was reset. Restoration report SHA: `78f94985fca3938667349ad211a26994aeeeb97fc8d8aa0abe59cb36ef7c5e3e`.

The engine generated **four source-backed content drafts and one navigation index**. The index has null source/chunk references and is not adopted as authoritative Knowledge. The initial quality-plan attempt expected five adopted drafts and failed; inspection established this distinction before freezing all four content drafts. The four adopted drafts have valid scoped source references. This is referential integrity, not a factual-quality pass.

The subsequent bounded review made one call per content draft, using complete frozen paragraphs and source chunks with exact span IDs and SHA checks. Plan SHA: `9ec48445ac523f82126471a936f70f8b8e3b6bbfbf5919015873dd30d07732be`; report SHA: `d77480d0f0ee6da0557381f5da9c58bb8fdfa3db654acb0b6b249d0ffe07fc7f`. Across 39 paragraphs, 38 received valid classifications: **8 supported, 19 insufficient and 11 nonfactual**. One paragraph failed the response/claim/span validation. Three of four reviews had complete valid coverage; this does not mean those three pages passed factual quality. This automated source-consistency assessment is not an expert-adjudicated factual gold standard.

All four content pages remain **draft**, with their generated text and failed quality evidence preserved. No generated Wiki statement was automatically approved, edited into a claimed pass or published. Functional generation, native storage, source publication and Relay draft adoption are demonstrated; **Wiki factual/source-support quality remains an open release gate**. These artifacts are private under `runtime/wiki-flash-acceptance-prep-2026-10-25T164629222Z` on the approved nonproduction host; source bodies, prompts, model responses and credentials are not included in Git.
