# Safe upstream JSON error summaries

Production request `293197e5-feef-4147-bfcd-b35d69f0ae3e` confirmed an embedding-stage HTTP 502 with JSON content and no usable request ID in response headers. This change reads bounded JSON errors to derive allowlisted error codes, fixed reason categories, reported nested HTTP status and safe request IDs, including IDs embedded in error messages.

Raw error messages are not returned or logged. Unknown fields are omitted; raw/encoded tokens and IDs matching submitted request content are rejected. Error-body reads stop after 16 KiB or one second. Malformed, oversized or incomplete JSON preserves the original HTTP error and retry classification.

Validation:

- Red phase confirmed absent JSON error evidence; a second regression exposed an echoed document value being accepted as an ID before the request-content filter was added.
- `npm test`: **374 passed, 0 failed, 0 skipped** on Windows.
- `npm run build`: passed, including MCP boundary (316 lines, 120 tools), TypeScript and Vite in the OneDrive workspace.
- Chromium with the built frontend, real local Fastify/SQLite and an HTTP fixture passed. The alert showed outer HTTP 502, reported upstream HTTP 404, an allowlisted error code and a JSON-embedded request ID, while omitting private error text. Failure did not save the provider. Expected fixture 502 console entries were observed.
- `git diff --check`: passed. Review covered bounded reads, deadline cleanup, error classification preservation, ID filtering and avoidance of raw body logging.

These classifications report what the gateway says; they are not proof of its internal root cause. The authenticated botcf failure still requires another user retry after deployment. No model, gateway URL, production token or database schema is changed.
