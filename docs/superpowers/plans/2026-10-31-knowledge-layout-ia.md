# Knowledge Layout and Information Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Knowledge pages share one content rail and give Provider, Wiki, Sessions, and Candidate insights one visible canonical home.

**Architecture:** Add reusable `StandardPage` and `WorkspacePage` wrappers with CSS tokens, then apply them to all Knowledge routes. Keep Control plane as the canonical Provider and Release gates surface, make Operations index read-only for provider state with a link to Provider configuration, and redirect legacy Control plane tabs to their existing canonical pages.

**Tech Stack:** React, React Router, TypeScript, Tailwind utility classes, existing CSS token files, Node test runner through `tsx`.

**Spec:** `docs/superpowers/specs/2026-10-31-knowledge-layout-ia-design.md`

## Global Constraints

- Preserve existing backend APIs and permissions.
- Preserve existing deep-link routes; legacy Control plane query tabs redirect to canonical routes.
- Use the current dark operational-console palette, typography, focus ring, and reduced-motion behavior.
- Keep Provider mutations available only from the canonical Control plane Provider surface.

## Review Focus

- A direct `/knowledge/operations/index` load must keep Overview inactive and Operations active.
- Provider configuration must not be available from Operations, while provider health and a canonical management link remain visible.
- Legacy `?tab=sessions`, `?tab=candidates`, and `?tab=wiki` links must land on Memory or Wiki instead of rendering duplicate modules.
- Standard and workspace frames must keep headings, tables, panels, and footer on aligned left/right edges at desktop and mobile widths.
- Wiki and Product docs must retain their wider workspace without regressing the existing directory/table responsiveness.

### Task 1: Add failing layout and information-architecture contract tests

**Files:**
- Create: `tests/knowledge-layout-ia.test.ts`
- Modify: `tests/knowledge-ui-routes.test.ts` only if shared assertions need consolidation

**Interfaces:**
- Consumes: current source files under `frontend/src`
- Produces: static contracts for frame usage, canonical tabs, provider ownership, and Overview active-state behavior

- [ ] **Step 1: Write the failing tests**

  Assert that the shared frame component exists and is used by the Knowledge pages, Operations has no Provider CRUD controls, Control plane has only Providers and Release gates as visible tabs, legacy redirects exist, and `SubNav` passes an exact-match flag for Overview.

- [ ] **Step 2: Run the focused test to verify it fails**

  Run: `npx tsx --test tests/knowledge-layout-ia.test.ts`
  Expected: FAIL because the shared frame and ownership changes do not exist yet.

### Task 2: Implement shared Knowledge page frames and shell alignment

**Files:**
- Create: `frontend/src/components/knowledge/KnowledgeFrame.tsx`
- Create: `frontend/src/components/knowledge/knowledge-frame.css`
- Modify: `frontend/src/components/shell/shell.css`
- Modify: `frontend/src/pages/KnowledgeOverview.tsx`
- Modify: `frontend/src/pages/KnowledgeIntegrated.tsx`
- Modify: `frontend/src/pages/KnowledgeMemory.tsx`
- Modify: `frontend/src/pages/KnowledgeOperations.tsx`
- Modify: `frontend/src/pages/KnowledgeProduct.tsx`
- Modify: `frontend/src/pages/KnowledgeProject.tsx`
- Modify: `frontend/src/pages/KnowledgeSource.tsx`
- Modify: `frontend/src/pages/KnowledgeWiki.tsx`
- Modify: `frontend/src/components/knowledge/overview.css`

**Interfaces:**
- Produces: `StandardPage` and `WorkspacePage` React wrappers with a shared content rail.

- [ ] **Step 1: Implement `StandardPage` and `WorkspacePage`**

  Give standard pages a centered 1280px rail and workspace pages a centered 1600px rail. Use the existing spacing and color tokens and keep horizontal padding fluid.

- [ ] **Step 2: Apply the wrappers to all Knowledge routes**

  Remove page-local max-width and padding choices where they duplicate the frame. Keep Wiki/Product docs wide while making their outer edges align with the same gutter.

- [ ] **Step 3: Align the shell footer and Operations header**

  Use the StandardPage rail for the footer and the shared page-tab styling so Operations no longer starts at viewport x=0 or places its tab group on a different rail.

- [ ] **Step 4: Run focused layout tests**

  Run: `npx tsx --test tests/knowledge-layout-ia.test.ts`
  Expected: PASS for frame usage and shell alignment contracts.

### Task 3: Collapse duplicate Knowledge navigation and Provider ownership

**Files:**
- Modify: `frontend/src/components/shell/navigation.ts`
- Modify: `frontend/src/components/shell/SubNav.tsx`
- Modify: `frontend/src/pages/KnowledgeIntegrated.tsx`
- Modify: `frontend/src/pages/KnowledgeOperations.tsx`
- Modify: `frontend/src/App.tsx` only if a compatibility redirect needs route-level handling

**Interfaces:**
- Consumes: `StandardPage`/`WorkspacePage` from Task 2
- Produces: canonical Provider and Release gates tabs, legacy redirects, and read-only Operations provider summary.

- [ ] **Step 1: Fix exact Overview matching**

  Pass `end` for the Overview `NavLink` so `/knowledge/operations/*` never marks Overview active.

- [ ] **Step 2: Reduce Control plane to canonical tabs**

  Keep Providers and Release gates visible. Redirect `sessions`, `candidates`, and `wiki` query tabs to `/knowledge/sessions`, `/knowledge/candidate-insights`, and `/knowledge/wiki` respectively.

- [ ] **Step 3: Remove Provider CRUD from Operations**

  Keep index health, built-in capability, provider status, and test/rebuild controls. Remove the duplicate setup form, modify/delete actions, and provider mutation state. Add one “Manage providers” link to Control plane Providers.

- [ ] **Step 4: Run focused tests**

  Run: `npx tsx --test tests/knowledge-layout-ia.test.ts tests/knowledge-ui-routes.test.ts`
  Expected: PASS.

### Task 4: Build, regression-test, and inspect the rendered production-style bundle

**Files:**
- Modify: any files needed to resolve test or build failures from Tasks 2-3

- [ ] **Step 1: Run the frontend build**

  Run: `npm --prefix frontend run build`
  Expected: PASS.

- [ ] **Step 2: Run the full test suite**

  Run: `npm test`
  Expected: all tests pass.

- [ ] **Step 3: Review the diff and inspect the built UI**

  Check the Operations and Control plane routes at desktop width, confirm the content rails align, and confirm no duplicate Provider mutation controls remain.

### Task 5: Deploy the verified build to production

**Files:**
- Deploy generated `dist/` and `frontend/dist/` artifacts to `/home/ftd/MCP` using the existing staged archive workflow.

- [ ] **Step 1: Archive and checksum the built artifacts**

- [ ] **Step 2: Upload to the production staging directory and verify checksum**

- [ ] **Step 3: Back up current artifacts, extract the new build, reload Web/MCP with PM2, and save the process state**

- [ ] **Step 4: Verify production routes, PM2 status, and Provider ownership**

  Confirm `/knowledge/operations/index` has aligned content and only a management link, `/knowledge/integrated?tab=providers` retains Provider mutations, and legacy query tabs redirect correctly.
