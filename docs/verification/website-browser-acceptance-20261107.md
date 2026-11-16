# Website browser acceptance — 2026-11-07

This record covers the React implementation after connecting the latest `docs/design` homepage, user workspace and administrator console previews. The Vite frontend ran on `localhost:5173`; authenticated checks used a disposable local Web API and database.

## Browser matrix

- Desktop: 1440 × 900.
- Mobile: 390 × 844.
- Public homepage: lime diamond brand, centered hero, sticky scroll Flow scene, four route stages, client setup steps, FAQ and final access CTA.
- User workspace: workspace overview, live API/project/runtime counts, permission-aware Memory state, route canvas, run trace, runtime links and mobile menu.
- Administrator console: access request state, account totals, Knowledge queue, runtime posture, review links, administrator context rail and mobile layout.
- Keyboard: skip link, public navigation, FAQ disclosure, route links, mobile menu and primary actions remain reachable with visible focus.

## Results

- No JavaScript console errors or warnings remained on the verified routes. The only console entry was the development-only React DevTools informational message.
- Desktop and mobile document widths matched the viewport; no horizontal page overflow was observed.
- The public homepage follows `docs/design/relay-website-preview-v3.html` with the scroll-linked Relay loop and reduced-motion fallback.
- `/workspace` follows `docs/design/relay-website-user-preview-v1.html` while using live API data and explicit empty/error states instead of fabricated counters.
- `/admin` follows `docs/design/relay-website-admin-preview-v1.html`; Knowledge requests are skipped when the administrator account has no Knowledge permission, so a valid disabled state does not create noisy 403 requests.
- Existing project, server, instance, tools, Knowledge, token and user routes remain reachable from the updated shell.

## Implementation notes

- The static previews remain design references; the runtime now renders equivalent React components in `frontend/src/pages/Landing.tsx`, `WorkspaceOverview.tsx` and `AdminOverview.tsx`.
- The authenticated shell keeps the existing API and permission behavior while adopting the preview's 76px top bar, lime brand mark, contextual rails and responsive spacing.
- The full repository suite and production build were rerun after this integration.
