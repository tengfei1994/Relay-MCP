# Product document imports

Both product import HTTP routes and product retry routes return HTTP 202 with a durable ingest job ID. Importing runs in one forked Node process per Web server, outside the HTTP event loop. Poll `/api/knowledge/ingest-jobs/:id` for status and progress. The product page retains the active job ID across refreshes.

ZIP files are read in 64 KiB chunks and entries are written directly to disk, including nested ZIPs, rather than retaining entire archives in memory. The importer reports progress every 100 source files and commits each document atomically. Knowledge SQLite uses WAL so readers can continue during short write transactions. Existing content hashes remain unchanged on retry. A failed or interrupted batch may contain completed documents; retry uses a new operation key and skips those documents.

Workers default to a 30-minute deadline (`RELAY_INGEST_TIMEOUT_MS` can override it), a 512 MiB V8 heap limit, and a 900 MiB resident-memory limit on Linux. Nested archives are limited to five levels, 150,000 entries and 2 GiB expanded bytes per extraction budget. Timeout/crash is recorded as a failed job. Startup marks interrupted running jobs failed instead of automatically replaying them. Queued jobs are drained serially. Graceful shutdown stops the worker; a watchdog stops orphaned workers after abrupt parent death.

Only deploy the importer modules, store changes, Web routes/entry point and built frontend for this fix. No table rebuild or destructive schema migration is required. Before deployment use SQLite backup, then verify `/api/health` and the public homepage. A PM2 `online` label alone does not prove that the HTTP event loop is responsive.
