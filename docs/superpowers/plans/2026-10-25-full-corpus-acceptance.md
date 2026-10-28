# Full Product corpus migration and quality acceptance

Continuation of PR61, base e5a392a. The user authorized continuing nonproduction automation, prioritizing5,372 pages and retrieval/Wiki quality, and issue comments/closure only after individual acceptance.

## Binding constraints

- Direct SSH via ftd1994-codex, never Relay MCP connector; production remains read-only.
- Approved original21.1/21.3 archives and encrypted provider configuration remain under /home/ftd/relay-knowledge-engine-nonprod. No private bodies, prompts or credentials in Git/tool output.
- Retain the current200 logical calls/hour/provider, concurrency1 and existing retry/time limits. Do not restart to reset quotas or auto-repeat uncertain billed work.
- Preserve original5 samples, CHM proofs, Evidence, Memory and audit. No automatic production deployment, destructive index cleanup or broad issue closure.

## Work

1. Freeze the exact corpus:21.3 Product inner ZIP contains5,374 HTML files;2 empty MadCap shell pages explain5,372 nonempty documents. Classify navigation/MicroContent explicitly; do not silently remove them or mix Developer HTML. Record source/body/parser hashes and content/chunk/token/resource estimates.
2. Make the existing migration safe for full scale: immutable manifest, bounded checkpointed batches, explicit suspension/resumption, per-document status and quota-aware pacing. Failed/withdrawn/uncertain work requires its explicit policy. Preserve idempotent identities and historical reports.
3. Seed a dedicated nonproduction full-corpus scope, run baseline local gold queries, then actual engine upload/index/validation. Keep Product staged until complete source/chunk/model proof. Use documented bulk indexing/Wiki scheduling controls, never bypass actual embeddings or fake completion.
4. Run source-grounded English/Chinese/object/path/version/config/VGL/XML queries, citation completeness and forbidden-scope gates. Freeze expectations before comparing. Measure actual HTTP/model latency separately from hot-cache FTS.
5. Validate actual Wiki provenance and lifecycle plus automated source support checks. Distinguish citation presence from factual entailment; unsupported claims fail the quality report rather than being silently accepted.
6. Run affected regression/full tests/build, deploy only nonproduction, verify persistence and retry/rollback/ACL; refresh privacy scans and operational evidence. Update PR61 and individual issues, close only complete criteria.

## Current evidence and decisions

- Prior bounded acceptance587/587, standard build and real5 samples+2 CHM pages passed; #48 alone closed. This is not full-corpus acceptance.
- Existing worker has a30-minute process deadline and no quota-reset scheduling. A single unmodified limit5372 call is not an acceptable full run.
- Ruling: use the exact nonempty Product archive corpus, retaining 33 MicroContent pages and one search/navigation page as evidence. Cost if incorrect: corpus mismatch invalidates full-migration/quality results; assert inventory before writes.
- Frozen JSONL SHA-256: `712d0e78e9928123c402b748a3e966ef99eaf30121a7ff4ac76be3fe0ab30009`. The corpus has 5,372 documents, 22,694 local chunks, 13,164 sections and 5,148 topic bindings; 82 pairs of equal bodies at different source paths remain distinct.
- Real CPU-only preview covers 5,371 pages: 39,521 engine chunks, 10,073 logical embedding sub-batches (batch size 5), approximately 4,142,664 input tokens. One 81,850-character page exceeds the preview endpoint limit and requires the same native chunker offline. No model calls were made for the estimate.
- Bulk profile keeps the existing KB/model identities and actual vector indexing, temporarily disables Wiki on the dedicated nonproduction KB and defers per-document summaries/questions. Existing Wiki pages/history are retained but inaccessible while disabled; restore standard after migration. This profile does not retroactively generate Wiki for the full corpus.
- The user authorized maximum-efficiency execution in response to the concrete 12,000 logical calls per 24 hours proposal. Apply only to nonproduction embedding, keep concurrency 1/retries 1, retain the admission ledger, audit the new budget and restore 200/hour after acceptance. A private 24-hour watchdog also restores the previous quota if the acceptance run is interrupted; Wiki/Candidate policies remain unchanged.
- Initial full test run: 613/617 passed; four Python child-process checks were blocked by sandbox EPERM. Those runtime/privacy checks passed 19/19 under normal execution permissions. A further dispatcher ownership race was found in review; final full-suite verification follows its repair.

## Progress

- [x] Exact immutable manifest and dry-run resource/call estimate
- [x] Safe bounded migration regression and implementation
- [ ] Full engine migration, verified publication and idempotent replay
- [ ] Retrieval/Wiki quality report with explicit failures/limits
- [ ] Final verification, PR update and issue disposition

## Subsequent evidence, 2026-10-25 15:18 UTC

The earlier html-2 run is retained as failed evidence. Candidate v3-b freezes all 5,372 html-3 sources under manifest `6e151fcae5636df1e6a682294e4985b53d6a0e59054193112321142566188b95`, with 44,833 indexable chunks and 11,248 logical embedding batches. The user explicitly approved **15,000/24h**, retaining concurrency 1, gateway retries 1, the existing ledger and the original restoration deadline.

Actual indexing is paused at 357 accepted mappings/339 upstream-verified mappings. Independent chunk hashing exposed an upstream linked-image transformation; a separate controlled patch preserves the full source and has passed a CPU comparison for all 5,372 documents. Embedding now returns HTTP 403 even for a fixed-text minimal probe, while model discovery and same-key Wiki calls work. Do not restart corpus calls until the refusal is resolved. The migration must stop at its durable checkpoint on a fresh bound-provider failure; circuit-open denials must not consume new transport admissions.

The linked-image repair and no-automatic-document-retry patch are separately pinned, tested and built before a nonproduction upgrade. Existing indexes requiring repair remain unpublished. Current projected ledger after remaining work, 89 index repairs and 55 online queries is 14,859, leaving only 141 logical invocations of headroom; this is a forecast, not permission to exceed the cap.

See [the full-corpus progress and failure report](../../verification/full-corpus-v3-progress.md), [provider diagnosis](../../verification/knowledge-provider-failure-20261025.md), [Wiki review](../../verification/wiki-source-consistency-review.md) and [real-format browser import](../../verification/browser-real-format-import.md). The older facts above are historical checkpoints, not the current acceptance result.

## Authorized continuation: Flash, 16,000 calls

The user approved 16,000 logical embedding invocations per 24 hours after the verified Flash model switch. Retain all historical admissions; concurrency 1, at most one provider retry, and no automatic whole-document retry. The original lease expiry and restoration to 200/hour remain in force. Wiki/Candidate budgets are unchanged.

Run the same frozen 5,372-source v3-b manifest into the new Flash KB `c5c3bc14-c3e6-4b93-8147-87a3bfa0e29a`, migration `migration-d09f8da0-9f7c-4501-b3d4-1ff8ada653f5`, provider `qwen3.7-text-embedding-flash` / index 2. Explicitly filter validation by migration and model identity because the source environment is shared with retained old attempts. Do not resume the former model's migration or treat its indexes as Flash evidence. Current progress and hashes are in `docs/verification/full-corpus-v3-progress.md`.
