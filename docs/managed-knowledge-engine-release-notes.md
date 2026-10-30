# Unreleased: Relay-managed Product and Wiki engine

Product Documents are now the canonical product domain object. Relay keeps engine identifiers/status/provenance as a projection on each Product Document; legacy WeKnora/migration rows remain compatibility and audit history rather than a second user-facing object.

## Changes

- Relay deploy manages the private engine bundle, model gateway, startup/readiness, nativeCHM dependency and backup/recovery. The standard `npm run build` remains the application build.
- Existing Product IDs and API/MCP tools resolve actual engine content with verified original source citations. Product catalogs use the selected backend's published scope. A Product outage returns an explicit degraded section while authorized Relay memory remains available.
- KnowledgeStore startup migrations serialize concurrent Web/MCP openers, retry transient SQLite locks with bounded backoff, and keep repair/backfill work idempotent. Product Topics use scoped SQL/indexes instead of a full visibility JSON scan; paginated UI requests cancel stale work and surface timeouts.
- Generated Wiki pages converge to one page per `topic_group_id`, with common/version/difference sections, validated section-level document/chunk citations, and a solution → module → topic directory. Product imports enqueue background LLM generation; generated pages remain drafts until review.
- Durable migration jobs return202 with polling/retry and survive browser refresh. Parsing, indexing and publication remain separate; no incomplete document becomes published.
- Real ZIP/CHM/PDF parsing uses native extraction. Legacy PDF placeholder repair preserves source identity and manual edits. The normalized Product path preserves code and supports explicit parser-version upgrades.
- Native Wiki browsing/source jumps, edit/diff/publication/rollback use actual upstream revisions with Relay audit and scope checks. Transactional revision/source checks prevent competing writers from reviving deprecated pages or overwriting a newer review; no-op requests still recheck permission.
- Candidate compilation uses managed Relay models with strict typed output and deterministic fallback. Web/MCP consume the durable queue with atomic leases and explicit handling of uncertain interrupted calls. SQLite admission records enforce the shared logical-call quota across processes and restarts.
- Candidate review uses frozen trusted scope; legacy records require an explicit scope review. Case details and the draft→reproduced→verified flow work through existing review APIs. Rejected Candidates stay terminal.
- The model logging patch removes request/response bodies from supported upstream model paths. It ships with pinned source hashes and real Go regression proof.
- Structure-preserving html-3 normalization, linked-image preservation and original-file SHA-verified reads keep tables, code and anchors intact; document views no longer concatenate overlapping chunks.
- Whole-document automatic retries are disabled in the managed engine. Migration checkpoints retain accepted external IDs; provider model/credential changes invalidate queued stale invocations before transport.
- Unconfigured hybrid retrieval defaults favor keywords for technical objects and paths. Explicit retrieval weights retain their existing behavior.
- Wiki links navigate between scoped Relay pages with deep links and Back support; stale async responses cannot overwrite a newer selection or draft.
- Session summaries retain scoped Job/Deployment/Evidence/retrieval receipts. Audit projections omit raw queries, Candidate context and private reasoning fields.
- Three-way Solution comparison now distinguishes single-side changes/deletions from real conflicts and enforces Project Snapshot ACL in MCP. Baseline/snapshot selectors, source-evidence references and paged Source files are available in the existing Solution UI.
- Upgrade analysis includes deterministic C#/SQL/VGL/XML symbol changes with line spans and old/project/next chunk references alongside the existing file-level result; unsupported languages remain file-level.
- Local migration accepts exact `localDocumentIds` for bounded batches while preserving the same idempotency/checkpoint semantics. Empty selections import nothing, reruns stage only newly added documents, and no 10,000-document prefix is silently reused across batches.
- Product bindings below 0.8 match confidence enter `pending_review`; administrators can approve/reject with a required audited reason in Topics. Existing reviewed binding identity is preserved when a same-version revision advances.
- Product Knowledge now has a deterministic graph retrieval layer: Product headings, stable identifiers, links, metadata and explicitly labelled relations are stored with source locator/SHA, version and extraction provenance. The existing Product vector/keyword search routes relation/entity intents through ACL-scoped, bounded graph expansion with endpoint indexes; no standalone graph-search entry point is added. `scripts/rebuild-product-graph.ts` performs resumable, idempotent backfill for existing Product documents.

## Upgrade and rollback

Back up application/Knowledge databases, Evidence, encrypted-provider key/configuration and the stopped engine as a consistent checkpoint. Migrations040–046 add engine control state, Candidate scope, worker leases, explicit migration withdrawal, durable provider admission, ingestion ownership and parser-aware revision identity. They preserve old source bodies and audit history. Do not remove old Product indexes as part of this release; cleanup remains a dry run.

After updating Relay, stage and validate the intended sources, inspect their real parse/chunk/model evidence, then publish. Sources affected by earlier Markdown cleanup require a new operation key and parser version; do not relabel a historical mapping as repaired. Review legacy Candidate scopes before allowing their Cases into default reuse.

A Product migration rollback returns routing to the retained local index without deleting Memory or Evidence. For an application/schema rollback, stop services and restore the matching database/configuration checkpoint; do not assume older application code understands newer withdrawn/lease states.

## Compatibility and limits

The catalog is121 tools. `knowledge_candidate_insight_job_get` is additive; asynchronous compile accepts providerId and explicit failed-job retry. Knowledge outputs retain structured JSON up to16MiB instead of generic preview truncation.

Provider admissions persist across restarts and are shared by processes using this Knowledge database; they are not global account/billing caps. Retries can issue additional physical requests within one logical admission. A crash between remote model completion and local persistence cannot prove exactly-once billing; ambiguous expired jobs require explicit retry.

The nonproduction 5,372-page migration, exact source/chunk/vector verification, publication, restart/replay, formal reindex, real Job/Deployment correlation and provider fault/rotation packets are complete. Full tests pass 849/849 plus 22/22 Python regressions and the standard build. Retrieval Recall@10 improved to 0.831681, while MRR/nDCG remain below the FTS control; semantic precision and Wiki factual/source-support quality do not pass the aggregate release gate. Production has not been updated by this acceptance phase. See the [current issue/evidence report](verification/knowledge-acceptance-20261026.md) and [operations guide](managed-knowledge-engine-operations.md).
