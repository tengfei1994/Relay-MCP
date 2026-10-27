# Provider transport acceptance — 2026-10-26

The packet ran on `ftd1994-codex` using independent, freshly migrated databases and real loopback HTTP listeners. It exercised the current ProviderSetupService, CredentialStore, ProviderRegistry, model gateway, Fastify routes, JWT authorization and request logging. Provider responses and credentials were synthetic. This is evidence of actual local transport and application behavior under injected faults, not a claim of cloud-side failure, actual account token revocation or model quality.

No live application database, provider secret, engine profile, model binding or quota was read or modified by the packet. No production service or external model endpoint was contacted. The isolated process imported route/service modules, never the server or MCP composition roots; it started no ingest worker. Both local HTTP listeners were closed at completion.

## Result and provenance

- Status: `passed_isolated_provider_transport`; 11 of 11 scenarios passed.
- Actual HTTP requests: 48 to Relay, including 26 gateway entries; 35 to the local provider responder. External cloud calls: zero. Active ingest jobs in the fresh database: zero.
- Execution: `2026-10-25T16:18:25.238Z` (2026-10-26 in Asia/Shanghai).
- Report: `/home/ftd/relay-knowledge-engine-nonprod/providerfixture/run-20261026a/report.json`.
- Report SHA-256: `d837bd2d541115ecb7c476fb68e10dc862d16ee3e997957253926fbd7b097e59`.
- Source archive SHA-256: `efde2d610216277d74c9cf3647bcaebf81e30c102062b6006c2c04182577de99`. The archive contains only source, the driver and package/TypeScript metadata; it excludes environment files, live databases and credentials.
- Source checkout: `providerfixture/source-20261026a`; dependency symlink points to the installed nonproduction node_modules. Every generated database/key/report is inside `providerfixture/run-20261026a`. Report and generated 32-byte encryption key are mode `0600`.
- Driver: `scripts/knowledge-provider-transport-acceptance.ts`. The report records relevant source hashes and metadata for every actual provider request, never its authorization header or input body.

| Criterion | Observed result |
| --- | --- |
| Administrator boundary | Nonadmin model discovery, configuration, token clear and disable returned 403; bad gateway authentication returned 401. These denials made zero provider requests. |
| Encrypted credential persistence | Configuration derived three dimensions; one encrypted secret row remained. A fresh registry instance resolved the persisted credential and performed an actual probe. |
| Rotation with a queued call | An actual A request was held open while a second request queued. After B committed, the queued request, future requests and a previously resolved handle used B. No new A request began after commit; the already running A request could finish. |
| Clear with a queued call | Clear sent no provider request and removed the encrypted secret. The queued and future gateway requests were rejected without transport; the already running request could finish. |
| Disable and restore | Disabled gateway and previously resolved handle made zero HTTP requests. Formal candidate-credential configuration restored the provider successfully. |
| Failed configuration | Injected 401 during candidate validation returned 502 and preserved the complete existing configuration and encrypted secret. The old credential remained usable. |
| Concurrent CAS | Two actual validations overlapped. The fast winner committed; the stale contender returned 400 without overwriting it or leaving an extra secret. |
| Faults and recovery | Injected 401, 429, invalid JSON, invalid vector, dimension mismatch and timeout each produced the expected safe 503 error code with one provider HTTP attempt. Each subsequent recovery call succeeded. |
| Retry accounting | A 429 followed by success caused two real HTTP attempts and exactly one durable logical admission. |
| Local binding guards | Requested dimension mismatch returned 409; unknown model alias returned 403. Neither reached the provider. |
| Privacy | All returned API payloads, actual Pino request logs, config/secret/audit/admission rows and checkpointed SQLite bytes were scanned for synthetic tokens, JWTs, request bodies and upstream error sentinels. Matches: zero. |

The response scan covered 12,018 bytes; logs 19,960 bytes; metadata/audit 13,272 bytes; the checkpointed database 1,011,712 bytes. The report retains only hashes, sizes, counts, safe codes and version labels. Original logs, response bodies and synthetic plaintext tokens are not written as report artifacts.

## Defect discovered and fixed

The first actual packet failed when formal configuration attempted to restore a cleared/disabled provider. The candidate-credential probe reused runtime admission, which rejected disabled status before it could validate the new credential. Administrators therefore had no successful normal configuration path to recover that provider.

The narrow fix adds a dedicated configuration-probe admission operation. It reserves against the same persisted quota, historical admissions and upgrade barrier; failed probes stay counted and quota is not reset. Ordinary runtime admission continues to reject disabled providers. Configuration publishes the new credential and ready state only after a successful probe and the existing transaction/CAS check. A failed or stale validation preserves the prior disabled state and encrypted credential.

Seven added regressions first failed, then passed: successful configure/updateToken on disabled state, failed probe preservation for each operation, exhausted quota for each operation, and the upgrade barrier. The focused setup/admission/HTTP/credential/packet group passed 39 tests. Strict TypeScript checking of the packet and server composition root passed. The wider release suite and final deployment belong to the coordinated release, not this isolated process.

## Reproduction

On the approved host, from a source-only isolated checkout with installed dependencies, run:

```sh
RELAY_E2E_ISOLATED=1 node --import tsx scripts/knowledge-provider-transport-acceptance.ts --root /home/ftd/relay-knowledge-engine-nonprod/providerfixture/<new-run>
```

The root must be a fresh child of the guarded directory; an existing knowledge database or a resolved symlink path is rejected. A separate local regression runs only under an OS temporary directory with an explicit test flag. Do not copy live .env files or credentials into the fixture. This packet does not establish external provider entitlement, cloud-side token invalidation, real model quality, whole-corpus indexing or UI usability; those require their separate evidence. Issue closure remains the parent release decision.
