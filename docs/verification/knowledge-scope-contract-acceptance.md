# #46/#53 positive scope and reference contract packet — 2026-10-26

This packet completes the bounded **synthetic Solution/scope/reference contract** checks identified in [the criterion matrix](issue-acceptance-matrix-20261025.md). It does not assert real Product semantic quality or close either issue. The issue bodies were reread through GitHub: [#46](https://github.com/tengfei1994/Relay-MCP/issues/46) requires the internal Product/Relay-memory Context Pack boundary; [#53](https://github.com/tengfei1994/Relay-MCP/issues/53) also requires compatibility, scope validation, deterministic faults and source references.

## Execution and isolation

- Driver: `scripts/knowledge-scope-contract-acceptance.ts`.
- Regression: `tests/knowledge-scope-contract-acceptance.test.ts`.
- Retained local report: `runtime/scope46-53-synthetic-20261026a.json`.
- Report SHA-256: `5432afe7a7e56878786e4642a95f7962683de895583f7db15badec09729ed6a8`.
- Executed driver SHA-256: `e83fc9db28441f7859f710f6cd775bc7314fea0ab11d18d41c1d95cd216a93c4`.
- Executed UTC window: `2026-10-25T16:41:18.716Z`–`2026-10-25T16:41:21.385Z` (26 October locally).
- Result: `passed_synthetic_scope_contract`, 16 scenarios.

The driver starts three fresh loopback listeners: a synthetic WeKnora-compatible HTTP fixture, actual Fastify `knowledgeRoutes`, and the SDK Streamable HTTP transport using the complete `registerToolsForUser` composition. It creates independent temporary app/Knowledge databases with real fixture user/project ownership and a real `ProjectRegistry`. Authentication tokens and the HTTP authentication hook are synthetic; this does not replace the separate deployed JWT/outer-audit acceptance.

Ten explicitly synthetic Product mappings vary Solution A/B, 21.1/21.3, Forms/Inventory, dev/prod, project 1/2, en/zh, and published/staged/deprecated/unverified state. All synthetic metadata, source identities and tested source hashes are retained in the report. Neither the genuine source corpus nor the active databases/configuration/migration is read, copied, changed or restarted. No production composition root or worker is started. The fixture databases are removed after execution; reports use exclusive-create semantics. Fetch is restricted to the dynamically allocated loopback origins.

## Observed contracts

| Scenario | Observed result |
| --- | --- |
| Positive Solution A and B | HTTP and MCP each return only the mapping for the requested synthetic Solution. |
| Positive 21.1/21.3, module, environment and language | Both transports return exactly the expected external document and verified chunk. MCP environment is supplied by its fixture token context, matching production tool shape. |
| Absent Solution/version/module | Empty Product references and no upstream request. |
| Same topic with 21.1 and 21.3, version omitted | Two references and `versionConflicts=1`; pinning a version returns only that version. |
| Deliberately forged upstream metadata and foreign reference | Relay mapping values remain authoritative; the foreign document is omitted. The fixture deliberately advertises a wrong version, Solution, module, topic, project and environment. |
| Staged/deprecated/unverified reads | HTTP 403/404 and MCP error; no upstream read. These mappings also never enter search allowlists. |
| Published source read | Both transports return the correct raw SHA-256 and verified chunk citation. |
| Foreign actor | HTTP 403 and MCP error before any upstream call. |
| Relay memory partition | Approved Case, Pattern and Playbook appear only in confirmed memory; a draft Candidate appears only in Candidates; a project Fact remains in current facts. Draft/deprecated/foreign Cases and stale local Product data do not enter the accepted Context Pack. |

Every successful nonempty search sends the precise document `knowledge_ids` allowlist; no broad knowledge-base scope is sent. Observed requests total **20 upstream API + 16 Relay HTTP + 26 MCP HTTP**; MCP includes transport setup/control requests. The full tools/list deep comparison matches the existing **121-tool** versioned baseline, including input schemas, annotations and execution hints.

The reference ledger checks presence and source consistency of `provider`, `documentId`, `chunkId`, `topicId`, `version`, `sourceLocator`, `citation`, `score`, `matchReason`, `retrievalRunId`, `sourceSha256`, `solution`, `module`, `projectId`, `environment`, and `language`. Each Product reference is also the corresponding `authoritativeDocs` entry. Retrieval IDs match the containing response; citations are the mapped synthetic source path plus the verified text offsets. Engine endpoint, internal KB ID and synthetic credentials are absent from authorized responses.

## Privacy, zero-model evidence and limits

The final fixture contains **zero provider configurations, zero provider admissions, zero queued/running ingest jobs, and zero non-loopback fetch requests**. Its source/configuration freeze hash is unchanged: `28351853d1c1015745ae2243cc08f88331427c6fc7a4ca0c52e5c55b1957df25`.

The fresh telemetry window contains **66 retrieval rows, 66 Knowledge audit rows, 16 projected MCP tool audits and 6,552 Fastify log bytes**. Known query/body/credential canaries have zero raw, JSON-escaped or URL-encoded matches. Telemetry SHA-256: `df6d95b7efc44db88079678e1cea66e22e7f6be341d3091e79eb56cb38df1ff3`. Authorized response content is intentionally allowed. This is a bounded synthetic canary scan, not a statement about unknown secrets or historical logs.

The conflict result measures **same-topic cross-version conflict metadata**, not contradictory-claim detection or factual correctness. Directly seeded approved Memory fixtures prove retrieval partitioning; actual Review/promotion enforcement remains supported by its separate lifecycle and live Memory evidence. The existing Fact domain is project-scoped, so this fixture does not invent environment-specific Fact metadata. Synthetic `zh` source metadata proves filtering, not Chinese-language semantic retrieval. The running genuine-source bilingual/object/path/version evaluation remains separate. Real WeKnora ingestion/chunk structure, provider behavior and indexing completion are not claimed by a synthetic response fixture.

Combine this report with [the real seven-source scope/privacy packet](knowledge-mcp-real-acceptance.md), [the isolated deterministic fault packet](knowledge-mcp-fault-acceptance.md), and genuine-source quality results. None should be silently substituted for another. No issue was modified or closed.

## Reproduce

```sh
node --import tsx scripts/knowledge-scope-contract-acceptance.ts \
  --report runtime/scope-contract-NEW.json
node --import tsx --test tests/knowledge-scope-contract-acceptance.test.ts
npx tsc --noEmit --strict --esModuleInterop --skipLibCheck --target ES2022 \
  --module ESNext --moduleResolution bundler --allowImportingTsExtensions \
  scripts/knowledge-scope-contract-acceptance.ts \
  tests/knowledge-scope-contract-acceptance.test.ts src/server/index.ts
```

The static check includes `src/server/index.ts` only for existing Fastify declaration merging; the driver never imports or executes it. The new regression was observed failing before the driver existed, then passing with the actual socket fixture. No product source was changed for this packet.
