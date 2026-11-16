# Issue 67 local validation

This record describes the local working tree on 2026-11-05. It is not a deployment, a production-data migration, or approval of the product design. Existing uncommitted work was retained.

## Automated checks

- `npm run build`: passed, including the MCP boundary check and frontend production build. The frontend build reports a bundle-size warning.
- `npx tsc --noEmit --jsx react-jsx --moduleResolution bundler --module esnext --target es2022 --allowSyntheticDefaultImports --esModuleInterop --skipLibCheck frontend/src/main.tsx`: passed.
- `npm test`: **966 passed, 0 failed**, using the bundled Python runtime on `PATH`. The suite includes the isolated migration rehearsal, the engine runtime backup/restore tests, HTTP and MCP authorization tests, and the project file tests.
- `tests/knowledge-v2-real-e2e.test.ts` starts separate local Web and MCP processes with synthetic users and data. It exercises ordinary calls, an idempotent no-evidence Memory submission, pending isolation, administrator review, search and detail, permission withdrawal and restoration, and deletion of the MCP token.
- `tests/knowledge-migration-rehearsal.test.ts` backs up synthetic legacy SQLite databases, migrates twice, verifies historical visibility, classifies a synthetic document, restores an earlier snapshot to a separate directory, and checks preserved records. Its Evidence, engine and configuration files are fixtures; the engine runtime backup/restore implementation has separate tests.
- The classification report is administrator-only, paginated, excludes server paths, and records pending and completed decisions. Local API tests cover the report and its authorization. A separate synthetic preview showed its pending count and document status in the browser.

## Browser checks

The local preview covered the public landing page, sign-in and application pages, account and token views, administrator user list, project file navigation, Memory views and the classification report. Project and Memory navigation were checked with a narrow viewport and keyboard interaction. The browser rendered the synthetic approved Memory submission as approved and general in the submission list.

Automatic action review rejected clicking **Approve** on a pending synthetic user because it changes account access, and rejected **Sign out** because it changes the active session. Separate isolated HTTP tests exercise account approval, rejection and current-session authorization, but those two specific browser interactions were not completed. Do not treat the browser checks as a complete end-to-end acceptance of those controls.

PR #66 remained open and unmerged at the time of verification. Equivalent project file permission-error handling is present in this working tree and tested without exposing internal paths.

## Frontend refactor follow-up

- The approved charcoal/white/lime design is now applied to the authenticated shell, shared tokens and controls, landing surface, account, runtime, token and administrator pages. Primary navigation is in the top bar; contextual Knowledge, token and administrator links are in one desktop rail and become mobile contextual tabs. Existing feature routes remain available, with separate routes for MCP Access Tokens, Relay Agent Tokens, administrator access requests, Knowledge permissions, provider management and release gates.
- Frontend typecheck passed from `frontend`: `npx tsc --noEmit --jsx react-jsx --moduleResolution bundler --module esnext --target es2022 --allowSyntheticDefaultImports --esModuleInterop --skipLibCheck src/main.tsx`.
- Browser smoke passed against the local Vite server: public landing at 1440px and 390px, login, access request, authenticated Projects shell, Knowledge provider/gate navigation, token route split, administrator route split, mobile contextual navigation, and a real click from Providers to Release gates. Keyboard checks passed for the public and console skip links, Product Tour ArrowRight/Home/End behavior, mobile menu opening, and non-admin Users gating. Browser console/page error collections were empty for the verified scenarios. Authenticated API responses in these shell checks were isolated browser fixtures; real-data acceptance remains open.
- The production build was not rerun in this follow-up because the workspace policy requires explicit build permission.

These checks verify frontend routing and presentation, not the remaining real-data migration, backup/rollback, contact-channel, accessibility and deployment acceptance gates below.


## Remaining release gates

1. Product-owner review of the information architecture, visual design, public product claims, contact channel and any recovery, notification, privacy or terms decisions.
2. Classification and scope review of the actual historical documents and Memory in a non-production copy; retain the resulting classification report privately. Fixtures do not represent those decisions.
3. A coordinated, recoverable backup and restore/rollback rehearsal for the actual non-production application database, Knowledge database, Evidence, configured engine data and matching configuration; verify the real hosted engine and its source mappings if used. The historical non-production Web and MCP endpoints documented by the project were not reachable locally during this check.
4. Complete the outstanding browser approval and sign-out checks, the wider permission and accessibility acceptance, and release verification with the actual deployment configuration. Existing historical acceptance reports for the old MCP tools do not prove the new contract.

No production service or dataset was changed as part of this validation. The repository changes described here have not been committed or deployed.
