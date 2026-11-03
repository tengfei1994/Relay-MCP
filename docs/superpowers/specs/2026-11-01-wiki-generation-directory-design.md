# Wiki generation migration and persistent directory design

## Intent

Move Wiki generation operations out of the compact Wiki reading surface into a dedicated Operations page, and make Wiki directory classification stable across pagination, reloads, and future Product Document imports.

## Goals

- Give Wiki generation its own Operations route and page with progress, manual/automatic job labels, and job-scoped pause/resume controls.
- Keep the Wiki page focused on directory navigation and source-linked reading.
- Remove alphabetic buckets from the directory.
- Persist a classification projection so a page keeps the same visible folder when more pages are imported or loaded.
- Classify generated topic pages by stable topic identity and source-derived family/context, while retaining the original source path for traceability.
- Keep versioned Product Documents and generated Wiki pages separate: importing a new version updates the affected topic classification and queues generation, but does not rewrite unrelated directory assignments.

## Non-goals

- Changing Product Document retrieval: search continues to return source documents/chunks.
- Replacing `topic_group_id` or the existing Wiki generation job model.
- Building a general-purpose taxonomy editor in this change.
- Reclassifying the entire corpus on every document import.

## Current constraints

- Wiki directory paths are currently derived from graph/source metadata and then regrouped in the browser.
- The browser currently receives paged rows, so threshold-based grouping can change as more rows are loaded.
- Wiki generation status and control APIs already persist jobs in `knowledge_ingest_jobs`.

## Chosen design

### 1. Dedicated generation surface

Add `/knowledge/operations/wiki-generation` as a fourth Operations tab. Move the existing generation progress and controls into a dedicated `WikiGenerationOperations` page. Keep one small link from Wiki to this page for administrators. Remove generation controls, job cards, and polling from the Wiki directory pane. Control plane remains responsible for providers and release gates.

### 2. Durable directory assignment

Add `knowledge_wiki_directory_assignments`, keyed by scope and a stable page identity (`topic_group_id` when present, otherwise the canonical page ID). Store the display classification, normalized source path snapshot, classification source, and taxonomy version. The source-derived `directory_path` remains available for traceability.

The assignment is derived from the complete canonical Wiki set for a scope, never from an actor-specific ACL-visible page window. Repeated topic families become visible folders. A family with only one page is promoted to its nearest shared parent and its original family/path is retained as `directory_context`. Pages without a meaningful family go to a flat `Other topics` node; no A–Z child buckets are created. A family crossing the aggregation threshold is reclassified only through an explicit affected-family refresh with a new taxonomy version; ordinary reads do not move pages.

### 3. Import and regeneration behavior

When a Product Document import completes, the existing topic group is used as the directory identity. The affected topic group receives an assignment refresh and an automatic Wiki generation job. Existing assignments for other topics remain unchanged unless a taxonomy version or explicit rule change requires a bounded backfill. Directory assignment is a display projection; the normalized source-derived `directory_path` remains the traceable raw path.

### 4. API/UI contract

The Wiki directory response continues to return paged page summaries, but each item carries its persisted display path and context. The client renders that stable path directly and never decides whether a folder exists based on the current page window. The generation status endpoint remains the source for the dedicated Operations page.

## Acceptance criteria

- `/knowledge/operations/wiki-generation` is reachable from Operations navigation and has no duplicate generation panel in Wiki.
- The page shows automatic and manual jobs, percentage progress, and job-scoped pause/resume actions.
- Existing Wiki page deep links still open the directory and selected page.
- Directory output contains no alphabetic nodes such as `A`, `B`, or `0–9`.
- Loading more directory pages does not move an existing page to a different folder.
- A new version of an existing topic preserves the prior assignment and receives the same topic family assignment.
- An unrelated import does not rewrite other topic assignments.
- Focused tests, TypeScript checks, frontend build, and production smoke checks pass.
