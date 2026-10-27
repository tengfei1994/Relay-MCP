# Product document imports

Both product import HTTP routes and product retry routes return HTTP 202 with a durable ingest job ID. Importing runs in one forked Node process per Web server, outside the HTTP event loop. Poll `/api/knowledge/ingest-jobs/:id` for status and progress. The product page retains the active job ID across refreshes.

ZIP files are read in 64 KiB chunks and entries are written directly to disk, including nested ZIPs, rather than retaining entire archives in memory. The importer reports progress every 100 source files and commits each document atomically. Knowledge SQLite uses WAL so readers can continue during short write transactions. Existing content hashes remain unchanged on retry. A failed or interrupted batch may contain completed documents; retry uses a new operation key and skips those documents.

Workers default to a 30-minute deadline (`RELAY_INGEST_TIMEOUT_MS` can override it), a 512 MiB V8 heap limit, and a 900 MiB resident-memory limit on Linux. Nested archives are limited to five levels, 150,000 entries and 2 GiB expanded bytes per extraction budget. Timeout/crash is recorded as a failed job. Startup marks interrupted running jobs failed instead of automatically replaying them. Queued jobs are drained serially. Graceful shutdown stops the worker; a watchdog stops orphaned workers after abrupt parent death.

Only deploy the importer modules, store changes, Web routes/entry point and built frontend for this fix. No table rebuild or destructive schema migration is required. Before deployment use SQLite backup, then verify `/api/health` and the public homepage. A PM2 `online` label alone does not prove that the HTTP event loop is responsive.

For the complete Developer manifest, current managed-engine coverage and native CPU-only embedding forecast, see [source control and Developer scale acceptance](verification/source-control-developer-scale-20261027.md). A completed raw archive import is not evidence of managed-engine indexing. Retry recovery re-scans and skips unchanged documents; it is not a file-level checkpoint. Source baseline/snapshot lists and Source files use server-side pagination for large collections.


## Wiki source grounding

Managed Wiki generation supplies only resolved original source chunks as factual evidence. Generated descriptions and Details are not fallback evidence. Missing or partially unresolved source citations fail before the reducer calls a model or changes a stored page. Legacy extraction still passes through the citation stage; provider retry policy is unchanged.

Short sources no longer receive a minimum summary word target or mandatory invented section hierarchy. This constrains generation; it does not prove factual accuracy. Retain generated drafts, immutable source hashes, failed quality reports and reviewer decisions.

Wiki citations expose actual page chunk references. A document-level reference does not imply that every permitted chunk was cited. Do not fill missing page citations from the entire source mapping or equate referential integrity with claim support.

Before publication, review complete source coverage, factual support and the actual revision. Runtime/readiness checks and a valid source identity alone do not satisfy release-quality acceptance. See the dated nonproduction verification packet and keep unresolved semantic relevance, factual review and agreed performance gates open.
