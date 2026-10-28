# Long-term Memory Model Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old Case/Pattern/Playbook lifecycle as the primary memory model with Work Session, Evidence, Observation, Candidate Insight, and typed Confirmed Memory while preserving legacy read compatibility.

**Architecture:** Add an additive `knowledge_confirmed_memories` projection with strict discriminated unions and evidence/audit metadata. Candidate Insight review creates Confirmed Memory only through explicit typed promotion; search and Context Pack default to confirmed rows. Keep legacy document projections readable through adapters, and make the frontend Memory workspace the primary navigation.

**Tech Stack:** TypeScript, SQLite migrations, Fastify, MCP SDK, React/Vite, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-25-managed-knowledge-engine-design.md`

## Global Constraints

- Do not call external models or real WeKnora services; use fixtures and fake providers.
- Do not delete or rewrite legacy production data; legacy rows remain readable.
- Candidate Insight kinds are exactly `fact | decision | case | pattern`.
- Confirmed Memory kinds are exactly `Fact | Decision | Case | Pattern`.
- Candidate Insights never enter default Confirmed Context Pack.
- Product Knowledge, Wiki, and WeKnora paths remain separate and regression-tested.

## Review Focus

- Strict discriminants must reject playbook/observation candidates and cross-type patches: test schema failures.
- Confirmed records must carry visible Evidence, scope, source, confirmer, timestamp, and audit: test persistence and detail responses.
- Default retrieval must exclude candidates and Playbooks while honoring project/environment/ACL: test search and Context Pack isolation.
- Legacy Case/Pattern/Playbook data remains readable without becoming a new write target: test adapter reads and promotion writes.
- Memory navigation must remove the old arrow pipeline while retaining Product/Wiki routes: test rendered source/navigation contracts.

---

### Task 1: Typed domain model and additive migration

**Files:**
- Create: `src/knowledge/migrations/039-confirmed-memory.ts`
- Modify: `src/knowledge/domain.ts`
- Modify: `src/knowledge/candidate-insight.ts`
- Modify: `src/knowledge/store.ts`
- Test: `tests/confirmed-memory-domain.test.ts`

**Interfaces:**
- Produces `CandidateInsightKind`, `ConfirmedMemoryType`, `ConfirmedMemory`, validators, migration table and store row mappers for later tasks.

- [ ] Write failing tests for the four candidate kinds, four confirmed kinds, required provenance fields, and migration table.
- [ ] Run `npx tsx --test tests/confirmed-memory-domain.test.ts` and observe failures.
- [ ] Implement strict unions, per-type detail schemas, `knowledge_confirmed_memories` schema, evidence/audit columns, and store helpers without changing legacy table writes.
- [ ] Run the focused test and confirm it passes.

### Task 2: Confirmation/promotion service and retrieval boundary

**Files:**
- Modify: `src/knowledge/candidate-review.ts`
- Modify: `src/knowledge/review-service.ts`
- Modify: `src/knowledge/repository.ts`
- Modify: `src/knowledge/retriever.ts`
- Modify: `src/knowledge/context-sources.ts`
- Modify: `src/knowledge/context-pack.ts`
- Test: `tests/confirmed-memory-review.test.ts`
- Test: `tests/knowledge-retrieval-boundary.test.ts`

**Interfaces:**
- Consumes Task 1 validators/store helpers.
- Produces typed promotion, confirmed-only default retrieval, and legacy read adapters.

- [ ] Write failing tests covering promote Fact/Decision/Case/Pattern, rejection of cross-type targets, evidence/ACL/project/environment isolation, candidate exclusion, and legacy reads.
- [ ] Run focused tests and observe failures.
- [ ] Implement explicit promotion into `knowledge_confirmed_memories`, typed DTO mapping, legacy adapters, and default filters; keep Playbook opt-in only.
- [ ] Run focused tests and confirm they pass.

### Task 3: HTTP and MCP contracts

**Files:**
- Modify: `src/server/routes/knowledge.ts`
- Modify: `src/mcp/tools/knowledge.ts`
- Modify: `frontend/src/api/client.ts`
- Test: `tests/knowledge-memory-api.test.ts`
- Test: `tests/mcp-tools.test.ts`

**Interfaces:**
- Consumes Task 2 services.
- Produces confirmed-memory list/detail/search/review DTOs and explicit candidate/approved-operation filters.

- [ ] Add failing API/MCP tests for four typed promotions, default candidate exclusion, detail provenance/audit, and legacy document reads.
- [ ] Run focused tests and observe failures.
- [ ] Implement route schemas, MCP tool schemas, and client methods with discriminated types; preserve Product/Wiki endpoints.
- [ ] Run focused tests and confirm they pass.

### Task 4: Memory workspace UI

**Files:**
- Modify: `frontend/src/components/Layout.tsx`
- Modify: `frontend/src/components/KnowledgePrimitives.tsx`
- Modify: `frontend/src/pages/KnowledgeProject.tsx`
- Modify: `frontend/src/pages/KnowledgeIntegrated.tsx`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/App.tsx`
- Test: `tests/knowledge-ui-routes.test.ts`

**Interfaces:**
- Consumes Task 3 DTOs.
- Produces Memory workspace navigation with Sessions, Evidence, Observations, Candidate Insights, Confirmed Memory filters, and separate Approved Operations.

- [ ] Add failing source/render contract tests for no lifecycle arrows, new labels, typed filters, detail provenance, and unchanged Product/Wiki routes.
- [ ] Run focused tests and observe failures.
- [ ] Replace primary Project Knowledge pipeline with non-linear Memory workspace and separate Playbook area while retaining legacy URLs as compatibility views.
- [ ] Run frontend build and focused UI tests.

### Task 5: Documentation, migration notes, and full verification

**Files:**
- Modify: `docs/knowledge-governance.md`
- Modify: `docs/knowledge-card-scope.md`
- Modify: `docs/knowledge-base-architecture.md`
- Modify: `docs/deployment-command-guide.md`
- Modify: `docs/samplemanager-knowledge-enabled-deployment-flow.md`
- Modify: MCP baseline if generated contract changes
- Test: existing knowledge/Product/Wiki regression suites

- [ ] Write migration/read-compatibility and API/MCP contract notes.
- [ ] Run `npm test`, `npm run build`, strict TypeScript checks, affected frontend tests, and `git diff --check`.
- [ ] Record acceptance evidence, compatibility items, and open human-review items without closing issues.
