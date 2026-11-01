# Wiki Generation Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable per-job Wiki generation progress and pause/resume controls for manual and automatic jobs, expose them through the API, render them in the Knowledge Wiki page, and deploy the verified build to production.

**Architecture:** Extend `knowledge_ingest_jobs` with explicit trigger and control state fields while keeping execution status separate. The dispatcher will claim only active jobs, and the Wiki worker will honor pause requests at topic-batch boundaries. The status API will return normalized progress summaries; the UI will poll active jobs and send job-scoped control commands.

**Tech Stack:** TypeScript, Fastify, SQLite migrations, Node test runner, React/Vite frontend, PM2 deployment over the local `relaymcp` SSH host.

**Spec:** `docs/superpowers/specs/2026-10-31-wiki-generation-controls-design.md`

## Global Constraints

- Control only `wiki_generation` jobs; Product document imports remain unaffected.
- Keep execution lifecycle (`queued`, `running`, `succeeded`, `failed`) separate from `control_state` (`active`, `pause_requested`, `paused`).
- Pause is cooperative at the five-topic batch boundary and never kills an active model call.
- Manual and automatic jobs must remain independently identifiable and controllable.
- Admin authorization is required for control mutations and status access.

## Review Focus

- Legacy jobs without new columns must normalize as automatic and remain runnable; test migration defaults and status normalization in Task 1.
- A queued paused job must be skipped by every dispatcher claim path; test direct claim and pending-runner behavior in Task 2.
- A pause request arriving during a batch must preserve the cursor and release ownership exactly once; test the worker boundary in Task 2.
- Resume must not reset generated/failure counts or cursor; test control transition and normalized progress in Task 3.
- UI polling must stop when no active job remains and must show the correct action for manual and automatic jobs; test the rendered control states in Task 4.

### Task 1: Persist job trigger and control state

**Files:**
- Create: `src/knowledge/migrations/053-wiki-generation-controls.ts`
- Modify: `src/knowledge/ingest-worker.ts`
- Modify: `src/knowledge/ingest-dispatch.ts`
- Test: `tests/wiki-generation-controls.test.ts`

**Interfaces:**
- Produces migration columns `trigger_kind`, `control_state`, `pause_requested_at`, `paused_at`, `paused_by`, `resumed_at`.
- Produces enqueue metadata with `triggerKind: "manual" | "automatic"` and a normalized job summary helper used by API tests.

- [ ] **Step 1: Write failing persistence and enqueue tests**
  - Assert manual enqueue writes `trigger_kind = manual`, automatic enqueue writes `automatic`.
  - Assert legacy rows default to `automatic` and `active`.
  - Assert the normalized progress shape computes `percent` from `processed / total` and includes control/trigger fields.
- [ ] **Step 2: Run the focused tests and confirm they fail**
  - Run `npx tsx --test tests/wiki-generation-controls.test.ts`.
  - Expected: failures for missing migration columns/metadata/normalizer.
- [ ] **Step 3: Implement the migration and enqueue metadata**
  - Add idempotent columns with safe defaults and backfill legacy `manual-*` trigger ids when SQLite JSON extraction is available; retain helper-level prefix fallback.
  - Add `triggerKind` to `enqueueWikiGeneration` and set it from explicit manual/automatic callers.
  - Add a shared `normalizeWikiGenerationJob` helper that parses `payload_json`/`result_json`, clamps percentage to 0–100, and returns camelCase fields.
- [ ] **Step 4: Run the focused tests and confirm they pass**
  - Run `npx tsx --test tests/wiki-generation-controls.test.ts`.
- [ ] **Step 5: Commit the persistence slice**
  - Commit message: `feat: persist wiki generation controls`.

### Task 2: Enforce pause/resume at dispatch and worker boundaries

**Files:**
- Modify: `src/knowledge/ingest-dispatch.ts`
- Modify: `src/knowledge/ingest-worker.ts`
- Create: `src/knowledge/ingest-controls.ts`
- Test: `tests/wiki-generation-controls.test.ts`

**Interfaces:**
- Consumes the migration fields and normalizer from Task 1.
- Produces `controlWikiGenerationJob(db, jobId, action, actorId)` returning the updated normalized job or a typed conflict/not-found error.

- [ ] **Step 1: Extend failing tests for queued pause, running boundary pause, resume, terminal rejection, and non-Wiki rejection**
  - Verify a queued paused job is not claimed.
  - Verify a running Wiki job pauses after its current five-topic batch with its cursor/result preserved and ownership cleared.
  - Verify resume returns a paused job to queued/active without resetting progress.
  - Verify succeeded/failed/product-document jobs reject controls.
- [ ] **Step 2: Run the focused tests and confirm they fail**
  - Run `npx tsx --test tests/wiki-generation-controls.test.ts`.
- [ ] **Step 3: Implement atomic control transitions**
  - Pause active queued jobs immediately; mark active running jobs `pause_requested`.
  - Resume only paused or pause-requested Wiki jobs, returning them to active and scheduling queued work.
  - Use conditional updates on current state to reject duplicate/stale clicks with conflicts.
- [ ] **Step 4: Implement dispatcher and worker enforcement**
  - Add control-state predicates to claim/select paths.
  - Check control state before each topic and before requeueing; on pause persist the current cursor/result, set `paused`, clear ownership, and stop without resetting progress.
- [ ] **Step 5: Run the focused tests and confirm they pass**
  - Run `npx tsx --test tests/wiki-generation-controls.test.ts`.
- [ ] **Step 6: Commit the control slice**
  - Commit message: `feat: pause and resume wiki generation jobs`.

### Task 3: Add API status normalization and control endpoint

**Files:**
- Modify: `src/server/routes/knowledge.ts`
- Modify: `src/knowledge/ingest-dispatch.ts`
- Modify: `tests/wiki-generation-controls.test.ts`
- Test: `tests/knowledge-wiki-navigation-http.test.ts`

**Interfaces:**
- Consumes `normalizeWikiGenerationJob` and `controlWikiGenerationJob`.
- Produces `POST /api/knowledge/ingest-jobs/:id/control` with `{ action: "pause" | "resume" }` and normalized response.

- [ ] **Step 1: Write failing HTTP tests**
  - Assert status endpoint exposes `processed`, `total`, `percent`, `generated`, `failures`, `controlState`, `triggerKind`, and timestamps.
  - Assert admin pause/resume succeeds and non-admin/terminal/non-Wiki requests are rejected.
- [ ] **Step 2: Run the focused HTTP tests and confirm they fail**
  - Run `npx tsx --test tests/knowledge-wiki-navigation-http.test.ts tests/wiki-generation-controls.test.ts`.
- [ ] **Step 3: Implement the route and status response**
  - Add admin-only control route with Zod action validation and mapped 404/409 responses.
  - Replace raw Wiki job summaries with normalized summaries while retaining existing state data.
- [ ] **Step 4: Run focused HTTP tests and confirm they pass**
  - Run `npx tsx --test tests/knowledge-wiki-navigation-http.test.ts tests/wiki-generation-controls.test.ts`.
- [ ] **Step 5: Commit the API slice**
  - Commit message: `feat: expose wiki generation job controls`.

### Task 4: Render progress and controls in the Knowledge Wiki UI

**Files:**
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/pages/KnowledgeIntegrated.tsx`
- Modify: `frontend/src/styles/*.css` (the existing Knowledge Wiki directory styles file)
- Test: `tests/knowledge-ui-routes.test.ts`

**Interfaces:**
- Consumes normalized status and control endpoint from Task 3.
- Produces a polling progress panel with manual/automatic badges and Pause/Resume actions.

- [ ] **Step 1: Write failing UI/API contract tests**
  - Assert the client builds the job control request and the page renders percentage, counts, trigger badge, and the correct action label for each control state.
- [ ] **Step 2: Run the focused UI test and confirm it fails**
  - Run `npx tsx --test tests/knowledge-ui-routes.test.ts`.
- [ ] **Step 3: Implement client method, polling, progress bar, and controls**
  - Poll while any job is queued/running/pause-requested, refresh directory after start/control/terminal transitions, and stop polling when idle.
  - Keep controls job-scoped; automatic jobs get the same per-job Pause/Resume affordance as manual jobs.
- [ ] **Step 4: Run focused UI tests and build the frontend**
  - Run `npx tsx --test tests/knowledge-ui-routes.test.ts`.
  - Run `npm --prefix frontend run build`.
- [ ] **Step 5: Commit the UI slice**
  - Commit message: `feat: show wiki generation progress controls`.

### Task 5: Full verification and production deployment

**Files:**
- Modify: `docs/superpowers/specs/2026-10-31-wiki-generation-controls-design.md` only if verification reveals a contract correction.
- Include: `docs/superpowers/plans/2026-10-31-wiki-generation-controls.md` and implementation changes.

- [ ] **Step 1: Run the full test suite and production build**
  - Run `npm test`.
  - Run `npm run build`.
- [ ] **Step 2: Review the diff and deployment script**
  - Confirm no production data mutation commands are included; inspect `deploy.sh` and current git diff.
- [ ] **Step 3: Commit the complete implementation**
  - Commit message: `feat: add controllable wiki generation progress`.
- [ ] **Step 4: Deploy over the authorized production SSH host**
  - Use the configured `relaymcp` SSH identity/host alias and the repository's deployment procedure.
  - Preserve the existing production database and running job; only deploy code/migrations and restart the application as required.
- [ ] **Step 5: Verify production**
  - Confirm services are healthy, migration `053` is applied, the status endpoint returns normalized progress, and the UI asset is served.
  - Record the production commit, service status, and any limitations.
