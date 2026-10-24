# Managed provider failure diagnostics

## Scope

`Test and save` first rechecks `/models`, then probes the selected purpose. Previously both stages could report only `Managed provider returned HTTP 502`. This change identifies the failed stage and fixed adapter endpoint, preserves upstream status/response format and a safe bounded request ID, and correlates the browser error with a `provider_setup_failed` server log event using a generated Relay request ID.

No upstream response body, submitted token, or user-supplied URL is included in these diagnostics. Failed setup leaves existing provider configuration and encrypted credentials unchanged. There are no database migrations or changes to the model request payloads.

## Verification

- Red phase: the new stage/correlation tests failed against the previous implementation because diagnostics were absent.
- `npm test`: **369 passed, 0 failed, 0 skipped** on Windows.
- `npm run build`: passed, including MCP boundary validation (316 lines, 120 tools), TypeScript, and Vite from the OneDrive workspace.
- `git diff --check`: passed.
- HTTP regressions exercise real local upstream responses for models, embeddings, rerank and inference, malformed responses, timeouts and refused connections. Unsafe/oversized IDs and echoed raw/encoded credentials are excluded.
- API regressions distinguish a discovery failure (no embedding call) from an embedding failure, correlate response IDs with safe log events, and check that failures preserve saved configuration and credentials.
- Chromium acceptance against the built frontend and a real local Fastify/SQLite service passed: discovery and embedding alerts, Relay/upstream IDs visible, upstream body excluded, and failed configuration not saved. The two browser console 502 messages were expected responses from the deliberately failing fixture.
- Reproducible browser fixture: `tests/fixtures/provider-browser-server.ts` and `tests/fixtures/provider-browser-diagnostics.js`. Screenshot is retained locally at `output/playwright/provider-diagnostics.png` (ignored).

## Remaining real-gateway check

The authenticated `https://botcf.com/v1` request for `text-embedding-3-large` has not been reproduced by this verification. After deployment, retry **Test and save** and use the new Relay request ID to identify the failing request in production logs. A passing fixture test does not establish the cause or resolution of the real gateway's HTTP 502.
