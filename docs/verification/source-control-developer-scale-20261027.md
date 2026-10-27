# Source control and Developer scale acceptance — 2026-10-27

Scope: nonproduction only. Production, Wiki publication and provider quotas were not changed. All archive, raw-database, native-chunking and real-source checks below used **zero model calls**. Private source bodies, paths, queries, credentials and vectors are not included.

## Three-way source comparison

`compareSourceBaselines` now compares each side with the old baseline before declaring a conflict. The previous implementation returned `BOTH_CHANGED` for `old=A / project=B / new=A`; it now returns `PROJECT_ONLY` without `potentialConflict`. The same correction covers project-only deletion.

The regression matrix covers unchanged content, project/baseline additions, identical and different additions, project/baseline deletion, deletion on both sides, project/baseline modification, identical and different modifications, and delete-versus-modify conflicts. Existing status semantics remain: a new file present only in the new baseline is `ADDED`; a file absent from both project and new baseline is `DELETED`; identical project/new content is `PROJECT_ONLY` when it differs from old.

HTTP and MCP tests exercise the real routes/tool handlers with old/project/new manifests. They verify all six statuses, conflict flags, counts, and `evidenceRefs.old/project/next`. These references are the immutable IDs in `knowledge_source_files` and `knowledge_project_snapshot_files`; they are not asserted to be `knowledge_evidence` blob IDs. MCP also now rejects a snapshot belonging to a project the caller cannot read, even when the caller has an unrelated Knowledge ACL.

The Solution UI was exercised in Chromium with deterministic API replay: baseline/snapshot selection, project snapshot import controls, Compare upgrade, all three source-evidence references, and paged Source files rendered and operated successfully. The API and MCP behavior is covered separately by the real-handler tests above.

## Topics, revisions and review

Synthetic regressions verify:

- identical normalized content across 21.1/21.3 reuses one revision and one topic with two version bindings;
- same-version content changes advance the current binding to the new document/revision while retaining the old document body and old revision;
- a MadCap → Innovasys template change plus a directory move reuses the topic/revision when normalized content is equivalent;
- match confidence below 0.8 creates `pending_review`, while the confident family-ID path remains `active`;
- the review HTTP API requires an administrator and a reason, persists active/rejected status, and writes ordered audit records.

The Topics UI was exercised in Chromium: a pending binding exposed its status, Approve/Reject stayed disabled until a reason was entered, and Approve refreshed the binding to active.

A separate real-source check scanned **41,819 21.1 HTML documents** and **48,098 21.3 HTML documents** in the raw nonproduction corpus. It found no cross-version pair with byte-identical normalized body for bodies longer than 200 characters. Therefore no real equal-body claim is made; that behavior is covered by the synthetic fixture above.

The check then selected one real pair sharing a stable official identifier from **4,399 changed-body candidates**. Both original archive byte hashes matched. The current isolated importer produced two revisions, one topic and two version bindings, retained both bodies, and verified the relative directory move. Final report SHA-256: `f0a8db08bb05d4adc997227913fc65b4dcbbd4fa9b66cf5259bad405ae921277`, with `directoryMoveVerified=true`. The legacy raw database's normalized body hashes differ from the current importer output, so `legacyBodyMatches=false` is retained rather than rewritten as equality. This is a two-source identity check, not a full-corpus merge certification.

## Complete Developer manifest versus actual engine

Source: the pinned 21.3 archive with SHA-256 `256b2a52562f321f2788205605436e5e00272060ad76c20263c637672c4b7342`, inner `SampleManager Developer Documentation.zip`.

- Complete archive inventory: **47,646 files**, including **42,724 HTML** and 4,922 non-HTML files.
- HTML source bytes: **583,561,794**; unique paths **42,724**; unique raw SHA-256 values **42,724**; duplicate paths/raw bodies **0**.
- Manifest SHA-256: `0db5dd2ae1c02d0031619b7a490cf43dd4c5076fed889c0afdefd4da7f2e0973`.
- Every archived HTML hash matched the raw Relay import database. That database has 42,724 FTS-indexed Developer documents and 289,443 local chunks. This remains parser/local-FTS evidence, not managed-engine coverage.
- Actual managed engine: three Developer mappings, of which two are complete/published and one failed/missing externally; nine ready chunks and nine `lite_embeddings` rows. **42,722 of the 42,724 HTML documents are not present as complete external engine documents.**
- Metadata-only report SHA-256: `1621feea38f15a5084868934dc2a70ae07f8997c9a36717095601e5bf18d084a`.
The structural subtotal of 42,720 Innovasys documents does not cover the complete manifest: four additional HTML documents are included in the correct 42,724 scope.

## Native CPU embedding forecast

The existing pinned native chunker processed every normalized Developer body without a provider request:

| Metric | Value |
| --- | ---: |
| Documents | 42,724 |
| Unique normalized bodies | 42,723 |
| Duplicate normalized bodies | 1 |
| Raw preview chunks | 238,950 |
| Indexable chunks | 238,949 |
| Whitespace-only chunks excluded | 1 |
| Documents with no indexable chunk | 2 |
| Approximate tokens | 25,795,858 |
| Embedding batch size | 5 |
| Logical calls, no retry | **63,781** |
| Maximum logical calls with one retry per batch | **127,562** |

Forecast input SHA-256: `0ae0f46fb2ce08cc64f6ef405f63269d12ff89e2c2653c12bab15e39dc3da8eb`. Native chunker SHA-256: `a2309ea6d51c58bdbdd771839cc1045fdf8e712ca48124c7e3253720ec07777d`. Report SHA-256: `461c7856db70e0e48e8663d4b89fbb7685d500760bfd9f0cfa73a537c21dc23f`.

This is a full-corpus forecast before identity-level reconciliation of the two already-complete documents; it is not a new allowance and not an exact billable-cost estimate. A proposed authorization plan would be 638 batches of at most 100 logical calls (last batch 81), preserving the observed 200 calls/hour, concurrency one and retry-one policies. No batch was started. Existing admission rows were neither reset nor used to infer lifetime headroom.

## Async, recovery and pagination boundary

Existing durable-job tests cover serial asynchronous import, progress, idempotent retry, interruption marked failed, and re-scan with completed-document skipping. This is job-level idempotent recovery, not a file-cursor checkpoint. New source-control APIs add server-side baseline/snapshot lists and `limit/offset/total` for source files. The UI loads Source files on demand rather than loading the full manifest.

Full managed-engine import, incremental reindex, interrupted 42k recovery and 42k browser pagination remain unaccepted because the engine is missing nearly the entire Developer corpus. Completing them requires explicit embedding authorization and subsequent real engine verification; raw parsing and the isolated performance replay cannot substitute.

## Verification

- `npm test`: **884/884 passed**, zero skipped; includes the new comparison, API/MCP/ACL, Topic review and request-benchmark regressions.
- `npm run build`: passed; 121-tool MCP boundary and 1,827 frontend modules.
- `npx tsc --noEmit`: passed.
- `git diff --check`: passed apart from Git's Windows LF→CRLF warnings.
- Reversible nonproduction deployment passed with application archive SHA-256 `b26916e26e3ff86a83082d57219b60295de8950145b298e0b31746417db1e986` and deployment proof SHA-256 `9081db416bacff0fe04ce99cb4619c1978c3f25db3e59c99bea15eb5945e10b8`. Business state was preserved, both new list APIs returned HTTP 200, the engine was unchanged, and no model call occurred.
- Real Chromium interaction passed for Solution comparison/Evidence/files and Topic pending-review approval using deterministic API replay. No private source or model request was used.
