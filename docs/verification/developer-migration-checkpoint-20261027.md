# Developer full-migration stopped checkpoint — 2026-10-27

## Stop state

The migration driver was explicitly stopped by the user. The remote driver process is absent and `activeJobs=0`. The fourth batch's queued job was marked `driver_stopped_by_user`; no automatic retry, rollback or publication followed. Durable checkpoints and all existing business data remain intact.

This is not a completed full migration and does not close #42.

## Frozen input and budget

- Complete scope: 42,724 Developer HTML documents, with two zero-indexable-chunk documents separately classified as `metadata_only` rather than assigned fabricated vectors.
- Raw projection completed in nonproduction: 42,724 documents, 289,443 local chunks, 42,723 revisions, 42,637 bindings and 42,724 scope rows. SQLite integrity passed with zero model calls.
- Current provider generation is flash/indexVersion 2, batch size 8. It was not changed to the older generation.
- Exact batch-8 forecast: **54,472 logical calls without retry**, below the user-approved 63,781 ceiling. The one-retry ceiling is 108,944. Provider policy remains 200 calls/hour, concurrency one and retry one.
- Budget manifest SHA-256: `b72031981180188d1035cb3876295ea1f418c962dab56c310452cb6e0790ca52`.
- Provider admission accounting uses each migration job's start/finish window. Global row counts and rowid deltas are not used as migration totals because retention cleanup and unrelated consumers occurred during execution.

## Executed batches

- Three batches completed `staged` with **92 actual admissions**. They are not published.
- The fourth batch stopped at **40/83 mapped, 43 pending** and is not counted as a completed batch.
- Current engine coverage: **262 completed Developer documents, 1,507 ready chunks and 1,507 embedding rows**. Two existing published Developer mappings remain unchanged; 260 mappings are staged.
- This is approximately **0.61% of the 42,722 indexable documents** and **0.63% of the 238,949 expected vectors**. Full coverage was not reached.

The first three staged migrations were not published. No new migration was published, no Wiki was generated or published, and production was not changed.

## Preservation and recovery evidence

- Full raw-projection backups and an engine consistency backup were created before the relevant writes. The engine was restored to ready and bulk ingestion was enabled without changing model policy.
- Go build caches were cleared to recover disk space. This also removed the chunker's runtime Jieba dictionary; the exact pinned-release dictionary was restored and byte-compared before native budgeting continued. The running engine/databases/source archives were not deleted.
- The migration batch contract now accepts exact `localDocumentIds` and preserves them in the durable worker payload. Complete application verification at that change passed **889/889 tests**, standard build and strict TypeScript.
- The stopped job retains its mapping/checkpoint state. Resuming requires an explicit later decision; this report does not schedule one.

## Remaining work

Full engine coverage, incremental re-run, interrupted-resume verification at 42k scale, final publication, real-scale UI acceptance and final issue evidence are incomplete. Human semantic/Wiki review and agreed performance thresholds remain separate gates. #42/#43/#49/#50/#55/#56 remain open.
