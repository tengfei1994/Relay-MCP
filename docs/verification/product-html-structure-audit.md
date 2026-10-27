# Product HTML structure audit

This audit found a real blocker in the frozen 21.3 corpus. The `html-2` importer removed source link destinations, image references and anchor identifiers, and flattened two-column tables into independent cell lines. The source was already damaged before upload to WeKnora. The current importer used the same `parseHelpHtml` implementation, so simply retrying the migration would not repair it.

The replacement DOM renderer passes the same seven real source samples. This is structural evidence only. It does not establish semantic accuracy, browser rendering quality, image delivery through Relay, or successful reindexing of the full corpus.

## Inputs and method

- Approved outer archive: `21.3 Docs.zip`, SHA-256 `256b2a52562f321f2788205605436e5e00272060ad76c20263c637672c4b7342`.
- Inner archive: `21.3 Docs/SampleManager Documentation.zip`.
- Frozen 5,372-page manifest: SHA-256 `712d0e78e9928123c402b748a3e966ef99eaf30121a7ff4ac76be3fe0ab30009`.
- Every original HTML entry was matched against its frozen raw hash. Sampled Relay bodies and sections were checked against their frozen hashes.
- Python's independent `HTMLParser` inspected source features. Each feature stratum selected three pages by SHA-256 order of source path and raw hash, before examining output quality. Overlapping selections produced seven unique samples.
- The first inventory counted skin logos and generic template anchors. The retained v1 report also contains one heading false positive caused by the audit's treatment of underscores. Candidate evaluation keeps the original seven selections, excludes the explicitly identified skin assets/scaffold anchors, and preserves underscores. This correction does not replace failed samples with successful ones.
- Source feature inventory after template exclusions: 5,372 pages with headings; 1,959 with tables; 963 with `pre` code blocks; 2,503 with content images; 4,862 with links; 5,292 with non-scaffold anchors. Inline/CSS-styled code is outside the `pre` stratum definition.

The helper is `scripts/knowledge-quality-structure.py`. It uses read-only SQLite connections and emits source paths, element positions, hashes and structural counts. Source bodies are never written into the report or stdout. The candidate renderer ran in a separate private runtime directory with pinned `parse5` 8.0.1; it did not replace running application code. Model calls: **0**. The databases and frozen manifest were not modified.

## Evidence

Private reports under `/home/ftd/relay-knowledge-engine-nonprod/runtime/full-213/`:

| Report | SHA-256 | Meaning |
| --- | --- | --- |
| `structure-audit-v1.json` | `00b2b4cfcde46972de37b1cac432738a43de70ab14c7ee59b71646de89867b9b` | Original fixed selection and diagnostic; includes the audit limitations corrected below |
| `structure-audit-candidate-v3.json` | `e5606954585acb4fd9a4bcd2e74232c34c466c8f4c903a0b72d91aae4b1b788e` | Same seven pages, template/underscore corrections, old persisted output versus candidate rendering |

The seven sample filenames are:

- `Bitwise-Logical-Xor-Operator-SM.htm`
- `SAP-Object-Maintenance.htm`
- `GetStepVariableValue-SM.htm`
- `Single-Sign-On-IdP-App.htm`
- `Collection-keyword-Table.htm`
- `WEB_CLIENT_USER_AGENT.htm`
- `Standard-Details-Page.htm`

The corrected findings for the old Relay bodies are:

| Structure | Findings | Interpretation |
| --- | ---: | --- |
| Heading level/text/order | 0 | The v1 underscore mismatch was an audit defect |
| Table row/column relationships | 3 | Ordinary 8×2, 10×2 and 3×2 source tables became 16, 20 and 6 separate cell lines, without Markdown table delimiters |
| Exact decoded code | 2 | Only trailing whitespace was trimmed; no code-logic loss was demonstrated |
| Content image references | 2 | Real screenshots in `Resources/Images` were missing; original archive targets exist |
| Link destinations | 61 | Includes separately classified related-topic links and inline content references; five fragment targets in the Collection sample were verified against original target anchors |
| Original non-scaffold anchors | 14 | Original source identifiers were absent from the Markdown |
| Heading-to-section locator checks | 0 | No mismatch after the underscore correction |

At the snapshot, two selected pages had verified staged engine chunks; they inherited the old source losses. Five were `not_ready`. The audit does not count these five as an engine pass. No sample was published by the audit.

The candidate has **zero findings in all six structure categories**, and every sampled result remains byte-identical after another `normalizeProductMarkup` pass. The candidate comparison is in-memory, not proof that the old stored sources or indexed vectors have been repaired.

## Repair boundary

`parseHelpHtml` now shares a static DOM renderer with active HTML normalization. Normal tables keep row/cell relationships in Markdown. Tables requiring spans, nested tables or block-rich cells retain sanitized HTML with an explicit canonical marker. The normalizer re-sanitizes and protects those tables rather than reparsing the surrounding Markdown. Original IDs, links and image references survive nested headings, cells and lists. Code text is protected from line trimming and blank-line folding. Script/style/navigation content and active attributes or unsafe destinations are excluded without executing scripts or requesting assets.

`legacyProductMarkupForReplay` retains the original regex algorithm for old identity verification. Ordinary Markdown and literal/fenced HTML remain on the existing Markdown path. Parser-version/cache/revision migration is separate work; old staged data must not be silently rewritten or reported as repaired.

## Separate 9-versus-8 chunk diagnostic

Target local ID: `product-document-full213-08ee2967407040947e36764002b60630`, source `DS_HTML5/Content/SM/Expression/IncrementPadded-SM.htm`.

The frozen preview reported nine chunks. Actual verified text chunks had indices `0,1,2,4,5,6,7,8`. A fresh CPU-only chunk preview reproduced all nine. Each of the eight indexed chunks exactly matched the corresponding preview content and its source character range. The sole missing range was `[1228,1230)`: two whitespace characters, SHA-256 `75a11da44c802486bc6f65640aa48a730f0f684c5c07a42ba3cd1735eb3fb070`. Uncovered non-whitespace characters: **0**.

Official WeKnora v0.8.3 `internal/application/service/knowledge_process.go:572` skips chunks whose `strings.TrimSpace(Content)` is empty. The preview includes that empty chunk in its count. This discrepancy is an expected preview/indexing contract difference, not evidence of lost body content or repeated embedding. The original manifest was preserved.

## Remaining acceptance

Reparse into the explicitly versioned new corpus; verify immutable identities and all 5,372 raw hashes; rerun structure checks and CPU chunk budgeting before any new model work. After authorized indexing, repeat read-only chunk checks for the fixed samples. Resolve relative assets and source anchors through the actual user-facing reader before claiming clickable/image-rendering acceptance. Semantic relevance, factual accuracy and Wiki synthesis remain separate evaluations.

## Full-corpus follow-up and repaired candidate

The audit was expanded to every one of the **5,372 frozen manifest pages**, before new model work. Selection no longer depends on strata or output success. Source inventory contains 5,372 pages with headings, 1,959 with tables, 963 with `pre` code, 2,503 with content images, 4,862 with links and 5,292 with non-scaffold anchors. Every archived raw hash and persisted old body/sections hash was checked. Full scans do not recheck engine chunks or resolve every relative destination; their `engineNotReady: 0` is **not an engine acceptance result** (each engine entry says `not_evaluated_in_full_candidate_scan`).

The first full candidate report is retained at private `runtime/full-213/structure-audit-all-candidate-v3.json`, SHA-256 `1a7834badbe7d549783b0e73179bbcc40b20ec776521e054467e1f9e7b42e637`. It exposed cases absent from the fixed seven-page sample:

- 276 failing code blocks contained source `<br>` line endings that the candidate flattened. In `Force-Sample-Complete.htm`, source line 293 contains 66 such breaks; the candidate had zero, while all other characters were equal.
- 90 source hyperlinks inside `pre` disappeared when only text was emitted. The repaired renderer retains reference-bearing `pre` as sanitized canonical HTML, preserving both code text and destinations. Plain `pre` remains fenced code, with `<br>` converted to a line feed.
- Lists containing direct non-`li` explanatory nodes dropped 10 image references, three anchors and one link. All child nodes are now retained in source order, and only actual list items advance numbering.
- A nested list containing code restored only the opening fence at the list indentation. This broke one code block and hid two following headings from Markdown interpretation. Lists containing `pre` or tables now retain a sanitized canonical HTML tree, protected from whole-document normalization.

The independent checker also had false positives: Markdown punctuation escapes and image alt text were incorrectly treated as source text, and intraword `*emphasis*` was not decoded. Source character comparisons established these errors; the checker now has regressions for them. These corrections do not relax code-byte, destination, anchor, row/column or span comparisons. The initial report and metadata-only triage remain intact: `structure-audit-all-triage-v3.json`, SHA-256 `2eb5dfecbb112d851926f1b7f4f374c526711bf880a870b4ac6ac9e3e641b6e5`.

Four new renderer regressions were observed failing before their implementation, then passed. The focused related suite passed **66/66**, and project TypeScript checking passed. The repaired business source is frozen at `html-markdown.ts` SHA-256 `76729a9f98526a8396a1d46e21ea66706ce107c89354a91d5e8eb6161aad97f3`; `weknora-markdown.ts` SHA-256 `866969beeaf9dcb17626da569b34bc722ea2449ff57209982f916e44ac38d0e2`. Legacy replay remains unchanged.

The repaired full scan `structure-audit-all-candidate-v3b.json`, SHA-256 `ca10534c72544db71811b4d97a8c8f055811ba3fdab7a671947ddd698457ea2b`, found zero table/code/image/link/anchor differences and all 5,372 candidate bodies nonempty and normalization-idempotent. Its one heading difference was the independently confirmed emphasis-decoding checker error.

The final complete scan is private `runtime/full-213/structure-audit-all-candidate-v3b-final.json`, SHA-256 **`b6f53231679653f17489729452d9702a1c2245cc84366207199686280e893c76`**. All **5,372** candidates are nonempty and normalization-idempotent, with **zero findings in all six structural categories**, after checking every original raw hash. The report retains `completed_with_structure_findings` because the persisted old Relay corpus still has its documented losses; it does not claim those stored bodies or old vectors are repaired. Model calls throughout this structural audit and its preview probes: **0**.

### Pinned native chunker CPU check

Three real-source repaired bodies were sent only to the native `/chunker/preview` endpoint, with the current KB chunking configuration. There were **zero model calls and no uploads**. Metadata-only evidence is private `runtime/full-213/structure-candidate-v3b-native-ranges.json`, SHA-256 `7a42f06d3321264a069b0d9f998066c98930087bda6fced8a9054fb03a6a808e`.

`Index-Defintion.htm` produced seven chunks retaining the original linked-pre destinations; `Force-Sample-Complete.htm` produced four chunks retaining its exact restored code line feeds. Every chunk in these two pages equals its original body character range. `Limit-Calc-Routine.htm` produced 21 chunks: 20 equal their source range, and one contains its complete source range after a 56-character generated context prefix. No uncovered non-whitespace source character was found across any of the three pages. Directly concatenating overlapped chunks is not a valid standalone DOM/code audit: duplication and generated context can change that synthetic document. This preview establishes preservation of the selected source ranges, not semantic quality or independent rendering of every individual chunk.
