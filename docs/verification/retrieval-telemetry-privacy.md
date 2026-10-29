# Retrieval telemetry privacy boundary

This change covers future Relay retrieval telemetry for issues #53 and #56. It does not certify or erase historical records, rotate logs, or change the source Knowledge/Evidence content that authorized callers retrieve.

## Entry points and compatibility

- HTTP `/api/memory/search`, MCP `memory_search`, diagnostic composition and ContextPack Memory searches call `searchKnowledge`. ContextPack expands the query with its objective/actions, so those inputs require the same protection.
- `knowledge_retrieval_runs` has one production writer and no production reader that depends on its saved query or response body. The HTTP/MCP response continues to contain its original query, selected content and `retrievalRunId`.
- Feedback uses document IDs. The retrieval row ID and audit `entity_id` remain unchanged, and result IDs, scope metadata, ranks and scores remain available for correlation.
- Direct Product search uses the WeKnora client, whose trace records request ID, operation/path, HTTP status, latency and counts without the query or returned snippet. Its outer MCP `tools/call` audit still needed the separate projection below.

## New telemetry contract

`knowledge_retrieval_runs.query` stores `sha256:<64 hex characters>` for new rows, preserving the existing NOT NULL schema. `results_json` is a version 1 metadata envelope with query SHA-256, Unicode character/UTF-8 byte lengths, result count, elapsed time, degradation/provider/model metadata and an explicit result allowlist. Result metadata contains IDs, rank/score, lifecycle, applicability/scope, Evidence IDs and available external document/chunk/run IDs and source hashes. It excludes titles, summaries, snippets, body, arbitrary provider DTO fields and freeform match reasons.

The `memory.search` audit uses the same request metadata and keeps its retrieval ID. It no longer supplies `queryTokens`. The existing generic audit sanitizer already masks token-named keys, but that did not protect the raw retrieval table or raw `query` fields in the MCP transport log.

The outer MCP audit uses a dedicated allowlist only for `memory_search`, `knowledge_search`, `knowledge_source_search`, `knowledge_wiki_search` and `samplemanager_diagnose`. It retains known scope/correlation IDs and numeric limits, replaces the query with its hash/length, and drops unknown/nested argument fields. Actual execution receives the unchanged original arguments. Non-retrieval tool audit behavior is unchanged.

Fastify logs request method, path and remote endpoint metadata only. No original URL, query parameters, headers or body are copied by the request serializer. A safe 404 handler is registered even when frontend assets are absent because Fastify's default 404 log message includes the original URL and query. The real request URL/query/body remains available to route handlers. Error logging retains type/code/status metadata and uses a fixed log message: Fastify otherwise copies JSON parser errors containing truncated request text into both `err.message`/`err.stack` and `msg`. The original Error and client response are not rewritten.

## Validation

Regression tests reproduce and prevent raw query/result persistence, ContextPack objective/action persistence, request URL leakage in real HTTP/Pino logs, default 404 message leakage and outer MCP retrieval argument leakage. They also check that returned content, query/run identity, scope correlation, non-retrieval sanitization and historical rows remain intact. No real provider/model calls are needed.

## Historical remediation requires an explicit operation

Historical `knowledge_retrieval_runs`, `knowledge_audit` and Relay HTTP/MCP log files may still contain pre-change content. A running process using the earlier build continues its earlier logging behavior until a controlled deployment. This patch does not claim retroactive privacy compliance.

1. Inventory affected stores/log destinations and date ranges using counts and metadata only. Restrict access to any existing copies, including exports, SQLite WAL/SHM files, log rotations and backups. Before an authorized cleanup, create an isolated backup with restricted permissions/encryption and an explicit retention policy; do not export its content to shared reports.
2. Choose and authorize a retention outcome: retain restricted historical records for a defined period, or transform eligible retrieval rows into the new metadata shape while preserving row IDs, timestamps, document IDs and feedback/correlation links. Classification must verify the versioned envelope and tagged digest together, rather than trusting a `sha256:` prefix alone. Malformed legacy payloads require a reviewed fallback, not automatic replay or disclosure.
3. Audit/log cleanup needs its own approved scope. Raw request fields can be replaced by digest/length and result allowlists; historical log segments can be redacted or retired according to that decision. Do not alter actual Knowledge documents, Evidence, explicit user feedback or private acceptance fixtures merely because telemetry previously copied them.
4. Verify schema/foreign-key integrity, unchanged correlation counts and absence of the targeted content in active telemetry. SQLite deleted/replaced bytes, WAL pages, log rotations and backups have separate retention/remanence considerations; any checkpoint/compaction/backup retirement belongs to the authorized maintenance window. Record only counts, hashes, versions and outcome metadata.

No historical cleanup, remote database mutation or deployment is performed by this source change.
