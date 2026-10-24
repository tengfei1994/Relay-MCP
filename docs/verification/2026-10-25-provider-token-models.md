# Provider setup validation — 2026-10-25

## Verification

- `npm test`: **362 passed, 0 failed, 0 skipped**.
- `npm run build`: passed on Windows in the OneDrive workspace; MCP boundary: 316 lines / 120 tools; TypeScript and Vite succeeded.
- `npx tsc --noEmit --jsx react-jsx --module esnext --moduleResolution bundler --target es2022 --esModuleInterop --skipLibCheck frontend/src/components/ProviderSetupForm.tsx`: passed.
- `git diff --check`: passed.
- Initial HTTP regressions failed with 404 for missing routes. The concurrent update regression failed before its guard was added.

Coverage: admin-only discovery/setup/rotation/clear; sanitized model IDs; URL validation; bounded upstream responses and timeout classification; secret-free DTOs, audit and SQLite; encrypted credentials across reopen; tamper/missing-key rejection; failed saves preserve configuration; dimension detection; concurrent configuration changes; rotation and clear.

## Browser acceptance

Real Chromium via Playwright CLI, production frontend bundle, actual Fastify routes and temporary SQLite. The upstream model service is a local HTTP fixture.

Passed: bad-token error and no save; model discovery/filter/selection; connection edits invalidate selection; test/save; automatic 3-dimensional embedding detection; refresh and runtime probe; no provider token in browser local/session storage; failed and successful replacement; replacement after reload; clear disables the provider and removes the credential. A stale successful-probe display found during clear acceptance was fixed and rechecked.

Screenshots are under local `output/playwright/` (ignored by Git). Index & Providers now links directly to `/knowledge/integrated?tab=providers`.

Reproduce after `npm run build`:
1. Start `node --import tsx tests/fixtures/provider-browser-server.ts`.
2. Open `http://127.0.0.1:19742`; sign in as `browseradmin` / `local-browser-fixture` (fixture credentials).
3. Create `output/playwright/`. Run `playwright-cli -s=provider-acceptance run-code --filename <file>` for `tests/fixtures/provider-browser-connect.js`, then `provider-browser-selection.js`, then `provider-browser-token.js` in the same directory.
4. From a fresh snapshot click Clear token, accept the dialog, then run `tests/fixtures/provider-browser-clear.js`.
5. Stop the fixture server. Startup output identifies its temporary state directory.

## Limits and deployment

No real gateway credential was supplied. The tests prove the UI/API/storage flow against an OpenAI-compatible fixture. Actual gateway model permissions and availability are checked by the new UI before saving; these results do not claim model-quality acceptance.

Deploy merged main through SSH host RelayMCP, after testing/building in an isolated server directory and backing up artifacts/databases. Record deployed commit and health checks in the PR. See the deployment guide for backing up the separate credential key.
