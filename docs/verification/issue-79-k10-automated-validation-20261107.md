# Issue 79 K10 automated validation — 2026-11-07

This record covers the K10 checks that run locally with disposable synthetic data. No production or customer data was opened, migrated, or changed.

## Automated evidence

- `npm run test:k10` — 151 passed, 0 failed, 0 skipped. The runner is committed as `scripts/k10-acceptance.mjs`; it executes the MCP boundary check and the K10 matrix serially so independent local MCP and migration fixtures do not contend for ports or SQLite locks.
- MCP boundary gate — passed (`src/mcp/index.ts` 341 lines; 91 registered tools; registrar/catalog parity clean).
- `npm test` — 966 passed, 0 failed, 0 skipped.
- `npm run build` — passed, including the root TypeScript build and frontend production bundle.
- Browser acceptance — desktop and mobile routes passed with no console errors or warnings and no mobile horizontal overflow. The authenticated Knowledge routes, release gates, Memory, Evidence, Operations, Product, Wiki, login and request-access states are recorded in [website-browser-acceptance-20261107.md](./website-browser-acceptance-20261107.md).

## K10 coverage map

| K10 requirement | Local evidence |
| --- | --- |
| Product/Project/token/admin permissions and immediate revocation | Knowledge v2 access, boundary HTTP/MCP and isolated Web/MCP E2E tests |
| Direct ID, source-path, diagnostic and legacy-resource bypasses | Product/Memory/Wiki scope tests, source sanitization, MCP `resources/list` and `resources/read` rejection checks |
| Multi-chunk/version-filtered retrieval, citations, no-result/no-auth/unavailable | Product search v2, retrieval privacy/hybrid, provider failure, boundary HTTP/MCP and MCP smoke tests |
| Project/General/both Memory, pagination, ACL, review/reject, idempotency and isolation | Memory v2, Memory FTS, review, confirmed-memory and real Web/MCP E2E tests |
| Ordinary Agent calls do not create candidates; explicit submission then admin review | Candidate capture, candidate review/coexistence, candidate audit and Memory submission tests |
| Classification, traceability, idempotent migration, backup/restore rehearsal and rollback guards | Migration, migration-jobs, migration HTTP and migration rehearsal tests |
| Frontend authorization, route ownership, mobile/desktop contracts and states | Knowledge UI route/scope/layout tests plus browser acceptance record |
| Five Knowledge tools and no legacy Knowledge resources | `scripts/knowledge-v2-smoke.ts`, `tests/knowledge-v2-smoke.test.ts`, MCP HTTP resources checks and boundary gate |

## Remaining human or external gates

The automation is complete for the repository and disposable fixtures. Issue #79 remains open for the final release gate: repeat the candidate submission/admin review/search/revocation/recovery flow against the actual non-production deployment and hosted Knowledge engine, then attach deployment configuration, migration classification, backup/rollback and release approval evidence. This is the point at which user or deployment-owner involvement is required.
