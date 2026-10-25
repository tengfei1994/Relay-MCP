# Unreleased: Relay-managed Product and Wiki engine

Product document reads/searches and generated Wiki use the pinned internal WeKnora Lite process after an explicit validated publication. Relay remains the only browser/API/MCP entry point and owns encrypted model configuration, ACL, source/version bindings, review, deployment and rollback. Long-term Memory, Evidence and source baselines stay in Relay.

## Changes

- Relay deploy manages the private engine bundle, model gateway, startup/readiness, nativeCHM dependency and backup/recovery. The standard `npm run build` remains the application build.
- Existing Product IDs and API/MCP tools resolve actual engine content with verified original source citations. Product catalogs use the selected backend's published scope. A Product outage returns an explicit degraded section while authorized Relay memory remains available.
- Durable migration jobs return202 with polling/retry and survive browser refresh. Parsing, indexing and publication remain separate; no incomplete document becomes published.
- Real ZIP/CHM/PDF parsing uses native extraction. Legacy PDF placeholder repair preserves source identity and manual edits. The normalized Product path preserves code and supports explicit parser-version upgrades.
- Native Wiki browsing/source jumps, edit/diff/publication/rollback use actual upstream revisions with Relay audit and scope checks. Transactional revision/source checks prevent competing writers from reviving deprecated pages or overwriting a newer review; no-op requests still recheck permission.
- Candidate compilation uses managed Relay models with strict typed output and deterministic fallback. Web/MCP now consume the durable queue with atomic leases and explicit handling of uncertain interrupted calls. Shared in-process policies enforce cancellation, timeouts, concurrency and local quota.
- Candidate review uses frozen trusted scope; legacy records require an explicit scope review. Case details and the draft→reproduced→verified flow work through existing review APIs. Rejected Candidates stay terminal.
- The model logging patch removes request/response bodies from supported upstream model paths. It ships with pinned source hashes and real Go regression proof.

## Upgrade and rollback

Back up application/Knowledge databases, Evidence, encrypted-provider key/configuration and the stopped engine as a consistent checkpoint. Migrations040–043 add engine control state, Candidate scope, worker leases and explicit migration mapping withdrawal. They preserve old source bodies and audit history. Do not remove old Product indexes as part of this release; cleanup remains a dry run.

After updating Relay, stage and validate the intended sources, inspect their real parse/chunk/model evidence, then publish. Sources affected by earlier Markdown cleanup require a new operation key and parser version; do not relabel a historical mapping as repaired. Review legacy Candidate scopes before allowing their Cases into default reuse.

A Product migration rollback returns routing to the retained local index without deleting Memory or Evidence. For an application/schema rollback, stop services and restore the matching database/configuration checkpoint; do not assume older application code understands newer withdrawn/lease states.

## Compatibility and limits

The catalog is121 tools. `knowledge_candidate_insight_job_get` is additive; asynchronous compile accepts providerId and explicit failed-job retry. Knowledge outputs retain structured JSON up to16MiB instead of generic preview truncation.

Provider counters are process-local and reset on restart; they are not global account/billing caps. A crash between remote model completion and local persistence cannot prove exactly-once billing; ambiguous expired jobs require explicit retry.

This branch's bounded nonproduction acceptance does not complete the full5,372-page engine migration, retrieval gold-set, factual Wiki review, load/performance, remote Job/Deployment correlation or all provider-rotation/reindex release gates. Production has not been updated by this integration acceptance phase. See the [measured acceptance report](verification/managed-engine-progress.md) and [operations guide](managed-knowledge-engine-operations.md).
