# Wiki generation migration and persistent directory implementation plan

> **Goal:** Move Wiki generation to a dedicated Operations page and make Wiki directory classification durable and stable across pagination and future Product Document imports.

## Scope and architecture

- Keep `knowledge_ingest_jobs` and the existing pause/resume state model.
- Add a versioned `knowledge_wiki_directory_assignments` projection keyed by scope plus topic identity.
- Derive assignments from the complete canonical Wiki set for a scope and persist them during an explicit backfill or affected-topic refresh; ordinary reads do not recalculate the corpus.
- Let the browser render persisted paths; remove client-side A–Z and current-window threshold decisions.
- Keep Product Search source-based and keep Wiki reading source-linked.

## Task 1: Add failing backend persistence tests

**Files:**

- Create: `tests/wiki-directory-persistence.test.ts`
- Modify: `tests/knowledge-wiki-directory.test.ts`

**Checks:**

- A repeated family gets one stable display family across separate list calls.
- A singleton family is promoted to a shared parent and retains directory context.
- No alphabetic bucket is produced.
- A new version in the same topic group reuses the existing assignment.
- An unrelated topic import does not change existing assignments.
- A family crossing the aggregation threshold moves only during an explicit affected-family refresh and records a new taxonomy version.

Run `npx tsx --test tests/wiki-directory-persistence.test.ts tests/knowledge-wiki-directory.test.ts` and confirm the new assertions fail before implementation.

## Task 2: Implement the durable directory projection

**Files:**

- Create: `src/knowledge/migrations/054-wiki-directory-assignments.ts`
- Create: `src/knowledge/wiki-directory-assignments.ts`
- Modify: `src/knowledge/store.ts`
- Modify: `src/knowledge/wiki.ts`
- Modify: `src/server/routes/knowledge.ts`

**Implementation:**

- Add an idempotent table with scope, stable identity, topic group/page IDs, display path, directory context, classification source, taxonomy version, source path snapshot, and timestamps.
- Expose a helper that loads canonical Wiki summaries, derives source paths in one bounded graph pass, calculates global family counts, promotes singleton branches, and upserts assignments transactionally. It supports a full backfill and a topic-group-scoped refresh; list reads only consume assignments.
- Use the persisted assignment when `WikiService.list` returns summaries; preserve `directory_path` as source-derived data.
- Update the directory endpoint to return the same stable page paths and a directory version marker. Do not use the legacy solution/module-only `directory` payload as the client tree source.
- Keep manual legacy pages supported through page ID fallback.

Run the focused backend tests and verify the migration applies to a temporary SQLite store.

## Task 3: Remove A–Z projection from the frontend

**Files:**

- Modify: `frontend/src/knowledge/wiki-directory.ts`
- Modify: `frontend/src/pages/KnowledgeIntegrated.tsx`
- Modify: `frontend/src/pages/wiki.css`
- Modify: `tests/knowledge-wiki-directory.test.ts`

**Implementation:**

- Remove `letterBucket`, bucket counts, and the A–Z fallback branch.
- Render persisted paths directly, keeping `Other topics` flat.
- Update legend and hints to describe topic families and source context.
- Keep pagination and lazy reading behavior, but ensure loading more rows only adds pages to existing stable paths.

Run directory tests and the frontend route/UI contract tests.

## Task 4: Move Wiki generation into Operations

**Files:**

- Create: `frontend/src/pages/KnowledgeWikiGeneration.tsx`
- Modify: `frontend/src/components/shell/navigation.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/KnowledgeOperations.tsx`
- Modify: `frontend/src/pages/KnowledgeIntegrated.tsx`
- Modify: `frontend/src/api/client.ts` only if the existing methods need a narrower response type
- Modify: `frontend/src/pages/wiki.css` or a new Operations stylesheet for the dedicated panel
- Modify: `tests/knowledge-ui-routes.test.ts`

**Implementation:**

- Add the `Wiki generation` Operations tab and route.
- Move polling, job cards, progress bars, trigger labels, and pause/resume controls to the new page.
- Keep the generation start action and a compact admin link in Wiki; remove its embedded progress panel and generation polling.
- Preserve manual/automatic distinction and per-job controls.
- Ensure the page uses the shared StandardPage frame and does not inherit Wiki’s narrow directory layout.

Run UI contract tests, then build the frontend.

## Task 5: Import integration and regression verification

**Files:**

- Modify: `src/knowledge/ingest-worker.ts` only if the import completion path needs an assignment refresh hook
- Modify: `src/knowledge/wiki-generation.ts` only if topic identity metadata is needed by the assignment helper
- Add focused assertions to `tests/wiki-generation-controls.test.ts` or a new import integration test

**Checks:**

- An import queues generation for the affected topic group while the directory assignment is updated independently.
- A paused Wiki job remains paused after refresh/restart and the directory remains readable.
- Generation progress is absent from the Wiki reading surface and present on Operations.

## Task 6: Build, test, deploy, and verify

- Run focused tests for directory persistence, Wiki controls, UI routes, and layout.
- Run `npx tsc --noEmit`.
- Run the frontend production build.
- Run the full test suite and record unrelated environment failures without hiding them.
- Deploy the backend migration, server bundle, and frontend assets to `/home/ftd/MCP` over the authorized `relaymcp` SSH path, preserving the production database.
- Reload PM2 services, verify migration 054, health endpoints, Operations route, Wiki route, stable directory paths, and existing paused jobs.
