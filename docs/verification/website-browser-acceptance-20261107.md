# Website browser acceptance — 2026-11-07

This check covers the local frontend revision in the working tree. The Vite server ran on `localhost:5173`; the Web API ran on `localhost:3000` with a disposable database and workspace under `tmp-browser-acceptance`.

## Browser matrix

- Desktop: 1440 × 900.
- Mobile: 390 × 844.
- Public landing: hero CTA, section anchors, Product Tour tabs, file selection, Knowledge search and empty state, Memory scope selection, FAQ disclosure and keyboard tab navigation.
- Access pages: request-access layout, sign-in layout, form labels/autocomplete, and the request/sign-in mode switch.
- Authenticated console: fixture sign-in, Projects empty state, mobile primary navigation, Knowledge contextual navigation, Control plane Providers → Release gates, Product docs, Memory/Evidence, Operations, Tokens and administrator routes.

## Results

- No JavaScript console errors or warnings remained in the verified routes.
- Mobile document width matched the viewport on the public and console routes; no horizontal page overflow was observed.
- The active Knowledge parent remains visible on child routes such as Evidence, Control plane release gates and Operations. The mobile contextual strip scrolls the active item into view.
- Desktop and mobile screenshots were captured during the run in the local Playwright artifact directory.

## Fixes in this revision

- Opted into the React Router v7 transition and splat-resolution flags to remove repeat browser-console warnings.
- Changed the mobile Knowledge strip to use explicit active-state links, so parent sections stay selected on nested routes.
- Added active-item scrolling for the mobile Knowledge strip with reduced-motion behavior inherited from the browser.

This is a frontend routing and presentation check. It does not approve production data, hosted Knowledge engine state, account approval/sign-out side effects or deployment rollback gates.
