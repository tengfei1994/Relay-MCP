# Relay-managed Knowledge Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace Product/Wiki engine paths with actual WeKnora under Relay-managed models and deployment.
**Architecture:** Pin upstream Lite, bootstrap through private backend state, use scoped model proxy and existing Relay ACL/publication mappings. Preserve memory/source baselines and explicit rollback.
**Tech Stack:** TypeScript/Fastify/SQLite/React; WeKnora Go Lite v0.8.3; shell lifecycle tooling.
**Spec:** ../specs/2026-10-25-managed-knowledge-engine-design.md

## Global Constraints
- No Relay MCP tool use. Direct SSH via configured host only. Production reads only during implementation.
- No user provider token in upstream config, public DTO, logs or audit. No mock-only completion claims.
- Preserve existing schema/API/source evidence; no destructive index cleanup.
- All nine reopened child issues require acceptance re-evaluation.

## Review Focus
- A valid config with failed actual upstream parse must remain unpublished.
- Wrong environment or unknown upstream IDs must be rejected before source hydration.
- Token rotation/disabled providers and changed dimensions must affect already provisioned engine models.
- Engine failure must preserve Memory/Evidence and return explicit degradation, without stale Product FTS.
- Restart during migration must not double ingest, lose mappings, or claim release-ready without real engine evidence.

### Task 1: Correct issue evidence and baseline
- [x] Audit #42–#56 bodies/comments/code; reopen unfulfilled #44–48/#51–54 with specific reasons.
- [x] Baseline latest main plus browser fixes; record exact tests and build.

### Task 2: Managed runtime (runtime_recon)
Files: scripts/knowledge-engine/*, scripts/knowledge-engine.sh, ecosystem.config.cjs, deploy.sh, tests/knowledge-engine-runtime.test.ts
- [x] Pin upstream/Go artifacts; installer stages immutable versioned release and hashes, without privileged runtime dependencies.
- [x] Test directory validation, failed install, PID identity, readiness and backup contract; implement install/run/start/status/stop/backup.
- [x] Build and run real Lite on isolated nonproduction host. Record health, restart and data persistence.

### Task 3: Actual upstream document contract (upstream_contract)
Files: src/knowledge/weknora.ts, src/knowledge/weknora-ingest.ts, related tests
- [x] Add regression tests for real upstream envelopes, async parse completion, scope filtering and real chunk reads.
- [x] Implement schema-compatible methods and bounded polling/retry; only verified parsed records can publish.
- [x] Preserve stable public DTO and source/metadata mapping; never return KB credentials.

### Task 4: Unified model gateway/bootstrap (root)
Files: src/knowledge/engine-{config,manager,model-gateway}.ts, src/server/routes/knowledge-engine.ts, src/server/index.ts, tests/knowledge-engine*.test.ts
- [x] Test scoped internal auth, provider kind/model/version binding, disabled provider, no secret disclosure.
- [x] Implement private engine config and idempotent upstream tenant/model/KB bootstrap using current Relay ProviderRegistry.
- [x] Register safe admin status/initialize operations and proxy endpoints. Verify real embedding reaches user-configured model through Relay.

### Task 5: Product/Wiki routing and UI (root + scoped agent)
Files: src/knowledge/product-backend.ts, src/knowledge/engine-wiki.ts, src/server/routes/knowledge.ts, src/mcp/tools/knowledge.ts, frontend Knowledge UI
- [x] Regression tests: legacy search/get obey active engine, published/ACL/environment, degraded no local fallback.
- [x] Wiki backend methods use real upstream Wiki; keep ACL/audit/publication in Relay. Verify citation, diff and rollback.
- [x] Bind existing Web/MCP entry points and model status UI, retaining route compatibility.

### Task 6: Real validation and handoff
Files: scripts/knowledge-engine-e2e.ts, docs/*, acceptance report
- [x] Run actual bootstrap/import/index/search/read/Wiki/model/ACL/restart/migration/rollback flow with recorded IDs and numeric metrics.
- [x] Run full test/build and browser checks against isolated service, inspect failures and fix regressions.
- [ ] Review branch, create PR, update issues with exact evidence; close only complete criteria. Preserve remaining scale/scenario gaps explicitly.


### Acceptance-driven corrections
- [x] Trusted Candidate scope migration041, transactional review, legacy review and Case deep links.
- [x] Async Candidate dispatcher/lease migration042, cancellation and shared process-local provider policy.
- [x] Full original archive parsing and distinct-operation idempotency, with native PDF and managedCHM dependency.
- [x] Rebuilt metadata-only model logging patch and actual approved-provider scan.
- [x] Preserve confirmed Relay memory when only Product availability is degraded.
- [x] Preserve CHM code through normalization, parser-version upgrade and actual stored-source verification.
- [x] Final deployed async Candidate probe and real outage ContextPack rerun.
- [ ] Final complete tests/build, PR and per-issue comments/closure decision.
