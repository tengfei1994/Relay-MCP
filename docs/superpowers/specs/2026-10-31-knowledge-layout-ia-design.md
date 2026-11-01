# Knowledge Layout and Information Architecture Design

## Intent

Make the Knowledge area feel like one product: page content shares a stable left and right boundary, and each capability has one canonical home. The change keeps existing backend APIs and URLs where possible so production data and deep links remain usable.

## Goals

- Use one centered `StandardPage` frame for normal Knowledge pages.
- Use one centered `WorkspacePage` frame for wide Wiki and Product docs workspaces.
- Keep Provider configuration in one canonical Control plane surface.
- Keep Operations focused on capture, ingest, index health, and runtime diagnostics.
- Keep Wiki, Sessions, and Candidate insights in their existing top-level destinations.
- Preserve existing URLs and redirect or link duplicate entry points rather than breaking deep links.

## Non-goals

- No backend API or database changes.
- No change to provider permissions or mutation semantics.
- No redesign of Wiki directory or Product docs data workflows beyond their outer frame.
- No removal of historical routes that may be bookmarked.

## Chosen approach

Use shared frontend layout primitives and route-level ownership changes. Add reusable Knowledge page and workspace frames, make Operations index read-only for provider state with a link to Control plane Providers, and remove duplicate Control plane tabs for Sessions, Candidates, and Wiki. Existing routes continue to render their canonical page so bookmarks remain valid.

The visual direction stays with the current dark operational console: centered content boundaries, restrained glass surfaces, existing typography and semantic colors. The differentiator is a consistent content rail that keeps headings, tabs, cards, tables, and the footer aligned across Knowledge pages.

## Information architecture

```text
Knowledge
├── Overview
├── Product docs
├── Wiki
├── Memory
│   ├── Workspace
│   ├── Sessions
│   ├── Evidence
│   ├── Observations
│   ├── Candidate insights
│   └── Confirmed memory
├── Solutions
├── Playbooks
├── Operations
│   ├── Capture
│   ├── Ingest
│   └── Index health
└── Control plane
    ├── Providers
    └── Release gates
```

Control plane may retain compatibility redirects for its previous Sessions, Candidates, and Wiki query tabs, but those tabs are no longer presented as parallel destinations. Operations keeps provider health summaries and a link to the canonical Provider configuration.

## Layout contract

- `StandardPage`: `max-width: 1280px`, centered, horizontal padding `clamp(20px, 3vw, 40px)`.
- `WorkspacePage`: `max-width: 1600px`, centered, the same horizontal padding.
- All Knowledge page headers, local tabs, panels, tables, and empty states live inside one of these frames.
- The shell footer uses the StandardPage rail so its left edge matches ordinary pages.
- The existing dark palette, fonts, focus ring, reduced-motion behavior, and semantic status colors remain in use.

## Verification

- Add route/layout contract tests that assert canonical tab ownership and shared frame usage.
- Add a UI test that the Operations index surface no longer exposes Provider CRUD controls but does expose the canonical Provider link.
- Build the frontend and run the existing full test suite.
- Verify production routes, visual alignment, and provider ownership in the authenticated browser session before deployment.
